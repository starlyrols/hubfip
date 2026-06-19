'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.HUBFIP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hubfip-ep-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const ledger = require('../lib/ledger');
ledger.init();
const { createApp } = require('../lib/createApp');

const API = { key: 'test-key', secret: 'test-secret' };
const app = createApp({ api: API, tlsEnabled: false, serveStatic: false, demoLogin: true, broadcast() {} });
const sign = (body) => crypto.createHmac('sha256', API.secret).update(body).digest('hex');

// Ouvre une session (régulateur) et renvoie l'en-tête Cookie correspondant.
async function authCookie() {
  const r = await fetch(base + '/api/v1/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'regulateur' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

let server; let base;
before(async () => {
  await new Promise((resolve) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
after(() => server.close());

test('GET /healthz => 200 ok', async () => {
  const r = await fetch(base + '/healthz');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.status, 'ok');
  assert.equal(j.demo, true);
});

test('POST /api/v1/iso8583 sans authentification => 401', async () => {
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operatorId: 'bgfi', amount: 1000 }) });
  assert.equal(r.status, 401);
});

test('POST avec signature HMAC invalide => 401', async () => {
  const body = JSON.stringify({ operatorId: 'bgfi', amount: 1000 });
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hubfip-key': API.key, 'x-hubfip-signature': 'mauvaise' }, body });
  assert.equal(r.status, 401);
});

test('POST avec authentification valide => 202 + message ISO 8583', async () => {
  const body = JSON.stringify({ operatorId: 'bgfi', amount: 2500000, cityName: 'Libreville' });
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hubfip-key': API.key, 'x-hubfip-signature': sign(body) }, body });
  const j = await r.json();
  assert.equal(r.status, 202);
  assert.equal(j.status, 'ACCEPTED');
  assert.ok(String(j.iso8583).startsWith('0200'));
});

test('POST opérateur inconnu (auth valide) => 400', async () => {
  const body = JSON.stringify({ operatorId: 'inexistant', amount: 1000 });
  const r = await fetch(base + '/api/v1/iso8583', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hubfip-key': API.key, 'x-hubfip-signature': sign(body) }, body });
  assert.equal(r.status, 400);
});

test('GET /api/v1/export sans session => 401', async () => {
  const r = await fetch(base + '/api/v1/export?format=csv');
  assert.equal(r.status, 401);
});

test('GET /api/v1/export (authentifié) => fichier signé (en-têtes SHA-256 + ECDSA)', async () => {
  const r = await fetch(base + '/api/v1/export?format=csv', { headers: { Cookie: await authCookie() } });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('x-content-sha256'));
  assert.ok(r.headers.get('x-signature-ecdsa-p256'));
  assert.match(r.headers.get('content-disposition') || '', /attachment/);
});
