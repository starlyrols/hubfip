'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isolation du registre pour les tests (avant require de ledger).
process.env.HUBFIP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hubfip-auth-'));

const ledger = require('../lib/ledger');
ledger.init();
const model = require('../lib/model');
const users = require('../lib/users');
const { createApp } = require('../lib/createApp');

function listen(app) {
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('GET /api/v1/auth/accounts expose le catalogue de démo (mode démo)', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const j = await (await fetch(base(s) + '/api/v1/auth/accounts')).json();
  assert.equal(j.demoLogin, true);
  const ids = j.accounts.map((a) => a.username);
  assert.ok(ids.includes('regulateur'));
  assert.ok(ids.includes('admin'));
  assert.ok(ids.includes('auditeur'));
  assert.ok(ids.includes('bgfi'));   // banque
  assert.ok(ids.includes('airtel')); // momo
  assert.ok(ids.includes('gimac'));  // passerelle
  // Aucun hachage de mot de passe ne doit fuiter.
  assert.ok(j.accounts.every((a) => a.passwordHash === undefined));
  s.close();
});

test('GET /api/v1/auth/me sans session → 401', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const r = await fetch(base(s) + '/api/v1/auth/me');
  assert.equal(r.status, 401);
  s.close();
});

test('POST /api/v1/auth/demo pose une session scopée à l’opérateur', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const r = await fetch(base(s) + '/api/v1/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bgfi' }) });
  assert.equal(r.status, 200);
  const cookie = cookieOf(r);
  assert.ok(cookie.startsWith('hubfip_sess='));
  const me = await (await fetch(base(s) + '/api/v1/auth/me', { headers: { Cookie: cookie } })).json();
  assert.equal(me.user.role, 'OPERATEUR');
  assert.equal(me.user.operatorId, 'bgfi');
  s.close();
});

test('POST /api/v1/auth/login : bon mot de passe accepté, mauvais rejeté', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const ok = await fetch(base(s) + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: users.DEMO_PASSWORD }) });
  assert.equal(ok.status, 200);
  const bad = await fetch(base(s) + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'mauvais' }) });
  assert.equal(bad.status, 401);
  s.close();
});

test('Accès démo désactivé (prod) → 403', async () => {
  const s = await listen(createApp({ demoLogin: false, serveStatic: false }));
  const r = await fetch(base(s) + '/api/v1/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'regulateur' }) });
  assert.equal(r.status, 403);
  const acc = await (await fetch(base(s) + '/api/v1/auth/accounts')).json();
  assert.equal(acc.demoLogin, false);
  assert.equal(acc.accounts.length, 0);
  s.close();
});

test('GET /api/v1/ledger exige une session', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const r = await fetch(base(s) + '/api/v1/ledger');
  assert.equal(r.status, 401);
  s.close();
});

test('Le registre est filtré sur l’opérateur connecté', async () => {
  // Seed : une transaction par opérateur distinct.
  ledger.append(model.buildTransaction({ operatorId: 'bgfi', amount: 1000, source: 'EXTERNAL' }));
  ledger.append(model.buildTransaction({ operatorId: 'airtel', amount: 2000, source: 'EXTERNAL' }));

  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const login = await fetch(base(s) + '/api/v1/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bgfi' }) });
  const cookie = cookieOf(login);

  const led = await (await fetch(base(s) + '/api/v1/ledger?limit=500', { headers: { Cookie: cookie } })).json();
  assert.ok(led.records.length >= 1);
  assert.ok(led.records.every((rec) => rec.payload.operator.id === 'bgfi'));
  s.close();
});

test('Le régulateur voit tous les opérateurs', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const login = await fetch(base(s) + '/api/v1/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'regulateur' }) });
  const cookie = cookieOf(login);
  const led = await (await fetch(base(s) + '/api/v1/ledger?limit=500', { headers: { Cookie: cookie } })).json();
  const opIds = new Set(led.records.map((r) => r.payload.operator.id));
  assert.ok(opIds.size >= 2); // bgfi + airtel seedés précédemment
  s.close();
});
