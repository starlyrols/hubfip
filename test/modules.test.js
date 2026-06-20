'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-mod-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
const model = require('../lib/model');
const normalize = require('../lib/normalize');
const rules = require('../lib/rules');
const warehouse = require('../lib/warehouse');
const revenue = require('../lib/revenue');
const audit = require('../lib/audit');
audit.init();

test('normalize : harmonise un dialecte opérateur (a_party/amt/service/bearer)', () => {
  const r = normalize.normalizeObject({ a_party: '+241074111111', b_party: '+241074222222', amt: 75000, service: 'cashout', bearer: 'app' }, { operatorId: 'airtel' });
  assert.equal(r.ok, true);
  assert.equal(r.input.type, 'CASHOUT');
  assert.equal(r.input.channel, 'APP');
  assert.equal(r.input.amount, 75000);
});

test('normalize : rejette un enregistrement sans montant', () => {
  const r = normalize.normalizeObject({ a_party: '+241074111111' }, { operatorId: 'airtel' });
  assert.equal(r.ok, false);
});

test('normalize : opérateur inconnu rejeté', () => {
  const r = normalize.normalizeObject({ amt: 1000 }, { operatorId: 'zzz' });
  assert.equal(r.ok, false);
});

test('rules : transaction de montant très élevé → alerte HIGH_VALUE', () => {
  const tdr = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 9_000_000, senderMsisdn: '+241074999999' });
  const alerts = rules.evaluate(tdr);
  assert.ok(alerts.some((a) => a.ruleId === 'HIGH_VALUE'));
});

test('rules : vélocité → alerte au-delà du seuil de rafale', () => {
  const ms = '+241077000001';
  let last = [];
  for (let i = 0; i < 12; i++) last = rules.evaluate(model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 5000, senderMsisdn: ms }));
  assert.ok(last.some((a) => a.ruleId === 'VELOCITY'));
});

test('revenue : détecte un écart de frais (sous-déclaration)', () => {
  // Frais attendus P2P de 200000 XAF = 2000 ; on en déclare 500 → écart 1500.
  const tdr = model.buildTDR({ operatorId: 'moov', type: 'P2P', amount: 200000, feeOverride: 500, senderMsisdn: '+241062111111' });
  warehouse.ingest(tdr);
  const rep = revenue.report({ operatorId: 'moov' });
  const moov = rep.byOperator.find((o) => o.operatorId === 'moov');
  assert.ok(moov.discrepancyXaf > 0);
  assert.ok(moov.underReportedCount >= 1);
});

test('audit : journal chaîné/signé vérifiable', () => {
  audit.record({ action: 'TEST', actor: 'x', meta: { ip: '1.2.3.4' } });
  audit.record({ action: 'TEST2', actor: 'y', meta: {} });
  const v = audit.verify();
  assert.equal(v.valid, true);
});
