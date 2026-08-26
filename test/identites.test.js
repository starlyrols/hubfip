'use strict';

// =============================================================================
// Correctif B3 — identités individuelles. Éprouve le MODE PRODUCTION : c'est là
// que les contraintes s'appliquent (secret aléatoire par compte, changement au
// premier accès, verrouillage, second facteur des profils habilités).
// =============================================================================

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-id-'));
process.env.NODE_ENV = 'production';        // désactive le mode démonstration
process.env.SUMO_LOGIN_LOCK_MS = '2000';    // verrou court, pour pouvoir l'observer

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
require('../lib/audit').init();
const users = require('../lib/users');
const credentials = require('../lib/credentials');
const totp = require('../lib/totp');
const { createApp } = require('../lib/createApp');

users.ensureCredentials();

const motsDePasseInitiaux = (() => {
  const txt = fs.readFileSync(credentials.HANDOVER_FILE, 'utf8');
  const map = new Map();
  for (const l of txt.split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+)$/);
    if (m && !l.startsWith('#')) map.set(m[1], m[2]);
  }
  return map;
})();

const listen = (app) => new Promise((r) => { const s = http.createServer(app); s.listen(0, () => r(s)); });
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('B3 : chaque compte porte un secret DISTINCT — plus de hachage partagé', () => {
  const s = credentials.summary();
  assert.equal(s.comptes, users.count());
  assert.equal(s.secretsDistincts, s.comptes, 'un secret unique pour tous serait le défaut d\'origine');
  assert.equal(s.changementRequis, s.comptes, 'tous les comptes doivent changer leur secret initial');
});

test('B3 : le mot de passe de démonstration n\'ouvre plus aucun compte', () => {
  for (const compte of ['pcr', 'se', 'dctlf', 'admin-systeme', 'airtel']) {
    assert.equal(users.authenticate(compte, 'Arcep@2026').error, 'INVALIDE', `compte ${compte}`);
  }
});

test('B3 : un mot de passe initial n\'ouvre que SON compte', () => {
  const mdpDctlf = motsDePasseInitiaux.get('dctlf');
  assert.ok(mdpDctlf, 'le fichier de remise contient le secret initial');
  assert.ok(users.authenticate('dctlf', mdpDctlf).user, 'ouvre son compte');
  assert.equal(users.authenticate('dj', mdpDctlf).error, 'INVALIDE', 'et aucun autre');
});

test('B3 : le fichier de remise est en 0600 et couvre tous les comptes', () => {
  const mode = fs.statSync(credentials.HANDOVER_FILE).mode & 0o777;
  assert.equal(mode, 0o600, 'lisible du seul propriétaire');
  assert.equal(motsDePasseInitiaux.size, users.count());
});

test('B3 : l\'accès aux modules est SUSPENDU tant que le secret initial n\'est pas changé', async () => {
  const s = await listen(createApp({ demoLogin: false, serveStatic: false }));
  const mdp = motsDePasseInitiaux.get('dfc');

  const login = await fetch(base(s) + '/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'dfc', password: mdp }),
  });
  assert.equal(login.status, 200, 'la connexion réussit…');
  const cookie = cookieOf(login);

  const bloque = await fetch(base(s) + '/api/v1/revenue', { headers: { Cookie: cookie } });
  assert.equal(bloque.status, 403, '…mais aucun module n\'est accessible');
  assert.equal((await bloque.json()).code, 'CHANGEMENT_REQUIS');

  // Un secret faible est refusé.
  const faible = await fetch(base(s) + '/api/v1/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ current: mdp, next: 'court' }),
  });
  assert.equal(faible.status, 400);
  assert.match((await faible.json()).error, /trop court/);

  // Le changement lève la contrainte IMMÉDIATEMENT, sans reconnexion.
  const ok = await fetch(base(s) + '/api/v1/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ current: mdp, next: 'Redevances#2026!Gab' }),
  });
  assert.equal(ok.status, 200);
  const libre = await fetch(base(s) + '/api/v1/revenue', { headers: { Cookie: cookie } });
  assert.equal(libre.status, 200, 'le module s\'ouvre sans reconnexion');
  s.close();
});

test('B3 : la politique refuse les secrets manifestement faibles', () => {
  const refus = ['court', 'motdepasse00', 'Arcep@2026', 'dctlf-motdepasse-1'];
  for (const p of refus) assert.throws(() => credentials.checkPolicy(p, 'dctlf'), new RegExp('.'), `« ${p} » devrait être refusé`);
  assert.ok(credentials.checkPolicy('Supervision#2026!Ga', 'dctlf'));
});

test('B3 : le compte se verrouille après des échecs répétés (anti-force brute)', async () => {
  for (let i = 0; i < credentials.MAX_FAILED - 1; i++) {
    assert.equal(users.authenticate('drh', 'faux-mot-de-passe').error, 'INVALIDE');
  }
  assert.equal(users.authenticate('drh', 'faux-mot-de-passe').error, 'VERROUILLE', 'le N-ième échec verrouille');
  // Et le BON mot de passe est refusé tant que le verrou court.
  assert.equal(users.authenticate('drh', motsDePasseInitiaux.get('drh')).error, 'VERROUILLE');
  await new Promise((r) => setTimeout(r, 2100));
  assert.ok(users.authenticate('drh', motsDePasseInitiaux.get('drh')).user, 'le verrou expire');
});

test('B3 : les profils habilités à la révélation exigent un second facteur', async () => {
  // DCTLF est habilité (révélation MSISDN, traçage) → TOTP obligatoire.
  assert.equal(credentials.describe('dctlf').requiresTotp, true);
  // DRH ne l'est pas.
  assert.equal(credentials.describe('drh').requiresTotp, false);

  const s = await listen(createApp({ demoLogin: false, serveStatic: false }));
  const mdp = motsDePasseInitiaux.get('dctlf');
  const login = await fetch(base(s) + '/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'dctlf', password: mdp }),
  });
  const cookie = cookieOf(login);

  // Tant que le second facteur n'est pas enrôlé, l'accès reste suspendu.
  await fetch(base(s) + '/api/v1/auth/password', {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ current: mdp, next: 'Antifraude#2026!Ga' }),
  });
  const encoreBloque = await fetch(base(s) + '/api/v1/fraud/alerts', { headers: { Cookie: cookie } });
  assert.equal(encoreBloque.status, 403);
  assert.equal((await encoreBloque.json()).code, 'TOTP_ENROLEMENT_REQUIS');

  // Enrôlement puis activation.
  const enroll = await (await fetch(base(s) + '/api/v1/auth/totp/enroll', { method: 'POST', headers: { Cookie: cookie } })).json();
  assert.match(enroll.uri, /^otpauth:\/\/totp\//);
  const activate = await (await fetch(base(s) + '/api/v1/auth/totp/activate', {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: totp.current(enroll.secret) }),
  })).json();
  assert.equal(activate.recoveryCodes.length, 8, 'des codes de secours à usage unique sont remis');

  const ouvert = await fetch(base(s) + '/api/v1/fraud/alerts', { headers: { Cookie: cookie } });
  assert.equal(ouvert.status, 200, 'l\'accès s\'ouvre une fois le second facteur actif');

  // Désormais, la connexion EXIGE le code.
  const sansCode = await fetch(base(s) + '/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'dctlf', password: 'Antifraude#2026!Ga' }),
  });
  assert.equal(sansCode.status, 401);
  assert.equal((await sansCode.json()).code, 'TOTP_REQUIS');

  const avecCode = await fetch(base(s) + '/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'dctlf', password: 'Antifraude#2026!Ga', otp: totp.current(enroll.secret) }),
  });
  assert.equal(avecCode.status, 200);

  // Un code de secours fonctionne une fois, et une seule.
  const secours = activate.recoveryCodes[0];
  assert.ok(users.authenticate('dctlf', 'Antifraude#2026!Ga', secours).user, 'code de secours accepté');
  assert.equal(users.authenticate('dctlf', 'Antifraude#2026!Ga', secours).error, 'TOTP_INVALIDE', 'et consommé');
  s.close();
});

test('B3 : l\'accès démo « un clic » est refusé en production', async () => {
  const s = await listen(createApp({ demoLogin: false, serveStatic: false }));
  const r = await fetch(base(s) + '/api/v1/auth/demo', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'pcr' }),
  });
  assert.equal(r.status, 403);
  s.close();
});

after(() => require('../lib/scanner').close());
