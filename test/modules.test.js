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
const { contractRecord } = require('./helpers');

test('normalize : harmonise un dialecte opérateur (a_party/amt/service/bearer)', () => {
  const r = normalize.normalizeObject(
    contractRecord({ a_party: '+241074111111', b_party: '+241074222222', amt: 75000, service: 'cashout', bearer: 'app',
      sender_msisdn: undefined, receiver_msisdn: undefined, transaction_type: undefined, channel: undefined, amount: undefined,
      transaction_id: 'X-1', fee_amount: 400, tax_amount: 72 }),
    { operatorId: 'airtel' },
  );
  assert.equal(r.ok, true, r.error);
  assert.equal(r.input.type, 'CASHOUT');
  assert.equal(r.input.channel, 'APP');
  assert.equal(r.input.amount, 75000);
  // Correctif A1 : l'identifiant de l'assujetti et les frais déclarés sont conservés.
  assert.equal(r.input.operatorRef, 'X-1');
  assert.equal(r.input.feeDeclared, 400);
  assert.equal(r.input.taxDeclared, 72);
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

test('reporting : la date de fin (YYYY-MM-DD) est inclusive jusqu\'à la fin de journée', () => {
  const reporting = require('../lib/reporting');
  const to = reporting.periodEnd('2026-07-10');
  const midi = new Date('2026-07-10T12:00:00').getTime();
  assert.ok(to >= midi, 'une transaction de midi le jour de fin doit être incluse');
});

test('config : rejette intervalMs=0 et highValueXaf=0 (champ vidé du formulaire admin)', () => {
  const config = require('../lib/config');
  assert.throws(() => config.update({ stream: { intervalMs: 0 } }));
  assert.throws(() => config.update({ rules: { highValueXaf: 0 } }));
});

test('normalize : cityName transporte la géographie pour une injection externe', () => {
  const r = normalize.normalizeObject(contractRecord({ ville: 'oyem' }), { operatorId: 'airtel' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.input.cityName, 'Oyem');
  const tdr = model.buildTDR(r.input);
  assert.equal(tdr.cellOrigin.city, 'Oyem');
  assert.equal(tdr.provenance.cellOrigin, 'DEDUIT');
});

test('model : fromIso8583 respecte la grille tarifaire transmise (feeGrid)', () => {
  const base = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 100000, senderMsisdn: '+241074111111' });
  const grid = { P2P: { pct: 2.0, flat: 0, min: 0, cap: 0 } };
  const tdr = model.fromIso8583(base.iso8583.message, { operatorId: 'airtel', channel: 'USSD', feeDeclared: 1500, taxDeclared: 270, feeGrid: grid });
  assert.equal(tdr.fee.expected, 2000);
});

test('cases : les contreparties sont agrégées par MSISDN réel, pas par libellé masqué', async () => {
  const ledger = require('../lib/ledger');
  ledger.init();
  const cases = require('../lib/cases');
  const scanner = require('../lib/scanner');
  const subject = '+241074000010';
  // Deux contreparties distinctes qui partagent le même libellé masqué (+241074****56).
  ledger.append(model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 1000, senderMsisdn: subject, receiverMsisdn: '+241074123456' }));
  ledger.append(model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 2000, senderMsisdn: subject, receiverMsisdn: '+241074999956' }));
  const chain = await cases.traceChain(subject, { reveal: false });
  assert.equal(chain.counterparties.length, 2);
  // Le parcours est déporté (correctif D1) : son coût réel est remonté à l'appelant.
  assert.equal(typeof chain.scanStats.scannedRecords, 'number');
  assert.equal(chain.scanStats.truncated, false);
  scanner.close();
});
