'use strict';

// =============================================================================
// Registre chaîné, signé et persistant — réutilisable (factory).
// - Persistance append-only sur disque (JSONL) → survit au redémarrage (lac de données brut).
// - Chaînage SHA-256 (chaque enregistrement lie le hash précédent) → infalsifiable a posteriori.
// - Signature ECDSA P-256 de chaque enregistrement → non-répudiation vérifiable.
// Deux instances : le registre des TDR (data lake souverain) et le JOURNAL D'AUDIT
// inviolable (cahier §2 #12) — mêmes garanties cryptographiques, fichiers/clés distincts.
//
// NOTE : un horodatage qualifié RFC 3161 exigerait une autorité d'horodatage (TSA)
// externe ; non implémenté ici et non revendiqué.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const DATA_DIR = process.env.SUMO_DATA_DIR || path.join(__dirname, '..', 'data');
const KEYS_DIR = path.join(DATA_DIR, 'keys');
const GENESIS = '0'.repeat(64);
const ALG = 'ECDSA-P256-SHA256';
const MAX_RECENT = 1500;

// JSON canonique (clés triées récursivement) → hash déterministe.
// IMPORTANT : traite `undefined` comme JSON.stringify (clés omises dans les objets,
// `null` dans les tableaux) afin que le hash calculé à l'écriture soit IDENTIQUE à
// celui recalculé après aller-retour JSON sur disque (sinon la chaîne casse).
function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function createChain({ name, file, privName, pubName }) {
  const LEDGER_FILE = path.join(DATA_DIR, file);
  const privPath = path.join(KEYS_DIR, privName);
  const pubPath = path.join(KEYS_DIR, pubName);

  let privateKey = null; let publicKey = null; let publicKeyPem = '';
  let lastHash = GENESIS; let seq = 0; let total = 0;
  const recent = [];

  function loadOrCreateKeys() {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
      privateKey = crypto.createPrivateKey(fs.readFileSync(privPath));
      publicKey = crypto.createPublicKey(fs.readFileSync(pubPath));
    } else {
      const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      privateKey = kp.privateKey; publicKey = kp.publicKey;
      fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
      logger.info('ledger.keys.generated', { chain: name, curve: 'P-256' });
    }
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  const contentHash = (payload) => crypto.createHash('sha256').update(canonical(payload)).digest('hex');
  const recordHash = (s, prev, ph) => crypto.createHash('sha256').update(`${s}|${prev}|${ph}`).digest('hex');
  const sign = (hashHex) => crypto.sign('sha256', Buffer.from(hashHex, 'hex'), privateKey).toString('base64');
  const verifySig = (hashHex, sigB64) => crypto.verify('sha256', Buffer.from(hashHex, 'hex'), publicKey, Buffer.from(sigB64, 'base64'));

  function pushRecent(rec) { recent.push(rec); if (recent.length > MAX_RECENT) recent.shift(); }

  function loadChain() {
    if (!fs.existsSync(LEDGER_FILE)) return;
    const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      seq = rec.seq; lastHash = rec.hash; total++; pushRecent(rec);
    }
    logger.info('ledger.loaded', { chain: name, total, lastHash: lastHash.slice(0, 12) });
  }

  function init() { loadOrCreateKeys(); loadChain(); return api; }

  function append(payload) {
    seq += 1;
    const ts = new Date().toISOString();
    const prevHash = lastHash;
    const payloadHash = contentHash(payload);
    const hash = recordHash(seq, prevHash, payloadHash);
    const signature = sign(hash);
    const rec = { seq, ts, alg: ALG, prevHash, payloadHash, hash, signature, payload };
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(rec) + '\n');
    lastHash = hash; total += 1; pushRecent(rec);
    return rec;
  }

  function verifyChain() {
    if (!fs.existsSync(LEDGER_FILE)) return { valid: true, total: 0, brokenAt: null };
    const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
    let prev = GENESIS; let n = 0;
    for (const line of lines) {
      const rec = JSON.parse(line);
      const ph = contentHash(rec.payload);
      const h = recordHash(rec.seq, prev, ph);
      if (ph !== rec.payloadHash || h !== rec.hash || rec.prevHash !== prev || !verifySig(h, rec.signature)) {
        return { valid: false, total: lines.length, brokenAt: rec.seq };
      }
      prev = rec.hash; n++;
    }
    return { valid: true, total: n, brokenAt: null };
  }

  // Relit tout le fichier (payloads) — pour la reconstruction d'agrégats / rapports
  // sur période arbitraire. Optionnellement filtré par prédicat.
  function readAll(filter) {
    if (!fs.existsSync(LEDGER_FILE)) return [];
    const out = [];
    for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
      if (!line) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (!filter || filter(rec.payload)) out.push({ seq: rec.seq, hash: rec.hash, payload: rec.payload });
    }
    return out;
  }

  const getRecent = (limit = 200) => recent.slice(-limit).reverse();
  const stats = () => ({ chain: name, total, lastHash, algorithm: ALG });
  const getPublicKeyPem = () => publicKeyPem;
  const signHashHex = (hashHex) => sign(hashHex);

  const api = { name, init, append, verifyChain, readAll, getRecent, stats, getPublicKeyPem, signHashHex };
  return api;
}

// Registre principal des TDR (lac de données souverain).
const tdr = createChain({ name: 'tdr', file: 'tdr-ledger.jsonl', privName: 'ledger_private.pem', pubName: 'ledger_public.pem' });

module.exports = Object.assign({ createChain, canonical, DATA_DIR, GENESIS }, tdr);
