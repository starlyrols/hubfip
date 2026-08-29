'use strict';

// =============================================================================
// Sauvegarde CHIFFRÉE du volume de données, et vérification de restauration
// (correctif P1 n°18 — constat E5).
//
// Le constat était simple : aucune sauvegarde. Un incident disque effaçait le
// registre, le journal d'audit, les clés et les dossiers — c'est-à-dire toute la
// preuve. Et une sauvegarde en clair d'un registre qui contient des identifiants
// nominatifs déplacerait le problème plutôt que de le résoudre.
//
// L'archive est donc chiffrée (AES-256-GCM, clé dérivée par scrypt d'une phrase
// distincte de celle du service : l'exploitant du service et le détenteur des
// sauvegardes ne doivent pas être la même personne — séparation des rôles, P1 n°12).
// Un MANIFESTE accompagne l'archive : empreinte, inventaire, et racine de chaîne
// au moment de la copie, ce qui permet de prouver ce qui a été sauvegardé.
//
//   npm run backup                      → crée data-backup/<horodatage>.tar.gz.enc
//   npm run backup -- --verify <fichier>  → restaure en zone temporaire et vérifie
//
// La sauvegarde HORS SITE reste un acte d'exploitation : ce script produit un
// fichier chiffré, il ne le transporte pas.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.SUMO_DATA_DIR || path.join(__dirname, '..', 'data');
const OUT_DIR = process.env.SUMO_BACKUP_DIR || path.join(__dirname, '..', 'data-backup');
const ALG = 'aes-256-gcm';

function phrase() {
  const p = process.env.SUMO_BACKUP_PASSPHRASE
    || (process.env.SUMO_BACKUP_PASSPHRASE_FILE ? fs.readFileSync(process.env.SUMO_BACKUP_PASSPHRASE_FILE, 'utf8').trim() : null);
  if (!p) {
    console.error('REFUS : SUMO_BACKUP_PASSPHRASE (ou _FILE) est requis.');
    console.error('        Une sauvegarde en clair d\'un registre nominatif déplacerait le risque au lieu de le traiter.');
    console.error('        Employez une phrase DISTINCTE de SUMO_KEY_PASSPHRASE : le détenteur des sauvegardes');
    console.error('        et l\'exploitant du service ne doivent pas être la même personne.');
    process.exit(2);
  }
  if (p.length < 12) { console.error('REFUS : phrase de sauvegarde trop courte (12 caractères minimum).'); process.exit(2); }
  return p;
}

const inventaire = (dir) => {
  const out = [];
  (function parcourir(d, prefixe) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = prefixe ? `${prefixe}/${e.name}` : e.name;
      if (e.isDirectory()) parcourir(p, rel);
      else out.push({ fichier: rel, octets: fs.statSync(p).size });
    }
  }(dir, ''));
  return out.sort((a, b) => a.fichier.localeCompare(b.fichier));
};

// Racine du registre au moment de la copie : c'est elle qui permettra de dire,
// plus tard, CE QUI a été sauvegardé.
//
// Lue DIRECTEMENT dans le fichier, sans passer par le module de registre : le
// détenteur des sauvegardes n'a pas à connaître la phrase secrète du service
// (séparation des rôles), et prendre le verrou d'écrivain casserait le service en
// cours d'exécution.
function racineChaine() {
  const fichier = path.join(DATA_DIR, 'tdr-ledger.jsonl');
  try {
    if (!fs.existsSync(fichier)) return { total: 0, lastHash: null, note: 'registre absent' };
    const contenu = fs.readFileSync(fichier, 'utf8');
    const lignes = contenu.trimEnd().split('\n');
    const derniere = JSON.parse(lignes[lignes.length - 1]);
    return { total: lignes.length, seq: derniere.seq, lastHash: derniere.hash, algorithm: derniere.alg };
  } catch (e) { return { erreur: e.message }; }
}

function creer() {
  const secret = phrase();
  if (!fs.existsSync(DATA_DIR)) { console.error(`REFUS : répertoire de données introuvable (${DATA_DIR}).`); process.exit(2); }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const horodatage = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-backup-'));
  const tar = path.join(tmp, 'data.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', path.dirname(DATA_DIR), path.basename(DATA_DIR)]);

  const clair = fs.readFileSync(tar);
  const sel = crypto.randomBytes(16);
  const cle = crypto.scryptSync(secret, sel, 32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, cle, iv);
  const chiffre = Buffer.concat([c.update(clair), c.final()]);

  const sortie = path.join(OUT_DIR, `sumo-${horodatage}.tar.gz.enc`);
  // En-tête lisible : sel + IV + tag, puis le corps chiffré.
  fs.writeFileSync(sortie, Buffer.concat([sel, iv, c.getAuthTag(), chiffre]), { mode: 0o600 });

  const manifeste = {
    cree: new Date().toISOString(),
    source: DATA_DIR,
    archive: path.basename(sortie),
    octets: fs.statSync(sortie).size,
    empreinteClair: crypto.createHash('sha256').update(clair).digest('hex'),
    empreinteArchive: crypto.createHash('sha256').update(fs.readFileSync(sortie)).digest('hex'),
    chiffrement: 'AES-256-GCM · clé dérivée par scrypt',
    racineRegistre: racineChaine(),
    inventaire: inventaire(DATA_DIR),
  };
  const mf = sortie.replace(/\.enc$/, '.manifest.json');
  fs.writeFileSync(mf, JSON.stringify(manifeste, null, 2), { mode: 0o600 });
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('Sauvegarde SUMo');
  console.log('  Archive        :', sortie);
  console.log('  Manifeste      :', mf);
  console.log('  Taille         :', (manifeste.octets / 1048576).toFixed(1), 'Mo');
  console.log('  Fichiers       :', manifeste.inventaire.length);
  console.log('  Racine registre:', manifeste.racineRegistre.total, 'enregistrements ·', String(manifeste.racineRegistre.lastHash).slice(0, 16) + '…');
  console.log('');
  console.log('  À TRANSPORTER HORS SITE. Vérifiez la restauration :');
  console.log(`    npm run backup -- --verify ${sortie}`);
}

function verifier(fichier) {
  const secret = phrase();
  if (!fs.existsSync(fichier)) { console.error(`Archive introuvable : ${fichier}`); process.exit(2); }
  const mf = fichier.replace(/\.enc$/, '.manifest.json');
  const manifeste = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : null;

  const brut = fs.readFileSync(fichier);
  const sel = brut.subarray(0, 16);
  const iv = brut.subarray(16, 28);
  const tag = brut.subarray(28, 44);
  const cle = crypto.scryptSync(secret, sel, 32);
  const d = crypto.createDecipheriv(ALG, cle, iv);
  d.setAuthTag(tag);

  let clair;
  try { clair = Buffer.concat([d.update(brut.subarray(44)), d.final()]); } catch {
    console.error('ÉCHEC : déchiffrement impossible (phrase incorrecte, ou archive altérée).');
    process.exit(1);
  }

  const empreinte = crypto.createHash('sha256').update(clair).digest('hex');
  // Restauration RÉELLE en zone temporaire : une sauvegarde qu'on n'a jamais
  // restaurée n'est pas une sauvegarde, c'est une intention.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-restore-'));
  const tar = path.join(tmp, 'data.tar.gz');
  fs.writeFileSync(tar, clair);
  execFileSync('tar', ['-xzf', tar, '-C', tmp]);
  const restaure = path.join(tmp, path.basename(DATA_DIR));
  const fichiers = fs.existsSync(restaure) ? inventaire(restaure) : [];

  console.log('Vérification de restauration');
  console.log('  Archive        :', fichier);
  console.log('  Déchiffrement  : OK');
  console.log('  Empreinte      :', empreinte.slice(0, 32) + '…');
  if (manifeste) {
    const conforme = empreinte === manifeste.empreinteClair;
    console.log('  Conformité     :', conforme ? 'OK — identique au manifeste' : 'ÉCART AVEC LE MANIFESTE');
    console.log('  Fichiers       :', fichiers.length, '/', manifeste.inventaire.length, 'attendus');
    console.log('  Racine attendue:', manifeste.racineRegistre.total, 'enregistrements');
    if (!conforme) { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); }
  } else {
    console.log('  Manifeste      : absent — conformité non vérifiable');
  }
  console.log('  Restauration   : OK (' + fichiers.length + ' fichiers extraits)');
  fs.rmSync(tmp, { recursive: true, force: true });
}

const args = process.argv.slice(2);
const i = args.indexOf('--verify');
if (i >= 0) verifier(args[i + 1]); else creer();
