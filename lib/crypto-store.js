'use strict';

// =============================================================================
// Socle cryptographique de la plateforme — protection des secrets AU REPOS.
//
// CORRECTIF C2 — les clés privées de signature étaient stockées en PKCS#8 EN
// CLAIR, dans le même volume que les registres qu'elles authentifient : un accès
// au système de fichiers (sauvegarde volée, instantané, échappement de conteneur)
// permettait de réécrire l'historique ET de le resigner. Elles sont désormais
// chiffrées par une PHRASE SECRÈTE qui vit HORS du volume de données.
//
// CORRECTIF F1 — l'AIPD engage un « chiffrement en transit et au repos ». Le
// chiffrement de volume (LUKS/dm-crypt) reste la mesure de déploiement ; ce module
// y ajoute une défense en profondeur applicative : les identifiants nominatifs
// (palier P2) et de localisation (P3) sont chiffrés CHAMP PAR CHAMP dans le
// registre (AES-256-GCM, clé de données enveloppée), de sorte qu'une copie du
// fichier ne livre aucun numéro.
//
// Modèle de clés (chiffrement d'enveloppe) :
//   phrase secrète (env, hors volume)
//        └─ dérive une clé maître (scrypt)
//              └─ chiffre la CLÉ DE DONNÉES (data/keys/data.key)
//                    └─ chiffre les champs P2/P3 du registre
//              └─ chiffre les CLÉS PRIVÉES de signature (PKCS#8 chiffré)
//
// Sans phrase secrète, le mode dégradé reste opérationnel (prototype, démo) mais
// il est ANNONCÉ comme tel dans la posture de sécurité — jamais présenté comme un
// chiffrement au repos.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const { DATA_DIR } = require('./store');

const KEYS_DIR = path.join(DATA_DIR, 'keys');
const DATA_KEY_FILE = path.join(KEYS_DIR, 'data.key');
const RING_FILE = path.join(KEYS_DIR, 'segments.json');
const SALT_FILE = path.join(KEYS_DIR, 'kdf.salt');

const ENC_PREFIX = 'enc:v1:';          // héritage : chiffré par la clé de données unique
const SEG_PREFIX = 'enc:v2:';          // chiffré par une clé de SEGMENT (effaçable)
// Marqueur laissé en place d'une valeur dont la clé a été détruite. Il vaut mieux
// dire « purgé » que renvoyer null : un champ vide se confond avec un champ jamais
// transmis, et la distinction est exactement ce que l'AIPD demande de tracer.
const PURGED = '[donnée purgée — clé de segment détruite]';
const ALG = 'aes-256-gcm';

let passphrase = null;   // phrase secrète effective (ou null → mode dégradé)
let masterKey = null;    // clé dérivée de la phrase (scrypt)
let dataKey = null;      // clé de chiffrement des champs (32 octets, héritage)
// Trousseau d'EFFACEMENT CRYPTOGRAPHIQUE (correctif P1 n°16). Un registre
// append-only ne peut pas oublier : supprimer une ligne romprait la chaîne, donc
// la valeur probante de tout ce qui suit. La parade est de chiffrer chaque
// palier de chaque période avec sa propre clé : DÉTRUIRE la clé rend les données
// définitivement illisibles sans toucher un seul octet du registre. La chaîne
// reste vérifiable, les reçus d'ancrage restent valables, et les statistiques du
// palier P1 — qui ne portent aucun identifiant — survivent à la purge.
let ring = null;         // { "P2:2026-08": {key, createdAt, destroyedAt} , ... }
let indexKey = null;     // clé HMAC des identifiants indexables (déterministe)
let loaded = false;

// ---------------------------------------------------------------------------
// Phrase secrète : variable d'environnement, ou fichier désigné par une variable
// (secret monté par l'orchestrateur — jamais dans le volume de données).
// ---------------------------------------------------------------------------
function readPassphrase() {
  if (process.env.SUMO_KEY_PASSPHRASE) return String(process.env.SUMO_KEY_PASSPHRASE);
  const file = process.env.SUMO_KEY_PASSPHRASE_FILE;
  if (file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) {
      throw new Error(`SUMO_KEY_PASSPHRASE_FILE illisible (${file}) : ${e.message}`);
    }
  }
  return null;
}

function salt() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  if (fs.existsSync(SALT_FILE)) return fs.readFileSync(SALT_FILE);
  const s = crypto.randomBytes(16);
  fs.writeFileSync(SALT_FILE, s, { mode: 0o600 });
  return s;
}

// ---------------------------------------------------------------------------
// Clé de données : générée au premier démarrage, ENVELOPPÉE par la clé maître si
// une phrase secrète est configurée. Sans phrase, elle est stockée telle quelle
// et le mode dégradé est journalisé à chaque démarrage.
// ---------------------------------------------------------------------------
function wrap(keyBuf) {
  if (!masterKey) return JSON.stringify({ wrapped: false, key: keyBuf.toString('base64') });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, masterKey, iv);
  const ct = Buffer.concat([c.update(keyBuf), c.final()]);
  return JSON.stringify({ wrapped: true, kdf: 'scrypt', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), key: ct.toString('base64') });
}

function unwrap(raw) {
  const o = JSON.parse(raw);
  if (!o.wrapped) {
    if (masterKey) throw new Error('La clé de données est en clair alors qu\'une phrase secrète est configurée : exécutez « npm run rewrap » pour l\'enveloppée.');
    return Buffer.from(o.key, 'base64');
  }
  if (!masterKey) throw new Error('Clé de données chiffrée mais aucune phrase secrète fournie (SUMO_KEY_PASSPHRASE / SUMO_KEY_PASSPHRASE_FILE).');
  const d = crypto.createDecipheriv(ALG, masterKey, Buffer.from(o.iv, 'base64'));
  d.setAuthTag(Buffer.from(o.tag, 'base64'));
  try { return Buffer.concat([d.update(Buffer.from(o.key, 'base64')), d.final()]); } catch {
    throw new Error('Phrase secrète invalide : la clé de données ne peut pas être déchiffrée.');
  }
}

function init() {
  if (loaded) return api;
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  passphrase = readPassphrase();
  if (passphrase) {
    if (passphrase.length < 12) throw new Error('SUMO_KEY_PASSPHRASE trop courte (12 caractères minimum).');
    masterKey = crypto.scryptSync(passphrase, salt(), 32);
  }

  if (fs.existsSync(DATA_KEY_FILE)) {
    dataKey = unwrap(fs.readFileSync(DATA_KEY_FILE, 'utf8'));
  } else {
    dataKey = crypto.randomBytes(32);
    fs.writeFileSync(DATA_KEY_FILE, wrap(dataKey), { mode: 0o600 });
    logger.info('cryptostore.datakey.generated', { wrapped: !!masterKey });
  }
  ring = loadRing();
  // Clé d'indexation dérivée (séparée du chiffrement) : sert à produire des
  // empreintes DÉTERMINISTES des numéros, seul moyen de retrouver les
  // transactions d'un sujet sans déchiffrer tout le registre.
  //
  // NOTE de conception : cette empreinte SURVIT à la purge, par nécessité — sans
  // elle on ne pourrait plus dédoublonner ni retrouver un sujet. Elle ne permet
  // pas de remonter au numéro (HMAC sous clé), mais elle reste un identifiant
  // stable : c'est une pseudonymisation, pas une anonymisation, et l'AIPD doit le
  // dire ainsi.
  indexKey = crypto.hkdfSync('sha256', dataKey, Buffer.from('sumo-index'), Buffer.from('subject-index-v1'), 32);
  indexKey = Buffer.from(indexKey);
  loaded = true;

  if (!masterKey) {
    logger.warn('cryptostore.degraded', {
      note: 'Aucune phrase secrète : la clé de données et les clés privées restent en clair sur le volume. Définissez SUMO_KEY_PASSPHRASE (ou SUMO_KEY_PASSPHRASE_FILE) pour un chiffrement au repos effectif.',
    });
  }
  return api;
}

const ensure = () => (loaded ? null : init());

// ---------------------------------------------------------------------------
// Trousseau de segments : une clé par (palier, période).
// ---------------------------------------------------------------------------
function loadRing() {
  try {
    if (!fs.existsSync(RING_FILE)) return { version: 1, keys: {} };
    return JSON.parse(fs.readFileSync(RING_FILE, 'utf8'));
  } catch (e) { logger.error('cryptostore.ring.read.failed', { error: e.message }); return { version: 1, keys: {} }; }
}

function persistRing() {
  try {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    fs.writeFileSync(RING_FILE, JSON.stringify(ring, null, 2), { mode: 0o600 });
  } catch (e) { logger.error('cryptostore.ring.persist.failed', { error: e.message }); }
}

// Période d'un horodatage — mensuelle : assez fin pour coller aux échéances de
// conservation, assez grossier pour que le trousseau reste lisible par un humain.
const segmentOf = (epoch) => new Date(epoch || Date.now()).toISOString().slice(0, 7);
const ringKey = (tier, segment) => `${tier}:${segment}`;

// Clé d'un segment. `create` distingue l'écriture (on crée au besoin) de la
// lecture (on ne ressuscite JAMAIS une clé détruite).
function segmentKey(tier, segment, { create = false } = {}) {
  ensure();
  const k = ringKey(tier, segment);
  const entree = ring.keys[k];
  if (entree && entree.destroyedAt) return null;         // purgé — définitif
  if (entree) return unwrap(entree.key);
  if (!create) return null;
  const brute = crypto.randomBytes(32);
  ring.keys[k] = { key: wrap(brute), createdAt: new Date().toISOString(), destroyedAt: null };
  persistRing();
  logger.info('cryptostore.segment.created', { tier, segment });
  return brute;
}

// DESTRUCTION — irréversible et voulue telle. C'est l'acte qui rend l'oubli
// possible sur un support qui, par construction, ne sait pas oublier.
function destroySegment(tier, segment) {
  ensure();
  const k = ringKey(tier, segment);
  const entree = ring.keys[k];
  if (!entree) return { tier, segment, statut: 'INEXISTANT' };
  if (entree.destroyedAt) return { tier, segment, statut: 'DEJA_DETRUITE', destroyedAt: entree.destroyedAt };
  entree.key = null;                                     // la matière disparaît
  entree.destroyedAt = new Date().toISOString();
  persistRing();
  logger.warn('cryptostore.segment.destroyed', { tier, segment, note: 'effacement cryptographique irréversible' });
  return { tier, segment, statut: 'DETRUITE', destroyedAt: entree.destroyedAt };
}

function ringState() {
  ensure();
  return Object.entries(ring.keys).map(([k, v]) => {
    const [tier, segment] = k.split(':');
    return { tier, segment, createdAt: v.createdAt, destroyedAt: v.destroyedAt, active: !v.destroyedAt };
  }).sort((a, b) => (a.segment === b.segment ? a.tier.localeCompare(b.tier) : a.segment.localeCompare(b.segment)));
}

// ---------------------------------------------------------------------------
// Chiffrement de champ (AES-256-GCM, IV aléatoire par valeur).
// ---------------------------------------------------------------------------
const chiffrer = (cle, texte) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, cle, iv);
  const ct = Buffer.concat([c.update(texte, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};

const dechiffrer = (cle, b64) => {
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv(ALG, cle, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
};

// `opts.tier` (P2 / P3) et `opts.epoch` désignent la clé de segment à employer.
// Sans palier, on retombe sur la clé de données unique (format hérité) — utile
// pour les champs qui ne relèvent d'aucune échéance de conservation.
function encryptField(value, opts = {}) {
  if (value === null || value === undefined || value === '') return value;
  ensure();
  const s = String(value);
  if (s.startsWith(ENC_PREFIX) || s.startsWith(SEG_PREFIX)) return s; // déjà scellé

  if (!opts.tier) return ENC_PREFIX + chiffrer(dataKey, s);
  const segment = segmentOf(opts.epoch);
  const cle = segmentKey(opts.tier, segment, { create: true });
  if (!cle) {
    // Écrire dans un segment déjà purgé produirait une donnée illisible dès sa
    // naissance. On refuse plutôt que de sceller du vide.
    throw new Error(`Segment ${opts.tier}:${segment} purgé : impossible d'y écrire.`);
  }
  return `${SEG_PREFIX}${opts.tier}:${segment}:${chiffrer(cle, s)}`;
}

function decryptField(value) {
  if (typeof value !== 'string') return value;
  ensure();

  if (value.startsWith(SEG_PREFIX)) {
    const reste = value.slice(SEG_PREFIX.length);
    const i1 = reste.indexOf(':');
    const i2 = reste.indexOf(':', i1 + 1);
    if (i1 < 0 || i2 < 0) return null;
    const tier = reste.slice(0, i1);
    const segment = reste.slice(i1 + 1, i2);
    const cle = segmentKey(tier, segment);
    if (!cle) return PURGED;   // clé détruite : l'oubli a bien eu lieu
    try { return dechiffrer(cle, reste.slice(i2 + 1)); } catch {
      logger.error('cryptostore.decrypt.failed', { tier, segment });
      return null;
    }
  }

  if (!value.startsWith(ENC_PREFIX)) return value; // héritage en clair
  try { return dechiffrer(dataKey, value.slice(ENC_PREFIX.length)); } catch {
    logger.error('cryptostore.decrypt.failed', { hint: 'clé de données différente de celle ayant scellé cet enregistrement' });
    return null;
  }
}

const isEncrypted = (v) => typeof v === 'string' && (v.startsWith(ENC_PREFIX) || v.startsWith(SEG_PREFIX));
const isPurged = (v) => v === PURGED;

// Empreinte déterministe d'un identifiant (indexation sans déchiffrement).
function indexOf(value) {
  if (!value) return null;
  ensure();
  return crypto.createHmac('sha256', indexKey).update(String(value)).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Clés privées de signature : PKCS#8 CHIFFRÉ quand une phrase secrète existe.
// Une clé héritée en clair est MIGRÉE au premier démarrage protégé.
// ---------------------------------------------------------------------------
function exportPrivateKey(key) {
  ensure();
  if (!passphrase) return key.export({ type: 'pkcs8', format: 'pem' });
  return key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase });
}

function importPrivateKey(pem, file) {
  ensure();
  const chiffree = String(pem).includes('ENCRYPTED PRIVATE KEY');
  if (chiffree && !passphrase) {
    throw new Error(`Clé privée chiffrée (${path.basename(file)}) mais aucune phrase secrète fournie : définissez SUMO_KEY_PASSPHRASE.`);
  }
  try {
    return crypto.createPrivateKey(chiffree ? { key: pem, passphrase } : pem);
  } catch (e) {
    throw new Error(`Clé privée ${path.basename(file)} illisible (phrase secrète incorrecte ?) : ${e.message}`);
  }
}

// Réécrit une clé privée en clair sous forme chiffrée (migration idempotente).
function protectPrivateKeyFile(file, key) {
  ensure();
  if (!passphrase) return false;
  const pem = fs.readFileSync(file, 'utf8');
  if (pem.includes('ENCRYPTED PRIVATE KEY')) return false;
  fs.writeFileSync(file, exportPrivateKey(key), { mode: 0o600 });
  logger.warn('cryptostore.key.protected', { file: path.basename(file), note: 'clé privée héritée chiffrée au repos' });
  return true;
}

// Posture affichée dans le module Sécurité — sans embellissement.
function status() {
  ensure();
  return {
    passphrase: !!passphrase,
    source: process.env.SUMO_KEY_PASSPHRASE ? 'variable d\'environnement' : (process.env.SUMO_KEY_PASSPHRASE_FILE ? 'fichier de secret monté' : null),
    clesPriveesChiffrees: !!passphrase,
    champsSensiblesChiffres: true,
    algorithme: 'AES-256-GCM (champs) · PKCS#8 AES-256-CBC (clés) · scrypt (dérivation)',
    limite: passphrase
      ? 'La phrase secrète est présente en mémoire du processus : un attaquant disposant d\'un accès root en cours d\'exécution reste hors périmètre. Un HSM/KMS souverain lèverait cette limite.'
      : 'MODE DÉGRADÉ : aucune phrase secrète — la clé de données et les clés privées sont lisibles par quiconque accède au volume. Ce n\'est PAS un chiffrement au repos.',
  };
}

const api = {
  init, status, encryptField, decryptField, isEncrypted, isPurged, indexOf,
  exportPrivateKey, importPrivateKey, protectPrivateKeyFile,
  segmentOf, segmentKey, destroySegment, ringState,
  ENC_PREFIX, SEG_PREFIX, PURGED, DATA_KEY_FILE, RING_FILE,
  hasPassphrase: () => { ensure(); return !!passphrase; },
};

module.exports = api;
