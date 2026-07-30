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
const { DATA_DIR } = require('./store');

const KEYS_DIR = path.join(DATA_DIR, 'keys');
const GENESIS = '0'.repeat(64);
const ALG = 'ECDSA-P256-SHA256';
const MAX_RECENT = 1500;
const READ_CHUNK = 4 * 1024 * 1024;

// Parcourt le fichier JSONL ligne par ligne SANS le charger d'un bloc : un registre
// volumineux (> ~512 Mo) dépasse la taille maximale d'une chaîne V8 et ferait
// planter readFileSync(utf8). Le reliquat est conservé en Buffer pour ne pas
// couper un caractère UTF-8 multi-octets à la frontière de deux blocs.
function forEachLine(file, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    let rest = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, READ_CHUNK, null);
      if (n <= 0) break;
      const chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        if (nl === -1) break;
        if (nl > start) onLine(chunk.toString('utf8', start, nl));
        start = nl + 1;
      }
      rest = Buffer.from(chunk.subarray(start));
    }
    if (rest.length) onLine(rest.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

// Lit les `maxLines` dernières lignes en partant de la fin du fichier (lecture
// arrière par blocs) — évite de parcourir tout l'historique pour la fenêtre récente.
function readTailLines(file, maxLines) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    let newlines = 0;
    while (pos > 0 && newlines <= maxLines) {
      const len = Math.min(READ_CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      tail = Buffer.concat([buf, tail]);
      newlines = 0;
      for (let i = 0; i < tail.length; i++) if (tail[i] === 10) newlines++;
    }
    return tail.toString('utf8').split('\n').filter(Boolean).slice(-maxLines);
  } finally { fs.closeSync(fd); }
}

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
    // Comptage en flux, puis seuls les enregistrements de la fenêtre récente sont parsés.
    total = 0;
    forEachLine(LEDGER_FILE, () => { total++; });
    for (const line of readTailLines(LEDGER_FILE, MAX_RECENT)) {
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      seq = rec.seq; lastHash = rec.hash; pushRecent(rec);
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

  // Vérifie la chaîne. Sans option : parcours intégral depuis la genèse (en flux).
  // { limit: n } : vérification bornée aux n derniers enregistrements (ancrée sur le
  // prevHash du premier de la fenêtre) — pour les endpoints interrogés fréquemment,
  // où revérifier tout l'historique à chaque appel bloquerait l'event loop.
  function verifyChain({ limit = 0 } = {}) {
    if (!fs.existsSync(LEDGER_FILE)) return { valid: true, total: 0, checked: 0, brokenAt: null, scope: 'full' };
    const check = (rec, prev) => {
      const ph = contentHash(rec.payload);
      const anchor = prev === null ? rec.prevHash : prev;
      const h = recordHash(rec.seq, anchor, ph);
      return ph === rec.payloadHash && h === rec.hash && rec.prevHash === anchor && verifySig(h, rec.signature);
    };
    if (limit > 0) {
      let prev = null; let checked = 0;
      for (const line of readTailLines(LEDGER_FILE, limit)) {
        let rec; try { rec = JSON.parse(line); } catch { return { valid: false, total, checked, brokenAt: null, scope: 'recent' }; }
        if (!check(rec, prev)) return { valid: false, total, checked, brokenAt: rec.seq, scope: 'recent' };
        prev = rec.hash; checked++;
      }
      return { valid: true, total, checked, brokenAt: null, scope: 'recent' };
    }
    let prev = GENESIS; let n = 0; let broken = null;
    try {
      forEachLine(LEDGER_FILE, (line) => {
        if (broken !== null) return;
        const rec = JSON.parse(line);
        if (!check(rec, prev)) { broken = rec.seq; return; }
        prev = rec.hash; n++;
      });
    } catch { return { valid: false, total, checked: n, brokenAt: broken, scope: 'full' }; }
    if (broken !== null) return { valid: false, total, checked: n, brokenAt: broken, scope: 'full' };
    return { valid: true, total: n, checked: n, brokenAt: null, scope: 'full' };
  }

  // Relit tout le fichier (payloads) — pour la reconstruction d'agrégats / rapports
  // sur période arbitraire. Optionnellement filtré par prédicat.
  function readAll(filter) {
    if (!fs.existsSync(LEDGER_FILE)) return [];
    const out = [];
    forEachLine(LEDGER_FILE, (line) => {
      let rec; try { rec = JSON.parse(line); } catch { return; }
      if (!filter || filter(rec.payload)) out.push({ seq: rec.seq, hash: rec.hash, payload: rec.payload });
    });
    return out;
  }

  // Derniers `maxRecords` enregistrements lus depuis la fin du fichier (sans
  // parcourir tout l'historique) — pour le rejeu au démarrage.
  function readTail(maxRecords) {
    if (!fs.existsSync(LEDGER_FILE)) return [];
    const out = [];
    for (const line of readTailLines(LEDGER_FILE, maxRecords)) {
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      out.push({ seq: rec.seq, hash: rec.hash, payload: rec.payload });
    }
    return out;
  }

  const getRecent = (limit = 200) => recent.slice(-limit).reverse();
  const stats = () => ({ chain: name, total, lastHash, algorithm: ALG });
  const getPublicKeyPem = () => publicKeyPem;
  const signHashHex = (hashHex) => sign(hashHex);

  const api = { name, init, append, verifyChain, readAll, readTail, getRecent, stats, getPublicKeyPem, signHashHex };
  return api;
}

// Registre principal des TDR (lac de données souverain).
const tdr = createChain({ name: 'tdr', file: 'tdr-ledger.jsonl', privName: 'ledger_private.pem', pubName: 'ledger_public.pem' });

module.exports = Object.assign({ createChain, canonical, DATA_DIR, GENESIS }, tdr);
