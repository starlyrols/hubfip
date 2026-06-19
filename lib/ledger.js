'use strict';

// Registre RÉELLEMENT chaîné, signé et persistant (corrige LEDGER-1).
// - Persistance append-only sur disque (data/ledger.jsonl) -> survit au redémarrage.
// - Chaînage par hash SHA-256 (chaque enregistrement lie le hash précédent) -> infalsifiable a posteriori.
// - Signature ECDSA P-256 de chaque enregistrement -> non-répudiation vérifiable.
// NOTE : un vrai horodatage qualifié RFC 3161 exigerait une autorité d'horodatage (TSA)
// externe ; ce n'est PAS implémenté ici et n'est plus revendiqué dans l'UI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const DATA_DIR = process.env.HUBFIP_DATA_DIR || path.join(__dirname, '..', 'data');
const KEYS_DIR = path.join(DATA_DIR, 'keys');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.jsonl');
const GENESIS = '0'.repeat(64);
const ALG = 'ECDSA-P256-SHA256';
const MAX_RECENT = 1000;

let privateKey = null;
let publicKey = null;
let publicKeyPem = '';
let lastHash = GENESIS;
let seq = 0;
let total = 0;
const recent = [];

function ensureDirs() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
}

function loadOrCreateKeys() {
  const privPath = path.join(KEYS_DIR, 'ledger_private.pem');
  const pubPath = path.join(KEYS_DIR, 'ledger_public.pem');
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(privPath));
    publicKey = crypto.createPublicKey(fs.readFileSync(pubPath));
  } else {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
    fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
    logger.info('ledger.keys.generated', { curve: 'P-256' });
  }
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

// JSON canonique (clés triées récursivement) pour un hash déterministe.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const contentHash = (payload) => crypto.createHash('sha256').update(canonical(payload)).digest('hex');
const recordHash = (s, prev, ph) => crypto.createHash('sha256').update(`${s}|${prev}|${ph}`).digest('hex');
const sign = (hashHex) => crypto.sign('sha256', Buffer.from(hashHex, 'hex'), privateKey).toString('base64');
const verify = (hashHex, sigB64) => crypto.verify('sha256', Buffer.from(hashHex, 'hex'), publicKey, Buffer.from(sigB64, 'base64'));

function pushRecent(rec) {
  recent.push(rec);
  if (recent.length > MAX_RECENT) recent.shift();
}

function loadChain() {
  if (!fs.existsSync(LEDGER_FILE)) return;
  const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    seq = rec.seq;
    lastHash = rec.hash;
    total++;
    pushRecent(rec);
  }
  logger.info('ledger.loaded', { total, lastHash: lastHash.slice(0, 12) });
}

function init() {
  ensureDirs();
  loadOrCreateKeys();
  loadChain();
}

// Ajoute une transaction au registre (append-only) et renvoie l'enregistrement scellé.
function append(payload) {
  seq += 1;
  const ts = new Date().toISOString();
  const prevHash = lastHash;
  const payloadHash = contentHash(payload);
  const hash = recordHash(seq, prevHash, payloadHash);
  const signature = sign(hash);
  const rec = { seq, ts, alg: ALG, prevHash, payloadHash, hash, signature, payload };
  fs.appendFileSync(LEDGER_FILE, JSON.stringify(rec) + '\n');
  lastHash = hash;
  total += 1;
  pushRecent(rec);
  return rec;
}

// Vérifie l'intégrité complète de la chaîne (relit le fichier).
function verifyChain() {
  if (!fs.existsSync(LEDGER_FILE)) return { valid: true, total: 0, brokenAt: null };
  const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
  let prev = GENESIS;
  let n = 0;
  for (const line of lines) {
    const rec = JSON.parse(line);
    const ph = contentHash(rec.payload);
    const h = recordHash(rec.seq, prev, ph);
    if (ph !== rec.payloadHash || h !== rec.hash || rec.prevHash !== prev || !verify(h, rec.signature)) {
      return { valid: false, total: lines.length, brokenAt: rec.seq };
    }
    prev = rec.hash;
    n++;
  }
  return { valid: true, total: n, brokenAt: null };
}

const getRecent = (limit = 200) => recent.slice(-limit).reverse();
const stats = () => ({ total, lastHash, algorithm: ALG });
const getPublicKeyPem = () => publicKeyPem;

// Signe une empreinte hex avec la clé du registre (utilisé pour les exports signés).
const signHashHex = (hashHex) => sign(hashHex);

module.exports = { init, append, verifyChain, getRecent, stats, getPublicKeyPem, signHashHex, GENESIS, DATA_DIR };
