'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-ep-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

require('../lib/config').load();
const ledger = require('../lib/ledger');
ledger.init();
require('../lib/audit').init();
const { createApp } = require('../lib/createApp');

const { contractRecord, injectionHeaders } = require('./helpers');

// Correctif P1 n°11 : plus de clé partagée. Chaque assujetti a son secret, et la
// signature couvre horodatage + nonce.
require('../lib/connectors').load();
const app = createApp({ tlsEnabled: false, serveStatic: false, demoLogin: true, broadcast() {} });

async function authCookie(username = 'se') {
  const r = await fetch(base + '/api/v1/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

let server; let base;
before(async () => { await new Promise((resolve) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); }); });
after(() => server.close());

test('GET /healthz => 200 ok', async () => {
  const j = await (await fetch(base + '/healthz')).json();
  assert.equal(j.status, 'ok');
  assert.equal(j.service, 'SUMo');
});

test('POST /api/v1/iso8583 sans authentification => 401', async () => {
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operatorId: 'airtel', amount: 1000 }) });
  assert.equal(r.status, 401);
});

test('POST avec signature HMAC invalide => 401', async () => {
  const body = JSON.stringify({ operatorId: 'airtel', amount: 1000 });
  const headers = { ...injectionHeaders(body), 'x-sumo-signature': 'mauvaise'.padEnd(64, '0') };
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers, body });
  assert.equal(r.status, 401);
});

const inject = async (record, operatorId = 'airtel') => {
  const body = JSON.stringify({ operatorId, record });
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: injectionHeaders(body, { operatorId }), body });
  return { status: r.status, json: await r.json() };
};

test('POST connecteur JSON authentifié => 202 + TDR scellé', async () => {
  const { status, json: j } = await inject(contractRecord({ fee_amount: 900, tax_amount: 162, latency_ms: 740 }));
  assert.equal(status, 202);
  assert.equal(j.status, 'ACCEPTED');
  assert.equal(j.type, 'P2P');
  assert.ok(String(j.iso8583).startsWith('0200'));
  // Correctif A1 : la référence de l'assujetti est conservée (réconciliation).
  assert.ok(j.operatorRef);
  // Correctif A2/A3 : les frais retenus sont les frais DÉCLARÉS, et l'écart avec
  // le barème est calculé — c'est là que naît l'assurance des revenus.
  assert.equal(j.provenance.fee, 'DECLARE');
  assert.equal(j.provenance.latencyMs, 'DECLARE');
  assert.equal(j.fee.declared, 900);
  assert.equal(typeof j.fee.ecart, 'number');
});

test('Correctif A1 : un enregistrement incomplet est REJETÉ, jamais complété', async () => {
  // Le dialecte historique (a_party/amt/service/bearer) ne satisfait plus le
  // contrat : ni identifiant, ni horodatage, ni frais, ni taxe.
  const { status, json: j } = await inject({ a_party: '+241074111111', amt: 250000, service: 'transfer', bearer: 'ussd' });
  assert.equal(status, 400);
  assert.equal(j.status, 'REJECTED');
  for (const champ of ['transactionId', 'timestamp', 'feeAmount', 'taxAmount']) {
    assert.ok(j.error.includes(champ), `le rejet doit nommer ${champ} — reçu : ${j.error}`);
  }
});

test('Correctif A2 : sans latence ni localisation déclarées, rien n\'est inventé', async () => {
  const { json: j } = await inject(contractRecord({ latency_ms: undefined, cell_id: undefined, city: undefined }));
  assert.equal(j.provenance.latencyMs, 'INCONNU');
  assert.equal(j.provenance.cellOrigin, 'INCONNU');
});

test('Correctif A4 : le statut REVERSED est conservé, jamais coercé en SUCCESS', async () => {
  const { json: j } = await inject(contractRecord({ status: 'REVERSED' }));
  assert.equal(j.status, 'ACCEPTED');
  const led = await (await fetch(base + '/api/v1/tx/recent?limit=5', { headers: { Cookie: await authCookie('se') } })).json();
  assert.ok(led.records.some((t) => t.status === 'REVERSED'), 'le TDR annulé doit rester REVERSED');
});

test('Correctif A4 : un statut hors énumération du contrat est rejeté', async () => {
  const { status, json: j } = await inject(contractRecord({ status: 'peut-etre' }));
  assert.equal(status, 400);
  assert.match(j.error, /statut non reconnu/i);
});

// Correctif P1 n°11 : un connecteur ne déclare QUE pour lui-même. Déclarer au nom
// d'un tiers — fût-il inexistant — est désormais refusé avant même la validation
// du contenu, et le refus est journalisé.
test('POST : un connecteur ne peut pas déclarer au nom d\'un autre opérateur', async () => {
  const body = JSON.stringify({ operatorId: 'inexistant', amount: 1000 });
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: injectionHeaders(body), body });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'OPERATEUR_USURPE');
});

test('GET /api/v1/reports/export sans session => 401', async () => {
  const r = await fetch(base + '/api/v1/reports/export?template=observatoire&format=csv');
  assert.equal(r.status, 401);
});

test('GET /api/v1/reports/export (authentifié) => fichier signé', async () => {
  const r = await fetch(base + '/api/v1/reports/export?template=observatoire&format=csv', { headers: { Cookie: await authCookie() } });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('x-content-sha256'));
  assert.ok(r.headers.get('x-signature-ecdsa-p256'));
  assert.match(r.headers.get('content-disposition') || '', /attachment/);
});

test('RBAC : un profil sans le module reçoit 403', async () => {
  // La direction DM (observatoire des marchés) n'a pas le module admin/config.
  const r = await fetch(base + '/api/v1/config', { headers: { Cookie: await authCookie('ag-dm') } });
  assert.equal(r.status, 403);
});

// Le fil de parcours du registre est arrêté à la fin de la suite.
after(() => require('../lib/scanner').close());
