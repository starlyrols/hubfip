'use strict';

// =============================================================================
// Module 2 — Normalisation & Intégration (cahier §2 #2).
// Harmonise des formats opérateurs HÉTÉROGÈNES (dialectes Comviva/Ericsson/maison,
// JSON ou CSV) vers le modèle commun (entrée de model.buildTDR), et opère un
// CONTRÔLE QUALITÉ / COMPLÉTUDE. Garde des statistiques d'ingestion par source.
// =============================================================================

const ref = require('./referentiel');

// Alias de champs rencontrés selon les moteurs/dialectes opérateurs.
const ALIASES = {
  senderMsisdn: ['senderMsisdn', 'msisdn', 'a_party', 'sender', 'from', 'msisdn_emetteur', 'emetteur'],
  receiverMsisdn: ['receiverMsisdn', 'dest', 'b_party', 'receiver', 'to', 'msisdn_recepteur', 'beneficiaire'],
  receiverOperatorId: ['receiverOperatorId', 'dest_operator', 'b_operator'],
  amount: ['amount', 'amt', 'value', 'montant', 'val'],
  currency: ['currency', 'ccy', 'devise', 'cur'],
  type: ['type', 'txntype', 'txn_type', 'service', 'operation'],
  channel: ['channel', 'chan', 'bearer', 'canal'],
  status: ['status', 'result', 'etat', 'state'],
  errorCode: ['errorCode', 'error', 'code_erreur', 'reason_code'],
  agentId: ['agentId', 'agent', 'agent_id', 'till'],
  cellOriginId: ['cellOriginId', 'cell', 'cell_id', 'cellule', 'cgi'],
  cityName: ['cityName', 'city', 'ville', 'city_name', 'location'],
};

const TYPE_MAP = {
  p2p: 'P2P', transfer: 'P2P', transfert: 'P2P', send: 'P2P',
  cashin: 'CASHIN', deposit: 'CASHIN', depot: 'CASHIN',
  cashout: 'CASHOUT', withdraw: 'CASHOUT', retrait: 'CASHOUT',
  merchant: 'MERCHANT', payment: 'MERCHANT', paiement: 'MERCHANT', pay: 'MERCHANT',
  airtime: 'AIRTIME', topup: 'AIRTIME', recharge: 'AIRTIME',
  bill: 'BILL', facture: 'BILL', billpay: 'BILL',
  xborder: 'XBORDER', remittance: 'XBORDER', international: 'XBORDER',
};
const CHAN_MAP = { ussd: 'USSD', stk: 'STK', sim: 'STK', app: 'APP', mobile: 'APP', smartphone: 'APP', sms: 'SMS' };
const STATUS_OK = new Set(['success', 'ok', 'completed', 'reussi', 'reussie', '00', 'true', '0']);
const STATUS_KO = new Set(['failed', 'failure', 'ko', 'echec', 'rejected', 'error', 'declined']);

// Statistiques d'ingestion par source (connecteur).
const stats = { received: 0, accepted: 0, rejected: 0, completenessSum: 0, bySource: {}, issues: {} };

function bumpSource(source, ok, completeness) {
  const s = stats.bySource[source] || (stats.bySource[source] = { received: 0, accepted: 0, rejected: 0, completenessSum: 0 });
  s.received++; if (ok) { s.accepted++; s.completenessSum += completeness; } else s.rejected++;
}
function bumpIssue(label) { stats.issues[label] = (stats.issues[label] || 0) + 1; }

function pick(raw, key) {
  for (const a of ALIASES[key]) {
    if (raw[a] !== undefined && raw[a] !== null && raw[a] !== '') return raw[a];
  }
  return undefined;
}

// Normalise un enregistrement brut (objet) → { ok, input, quality }.
function normalizeObject(raw, opts = {}) {
  const source = opts.source || 'connecteur';
  const operatorId = opts.operatorId || raw.operatorId || raw.operator;
  stats.received++;

  const issues = [];
  const present = {};
  for (const key of Object.keys(ALIASES)) present[key] = pick(raw, key);

  const input = { senderOperatorId: operatorId, source: 'EXTERNAL' };

  // Opérateur émetteur obligatoire et connu.
  if (!operatorId || !ref.byId.get(operatorId)) {
    issues.push('operatorId inconnu/manquant'); bumpIssue('operatorId inconnu/manquant');
    stats.rejected++; bumpSource(source, false, 0);
    return { ok: false, error: 'operatorId inconnu ou manquant', quality: { complete: false, issues } };
  }

  // Montant obligatoire et valide.
  const amount = Number(present.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    issues.push('montant invalide/manquant'); bumpIssue('montant invalide/manquant');
    stats.rejected++; bumpSource(source, false, 0);
    return { ok: false, error: 'montant invalide', quality: { complete: false, issues } };
  }
  input.amount = amount;

  // Champs optionnels normalisés (avec valeurs par défaut + signalement).
  input.senderMsisdn = present.senderMsisdn;
  input.receiverMsisdn = present.receiverMsisdn;
  if (present.receiverOperatorId && ref.byId.get(present.receiverOperatorId)) input.receiverOperatorId = present.receiverOperatorId;
  input.currency = ref.CURRENCIES[String(present.currency || 'XAF').toUpperCase()] ? String(present.currency).toUpperCase() : 'XAF';
  if (present.currency && !ref.CURRENCIES[String(present.currency).toUpperCase()]) { issues.push(`devise inconnue → XAF`); bumpIssue('devise inconnue'); }

  const t = present.type ? TYPE_MAP[String(present.type).toLowerCase()] : undefined;
  input.type = t || 'P2P';
  if (present.type && !t) { issues.push(`type « ${present.type} » non reconnu → P2P`); bumpIssue('type non reconnu'); }
  else if (!present.type) { issues.push('type manquant → P2P'); }

  const ch = present.channel ? CHAN_MAP[String(present.channel).toLowerCase()] : undefined;
  input.channel = ch || 'USSD';
  if (present.channel && !ch) { issues.push(`canal « ${present.channel} » non reconnu → USSD`); bumpIssue('canal non reconnu'); }

  const st = String(present.status == null ? 'success' : present.status).toLowerCase();
  input.status = STATUS_KO.has(st) ? 'FAILED' : 'SUCCESS';
  if (present.status != null && !STATUS_OK.has(st) && !STATUS_KO.has(st)) { issues.push(`statut « ${present.status} » ambigu → SUCCESS`); bumpIssue('statut ambigu'); }
  if (input.status === 'FAILED') input.errorCode = present.errorCode || '91';

  if (present.agentId) input.agentId = present.agentId;
  if (present.cellOriginId && ref.cellById.get(present.cellOriginId)) input.cellOriginId = present.cellOriginId;
  else if (present.cellOriginId) { issues.push('cellule inconnue (ignorée)'); bumpIssue('cellule inconnue'); }
  // Localisation par ville — seul moyen pour un partenaire externe de porter la
  // géographie (les IDs de cellules sont internes).
  if (present.cityName) {
    const city = ref.cityByName.get(String(present.cityName)) || ref.CITIES.find((c) => c.name.toLowerCase() === String(present.cityName).toLowerCase());
    if (city) input.cityName = city.name;
    else { issues.push(`ville « ${present.cityName} » inconnue (ignorée)`); bumpIssue('ville inconnue'); }
  }
  if (!present.senderMsisdn) issues.push('MSISDN émetteur manquant');

  // Complétude = part des champs « cœur » renseignés.
  const core = ['senderMsisdn', 'receiverMsisdn', 'amount', 'type', 'channel', 'status'];
  const filled = core.filter((k) => present[k] !== undefined || k === 'amount').length;
  const completeness = +(filled / core.length).toFixed(2);

  stats.accepted++; stats.completenessSum += completeness; bumpSource(source, true, completeness);
  return { ok: true, input, quality: { complete: issues.length === 0, completeness, issues } };
}

// CSV : ligne + colonnes (en-tête) → objet → normalizeObject.
function fromCsv(line, columns, opts = {}) {
  const cells = String(line).split(opts.delimiter || ',');
  const raw = {};
  (columns || []).forEach((col, i) => { raw[String(col).trim()] = (cells[i] || '').trim(); });
  return normalizeObject(raw, opts);
}

function getStats() {
  return {
    ...stats,
    completenessRate: stats.accepted ? +(stats.completenessSum / stats.accepted).toFixed(3) : 1,
    topIssues: Object.entries(stats.issues).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

// Signale une ingestion ISO 8583 (normalisée par model.fromIso8583).
function noteIso(source, ok) {
  stats.received++; if (ok) { stats.accepted++; stats.completenessSum += 1; bumpSource(source, true, 1); }
  else { stats.rejected++; bumpSource(source, false, 0); }
}

module.exports = { normalizeObject, fromCsv, getStats, noteIso };
