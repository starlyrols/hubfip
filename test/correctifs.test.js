'use strict';

// =============================================================================
// Tests de NON-RÉGRESSION des cinq correctifs critiques de l'audit du 24/08/2026.
// Chacun vérifie ce qui doit ÉCHOUER — c'est l'angle mort que l'audit signalait :
// la suite couvrait ce qui fonctionne, pas ce que le système doit refuser.
//   A1/A3 — contrat d'ingestion & assurance des revenus
//   A2    — aucune fabrication de valeur
//   B1/B2 — pseudonymisation non réversible & habilitation nominative
//   B4    — matrice statut × rôle appliquée côté serveur
//   C1/C3 — écrivain unique, continuité de séquence, portée de vérification
// =============================================================================

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-fix-'));

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
const ledger = require('../lib/ledger');
ledger.init();
require('../lib/audit').init();
const model = require('../lib/model');
const subjects = require('../lib/subjects');
const revenue = require('../lib/revenue');
const warehouse = require('../lib/warehouse');
const wf = require('../lib/workflow');
const { createApp } = require('../lib/createApp');
const { externalInput } = require('./helpers');

const listen = (app) => new Promise((resolve) => { const s = http.createServer(app); s.listen(0, () => resolve(s)); });
const base = (s) => `http://127.0.0.1:${s.address().port}`;
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
async function login(s, username) {
  const r = await fetch(base(s) + '/api/v1/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }) });
  return cookieOf(r);
}

// ---------------------------------------------------------------------------
// B1 — le jeton de sujet n'est plus dérivable d'un numéro connu
// ---------------------------------------------------------------------------
test('B1 : le jeton de sujet est un HMAC sous clé, pas un hash du MSISDN', () => {
  const msisdn = '+241074111111';
  const jeton = subjects.token(msisdn);
  const hashNu = crypto.createHash('sha256').update(msisdn).digest('hex').slice(0, 16);
  assert.notEqual(jeton, hashNu, 'un hash non clé serait pré-calculable sur tout le plan de numérotation');
  assert.equal(subjects.resolve(jeton), msisdn, 'le serveur, lui, doit savoir le résoudre');
  assert.equal(subjects.token(msisdn), jeton, 'jeton stable pour un même numéro');
  assert.notEqual(subjects.token('+241074111112'), jeton, 'numéros distincts → jetons distincts');
});

// ---------------------------------------------------------------------------
// B2 — le traçage d'un sujet exige l'habilitation nominative
// ---------------------------------------------------------------------------
test('B2 : sans habilitation nominative, le traçage d\'un sujet est refusé', async () => {
  const s = await listen(createApp({ demoLogin: true, serveStatic: false }));
  const jeton = subjects.token('+241074111111');

  // DM a le module « investigation » retiré par défaut ; on éprouve un profil qui
  // l'a bien (DCTLF est habilité, DRRRS ne l'est pas) — puis un profil habilité.
  const admin = await login(s, 'admin-systeme');
  await fetch(base(s) + '/api/v1/dispatch/users/drrrs', {
    method: 'PUT', headers: { 'content-type': 'application/json', Cookie: admin },
    body: JSON.stringify({ modules: ['investigation'] }),
  });

  const nonHabilite = await login(s, 'drrrs');
  const refus = await fetch(`${base(s)}/api/v1/trace?token=${jeton}`, { headers: { Cookie: nonHabilite } });
  assert.equal(refus.status, 403, 'le module « investigation » seul ne suffit plus');

  const habilite = await login(s, 'dctlf');
  const ok = await fetch(`${base(s)}/api/v1/trace?token=${jeton}`, { headers: { Cookie: habilite } });
  assert.ok([200, 404].includes(ok.status), `profil habilité : ${ok.status}`);
  s.close();
});

// ---------------------------------------------------------------------------
// A1/A2 — le contrat fait loi, et rien n'est fabriqué
// ---------------------------------------------------------------------------
test('A1 : un TDR externe sans horodatage déclaré est refusé', () => {
  const input = externalInput();
  delete input.datetime;
  assert.throws(() => model.buildTDR(input), /Horodatage/);
});

test('A2 : le simulateur peut synthétiser, le connecteur jamais', () => {
  const externe = model.buildTDR(externalInput({ latencyMs: undefined, cellOriginId: undefined, cityName: undefined }));
  assert.equal(externe.latencyMs, null);
  assert.equal(externe.provenance.latencyMs, 'INCONNU');
  assert.equal(externe.cellOrigin, null);
  assert.equal(externe.provenance.cellOrigin, 'INCONNU');

  const simule = model.buildTDR({ operatorId: 'airtel', type: 'P2P', amount: 1000, senderMsisdn: '+241074111111' });
  assert.equal(typeof simule.latencyMs, 'number');
  assert.equal(simule.provenance.latencyMs, 'SIMULE', 'une valeur synthétique doit se déclarer comme telle');
});

// ---------------------------------------------------------------------------
// A3 — l'assurance des revenus détecte enfin quelque chose sur du flux réel
// ---------------------------------------------------------------------------
test('A3 : une sous-déclaration de frais est détectée sur un TDR ingéré', () => {
  const complet = model.buildTDR(externalInput({ amount: 200000, feeDeclared: 2000 }));
  const attendu = complet.fee.expected;
  assert.ok(attendu > 0, 'le barème doit produire des frais attendus non nuls');

  const sousDeclare = model.buildTDR(externalInput({ amount: 200000, feeDeclared: Math.round(attendu / 3) }));
  const conforme = model.buildTDR(externalInput({ amount: 200000, feeDeclared: attendu }));

  assert.equal(revenue.isUnderReported(sousDeclare), true, 'écart au barème → sous-déclaration');
  assert.equal(revenue.isUnderReported(conforme), false);

  const agg = revenue.feeAggregates([sousDeclare, conforme]);
  const e = agg.get('airtel');
  assert.equal(e.declared, 2, 'les deux frais sont déclarés, donc confrontables');
  assert.equal(e.under, 1);
  assert.ok(e.expected - e.collected > 0, 'l\'écart alimente le manque à percevoir');
});

test('A3 : des frais NON déclarés restent hors assiette (jamais estimés)', () => {
  const sansFrais = model.buildTDR(externalInput({ amount: 200000, feeDeclared: undefined }));
  assert.equal(sansFrais.fee.amount, null);
  const e = revenue.feeAggregates([sansFrais]).get('airtel');
  assert.equal(e.undeclared, 1);
  assert.equal(e.collected, 0, 'aucune estimation ne vient combler la déclaration manquante');
});

// ---------------------------------------------------------------------------
// A4 — les états non dénoués ne polluent ni la QoS ni l'assiette
// ---------------------------------------------------------------------------
test('A4 : PENDING et REVERSED sortent du taux de succès et de l\'assiette', () => {
  const qos = require('../lib/qos');
  const list = ['SUCCESS', 'SUCCESS', 'FAILED', 'PENDING', 'REVERSED']
    .map((status) => model.buildTDR(externalInput({ status, latencyMs: 500 })));
  const agg = qos.aggregate(list);
  assert.equal(agg.settled, 3, 'seules SUCCESS + FAILED sont dénouées');
  assert.equal(agg.successRate, 0.6667, '2 succès sur 3 dénouées');
  assert.equal(agg.pending, 1);
  assert.equal(agg.reversed, 1);
  assert.equal(revenue.feeAggregates(list).get('airtel').n, 2, 'assiette = transactions réussies');
});

test('A2 : la latence non transmise n\'est pas comptée pour 0 ms', () => {
  const qos = require('../lib/qos');
  const avec = model.buildTDR(externalInput({ latencyMs: 1000 }));
  const sans = model.buildTDR(externalInput({ latencyMs: undefined }));
  const agg = qos.aggregate([avec, sans]);
  assert.equal(agg.latencySample, 1);
  assert.equal(agg.avgLatencyMs, 1000, 'la moyenne porte sur les seules mesures réelles');
  assert.equal(agg.latencyCoverage, 0.5, 'la couverture de mesure est exposée');
});

// ---------------------------------------------------------------------------
// B4 — la matrice statut × rôle est appliquée par le serveur
// ---------------------------------------------------------------------------
test('B4 : un opérateur ne peut pas prononcer la recevabilité de sa propre demande', () => {
  wf.load();
  const OPERATEUR = { username: 'airtel', role: 'OPERATEUR', operatorId: 'airtel', displayName: 'Airtel Gabon' };
  const d = wf.deposer(
    { typeId: 'TARIF', objet: 'Demande déposée par l\'assujetti lui-même', demandeur: { categorie: 'OPERATEUR', nom: 'Airtel Gabon', operatorId: 'airtel' } },
    'airtel',
  );
  assert.equal(d.statut, 'ENREGISTRE');
  assert.ok(wf.visible(d, OPERATEUR), 'le demandeur voit bien son dossier');
  assert.ok(!wf.allowedActions(d, OPERATEUR).includes('COMPLETUDE_OK'), 'et l\'interface ne le lui propose pas');

  // Le cœur du correctif : l'appel direct est refusé, pas seulement masqué.
  assert.throws(() => wf.executer(d.id, 'COMPLETUDE_OK', {}, OPERATEUR), /non autorisée pour votre profil/);
  assert.equal(wf.get(d.id).statut, 'ENREGISTRE', 'le dossier n\'a pas bougé');

  const SE = { username: 'se', role: 'SE', direction: 'SE' };
  wf.executer(d.id, 'COMPLETUDE_OK', {}, SE);
  assert.equal(wf.get(d.id).statut, 'RECEVABLE', 'le guichet, lui, y est habilité');
});

test('B4 : un opérateur ne peut pas classer sans suite le dossier d\'un tiers', () => {
  const AUTRE = { username: 'moov', role: 'OPERATEUR', operatorId: 'moov' };
  const d = wf.deposer(
    { typeId: 'TARIF', objet: 'Dossier d\'un autre assujetti', demandeur: { categorie: 'OPERATEUR', nom: 'Airtel Gabon', operatorId: 'airtel' } },
    'airtel',
  );
  assert.ok(!wf.visible(d, AUTRE), 'cloisonnement RG-16');
  assert.throws(() => wf.executer(d.id, 'CLASSER_SANS_SUITE', { motif: 'x' }, AUTRE), /Dossier introuvable/);
});

// ---------------------------------------------------------------------------
// C1/C3 — écrivain unique, continuité de séquence, portée annoncée
// ---------------------------------------------------------------------------
test('C1 : un second écrivain sur le même répertoire est refusé', () => {
  const script = `
    process.env.SUMO_DATA_DIR = ${JSON.stringify(process.env.SUMO_DATA_DIR)};
    try { require(${JSON.stringify(path.resolve(__dirname, '../lib/ledger'))}).init(); console.log('ACQUIS'); }
    catch (e) { console.log('REFUSE:' + e.message); }
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
  assert.match(out, /^REFUSE:/, `le second écrivain doit être refusé — reçu : ${out}`);
  assert.match(out, /déjà ouvert en écriture/);
});

test('C3 : une vérification bornée annonce sa portée et ne certifie pas l\'historique', () => {
  for (let i = 0; i < 5; i++) ledger.append(model.buildTDR(externalInput({ amount: 1000 + i })));
  const complete = ledger.verifyChain();
  assert.equal(complete.valid, true);
  assert.equal(complete.scope, 'full');
  assert.equal(complete.anchored, true, 'seul le parcours intégral est ancré à la genèse');

  const bornee = ledger.verifyChain({ limit: 3 });
  assert.equal(bornee.scope, 'recent');
  assert.equal(bornee.anchored, false);
  assert.match(bornee.note, /ne certifie PAS l'historique antérieur/);
});

test('C1 : une rupture de continuité de séquence est détectée', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-seq-'));
  const chain = ledger.createChain({ name: 'seq', file: 'seq.jsonl', privName: 'seq_priv.pem', pubName: 'seq_pub.pem' });
  const saved = process.env.SUMO_DATA_DIR;
  try {
    // La chaîne écrit dans le DATA_DIR courant : on éprouve la détection sur un
    // fichier volontairement amputé de son 2ᵉ enregistrement (doublon/trou de seq,
    // signature exacte de la corruption par écrivains concurrents).
    chain.init();
    for (let i = 0; i < 4; i++) chain.append({ i });
    chain.close();
    const file = path.join(process.env.SUMO_DATA_DIR, 'seq.jsonl');
    const lignes = fs.readFileSync(file, 'utf8').trim().split('\n');
    fs.writeFileSync(file, [lignes[0], lignes[2], lignes[3]].join('\n') + '\n');
    const v = chain.verifyChain();
    assert.equal(v.valid, false);
    assert.ok(['sequence', 'chainage'].includes(v.reason), `rupture attendue, reçu : ${v.reason}`);
  } finally {
    process.env.SUMO_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cloisonnement conservé (non-régression)
// ---------------------------------------------------------------------------
test('Non-régression : le cloisonnement opérateur reste appliqué', () => {
  const a = model.buildTDR(externalInput({ senderOperatorId: 'airtel' }));
  const m = model.buildTDR(externalInput({ senderOperatorId: 'moov', senderMsisdn: '+241062111111' }));
  assert.equal(warehouse.matchesOperator(a, 'airtel'), true);
  assert.equal(warehouse.matchesOperator(m, 'airtel'), false);
});

// Le fil de parcours du registre est arrêté à la fin de la suite.
after(() => require('../lib/scanner').close());
