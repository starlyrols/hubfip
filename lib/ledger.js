'use strict';

// =============================================================================
// Registre chaîné, signé et persistant — réutilisable (factory).
// - Persistance append-only sur disque (JSONL) → survit au redémarrage (lac de données brut).
// - Chaînage SHA-256 (chaque enregistrement lie le hash précédent) → infalsifiable a posteriori.
// - Signature ECDSA P-256 de chaque enregistrement → non-répudiation vérifiable.
// Deux instances : le registre des TDR (data lake souverain) et le JOURNAL D'AUDIT
// inviolable (cahier §2 #12) — mêmes garanties cryptographiques, fichiers/clés distincts.
//
// CORRECTIF C1 — ÉCRIVAIN UNIQUE. Chaque chaîne est protégée par un VERROU
// EXCLUSIF sur fichier. Deux processus partageant le même SUMO_DATA_DIR tenaient
// chacun leur propre compteur `seq` et leur propre `lastHash` en mémoire, et
// `appendFileSync` entrelaçait leurs écritures : le 8 août 2026, 4 187 numéros de
// séquence dupliqués ont rompu la chaîne sur 108 457 enregistrements. La parade
// était une convention (« un répertoire par instance ») ; c'est désormais un
// mécanisme — le second processus refuse de démarrer.
//
// CORRECTIF C4 — DURABILITÉ. Écriture sur descripteur persistant + fsync : une
// coupure ne peut plus laisser une ligne tronquée silencieusement ignorée au
// redémarrage (ce qui faisait repartir `seq` en arrière et réécrire par-dessus).
// Une ligne terminale illisible est détectée, tronquée et JOURNALISÉE.
//
// NOTE : un horodatage qualifié RFC 3161 exigerait une autorité d'horodatage (TSA)
// externe ; non implémenté ici et non revendiqué.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const { DATA_DIR } = require('./store');
const vault = require('./crypto-store');

const KEYS_DIR = path.join(DATA_DIR, 'keys');
const GENESIS = '0'.repeat(64);
const ALG = 'ECDSA-P256-SHA256';
const MAX_RECENT = 1500;
const READ_CHUNK = 4 * 1024 * 1024;
// fsync après chaque écriture : le coût (~1 ms) est négligeable devant la cadence
// du dispositif, et c'est ce qui distingue un registre probant d'un fichier de log.
// --- Durabilité (correctif P2 n°26, mesuré) ---------------------------------
// Le `fsync` par enregistrement s'est révélé, test de charge à l'appui, le
// goulot dominant du chemin d'écriture : 177 TDR/s avec, 456 sans — et une
// console qui s'effondre à 25 s de latence dans le premier cas. Un appel système
// bloquant par transaction ne tient pas à l'échelle d'un marché.
//
// La plateforme pratique donc une VALIDATION GROUPÉE : les enregistrements sont
// écrits immédiatement (l'ordre et le chaînage sont préservés), et la synchro-
// nisation disque est regroupée. La fenêtre de risque est explicite — au pire,
// les enregistrements des dernières `FSYNC_MS` millisecondes seraient perdus lors
// d'une COUPURE D'ALIMENTATION (un arrêt du processus, lui, force la synchro).
//
//   SUMO_FSYNC=strict  → synchronisation à chaque enregistrement (lent, maximal)
//   SUMO_FSYNC=0       → aucune synchronisation explicite (essais uniquement)
//   défaut             → groupée : toutes les FSYNC_EVERY écritures ou FSYNC_MS ms
const FSYNC_MODE = process.env.SUMO_FSYNC === '0' ? 'off'
  : (process.env.SUMO_FSYNC === 'strict' ? 'strict' : 'group');
const FSYNC_EVERY = Number(process.env.SUMO_FSYNC_EVERY) || 64;
const FSYNC_MS = Number(process.env.SUMO_FSYNC_MS) || 200;
// Nombre de signatures vérifiées en mode « échantillon » (contrôle au démarrage) :
// le chaînage est contrôlé intégralement — peu coûteux —, les signatures sur les
// derniers enregistrements plus un échantillon régulier de l'historique.
const SIGNATURE_SAMPLE = Number(process.env.SUMO_SIGNATURE_SAMPLE) || 500;

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

// `seal` / `unseal` : transformation appliquée au contenu AVANT écriture et APRÈS
// lecture. Le hachage et la signature portent sur la forme scellée — l'intégrité
// se vérifie donc sans détenir la clé de déchiffrement.
function createChain({ name, file, privName, pubName, seal, unseal }) {
  const LEDGER_FILE = path.join(DATA_DIR, file);
  const privPath = path.join(KEYS_DIR, privName);
  const pubPath = path.join(KEYS_DIR, pubName);

  const LOCK_FILE = LEDGER_FILE + '.lock';

  let privateKey = null; let publicKey = null; let publicKeyPem = '';
  let lastHash = GENESIS; let seq = 0; let total = 0;
  let writeFd = null;   // descripteur d'écriture persistant (append + fsync)
  let lockFd = null;    // verrou exclusif d'écrivain
  const recent = [];

  // --- Verrou d'écrivain unique (correctif C1) -----------------------------
  // `wx` échoue si le fichier existe déjà : c'est la primitive d'exclusion. Un
  // verrou dont le processus est mort est repris (redémarrage après crash), mais
  // JAMAIS un verrou dont le processus vit encore.
  function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  function acquireLock() {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        lockFd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, host: require('os').hostname(), chain: name, since: new Date().toISOString() }));
        try { fs.fsyncSync(lockFd); } catch { /* best effort */ }
        // Filet de sécurité : un `process.exit()` court-circuite l'arrêt propre
        // (c'est le cas des scripts en ligne de commande). Le verrou serait alors
        // laissé derrière — récupérable, puisque son PID est mort, mais salissant.
        process.once('exit', releaseLock);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let holder = {};
        try { holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { /* verrou illisible */ }
        if (pidAlive(holder.pid) && holder.pid !== process.pid) {
          throw new Error(
            `Registre « ${name} » déjà ouvert en écriture par le processus ${holder.pid} (${holder.host || 'hôte inconnu'}, depuis ${holder.since || 'date inconnue'}). `
            + 'Deux écrivains simultanés rompraient la chaîne : arrêtez l\'autre instance ou utilisez un SUMO_DATA_DIR distinct.',
          );
        }
        logger.warn('ledger.lock.stale', { chain: name, pid: holder.pid || null, action: 'reprise' });
        try { fs.unlinkSync(LOCK_FILE); } catch { /* course bénigne : nouvelle tentative */ }
      }
    }
    throw new Error(`Impossible d'acquérir le verrou du registre « ${name} ».`);
  }

  function releaseLock() {
    if (lockFd !== null) { try { fs.closeSync(lockFd); } catch { /* ignore */ } lockFd = null; }
    try {
      const holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (holder.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch { /* verrou déjà retiré */ }
  }

  function close() {
    syncNow(); // une fermeture propre ne perd jamais d'enregistrement
    if (writeFd !== null) { try { fs.closeSync(writeFd); } catch { /* ignore */ } writeFd = null; }
    releaseLock();
  }

  // Correctif C2 : la clé privée est écrite en PKCS#8 CHIFFRÉ dès qu'une phrase
  // secrète est configurée, et une clé héritée en clair est migrée au démarrage.
  function loadOrCreateKeys() {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    vault.init();
    if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
      privateKey = vault.importPrivateKey(fs.readFileSync(privPath, 'utf8'), privPath);
      publicKey = crypto.createPublicKey(fs.readFileSync(pubPath));
      vault.protectPrivateKeyFile(privPath, privateKey); // migration idempotente
    } else {
      const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      privateKey = kp.privateKey; publicKey = kp.publicKey;
      fs.writeFileSync(privPath, vault.exportPrivateKey(privateKey), { mode: 0o600 });
      fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
      logger.info('ledger.keys.generated', { chain: name, curve: 'P-256', chiffree: vault.hasPassphrase() });
    }
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  const contentHash = (payload) => crypto.createHash('sha256').update(canonical(payload)).digest('hex');
  const recordHash = (s, prev, ph) => crypto.createHash('sha256').update(`${s}|${prev}|${ph}`).digest('hex');
  const sign = (hashHex) => crypto.sign('sha256', Buffer.from(hashHex, 'hex'), privateKey).toString('base64');
  const verifySig = (hashHex, sigB64) => crypto.verify('sha256', Buffer.from(hashHex, 'hex'), publicKey, Buffer.from(sigB64, 'base64'));

  function pushRecent(rec) { recent.push(rec); if (recent.length > MAX_RECENT) recent.shift(); }

  // --- Validation groupée -----------------------------------------------------
  let depuisSync = 0;
  let syncTimer = null;

  function syncNow() {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    depuisSync = 0;
    if (FSYNC_MODE === 'off' || writeFd === null) return;
    try { fs.fsyncSync(writeFd); } catch (e) { logger.error('ledger.fsync.failed', { chain: name, error: e.message }); }
  }

  function scheduleSync() {
    if (FSYNC_MODE === 'off') return;
    if (FSYNC_MODE === 'strict') { syncNow(); return; }
    depuisSync++;
    if (depuisSync >= FSYNC_EVERY) { syncNow(); return; }
    if (!syncTimer) {
      syncTimer = setTimeout(syncNow, FSYNC_MS);
      syncTimer.unref(); // ne retient jamais le processus
    }
  }

  // Une écriture interrompue (coupure d'alimentation) laisse une ligne terminale
  // tronquée. Correctif C4 : elle est DÉTECTÉE et le fichier est tronqué à la
  // dernière frontière saine — au lieu d'être ignorée, ce qui faisait repartir le
  // compteur `seq` en arrière et réécrire par-dessus des enregistrements valides.
  function repairTornTail() {
    const size = fs.statSync(LEDGER_FILE).size;
    if (!size) return 0;
    const lines = readTailLines(LEDGER_FILE, 2);
    if (!lines.length) return 0;
    const last = lines[lines.length - 1];
    let ok = true;
    try { JSON.parse(last); } catch { ok = false; }
    const endsWithNewline = (() => {
      const fd = fs.openSync(LEDGER_FILE, 'r');
      try { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); return b[0] === 10; } finally { fs.closeSync(fd); }
    })();
    if (ok && endsWithNewline) return 0;
    const cut = size - Buffer.byteLength(last, 'utf8') - (endsWithNewline ? 1 : 0);
    fs.truncateSync(LEDGER_FILE, Math.max(0, cut));
    logger.error('ledger.torn-tail.repaired', { chain: name, bytesDropped: size - Math.max(0, cut), reason: ok ? 'ligne non terminée' : 'ligne illisible' });
    return 1;
  }

  function loadChain() {
    if (!fs.existsSync(LEDGER_FILE)) return;
    repairTornTail();
    // Comptage en flux, puis seuls les enregistrements de la fenêtre récente sont parsés.
    total = 0;
    forEachLine(LEDGER_FILE, () => { total++; });
    for (const line of readTailLines(LEDGER_FILE, MAX_RECENT)) {
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      seq = rec.seq; lastHash = rec.hash; pushRecent(rec);
    }
    logger.info('ledger.loaded', { chain: name, total, lastHash: lastHash.slice(0, 12) });
  }

  function init() {
    loadOrCreateKeys();
    acquireLock();       // avant toute écriture : un seul écrivain par chaîne
    loadChain();
    writeFd = fs.openSync(LEDGER_FILE, 'a');
    return api;
  }

  // Ouverture LECTURE SEULE : charge les clés publiques et l'état de la chaîne
  // sans prendre le verrou d'écrivain ni réparer le fichier. Indispensable pour
  // vérifier un registre pendant que le service tourne (audit, CI, contrôle
  // externe) — un contrôle d'intégrité n'a aucune raison d'exiger l'exclusivité.
  function openReadOnly() {
    loadOrCreateKeys();
    if (fs.existsSync(LEDGER_FILE)) {
      total = 0;
      forEachLine(LEDGER_FILE, () => { total++; });
      for (const line of readTailLines(LEDGER_FILE, MAX_RECENT)) {
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        seq = rec.seq; lastHash = rec.hash; pushRecent(rec);
      }
    }
    return api;
  }

  function append(raw) {
    if (writeFd === null) throw new Error(`Registre « ${name} » non initialisé (init() requis avant append()).`);
    const payload = seal ? seal(raw) : raw;
    seq += 1;
    const ts = new Date().toISOString();
    const prevHash = lastHash;
    const payloadHash = contentHash(payload);
    const hash = recordHash(seq, prevHash, payloadHash);
    const signature = sign(hash);
    const rec = { seq, ts, alg: ALG, prevHash, payloadHash, hash, signature, payload };
    fs.writeSync(writeFd, JSON.stringify(rec) + '\n');
    scheduleSync(); // durabilité : voir FSYNC_MODE (validation groupée par défaut)
    lastHash = hash; total += 1; pushRecent(rec);
    return rec;
  }

  // Vérifie la chaîne.
  //
  // Correctif C3 — HONNÊTETÉ DE LA PORTÉE. La vérification bornée s'ancre sur le
  // `prevHash` du premier enregistrement de la fenêtre, c'est-à-dire sur une valeur
  // fournie par le fichier lui-même : elle ne peut donc RIEN dire de l'historique
  // antérieur. C'est précisément ce qui a laissé afficher « chaîne VALIDE » alors
  // que la rupture du 8 août était en amont. Le résultat porte désormais
  // explicitement `scope`, `anchored` (ancrage à la genèse ou non) et
  // `signaturesChecked` : l'interface ne peut plus présenter un contrôle partiel
  // comme un contrôle intégral.
  //
  // Correctif C1 — CONTINUITÉ DE SÉQUENCE. Les numéros de séquence sont contrôlés
  // (`seq` strictement croissant de 1 en 1) : c'est la signature exacte de la
  // corruption par écrivains concurrents (4 187 doublons observés), qu'un simple
  // contrôle de hash pouvait manquer selon l'ordre d'entrelacement.
  //
  // signatures : 'all' (défaut) | 'sample' (n derniers + échantillon régulier) | 'none'.
  function verifyChain({ limit = 0, signatures = 'all', sample = SIGNATURE_SAMPLE } = {}) {
    const base = { total, brokenAt: null, reason: null, signaturesChecked: 0 };
    if (!fs.existsSync(LEDGER_FILE)) return { ...base, valid: true, total: 0, checked: 0, scope: 'full', anchored: true };

    // Structure (hash du contenu, hash d'enregistrement, chaînage, séquence).
    // `prev === null` → premier de la fenêtre : ancrage sur sa propre valeur, ce
    // que `anchored: false` signale au consommateur.
    const structure = (rec, prev, prevSeq) => {
      const ph = contentHash(rec.payload);
      if (ph !== rec.payloadHash) return 'payload';
      const anchor = prev === null ? rec.prevHash : prev;
      if (rec.prevHash !== anchor) return 'chainage';
      if (recordHash(rec.seq, anchor, ph) !== rec.hash) return 'hash';
      if (prevSeq !== null && rec.seq !== prevSeq + 1) return 'sequence';
      return null;
    };

    // ---- Fenêtre récente (endpoints interrogés fréquemment) ----------------
    if (limit > 0) {
      const lines = readTailLines(LEDGER_FILE, limit);
      const sigFrom = signatures === 'none' ? Infinity : (signatures === 'sample' ? Math.max(0, lines.length - sample) : 0);
      let prev = null; let prevSeq = null; let checked = 0; let sigs = 0;
      for (let i = 0; i < lines.length; i++) {
        let rec; try { rec = JSON.parse(lines[i]); } catch { return { ...base, valid: false, checked, scope: 'recent', anchored: false, reason: 'ligne illisible' }; }
        const bad = structure(rec, prev, prevSeq);
        if (bad) return { ...base, valid: false, checked, brokenAt: rec.seq, reason: bad, scope: 'recent', anchored: false, signaturesChecked: sigs };
        if (i >= sigFrom) { if (!verifySig(rec.hash, rec.signature)) return { ...base, valid: false, checked, brokenAt: rec.seq, reason: 'signature', scope: 'recent', anchored: false, signaturesChecked: sigs }; sigs++; }
        prev = rec.hash; prevSeq = rec.seq; checked++;
      }
      return {
        ...base, valid: true, checked, scope: 'recent', anchored: false, signaturesChecked: sigs,
        windowSize: limit,
        note: `Portée limitée aux ${checked} derniers enregistrements, ancrée sur le fichier lui-même : ne certifie PAS l'historique antérieur.`,
      };
    }

    // ---- Parcours intégral depuis la genèse --------------------------------
    // Échantillonnage des signatures : le chaînage est vérifié sur 100 % des
    // enregistrements (peu coûteux) ; les signatures sur un pas régulier plus la
    // queue, faute de quoi un contrôle au démarrage bloquerait plusieurs minutes.
    const every = signatures === 'all' ? 1 : (signatures === 'none' ? 0 : Math.max(1, Math.ceil(total / Math.max(1, sample))));
    const tailFrom = signatures === 'sample' ? Math.max(0, total - sample) : 0;
    let prev = GENESIS; let prevSeq = 0; let n = 0; let sigs = 0;
    let broken = null; let reason = null;
    try {
      forEachLine(LEDGER_FILE, (line) => {
        if (broken !== null) return;
        const rec = JSON.parse(line);
        const bad = structure(rec, prev, prevSeq);
        if (bad) { broken = rec.seq; reason = bad; return; }
        if (every && (n % every === 0 || n >= tailFrom)) {
          if (!verifySig(rec.hash, rec.signature)) { broken = rec.seq; reason = 'signature'; return; }
          sigs++;
        }
        prev = rec.hash; prevSeq = rec.seq; n++;
      });
    } catch (e) {
      return { ...base, valid: false, checked: n, brokenAt: broken, reason: reason || `lecture : ${e.message}`, scope: 'full', anchored: true, signaturesChecked: sigs };
    }
    if (broken !== null) return { ...base, valid: false, checked: n, brokenAt: broken, reason, scope: 'full', anchored: true, signaturesChecked: sigs };
    return { ...base, valid: true, total: n, checked: n, scope: 'full', anchored: true, signaturesChecked: sigs, signatureMode: signatures };
  }

  // Relit tout le fichier (payloads) — pour la reconstruction d'agrégats / rapports
  // sur période arbitraire. Le prédicat s'applique à la forme SCELLÉE (il peut donc
  // filtrer sur les champs en clair et sur les index, sans déchiffrement) ; seuls
  // les enregistrements retenus sont descellés.
  function readAll(filter) {
    if (!fs.existsSync(LEDGER_FILE)) return [];
    const out = [];
    forEachLine(LEDGER_FILE, (line) => {
      let rec; try { rec = JSON.parse(line); } catch { return; }
      if (!filter || filter(rec.payload)) out.push({ seq: rec.seq, hash: rec.hash, payload: unseal ? unseal(rec.payload) : rec.payload });
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
      out.push({ seq: rec.seq, hash: rec.hash, payload: unseal ? unseal(rec.payload) : rec.payload });
    }
    return out;
  }

  // Enregistrement à un rang donné — lecture en flux, sans déchiffrement : c'est
  // le hash SCELLÉ qui est confronté au reçu d'ancrage.
  function recordAt(targetSeq) {
    if (!fs.existsSync(LEDGER_FILE)) return null;
    let found = null;
    forEachLine(LEDGER_FILE, (line) => {
      if (found) return;
      let rec; try { rec = JSON.parse(line); } catch { return; }
      if (rec.seq === targetSeq) found = { seq: rec.seq, ts: rec.ts, hash: rec.hash, prevHash: rec.prevHash };
    });
    return found;
  }

  const getRecent = (limit = 200) => recent.slice(-limit).reverse()
    .map((r) => (unseal ? { ...r, payload: unseal(r.payload) } : r));
  const stats = () => ({ chain: name, total, lastHash, algorithm: ALG });
  const getPublicKeyPem = () => publicKeyPem;
  const signHashHex = (hashHex) => sign(hashHex);

  const api = { name, file: LEDGER_FILE, init, openReadOnly, append, close, verifyChain, recordAt, readAll, readTail, getRecent, stats, getPublicKeyPem, signHashHex, LEDGER_FILE, LOCK_FILE };
  return api;
}

// Registre principal des TDR (lac de données souverain).
// Les crochets de scellement sont résolus PARESSEUSEMENT : `model` dépend du
// référentiel et du coffre, jamais du registre, mais le require différé garantit
// qu'aucun ordre de chargement ne peut créer de cycle.
const tdr = createChain({
  name: 'tdr', file: 'tdr-ledger.jsonl', privName: 'ledger_private.pem', pubName: 'ledger_public.pem',
  seal: (p) => require('./model').toSealed(p),
  unseal: (p) => require('./model').fromSealed(p),
});

module.exports = Object.assign({ createChain, canonical, DATA_DIR, GENESIS }, tdr);
