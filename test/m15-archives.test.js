'use strict';

// =============================================================================
// M15 — versement électronique des pièces et archivage scellé.
// Éprouve ce que le processus « intégralement numérique » doit garantir :
// le document entre au guichet haché et imputé, l'archive d'un dossier clos est
// scellée, vérifiable, et refuse de mentir (pièce altérée → refus de servir).
// =============================================================================

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-arch-'));
process.env.SUMO_KEY_PASSPHRASE = 'phrase-archives-eprouvee-2026';
process.env.SUMO_FSYNC = '0';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
require('../lib/ledger').init();
require('../lib/audit').init();
const archives = require('../lib/archives');
archives.init();
const wf = require('../lib/workflow');
wf.load();
const { createApp } = require('../lib/createApp');

const OPERATEUR = { username: 'airtel', role: 'OPERATEUR', operatorId: 'airtel', displayName: 'Airtel Gabon' };
const AUTRE_OP = { username: 'moov', role: 'OPERATEUR', operatorId: 'moov', displayName: 'Moov' };
const DM = { username: 'dm', role: 'DIRECTEUR', direction: 'DM' };
const SE = { username: 'se', role: 'SE', direction: 'SE' };
const DJ = { username: 'dj', role: 'DIRECTEUR', direction: 'DJ' };
const DFC = { username: 'dfc', role: 'DIRECTEUR', direction: 'DFC' };

const pdf = (texte) => Buffer.from('%PDF-1.4\n' + texte).toString('base64');

function nouveauDossier() {
  return wf.deposer(
    { typeId: 'TARIF', objet: 'Test pièces & archives — grille tarifaire', demandeur: { categorie: 'OPERATEUR', nom: 'Airtel Gabon', operatorId: 'airtel' } },
    'airtel',
  );
}

// ---------------------------------------------------------------------------
// Versement
// ---------------------------------------------------------------------------
test('pièces : le demandeur verse un document — haché, imputé, tracé', () => {
  const d = nouveauDossier();
  const contenu = pdf('Grille tarifaire proposée');
  const r = wf.verserPiece(d.id, { nom: 'Grille tarifaire proposée.pdf', mime: 'application/pdf', base64: contenu }, OPERATEUR);

  assert.equal(r.piece.sha256, crypto.createHash('sha256').update(Buffer.from(contenu, 'base64')).digest('hex'));
  assert.equal(r.piece.versePar, 'airtel');
  assert.equal(r.piece.categorie, 'DEMANDEUR');
  assert.ok(r.dossier.suivi.some((s) => s.action === 'VERSEMENT_PIECE'), 'le versement est une ligne de suivi');

  // La vue publique porte la pièce, empreinte comprise.
  const pub = wf.toPublicDossier(wf.get(d.id), OPERATEUR);
  assert.equal(pub.piecesFournies.length, 1);
  assert.equal(pub.piecesFournies[0].sha256, r.piece.sha256);
});

test('pièces : la direction pilote verse une pièce d\'instruction, un tiers est refusé', () => {
  const d = nouveauDossier();
  const r = wf.verserPiece(d.id, { nom: 'Rapport de contrôle DM.pdf', mime: 'application/pdf', base64: pdf('constat') }, DM);
  assert.equal(r.piece.categorie, 'INSTRUCTION');

  // Un AUTRE opérateur ne voit même pas le dossier (RG-16) : « introuvable ».
  assert.throws(() => wf.verserPiece(d.id, { nom: 'intrusion.pdf', mime: 'application/pdf', base64: pdf('x') }, AUTRE_OP), /introuvable/);
});

test('pièces : format hors liste et pièce trop volumineuse sont refusés', () => {
  const d = nouveauDossier();
  assert.throws(() => wf.verserPiece(d.id, { nom: 'script.html', mime: 'text/html', base64: pdf('x') }, OPERATEUR), /Format non admis/);
  const gros = Buffer.alloc(wf.PIECE_MAX_OCTETS + 1, 65).toString('base64');
  assert.throws(() => wf.verserPiece(d.id, { nom: 'trop-gros.pdf', mime: 'application/pdf', base64: gros }, OPERATEUR), /volumineuse/);
});

test('pièces : une altération sur disque est DÉTECTÉE et le fichier refusé', () => {
  const d = nouveauDossier();
  const r = wf.verserPiece(d.id, { nom: 'Preuve.pdf', mime: 'application/pdf', base64: pdf('original') }, OPERATEUR);

  const lu = wf.lirePiece(d.id, r.piece.id, OPERATEUR);
  assert.equal(lu.contenu.toString().includes('original'), true, 'restitution intègre');

  // Falsification directe du fichier, comme le ferait un accès disque.
  const chemin = path.join(process.env.SUMO_DATA_DIR, 'pieces', d.id, r.piece.id);
  fs.writeFileSync(chemin, '%PDF-1.4\nfalsifié');
  assert.throws(() => wf.lirePiece(d.id, r.piece.id, OPERATEUR), /ALTÉRATION DÉTECTÉE/);
});

// ---------------------------------------------------------------------------
// Archivage électronique
// ---------------------------------------------------------------------------
test('archives : la clôture scelle un instantané complet, vérifiable et unique', () => {
  const d = nouveauDossier();
  wf.verserPiece(d.id, { nom: 'Grille.pdf', mime: 'application/pdf', base64: pdf('grille') }, OPERATEUR);

  // Parcours complet jusqu'à la clôture.
  wf.executer(d.id, 'COMPLETUDE_OK', {}, DM);
  wf.executer(d.id, 'QUALIFIER', {}, SE);
  wf.executer(d.id, 'TRANSMETTRE_AVIS', { rapport: 'RAS' }, DM);
  wf.executer(d.id, 'RENDRE_AVIS', { sens: 'FAVORABLE' }, DJ);
  wf.executer(d.id, 'RENDRE_AVIS', { sens: 'FAVORABLE' }, DFC);
  wf.executer(d.id, 'VISER', {}, DM);
  const fini = wf.executer(d.id, 'DECIDER_SE', { sens: 'ADOPTE', motivation: 'Approuvé' }, SE);

  assert.equal(fini.statut, 'CLOS');
  assert.ok(fini.suivi.some((s) => s.action === 'ARCHIVE_SCELLEE'), 'le scellement figure au suivi du dossier');
  assert.equal(archives.isArchived(fini.numero), true);

  // L'archive porte TOUT : suivi intégral, décision, empreintes des pièces.
  const a = archives.get(fini.numero);
  assert.equal(a.payload.statutFinal, 'CLOS');
  assert.equal(a.payload.decision.sens, 'ADOPTE');
  assert.equal(a.payload.pieces.length, 1);
  assert.match(a.payload.pieces[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(a.payload.suivi.length >= 12, 'suivi intégral, pas une fenêtre');
  assert.ok(a.publicKeyPem.includes('PUBLIC KEY'), 'la clé publique accompagne l\'archive');

  // Le registre des archives se vérifie comme les autres chaînes.
  const v = archives.verify();
  assert.equal(v.valid, true);

  // Unicité : archiver deux fois ne crée pas de doublon.
  const total = archives.stats().total;
  assert.equal(archives.seal(wf.get(d.id), 'x'), null);
  assert.equal(archives.stats().total, total);
});

test('archives : un retrait s\'archive aussi — toute fin de vie laisse une archive', () => {
  const d = nouveauDossier();
  const retire = wf.executer(d.id, 'RETIRER', {}, OPERATEUR);
  assert.equal(retire.statut, 'RETIRE');
  assert.equal(archives.isArchived(retire.numero), true);
  assert.equal(archives.get(retire.numero).payload.statutFinal, 'RETIRE');
});

// ---------------------------------------------------------------------------
// Par l'API — dont le plafond dédié aux pièces (au-delà des 64 Ko généraux)
// ---------------------------------------------------------------------------
test('API : versement d\'une pièce de 200 Ko, restitution intègre, archive servie', async () => {
  const app = createApp({ demoLogin: true, serveStatic: false });
  const srv = await new Promise((r) => { const s = http.createServer(app); s.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
  const AIRTEL = cookieOf(await fetch(base + '/api/v1/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'airtel' }) }));

  const depot = await (await fetch(base + '/api/v1/workflow/dossiers', {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: AIRTEL },
    body: JSON.stringify({ typeId: 'TARIF', objet: 'API — pièce volumineuse et archive' }),
  })).json();
  const num = depot.dossier.numero;

  // 200 Ko : impossible sous le plafond général de 64 Ko — la route dédiée doit passer.
  const gros = Buffer.alloc(200 * 1024, 66);
  const versement = await fetch(`${base}/api/v1/workflow/dossiers/${num}/pieces`, {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: AIRTEL },
    body: JSON.stringify({ nom: 'Plan d\'affaires.pdf', mime: 'application/pdf', base64: gros.toString('base64') }),
  });
  assert.equal(versement.status, 201);
  const { piece } = await versement.json();
  assert.equal(piece.octets, gros.length);

  const telecharge = await fetch(`${base}/api/v1/workflow/dossiers/${num}/pieces/${piece.id}`, { headers: { Cookie: AIRTEL } });
  assert.equal(telecharge.status, 200);
  assert.equal(telecharge.headers.get('x-content-sha256'), piece.sha256);
  assert.equal(Buffer.from(await telecharge.arrayBuffer()).length, gros.length);

  // Avant clôture : pas d'archive. Après retrait : archive servie avec sa clé.
  const avant = await fetch(`${base}/api/v1/workflow/dossiers/${num}/archive`, { headers: { Cookie: AIRTEL } });
  assert.equal(avant.status, 404);
  await fetch(`${base}/api/v1/workflow/dossiers/${num}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json', Cookie: AIRTEL },
    body: JSON.stringify({ action: 'RETIRER' }),
  });
  const apres = await (await fetch(`${base}/api/v1/workflow/dossiers/${num}/archive`, { headers: { Cookie: AIRTEL } })).json();
  assert.equal(apres.archive.payload.numero, num);
  assert.equal(apres.archive.payload.pieces[0].sha256, piece.sha256);

  const verif = await (await fetch(`${base}/api/v1/workflow/archives/verify`, { headers: { Cookie: AIRTEL } })).json();
  assert.equal(verif.valid, true);
  srv.close();
});

after(() => { require('../lib/scanner').close(); archives.close(); });
