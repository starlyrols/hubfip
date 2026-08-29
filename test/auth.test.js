'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-auth-'));

require('../lib/config').load();
const ledger = require('../lib/ledger');
ledger.init();
require('../lib/audit').init();
const model = require('../lib/model');
const users = require('../lib/users');
const { createApp } = require('../lib/createApp');
const { externalInput } = require('./helpers');

function listen(app) { return new Promise((resolve) => { const s = http.createServer(app); s.listen(0, () => resolve(s)); }); }
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('GET /api/v1/auth/accounts expose le catalogue de démo', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const j = await (await fetch(base(s) + '/api/v1/auth/accounts')).json();
  assert.equal(j.demoLogin, true);
  const ids = j.accounts.map((a) => a.username);
  ['pcr', 'se', 'dctlf', 'ag-dm', 'admin-systeme', 'airtel', 'moov', 'gimac'].forEach((u) => assert.ok(ids.includes(u), `manque ${u}`));
  assert.ok(j.accounts.every((a) => a.passwordHash === undefined));
  s.close();
});

test('GET /api/v1/auth/me sans session → 401', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  assert.equal((await fetch(base(s) + '/api/v1/auth/me')).status, 401);
  s.close();
});

test('POST /api/v1/auth/demo pose une session scopée à l’opérateur + permissions', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const r = await fetch(base(s) + '/api/v1/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'airtel' }) });
  assert.equal(r.status, 200);
  const cookie = cookieOf(r);
  assert.ok(cookie.startsWith('sumo_sess='));
  const me = await (await fetch(base(s) + '/api/v1/auth/me', { headers: { Cookie: cookie } })).json();
  assert.equal(me.user.role, 'OPERATEUR');
  assert.equal(me.user.operatorId, 'airtel');
  assert.ok(Array.isArray(me.user.permissions.modules));
  s.close();
});

test('POST /api/v1/auth/login : bon mot de passe accepté, mauvais rejeté', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const ok = await fetch(base(s) + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin-systeme', password: users.DEMO_PASSWORD }) });
  assert.equal(ok.status, 200);
  const bad = await fetch(base(s) + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin-systeme', password: 'mauvais' }) });
  assert.equal(bad.status, 401);
  s.close();
});

test('Accès démo désactivé (prod) → 403', async () => {
  const s = await listen(createApp({ demoLogin: false, serveStatic: false }));
  const r = await fetch(base(s) + '/api/v1/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'se' }) });
  assert.equal(r.status, 403);
  const acc = await (await fetch(base(s) + '/api/v1/auth/accounts')).json();
  assert.equal(acc.demoLogin, false);
  assert.equal(acc.accounts.length, 0);
  s.close();
});

test('GET /api/v1/ledger exige une session', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  assert.equal((await fetch(base(s) + '/api/v1/ledger')).status, 401);
  s.close();
});

test('Le registre est cloisonné sur l’opérateur connecté', async () => {
  ledger.append(model.buildTDR(externalInput({ senderOperatorId: 'airtel', amount: 1000 })));
  ledger.append(model.buildTDR(externalInput({ senderOperatorId: 'moov', amount: 2000, senderMsisdn: '+241062111111' })));
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const login = await fetch(base(s) + '/api/v1/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'airtel' }) });
  const cookie = cookieOf(login);
  const led = await (await fetch(base(s) + '/api/v1/ledger?limit=500', { headers: { Cookie: cookie } })).json();
  assert.ok(led.records.length >= 1);
  assert.ok(led.records.every((rec) => rec.payload.operator.id === 'airtel' || rec.payload.receiverOperator.id === 'airtel'));
  s.close();
});

test('Le Secrétaire Exécutif (supervision complète) voit tous les opérateurs', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const login = await fetch(base(s) + '/api/v1/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'se' }) });
  const led = await (await fetch(base(s) + '/api/v1/ledger?limit=500', { headers: { Cookie: cookieOf(login) } })).json();
  const opIds = new Set(led.records.map((r) => r.payload.operator.id));
  assert.ok(opIds.size >= 2);
  s.close();
});
