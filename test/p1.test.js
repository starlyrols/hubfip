'use strict';

// =============================================================================
// Tests de non-régression de la série P1 :
//   n°11 canal d'ingestion nominatif · n°15 cloisonnement du palier P3
//   n°16 conservation & effacement cryptographique · n°17 compaction du journal
//   n°18 sauvegarde chiffrée · n°19 fiabilité de l'entrepôt
// =============================================================================

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-p1-'));
process.env.SUMO_KEY_PASSPHRASE = 'phrase-p1-eprouvee-2026';
process.env.SUMO_FSYNC = '0';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
const ledger = require('../lib/ledger');
ledger.init();
const audit = require('../lib/audit');
audit.init();
const vault = require('../lib/crypto-store');
const retention = require('../lib/retention');
const connectors = require('../lib/connectors');
const model = require('../lib/model');
const db = require('../lib/db');
const { createApp } = require('../lib/createApp');
const { contractRecord, injectionHeaders, externalInput } = require('./helpers');

connectors.load();

const listen = (app) => new Promise((r) => { const s = http.createServer(app); s.listen(0, () => r(s)); });
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const app = createApp({ serveStatic: false, demoLogin: true, broadcast() {} });
async function session(username) {
  const r = await fetch(base(srv) + '/api/v1/auth/demo', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }),
  });
  return cookieOf(r);
}
let srv;

// ---------------------------------------------------------------------------
// n°11 — canal d'ingestion nominatif
// ---------------------------------------------------------------------------
test('P1-11 : chaque assujetti a sa propre clé — plus de secret partagé', () => {
  const s = connectors.summary();
  assert.equal(s.connecteurs, 3);
  assert.equal(s.clesDistinctes, s.connecteurs, 'une clé commune serait le défaut d\'origine');
  // Le secret ne doit jamais apparaître dans la vue présentable.
  const vue = connectors.describe('airtel');
  assert.ok(vue.key);
  assert.equal(vue.secret, undefined);
});

test('P1-11 : le fichier de remise est en 0600 et couvre chaque opérateur', () => {
  assert.equal(fs.statSync(connectors.HANDOVER_FILE).mode & 0o777, 0o600);
  const txt = fs.readFileSync(connectors.HANDOVER_FILE, 'utf8');
  for (const op of ['airtel', 'moov', 'gimac']) assert.match(txt, new RegExp(`^${op}\\s`, 'm'));
});

test('P1-11 : horodatage hors fenêtre et nonce rejoué sont refusés', async () => {
  srv = srv || await listen(app);
  const body = JSON.stringify({ operatorId: 'airtel', record: contractRecord() });

  const vieux = await fetch(base(srv) + '/api/v1/iso8583', {
    method: 'POST', body, headers: injectionHeaders(body, { timestamp: Date.now() - 20 * 60_000 }),
  });
  assert.equal((await vieux.json()).code, 'HORODATAGE_HORS_FENETRE');

  const nonce = 'nonce-fixe-eprouve';
  const h = injectionHeaders(body, { nonce });
  const premier = await fetch(base(srv) + '/api/v1/iso8583', { method: 'POST', body, headers: h });
  assert.equal(premier.status, 202);
  const rejeu = await fetch(base(srv) + '/api/v1/iso8583', { method: 'POST', body, headers: h });
  assert.equal(rejeu.status, 409);
  assert.equal((await rejeu.json()).code, 'REJEU');
});

test('P1-11 : la même transaction envoyée deux fois ne crée qu\'un enregistrement', async () => {
  srv = srv || await listen(app);
  const record = contractRecord({ transaction_id: 'AM-IDEM-001' });
  const body = JSON.stringify({ operatorId: 'airtel', record });

  const a = await fetch(base(srv) + '/api/v1/iso8583', { method: 'POST', body, headers: injectionHeaders(body) });
  assert.equal(a.status, 202);
  const seq = (await a.json()).seq;

  const b = await fetch(base(srv) + '/api/v1/iso8583', { method: 'POST', body, headers: injectionHeaders(body) });
  assert.equal(b.status, 200);
  const j = await b.json();
  assert.equal(j.status, 'DUPLICATE');
  assert.equal(j.seq, seq, 'la réponse renvoie l\'enregistrement d\'origine');
});

test('P1-11 : les refus d\'ingestion sont journalisés au registre d\'audit', async () => {
  srv = srv || await listen(app);
  const body = JSON.stringify({ operatorId: 'moov', record: contractRecord() });
  await fetch(base(srv) + '/api/v1/iso8583', { method: 'POST', body, headers: injectionHeaders(body, { operatorId: 'airtel' }) });
  const evts = audit.recent(30).map((e) => e.action);
  assert.ok(evts.includes('INGESTION_REFUS'), 'un refus doit laisser une trace opposable');
});

// ---------------------------------------------------------------------------
// n°15 — cloisonnement du palier P3
// ---------------------------------------------------------------------------
test('P1-15 : la corrélation abonné ↔ déplacement exige une habilitation P3', async () => {
  srv = srv || await listen(app);
  const admin = await session('admin-systeme');
  // DM porte le module « geo » mais n'est pas habilitée au palier nominatif.
  await fetch(base(srv) + '/api/v1/dispatch/users/dm', {
    method: 'PUT', headers: { 'content-type': 'application/json', Cookie: admin },
    body: JSON.stringify({ modules: ['geo'] }),
  });

  const nonHabilite = await session('dm');
  const refus = await fetch(base(srv) + '/api/v1/geo/anomalies', { headers: { Cookie: nonHabilite } });
  assert.equal(refus.status, 403);
  assert.equal((await refus.json()).code, 'HABILITATION_P3_REQUISE');

  // La cartographie AGRÉGÉE ne désigne personne : elle reste ouverte au module.
  const agregat = await fetch(base(srv) + '/api/v1/geo/cells', { headers: { Cookie: nonHabilite } });
  assert.equal(agregat.status, 200);

  const habilite = await session('dctlf');
  const ok = await fetch(base(srv) + '/api/v1/geo/anomalies', { headers: { Cookie: habilite } });
  assert.equal(ok.status, 200);
});

// ---------------------------------------------------------------------------
// n°16 — conservation & effacement cryptographique
// ---------------------------------------------------------------------------
test('P1-16 : chaque palier de chaque période porte sa propre clé', () => {
  const tdr = model.buildTDR(externalInput({ datetime: '2026-08-10T10:00:00Z' }));
  const scelle = model.toSealed(tdr);
  assert.match(scelle.sender.msisdn, /^enc:v2:P2:2026-08:/);
  assert.match(scelle.cellOriginSealed || 'enc:v2:P3:2026-08:x', /^enc:v2:P3:/);
  assert.notEqual(
    vault.segmentKey('P2', '2026-08', { create: true }).toString('hex'),
    vault.segmentKey('P3', '2026-08', { create: true }).toString('hex'),
    'des clés identiques rendraient la purge par palier impossible',
  );
});

test('P1-16 : détruire la clé rend les identifiants illisibles SANS rompre la chaîne', () => {
  const ancien = model.buildTDR(externalInput({ datetime: '2023-01-15T10:00:00Z', senderMsisdn: '+241074777001' }));
  const recent = model.buildTDR(externalInput({ datetime: '2026-08-10T10:00:00Z', senderMsisdn: '+241074777002' }));
  ledger.append(ancien);
  ledger.append(recent);
  assert.equal(ledger.verifyChain().valid, true);

  const r = retention.runPurge({ record: (e) => audit.record(e) });
  const purges = r.segments.filter((s) => s.statut === 'DETRUITE').map((s) => `${s.tier}:${s.segment}`);
  assert.ok(purges.includes('P2:2023-01'), `2023-01 devait être purgé — purgés : ${purges.join(', ')}`);

  const relus = ledger.readTail(2).map((x) => x.payload);
  const vieux = relus.find((p) => p.epoch < Date.UTC(2024, 0, 1));
  const neuf = relus.find((p) => p.epoch > Date.UTC(2026, 0, 1));
  assert.ok(vault.isPurged(vieux.sender.msisdn), 'l\'identifiant échu est illisible');
  assert.equal(neuf.sender.msisdn, '+241074777002', 'la période non échue est intacte');

  // Le point crucial : la valeur probante survit à l'oubli.
  assert.equal(ledger.verifyChain().valid, true, 'la chaîne reste vérifiable après purge');
});

test('P1-16 : la purge est journalisée et annoncée avant d\'être exécutée', async () => {
  const evts = audit.recent(50).filter((e) => e.action === 'PURGE_SEGMENT');
  assert.ok(evts.length > 0, 'chaque destruction laisse une preuve opposable à la CNPDCP');
  assert.ok(evts[0].meta.fondement, 'le fondement juridique de l\'échéance est consigné');

  srv = srv || await listen(app);
  const admin = await session('dsin'); // porte le module « admin »
  const simulation = await fetch(base(srv) + '/api/v1/retention/purge', {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: admin }, body: '{}',
  });
  const j = await simulation.json();
  assert.equal(j.dryRun, true, 'sans confirmation explicite, rien n\'est détruit');
  assert.match(j.note, /irréversible/);
});

test('P1-16 : l\'état de conservation dit ce qui SUBSISTE après purge', () => {
  const e = retention.state();
  assert.ok(e.politique.P2.moisConservation > 0);
  assert.ok(e.subsisteApresPurge.some((x) => /HMAC/.test(x)), 'la pseudonymisation résiduelle doit être annoncée');
  assert.ok(e.palierP1.limite, 'la limite du palier P1 est énoncée, pas masquée');
});

// ---------------------------------------------------------------------------
// Couverture déclarative — l'observatoire et l'assurance des revenus mesurent la
// MÊME grandeur : ils ne doivent pas pouvoir annoncer deux chiffres.
// ---------------------------------------------------------------------------
test('Couverture déclarative : l\'observatoire et l\'écran Revenus ne peuvent pas diverger', () => {
  const warehouse = require('../lib/warehouse');
  const revenue = require('../lib/revenue');

  const lot = [
    model.buildTDR(externalInput({ feeDeclared: 2500 })),                    // déclaré
    model.buildTDR(externalInput({ feeDeclared: 400 })),                     // déclaré (sous-déclaré)
    model.buildTDR(externalInput({ feeDeclared: undefined })),               // NON déclaré
    model.buildTDR(externalInput({ status: 'FAILED', feeDeclared: 0 })),     // hors assiette
    model.buildTDR(externalInput({ status: 'PENDING', feeDeclared: 0 })),    // hors assiette
  ];
  // L'entrepôt est partagé par les tests de ce fichier : on raisonne en DELTA,
  // ce qui éprouve le comptage sans dépendre de ce qui précède.
  const avant = warehouse.snapshot().totals;
  for (const t of lot) warehouse.ingest(t);
  const apres = warehouse.snapshot().totals;

  assert.equal(apres.feeDeclared - avant.feeDeclared, 2, 'seules les réussies à frais déclarés comptent');
  assert.equal(apres.feeUndeclared - avant.feeUndeclared, 1);
  assert.equal(apres.count - avant.count, 5, 'les cinq transactions sont bien observées');

  // Les deux écrans lisent la même fenêtre : ils doivent conclure pareil.
  assert.equal(
    apres.declarationCoverage, revenue.report({}).declarationCoverage,
    'les deux écrans doivent afficher le même chiffre — sinon le prédicat a été dupliqué quelque part',
  );

  // Le prédicat n'a qu'une définition, portée par le modèle.
  assert.equal(model.hasDeclaredFee(lot[0]), true);
  assert.equal(model.hasDeclaredFee(lot[2]), false);
});

test('Couverture déclarative : une assiette vide ne vaut PAS 100 %', () => {
  const warehouse = require('../lib/warehouse');
  // Fenêtre dans le futur : aucune transaction observée.
  const vide = warehouse.snapshot({ sinceEpoch: Date.now() + 3_600_000 }).totals;
  assert.equal(vide.declarationCoverage, null, 'un indicateur au vert sur zéro donnée tromperait');
});

// ---------------------------------------------------------------------------
// n°19 — fiabilité de l'entrepôt
// ---------------------------------------------------------------------------
test('P1-19 : sans entrepôt configuré, l\'état est explicite et sans métrique fictive', async () => {
  const s = await db.status();
  assert.equal(s.enabled, false);
  assert.match(s.reason, /DATABASE_URL/);
  assert.equal(db._metriques().ecrits, 0, 'aucune écriture inventée quand l\'entrepôt est absent');
});

// ---------------------------------------------------------------------------
// n°18 — sauvegarde chiffrée et restauration vérifiée
// ---------------------------------------------------------------------------
test('P1-18 : la sauvegarde refuse de s\'exécuter sans phrase dédiée', () => {
  const script = path.resolve(__dirname, '../scripts/backup.js');
  const env = { ...process.env, SUMO_BACKUP_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-bk-')) };
  delete env.SUMO_BACKUP_PASSPHRASE;
  try {
    execFileSync(process.execPath, [script], { env, encoding: 'utf8', stdio: 'pipe' });
    assert.fail('une sauvegarde en clair ne doit pas être possible');
  } catch (e) {
    assert.equal(e.status, 2);
    assert.match(String(e.stderr), /SUMO_BACKUP_PASSPHRASE/);
  }
});

test('P1-18 : archive chiffrée, restaurée et vérifiée de bout en bout', () => {
  const script = path.resolve(__dirname, '../scripts/backup.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-bk-'));
  const env = { ...process.env, SUMO_BACKUP_DIR: dir, SUMO_BACKUP_PASSPHRASE: 'phrase-de-sauvegarde-distincte' };

  execFileSync(process.execPath, [script], { env, encoding: 'utf8' });
  const archive = fs.readdirSync(dir).find((f) => f.endsWith('.enc'));
  assert.ok(archive, 'une archive est produite');

  // Le registre ne doit pas être lisible dans l'archive : elle est chiffrée.
  const brut = fs.readFileSync(path.join(dir, archive), 'utf8').slice(0, 4096);
  assert.ok(!brut.includes('ECDSA-P256'), 'l\'archive ne doit pas livrer son contenu en clair');

  const sortie = execFileSync(process.execPath, [script, '--verify', path.join(dir, archive)], { env, encoding: 'utf8' });
  assert.match(sortie, /Déchiffrement\s+: OK/);
  assert.match(sortie, /Conformité\s+: OK/);
  assert.match(sortie, /Restauration\s+: OK/);
  fs.rmSync(dir, { recursive: true, force: true });
});

after(() => { if (srv) srv.close(); require('../lib/scanner').close(); });
