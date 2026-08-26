'use strict';

// =============================================================================
// Correctifs C2 (clés protégées + ancrage externe), F1 (chiffrement au repos)
// et D1 (parcours du registre hors du fil principal).
// =============================================================================

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-socle-'));
process.env.SUMO_KEY_PASSPHRASE = 'phrase-secrete-eprouvee-2026';
process.env.SUMO_FSYNC = '0';               // volume de test : durabilité non éprouvée ici
process.env.SUMO_VERIFY_ON_START = '0';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
const vault = require('../lib/crypto-store');
const ledger = require('../lib/ledger');
const audit = require('../lib/audit');
const anchor = require('../lib/anchor');
const model = require('../lib/model');
const cases = require('../lib/cases');
const reporting = require('../lib/reporting');
const scanner = require('../lib/scanner');
const { externalInput } = require('./helpers');

ledger.init();
audit.init();

const SUJET = '+241074555001';
const contenuRegistre = () => fs.readFileSync(ledger.file, 'utf8');

// ---------------------------------------------------------------------------
// C2 — les clés privées ne sont plus lisibles sur le volume
// ---------------------------------------------------------------------------
test('C2 : la clé privée de signature est chiffrée au repos', () => {
  const pem = fs.readFileSync(path.join(process.env.SUMO_DATA_DIR, 'keys', 'ledger_private.pem'), 'utf8');
  assert.match(pem, /ENCRYPTED PRIVATE KEY/, 'une clé en clair permettrait de resigner un historique réécrit');
  assert.doesNotMatch(pem, /BEGIN PRIVATE KEY-/);
});

test('C2 : sans la phrase secrète, la clé est inexploitable', () => {
  const pem = fs.readFileSync(path.join(process.env.SUMO_DATA_DIR, 'keys', 'ledger_private.pem'), 'utf8');
  const crypto = require('node:crypto');
  // Sans phrase, OpenSSL refuse d'ouvrir la clé (le libellé exact varie selon la version).
  assert.throws(() => crypto.createPrivateKey(pem));
  assert.throws(() => crypto.createPrivateKey({ key: pem, passphrase: 'mauvaise-phrase-secrete' }));
  // Avec la bonne phrase, le coffre ouvre la clé — c'est le processus légitime.
  assert.ok(vault.importPrivateKey(pem, 'ledger_private.pem'));

  // Scénario réel du vol de volume : un autre processus, SANS la phrase secrète,
  // n'obtient rien du registre. Éprouvé dans un processus séparé, seul moyen de
  // reproduire une absence de variable d'environnement.
  const { execFileSync } = require('node:child_process');
  const script = `
    process.env.SUMO_DATA_DIR = ${JSON.stringify(process.env.SUMO_DATA_DIR)};
    delete process.env.SUMO_KEY_PASSPHRASE;
    try { require(${JSON.stringify(path.resolve(__dirname, '../lib/ledger'))}).openReadOnly(); console.log('OUVERT'); }
    catch (e) { console.log('REFUSE:' + e.message); }
  `;
  const sortie = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
  assert.match(sortie, /^REFUSE:/, `un volume dérobé ne doit rien livrer — reçu : ${sortie}`);
  assert.match(sortie, /phrase secrète/i);
});

test('C2 : la posture annonce le chiffrement réel, sans embellissement', () => {
  const s = vault.status();
  assert.equal(s.passphrase, true);
  assert.equal(s.clesPriveesChiffrees, true);
  // La limite résiduelle est ÉNONCÉE : la phrase vit en mémoire du processus.
  assert.match(s.limite, /HSM|mémoire du processus/);
});

// ---------------------------------------------------------------------------
// F1 — chiffrement au repos des identifiants (P2) et de la localisation (P3)
// ---------------------------------------------------------------------------
test('F1 : aucun identifiant nominatif n\'apparaît en clair dans le registre', () => {
  const tdr = model.buildTDR(externalInput({ senderMsisdn: SUJET, receiverMsisdn: '+241066555002', cityName: 'Libreville' }));
  ledger.append(tdr);
  const brut = contenuRegistre();
  for (const forme of [SUJET, SUJET.replace('+', ''), '+241066555002']) {
    assert.ok(!brut.includes(forme), `le numéro « ${forme} » ne doit pas figurer en clair`);
  }
  // Format v2 : le marqueur porte le PALIER et la PÉRIODE, ce qui rend
  // l'effacement cryptographique par échéance possible (correctif P1 n°16).
  assert.match(brut, /enc:v2:P2:\d{4}-\d{2}:/, 'les identifiants nominatifs sont scellés par clé de segment P2');
  assert.match(brut, /enc:v2:P3:\d{4}-\d{2}:/, 'la localisation précise est scellée par clé de segment P3');
  assert.ok(!/"lat":/.test(brut), 'la localisation précise (P3) est scellée elle aussi');
  // La granularité déjà publiée dans les statistiques reste lisible.
  assert.match(brut, /"province":/);
});

test('F1 : le descellement restitue l\'enregistrement, et l\'intégrité tient', () => {
  const relu = ledger.readTail(1)[0].payload;
  assert.equal(relu.sender.msisdn, SUJET);
  assert.equal(relu.cellOrigin.city, 'Libreville');
  assert.equal(relu.legs.reduce((s, l) => s + (l.direction === 'DEBIT' ? -l.amount : l.amount), 0), 0, 'partie double préservée');
  const v = ledger.verifyChain();
  assert.equal(v.valid, true, 'le hachage porte sur la forme scellée : vérifiable sans déchiffrer');
});

test('F1 : l\'adresse IP consignée au journal d\'audit est scellée', () => {
  audit.record({ action: 'TEST_IP', actor: 'dctlf', meta: { ip: '10.42.7.99' } });
  const brut = fs.readFileSync(path.join(process.env.SUMO_DATA_DIR, 'audit-log.jsonl'), 'utf8');
  assert.ok(!brut.includes('10.42.7.99'), 'l\'IP d\'un agent est une donnée personnelle');
  assert.equal(audit.recent(1)[0].meta.ip, '10.42.7.99', 'restituée à la lecture');
});

// ---------------------------------------------------------------------------
// C2 (volet ancrage) — la réécriture par un initié devient détectable
// ---------------------------------------------------------------------------
test('C2 : un reçu d\'ancrage détecte une réécriture que la chaîne seule ne voit pas', () => {
  for (let i = 0; i < 4; i++) ledger.append(model.buildTDR(externalInput({ amount: 5000 + i })));
  const recu = anchor.emit(ledger, { note: 'dépôt de contrôle' });
  assert.equal(anchor.verifyAgainst(ledger, recu).valid, true);

  // Un initié détenant la clé tronque l'historique puis rechaîne : la chaîne
  // redevient cohérente avec elle-même.
  ledger.close();
  const lignes = contenuRegistre().trim().split('\n');
  fs.writeFileSync(ledger.file, lignes.slice(0, 2).join('\n') + '\n');

  const verdict = anchor.verifyAgainst(ledger, recu);
  assert.equal(verdict.valid, false, 'le reçu déposé chez un tiers pince la réécriture');
  assert.match(verdict.reason, /tronqué|réécrit/);

  fs.writeFileSync(ledger.file, lignes.join('\n') + '\n'); // remise en état
  ledger.init();
});

// ---------------------------------------------------------------------------
// D1 — le parcours du registre ne gèle plus le serveur
// ---------------------------------------------------------------------------
test('D1 : un parcours complet ne bloque PAS la boucle d\'évènements', async () => {
  // Registre volumineux : avec l'ancienne lecture synchrone, le serveur entier
  // restait figé pendant toute la relecture.
  for (let i = 0; i < 6000; i++) {
    ledger.append(model.buildTDR(externalInput({ amount: 1000 + (i % 900), senderMsisdn: `+2410745${String(i % 1000).padStart(5, '0')}` })));
  }
  assert.ok(ledger.stats().total >= 6000);

  // On mesure le retard maximal d'un battement régulier PENDANT le parcours.
  let retardMax = 0;
  let dernier = Date.now();
  const battement = setInterval(() => {
    const maintenant = Date.now();
    retardMax = Math.max(retardMax, maintenant - dernier - 10);
    dernier = maintenant;
  }, 10);

  const t0 = Date.now();
  const rapport = await reporting.generate('observatoire', {});
  const duree = Date.now() - t0;
  clearInterval(battement);

  assert.ok(rapport.recordCount >= 6000, `le rapport porte bien sur tout le registre (${rapport.recordCount})`);
  assert.ok(retardMax < 250, `la boucle est restée réactive (retard max ${retardMax} ms sur un parcours de ${duree} ms)`);
  assert.equal(typeof rapport.scanStats.scannedRecords, 'number');
});

test('D1 : un rapport tronqué le DIT — il ne se présente pas comme exhaustif', async () => {
  const petit = { ...process.env };
  process.env.SUMO_REPORT_MAX_RECORDS = '50';
  delete require.cache[require.resolve('../lib/reporting')];
  const borne = require('../lib/reporting');
  const r = await borne.generate('observatoire', {});
  assert.equal(r.truncated, true);
  assert.equal(r.recordCount, 50);
  process.env.SUMO_REPORT_MAX_RECORDS = petit.SUMO_REPORT_MAX_RECORDS || '';
  delete require.cache[require.resolve('../lib/reporting')];
});

test('D1 : le traçage d\'un sujet est borné dans le temps (proportionnalité)', async () => {
  const chaine = await cases.traceChain(SUJET, { reveal: false });
  assert.ok(chaine.window, 'la fenêtre effective est renvoyée');
  assert.equal(chaine.window.days, cases.TRACE_DEFAULT_DAYS);
  assert.equal(chaine.scanStats.truncated, false);
  // La fenêtre demandée est plafonnée : on ne remonte pas indéfiniment.
  const large = await cases.traceChain(SUJET, { reveal: false, days: 99999 });
  assert.equal(large.window.days, cases.TRACE_MAX_DAYS);
});

test('D1 : la file de parcours est bornée — saturation refusée, jamais empilée', async () => {
  const trop = Array.from({ length: scanner.QUEUE_MAX + 6 }, (_, i) =>
    scanner.scan({ kind: 'period', file: ledger.file, from: i, to: Date.now(), limit: 10 }).catch((e) => e));
  const resultats = await Promise.all(trop);
  const refus = resultats.filter((r) => r instanceof Error && r.code === 'SCANNER_BUSY');
  assert.ok(refus.length > 0, 'au-delà de la file, la demande est refusée (503) plutôt qu\'accumulée');
});

after(() => scanner.close());
