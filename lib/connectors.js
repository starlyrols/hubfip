'use strict';

// =============================================================================
// Canal d'ingestion des assujettis — identités et garde-fous par OPÉRATEUR (P1 n°11).
//
// AVANT : une clé HMAC UNIQUE, partagée par tous les connecteurs, et un
// `operatorId` librement choisi dans le corps de la requête. Trois conséquences :
//   * aucune ATTRIBUTION — un opérateur détenant la clé pouvait injecter des TDR
//     au nom d'un concurrent, et rien dans le registre ne permettait de le voir ;
//   * la fuite d'un seul secret ouvrait le canal de tous ;
//   * aucun anti-rejeu — la même requête signée, renvoyée, créait un doublon,
//     donc du volume et de la redevance fictifs.
// La procédure contradictoire prévue par le décret suppose exactement l'inverse :
// pouvoir dire QUI a déclaré QUOI, et QUAND.
//
// APRÈS, par assujetti : secret HMAC propre, horodatage et nonce signés
// (anti-rejeu), idempotence sur la référence de transaction, quota et liste
// d'adresses autorisées. L'`operatorId` déclaré doit correspondre à l'identité
// authentifiée : on ne déclare que pour soi.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const store = require('./store');
const ref = require('./referentiel');
const vault = require('./crypto-store');

const FILE = path.join(store.DATA_DIR, 'connectors.json');
const HANDOVER_FILE = path.join(store.DATA_DIR, 'keys', 'connecteurs-identifiants.txt');

// Fenêtre de tolérance sur l'horodatage signé : au-delà, la requête est un rejeu
// (ou une horloge à recaler — les deux méritent un refus explicite).
const CLOCK_TOLERANCE_MS = Number(process.env.SUMO_INGEST_TOLERANCE_MS) || 5 * 60_000;
const NONCE_MAX = Number(process.env.SUMO_INGEST_NONCE_MAX) || 200_000;
const QUOTA_PER_MIN = Number(process.env.SUMO_INGEST_QUOTA_PER_MIN) || 6000;
const IDEMPOTENCY_MAX = Number(process.env.SUMO_INGEST_IDEMPOTENCY_MAX) || 500_000;

let state = null;

// --- Persistance -----------------------------------------------------------
function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (e) { logger.error('connectors.persist.failed', { error: e.message }); }
}

function newCredential(operatorId) {
  return {
    key: `sumo-${operatorId}-${crypto.randomBytes(4).toString('hex')}`,
    // Le secret est chiffré au repos par le coffre : le fichier d'identifiants
    // ne livre rien sans la phrase secrète (cohérent avec le correctif C2).
    secret: vault.encryptField(crypto.randomBytes(32).toString('hex')),
    createdAt: new Date().toISOString(),
    rotatedAt: null,
    active: true,
    ipAllowlist: [],          // vide = pas de restriction d'adresse
    quotaPerMin: QUOTA_PER_MIN,
    // Empreinte du certificat client attendue, quand le mTLS est terminé par le
    // proxy (voir docs/DEPLOIEMENT-ONPREM.md). Vide = non exigé.
    clientCertFingerprint: null,
  };
}

function load() {
  state = store.readJson(FILE, null, 'connectors') || { version: 1, operators: {} };
  const crees = [];
  const remise = [];
  for (const op of ref.OPERATORS) {
    if (state.operators[op.id]) continue;
    state.operators[op.id] = newCredential(op.id);
    crees.push(op.id);
    remise.push(`${op.id.padEnd(12)} ${state.operators[op.id].key.padEnd(28)} ${vault.decryptField(state.operators[op.id].secret)}`);
  }
  if (crees.length) {
    persist();
    writeHandover(remise);
    logger.info('connectors.seeded', { operateurs: crees.length });
  }
  return state;
}

// Fichier de remise des identifiants de connexion, en 0600, destiné à une
// transmission par canal sûr à chaque assujetti — puis à sa destruction.
function writeHandover(lignes) {
  const corps = [
    '# SUMo — identifiants de connecteur, PAR OPÉRATEUR',
    '# Générés le ' + new Date().toISOString(),
    '# Colonnes : operatorId / clé (en-tête x-sumo-key) / secret HMAC',
    '#',
    '# Chaque assujetti ne reçoit QUE sa propre ligne, par canal sûr.',
    '# La signature couvre : horodatage + nonce + corps (voir README).',
    '# DÉTRUIRE ce fichier après transmission.',
    '',
    ...lignes,
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(HANDOVER_FILE), { recursive: true });
    fs.writeFileSync(HANDOVER_FILE, corps, { mode: 0o600 });
    logger.warn('connectors.handover.written', { file: HANDOVER_FILE, note: 'à transmettre puis détruire' });
  } catch (e) { logger.error('connectors.handover.failed', { error: e.message }); }
}

const ensure = () => state || load();
const byKey = (key) => Object.entries(ensure().operators).find(([, c]) => c.key === key && c.active);

// --- Anti-rejeu ------------------------------------------------------------
// Un nonce déjà vu dans la fenêtre de tolérance est un rejeu. La table est
// plafonnée et purgée par ancienneté : au-delà de la fenêtre, un nonce ne peut
// de toute façon plus servir, l'horodatage le rejetant en amont.
const nonces = new Map(); // `${operatorId}:${nonce}` -> epoch
function nonceSeen(operatorId, nonce, now) {
  const cle = `${operatorId}:${nonce}`;
  const vu = nonces.get(cle);
  if (vu !== undefined && now - vu < CLOCK_TOLERANCE_MS * 2) return true;
  nonces.set(cle, now);
  if (nonces.size > NONCE_MAX) {
    // Purge des entrées hors fenêtre, puis éviction FIFO si nécessaire.
    for (const [k, t] of nonces) {
      if (now - t >= CLOCK_TOLERANCE_MS * 2) nonces.delete(k);
      if (nonces.size <= NONCE_MAX * 0.8) break;
    }
    while (nonces.size > NONCE_MAX) nonces.delete(nonces.keys().next().value);
  }
  return false;
}

// --- Idempotence -----------------------------------------------------------
// La référence de transaction de l'assujetti est la seule base stable pour
// dédoublonner : deux envois de la même transaction ne doivent produire qu'un
// enregistrement, sinon volumes et redevance sont gonflés (constat A5).
const vues = new Map(); // `${operatorId}:${ref}` -> { id, seq, at }
function rememberRef(operatorId, operatorRef, rec) {
  if (!operatorRef) return;
  const cle = `${operatorId}:${operatorRef}`;
  vues.set(cle, { id: rec.id, seq: rec.seq, at: Date.now() });
  if (vues.size > IDEMPOTENCY_MAX) vues.delete(vues.keys().next().value);
}
const knownRef = (operatorId, operatorRef) => (operatorRef ? vues.get(`${operatorId}:${operatorRef}`) || null : null);

// Réamorçage depuis le registre au démarrage : sans lui, un redémarrage rouvrirait
// une fenêtre pendant laquelle les rejeux repasseraient.
function seedFromLedger(records) {
  let n = 0;
  for (const r of records) {
    const p = r.payload;
    if (!p || !p.operatorRef || !p.operator) continue;
    vues.set(`${p.operator.id}:${p.operatorRef}`, { id: p.id, seq: r.seq, at: p.epoch });
    n++;
  }
  if (n) logger.info('connectors.idempotency.seeded', { references: n });
  return n;
}

// --- Quota par opérateur ---------------------------------------------------
const compteurs = new Map(); // operatorId -> { minute, n }
function quotaExceeded(operatorId, limite) {
  const minute = Math.floor(Date.now() / 60_000);
  const c = compteurs.get(operatorId);
  if (!c || c.minute !== minute) { compteurs.set(operatorId, { minute, n: 1 }); return false; }
  c.n++;
  return c.n > limite;
}

// ---------------------------------------------------------------------------
// Vérification complète d'une requête d'injection.
// Renvoie { ok:true, operatorId } ou { ok:false, status, error, code }.
// ---------------------------------------------------------------------------
function verify({ key, signature, timestamp, nonce, rawBody, ip, clientCertFingerprint, declaredOperatorId }) {
  if (!key || !signature || !rawBody) {
    return { ok: false, status: 401, code: 'AUTH_REQUISE', error: 'Authentification requise : clé, signature, horodatage et nonce.' };
  }
  const trouve = byKey(key);
  if (!trouve) return { ok: false, status: 401, code: 'CLE_INCONNUE', error: 'Clé de connecteur inconnue ou révoquée.' };
  const [operatorId, cred] = trouve;

  // Adresse d'origine : quand une liste est déclarée, elle fait foi.
  if (cred.ipAllowlist.length && !cred.ipAllowlist.includes(String(ip))) {
    return { ok: false, status: 403, code: 'IP_NON_AUTORISEE', operatorId, error: `Adresse ${ip} hors de la liste déclarée pour « ${operatorId} ».` };
  }

  // mTLS terminé au proxy : l'empreinte du certificat client doit correspondre.
  if (cred.clientCertFingerprint && cred.clientCertFingerprint !== clientCertFingerprint) {
    return { ok: false, status: 403, code: 'CERTIFICAT_INVALIDE', operatorId, error: 'Certificat client absent ou non conforme au certificat déclaré.' };
  }

  // Anti-rejeu : l'horodatage et le nonce sont SIGNÉS, donc non manipulables.
  const t = Number(timestamp);
  if (!Number.isFinite(t)) return { ok: false, status: 401, code: 'HORODATAGE_MANQUANT', operatorId, error: 'En-tête x-sumo-timestamp manquant ou invalide.' };
  const ecart = Math.abs(Date.now() - t);
  if (ecart > CLOCK_TOLERANCE_MS) {
    return { ok: false, status: 401, code: 'HORODATAGE_HORS_FENETRE', operatorId, error: `Horodatage hors fenêtre de tolérance (${Math.round(ecart / 1000)} s d'écart).` };
  }
  if (!nonce || String(nonce).length < 8) return { ok: false, status: 401, code: 'NONCE_MANQUANT', operatorId, error: 'En-tête x-sumo-nonce manquant (8 caractères minimum).' };

  // La signature couvre horodatage + nonce + corps : rejouer suppose de resigner.
  const secret = vault.decryptField(cred.secret);
  const attendu = crypto.createHmac('sha256', secret).update(`${t}.${nonce}.`).update(rawBody).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(attendu);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, code: 'SIGNATURE_INVALIDE', operatorId, error: 'Signature HMAC invalide (elle couvre horodatage + nonce + corps).' };
  }

  if (nonceSeen(operatorId, nonce, Date.now())) {
    return { ok: false, status: 409, code: 'REJEU', operatorId, error: 'Nonce déjà utilisé : requête rejouée.' };
  }

  // On ne déclare que pour soi : c'est ce qui rend l'attribution opposable.
  if (declaredOperatorId && declaredOperatorId !== operatorId) {
    return { ok: false, status: 403, code: 'OPERATEUR_USURPE', operatorId, error: `Le connecteur « ${operatorId} » ne peut pas déclarer au nom de « ${declaredOperatorId} ».` };
  }

  if (quotaExceeded(operatorId, cred.quotaPerMin)) {
    return { ok: false, status: 429, code: 'QUOTA', operatorId, error: `Quota d'ingestion dépassé (${cred.quotaPerMin}/min).` };
  }

  return { ok: true, operatorId };
}

// --- Administration --------------------------------------------------------
function rotate(operatorId) {
  const c = ensure().operators[operatorId];
  if (!c) throw new Error(`Connecteur inconnu : « ${operatorId} ».`);
  const frais = newCredential(operatorId);
  frais.ipAllowlist = c.ipAllowlist;
  frais.quotaPerMin = c.quotaPerMin;
  frais.clientCertFingerprint = c.clientCertFingerprint;
  frais.rotatedAt = new Date().toISOString();
  state.operators[operatorId] = frais;
  persist();
  logger.warn('connectors.rotated', { operatorId });
  return { operatorId, key: frais.key, secret: vault.decryptField(frais.secret) };
}

function update(operatorId, patch = {}) {
  const c = ensure().operators[operatorId];
  if (!c) throw new Error(`Connecteur inconnu : « ${operatorId} ».`);
  if (Array.isArray(patch.ipAllowlist)) c.ipAllowlist = patch.ipAllowlist.map(String).slice(0, 32);
  if (patch.quotaPerMin != null) {
    const q = Number(patch.quotaPerMin);
    if (!Number.isFinite(q) || q <= 0) throw new Error('quotaPerMin doit être un entier positif.');
    c.quotaPerMin = Math.floor(q);
  }
  if (patch.clientCertFingerprint !== undefined) c.clientCertFingerprint = patch.clientCertFingerprint || null;
  if (patch.active !== undefined) c.active = !!patch.active;
  persist();
  return describe(operatorId);
}

// Vue présentable : jamais le secret.
function describe(operatorId) {
  const c = ensure().operators[operatorId];
  if (!c) return null;
  return {
    operatorId, key: c.key, active: c.active,
    createdAt: c.createdAt, rotatedAt: c.rotatedAt,
    ipAllowlist: c.ipAllowlist, quotaPerMin: c.quotaPerMin,
    mtlsExige: !!c.clientCertFingerprint,
  };
}

function summary() {
  const tous = Object.keys(ensure().operators);
  return {
    connecteurs: tous.length,
    // Un secret partagé se verrait ici : deux opérateurs à la même clé.
    clesDistinctes: new Set(tous.map((o) => ensure().operators[o].key)).size,
    actifs: tous.filter((o) => ensure().operators[o].active).length,
    avecMtls: tous.filter((o) => ensure().operators[o].clientCertFingerprint).length,
    avecListeIp: tous.filter((o) => ensure().operators[o].ipAllowlist.length).length,
    antiRejeu: { fenetreMs: CLOCK_TOLERANCE_MS, noncesSuivis: nonces.size },
    idempotence: { referencesSuivies: vues.size },
  };
}

module.exports = {
  FILE, HANDOVER_FILE, CLOCK_TOLERANCE_MS,
  load, verify, rotate, update, describe, summary,
  knownRef, rememberRef, seedFromLedger,
  _state: () => ensure(),
};
