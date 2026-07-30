'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-ep-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

require('../lib/config').load();
const ledger = require('../lib/ledger');
ledger.init();
require('../lib/audit').init();
const { createApp } = require('../lib/createApp');

const API = { key: 'test-key', secret: 'test-secret' };
const app = createApp({ api: API, tlsEnabled: false, serveStatic: false, demoLogin: true, broadcast() {} });
const sign = (body) => crypto.createHmac('sha256', API.secret).update(body).digest('hex');

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
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sumo-key': API.key, 'x-sumo-signature': 'mauvaise' }, body });
  assert.equal(r.status, 401);
});

test('POST connecteur JSON authentifié => 202 + TDR scellé', async () => {
  const body = JSON.stringify({ operatorId: 'airtel', record: { a_party: '+241074111111', amt: 250000, service: 'transfer', bearer: 'ussd' } });
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sumo-key': API.key, 'x-sumo-signature': sign(body) }, body });
  const j = await r.json();
  assert.equal(r.status, 202);
  assert.equal(j.status, 'ACCEPTED');
  assert.equal(j.type, 'P2P');
  assert.ok(String(j.iso8583).startsWith('0200'));
});

test('POST opérateur inconnu (auth valide) => 400', async () => {
  const body = JSON.stringify({ operatorId: 'inexistant', amount: 1000 });
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sumo-key': API.key, 'x-sumo-signature': sign(body) }, body });
  assert.equal(r.status, 400);
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
