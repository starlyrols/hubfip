'use strict';

// Dispatch des modules (admin système) : gating de l'API, effet immédiat des
// affectations/révocations sans re-login, expansion du module parent
// « monitoring », validations, journalisation d'audit, cloisonnement opérateur.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-dispatch-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

require('../lib/config').load();
const ledger = require('../lib/ledger');
ledger.init();
const audit = require('../lib/audit');
audit.init();
const model = require('../lib/model');
const { externalInput } = require('./helpers');
const { createApp } = require('../lib/createApp');

const app = createApp({ tlsEnabled: false, serveStatic: false, demoLogin: true, broadcast() {} });

let server; let base;
before(async () => { await new Promise((resolve) => { server = http.createServer(app).listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); }); });
after(() => server.close());

async function authCookie(username) {
  const r = await fetch(base + '/api/v1/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }) });
  assert.equal(r.status, 200, `login démo ${username}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const get = (p, cookie) => fetch(base + p, { headers: cookie ? { Cookie: cookie } : {} });
const put = (p, cookie, body) => fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });

test('GET /api/v1/dispatch/state : 401 sans session, 403 hors admin système, 200 pour admin-systeme', async () => {
  assert.equal((await get('/api/v1/dispatch/state')).status, 401);
  assert.equal((await get('/api/v1/dispatch/state', await authCookie('drh'))).status, 403);
  const r = await get('/api/v1/dispatch/state', await authCookie('admin-systeme'));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.modules[0].id, 'monitoring');
  // Littéral volontaire : comparer au registre rendrait le test tautologique et
  // laisserait passer tout ajout/retrait accidentel de module. 13 + 4 (M14).
  assert.equal(j.modules[0].children.length, require('../lib/modules').LEAF_MODULE_IDS.length);
  assert.equal(j.directions.length, 17);
  assert.ok(j.users.every((u) => u.username !== 'admin-systeme'), 'admin-systeme exclu des cibles');
  const dctlf = j.directions.find((d) => d.code === 'DCTLF');
  assert.ok(dctlf.modules.includes('antifraude'), 'défauts pré-remplis');
  assert.ok(dctlf.membres.some((m) => m.username === 'dctlf'), 'membres rattachés');
});

test('Dispatch → direction : effet immédiat sans re-login, puis révocation', async () => {
  const admin = await authCookie('admin-systeme');
  const drh = await authCookie('drh');

  // Défauts : DRH n'a que l'observatoire.
  assert.equal((await get('/api/v1/qos', drh)).status, 403);
  assert.equal((await get('/api/v1/stats', drh)).status, 200);

  // L'admin dispatche qos à la DRH → la MÊME session drh passe à 200 (calcul à chaud).
  const r1 = await put('/api/v1/dispatch/directions/DRH', admin, { modules: ['observatoire', 'qos'] });
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.deepEqual(j1.added, ['qos']);
  assert.equal((await get('/api/v1/qos', drh)).status, 200);

  // Révocation → 403 immédiat, toujours sans re-login.
  const r2 = await put('/api/v1/dispatch/directions/DRH', admin, { modules: ['observatoire'] });
  assert.deepEqual((await r2.json()).removed, ['qos']);
  assert.equal((await get('/api/v1/qos', drh)).status, 403);
});

test('Affectation individuelle : un agent gagne un module que sa direction n\'a pas', async () => {
  const admin = await authCookie('admin-systeme');
  const agdm = await authCookie('ag-dm');

  assert.equal((await get('/api/v1/qos', agdm)).status, 403); // DM n'a pas qos
  const r = await put('/api/v1/dispatch/users/ag-dm', admin, { modules: ['qos'] });
  assert.equal(r.status, 200);
  assert.equal((await get('/api/v1/qos', agdm)).status, 200);

  // L'union hérité (DM) + individuel est visible dans /auth/me.
  const me = await (await get('/api/v1/auth/me', agdm)).json();
  assert.ok(me.user.permissions.modules.includes('observatoire'), 'hérité de DM');
  assert.ok(me.user.permissions.modules.includes('qos'), 'individuel');

  await put('/api/v1/dispatch/users/ag-dm', admin, { modules: [] }); // nettoyage
  assert.equal((await get('/api/v1/qos', agdm)).status, 403);
});

test('Dispatcher « monitoring » (parent) = tous les sous-modules du registre, y compris admin/config', async () => {
  const admin = await authCookie('admin-systeme');
  const diai = await authCookie('diai');

  assert.equal((await get('/api/v1/config', diai)).status, 403);
  await put('/api/v1/dispatch/directions/DIAI', admin, { modules: ['monitoring'] });
  const me = await (await get('/api/v1/auth/me', diai)).json();
  assert.equal(me.user.permissions.modules.length, require('../lib/modules').LEAF_MODULE_IDS.length);
  assert.equal(me.user.permissions.canAdmin, true);
  assert.equal((await get('/api/v1/config', diai)).status, 200);

  await put('/api/v1/dispatch/directions/DIAI', admin, { modules: ['observatoire'] }); // retour aux défauts
});

test('Validations : module inconnu → 400, direction inconnue → 404, compte inconnu → 404, cible admin-systeme → 400', async () => {
  const admin = await authCookie('admin-systeme');
  assert.equal((await put('/api/v1/dispatch/directions/DRH', admin, { modules: ['inexistant'] })).status, 400);
  assert.equal((await put('/api/v1/dispatch/directions/DRH', admin, { modules: ['dispatch'] })).status, 400, 'dispatch non affectable');
  assert.equal((await put('/api/v1/dispatch/directions/DRH', admin, { modules: 'qos' })).status, 400, 'body non-tableau');
  assert.equal((await put('/api/v1/dispatch/directions/XXX', admin, { modules: [] })).status, 404);
  assert.equal((await put('/api/v1/dispatch/users/fantome', admin, { modules: [] })).status, 404);
  assert.equal((await put('/api/v1/dispatch/users/admin-systeme', admin, { modules: ['qos'] })).status, 400);
});

test('Un non-admin ne peut pas dispatcher (403), même directeur', async () => {
  const se = await authCookie('se');
  assert.equal((await put('/api/v1/dispatch/directions/DRH', se, { modules: ['monitoring'] })).status, 403);
});

test('Chaque dispatch est journalisé (audit chaîné) avec le diff added/removed', async () => {
  const admin = await authCookie('admin-systeme');
  await put('/api/v1/dispatch/directions/DDSU', admin, { modules: ['observatoire', 'geo'] });
  const events = audit.recent(50);
  const ev = events.find((e) => e.action === 'DISPATCH_DIRECTION' && e.target === 'DDSU');
  assert.ok(ev, 'évènement DISPATCH_DIRECTION présent');
  assert.equal(ev.actor, 'admin-systeme');
  assert.deepEqual(ev.meta.added, ['geo']);
  assert.equal(audit.verify().valid, true, 'chaîne d\'audit intacte');
});

test('Opérateur : défauts individuels actifs et cloisonnement operatorId intact', async () => {
  ledger.append(model.buildTDR(externalInput({ senderOperatorId: 'airtel', amount: 1000 })));
  ledger.append(model.buildTDR(externalInput({ senderOperatorId: 'moov', amount: 2000, senderMsisdn: '+241062111111' })));
  const airtel = await authCookie('airtel');

  assert.equal((await get('/api/v1/qos', airtel)).status, 200, 'défaut individuel opérateur');
  assert.equal((await get('/api/v1/fraud/rules', airtel)).status, 403, 'antifraude non affecté');
  const led = await (await get('/api/v1/ledger?limit=500', airtel)).json();
  assert.ok(led.records.length >= 1);
  assert.ok(led.records.every((rec) => rec.payload.operator.id === 'airtel' || rec.payload.receiverOperator.id === 'airtel'), 'scope airtel');

  // L'admin peut aussi réviser le périmètre individuel d'un opérateur.
  const admin = await authCookie('admin-systeme');
  const r = await put('/api/v1/dispatch/users/airtel', admin, { modules: ['observatoire', 'registre'] });
  assert.equal(r.status, 200);
  assert.equal((await get('/api/v1/qos', airtel)).status, 403, 'révocation opérateur effective');
});

test('Un profil sans aucun module affecté reçoit une liste vide (et 403 partout)', async () => {
  const admin = await authCookie('admin-systeme');
  await put('/api/v1/dispatch/directions/DRRRS', admin, { modules: [] });
  const drrrs = await authCookie('drrrs');
  const me = await (await get('/api/v1/auth/me', drrrs)).json();
  assert.deepEqual(me.user.permissions.modules, []);
  assert.equal((await get('/api/v1/stats', drrrs)).status, 403);
});
