'use strict';

// =============================================================================
// Module 2 — Normalisation & Intégration (cahier §2 #2).
// Harmonise des formats opérateurs HÉTÉROGÈNES (dialectes Comviva/Ericsson/maison,
// JSON ou CSV) vers le modèle commun (entrée de model.buildTDR), et opère le
// CONTRÔLE DE CONFORMITÉ AU CONTRAT d'interfaçage.
//
// CORRECTIF A1/A2/A4 — le normaliseur applique désormais le dictionnaire de
// données de la « Fiche d'interfaçage » :
//   * les 11 champs OBLIGATOIRES (M) sont exigés ; un enregistrement incomplet est
//     REJETÉ (400) et non « complété » par des valeurs par défaut ;
//   * les énumérations sont celles du contrat, statuts PENDING/REVERSED compris —
//     une valeur non reconnue est un rejet, jamais un repli silencieux ;
//   * l'identifiant de transaction de l'assujetti, l'horodatage réel, les frais
//     perçus et la taxe sont conservés tels quels (réconciliation, assurance des
//     revenus, fiscalité).
// Les champs OPTIONNELS absents ne bloquent pas mais restent absents : ils ne sont
// jamais devinés.
// =============================================================================

const ref = require('./referentiel');

// Alias de champs rencontrés selon les moteurs/dialectes opérateurs.
const ALIASES = {
  // --- Champs obligatoires (M) du contrat ---
  transactionId: ['transaction_id', 'transactionId', 'txn_id', 'txnId', 'trx_id', 'id', 'reference', 'ref'],
  timestamp: ['timestamp', 'datetime', 'date_time', 'dateTime', 'ts', 'transaction_date', 'date_transaction', 'horodatage', 'time'],
  type: ['transaction_type', 'transactionType', 'type', 'txntype', 'txn_type', 'service', 'operation'],
  amount: ['amount', 'amt', 'value', 'montant', 'val'],
  currency: ['currency', 'ccy', 'devise', 'cur'],
  feeAmount: ['fee_amount', 'feeAmount', 'fee', 'fees', 'frais', 'commission'],
  taxAmount: ['tax_amount', 'taxAmount', 'tax', 'taxe', 'tva', 'vat'],
  status: ['status', 'result', 'etat', 'state'],
  channel: ['channel', 'chan', 'bearer', 'canal'],
  senderMsisdn: ['sender_msisdn', 'senderMsisdn', 'msisdn', 'a_party', 'sender', 'from', 'msisdn_emetteur', 'emetteur'],
  receiverMsisdn: ['receiver_msisdn', 'receiverMsisdn', 'dest', 'b_party', 'receiver', 'to', 'msisdn_recepteur', 'beneficiaire'],
  // --- Champs conditionnels / optionnels ---
  errorCode: ['error_code', 'errorCode', 'error', 'code_erreur', 'reason_code'],
  senderKyc: ['sender_kyc_level', 'senderKycLevel', 'kyc', 'kyc_level', 'niveau_kyc'],
  senderWalletId: ['sender_wallet_id', 'senderWalletId', 'wallet', 'wallet_emetteur'],
  receiverWalletId: ['receiver_wallet_id', 'receiverWalletId', 'wallet_recepteur'],
  receiverOperatorId: ['counterparty_operator', 'counterpartyOperator', 'receiverOperatorId', 'dest_operator', 'b_operator'],
  counterpartyBank: ['counterparty_bank', 'counterpartyBank', 'banque', 'bank'],
  agentId: ['agent_id', 'agentId', 'agent', 'till'],
  merchantId: ['merchant_id', 'merchantId', 'marchand'],
  sessionId: ['session_id', 'sessionId', 'session'],
  latencyMs: ['latency_ms', 'latencyMs', 'duration_ms', 'response_time_ms', 'latence_ms'],
  cellOriginId: ['cell_id', 'cellOriginId', 'cell', 'cellule', 'cgi', 'ecgi'],
  lacTac: ['lac_tac', 'lacTac', 'lac', 'tac'],
  cityName: ['cityName', 'city', 'ville', 'city_name', 'location'],
  platformRef: ['platform_ref', 'platformRef'],
};

// Champs obligatoires au sens du contrat (hors operatorId, porté par l'enveloppe).
const REQUIRED = ['transactionId', 'timestamp', 'type', 'amount', 'currency', 'feeAmount', 'taxAmount', 'status', 'channel', 'senderMsisdn', 'receiverMsisdn'];

const TYPE_MAP = {
  p2p: 'P2P', p2p_onnet: 'P2P', p2p_offnet: 'P2P', transfer: 'P2P', transfert: 'P2P', send: 'P2P',
  cashin: 'CASHIN', cash_in: 'CASHIN', deposit: 'CASHIN', depot: 'CASHIN',
  cashout: 'CASHOUT', cash_out: 'CASHOUT', withdraw: 'CASHOUT', withdrawal: 'CASHOUT', retrait: 'CASHOUT',
  merchant: 'MERCHANT', merchant_pay: 'MERCHANT', payment: 'MERCHANT', paiement: 'MERCHANT', pay: 'MERCHANT',
  airtime: 'AIRTIME', topup: 'AIRTIME', top_up: 'AIRTIME', recharge: 'AIRTIME',
  bill: 'BILL', bill_pay: 'BILL', billpay: 'BILL', facture: 'BILL',
  xborder: 'XBORDER', remittance: 'XBORDER', international: 'XBORDER',
};
// Le contrat ajoute WEB à l'énumération des canaux ; il est traité comme APP
// (même famille « application ») et le repli est SIGNALÉ, jamais silencieux.
const CHAN_MAP = { ussd: 'USSD', stk: 'STK', sim: 'STK', app: 'APP', mobile: 'APP', smartphone: 'APP', web: 'APP', sms: 'SMS' };
const CHAN_ALIASED = { web: 'APP' };

// Énumération de statuts du contrat : SUCCESS / FAILED / PENDING / REVERSED.
const STATUS_MAP = {
  success: 'SUCCESS', ok: 'SUCCESS', completed: 'SUCCESS', complete: 'SUCCESS', reussi: 'SUCCESS', reussie: 'SUCCESS', '00': 'SUCCESS', '0': 'SUCCESS',
  failed: 'FAILED', failure: 'FAILED', ko: 'FAILED', echec: 'FAILED', rejected: 'FAILED', error: 'FAILED', declined: 'FAILED', timeout: 'FAILED',
  pending: 'PENDING', en_cours: 'PENDING', encours: 'PENDING', in_progress: 'PENDING', initiated: 'PENDING', attente: 'PENDING',
  reversed: 'REVERSED', reversal: 'REVERSED', annule: 'REVERSED', annulee: 'REVERSED', cancelled: 'REVERSED', canceled: 'REVERSED', refunded: 'REVERSED', rembourse: 'REVERSED',
};

const KYC_MAP = {
  full: 'VERIFIE', verified: 'VERIFIE', verifie: 'VERIFIE', complet: 'VERIFIE', niveau_2: 'VERIFIE', level2: 'VERIFIE', '2': 'VERIFIE',
  basic: 'PARTIEL', partial: 'PARTIEL', partiel: 'PARTIEL', simplifie: 'PARTIEL', niveau_1: 'PARTIEL', level1: 'PARTIEL', '1': 'PARTIEL',
  none: 'NON_VERIFIE', unverified: 'NON_VERIFIE', non_verifie: 'NON_VERIFIE', aucun: 'NON_VERIFIE', niveau_0: 'NON_VERIFIE', level0: 'NON_VERIFIE', '0': 'NON_VERIFIE',
};

// Fenêtre de plausibilité de l'horodatage : une transaction ne peut pas être
// datée du futur (au-delà de la dérive d'horloge tolérée) ni d'avant l'existence
// du service. Contrôle de qualité, pas de confort.
const CLOCK_SKEW_MS = 5 * 60_000;
const EPOCH_FLOOR_MS = Date.UTC(2015, 0, 1);

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

function reject(source, issues, error) {
  for (const i of issues) bumpIssue(i);
  stats.rejected++; bumpSource(source, false, 0);
  return { ok: false, error, quality: { complete: false, completeness: 0, issues } };
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

  // --- Enveloppe : opérateur émetteur obligatoire et connu ------------------
  if (!operatorId || !ref.byId.get(operatorId)) {
    return reject(source, ['operatorId inconnu/manquant'], 'operatorId inconnu ou manquant');
  }

  // --- Contrôle de présence des champs OBLIGATOIRES -------------------------
  // Tous les manquants sont rapportés d'un coup : l'assujetti corrige son flux en
  // une passe au lieu de découvrir les erreurs une par une.
  const missing = REQUIRED.filter((k) => present[k] === undefined);
  if (missing.length) {
    const labels = missing.map((k) => `champ obligatoire manquant : ${k}`);
    return reject(source, labels, `Champs obligatoires manquants au contrat d'interfaçage : ${missing.join(', ')}`);
  }

  // --- Identifiant de l'assujetti (réconciliation, idempotence) -------------
  input.operatorRef = String(present.transactionId).slice(0, 64);

  // --- Horodatage RÉEL de la transaction ------------------------------------
  const when = new Date(present.timestamp);
  const t = when.getTime();
  if (!Number.isFinite(t)) return reject(source, ['timestamp illisible'], `timestamp illisible : « ${present.timestamp} » (ISO 8601 attendu)`);
  if (t > Date.now() + CLOCK_SKEW_MS) return reject(source, ['timestamp dans le futur'], 'timestamp postérieur à l\'heure de réception');
  if (t < EPOCH_FLOOR_MS) return reject(source, ['timestamp aberrant'], 'timestamp antérieur au périmètre du dispositif');
  input.datetime = when.toISOString();

  // --- Montant & devise ------------------------------------------------------
  const amount = Number(present.amount);
  if (!Number.isFinite(amount) || amount <= 0) return reject(source, ['montant invalide'], 'montant invalide');
  input.amount = amount;

  const ccy = String(present.currency).toUpperCase();
  if (!ref.CURRENCIES[ccy]) return reject(source, ['devise inconnue'], `devise non reconnue : « ${present.currency} »`);
  input.currency = ccy;

  // --- Type / canal / statut : énumérations du contrat, sans repli silencieux -
  const t2 = TYPE_MAP[String(present.type).toLowerCase()];
  if (!t2) return reject(source, ['type non reconnu'], `type de transaction non reconnu : « ${present.type} »`);
  input.type = t2;

  const chKey = String(present.channel).toLowerCase();
  const ch = CHAN_MAP[chKey];
  if (!ch) return reject(source, ['canal non reconnu'], `canal non reconnu : « ${present.channel} »`);
  input.channel = ch;
  if (CHAN_ALIASED[chKey]) { issues.push(`canal « ${present.channel} » rattaché à ${ch}`); bumpIssue('canal rattaché'); }

  const st = STATUS_MAP[String(present.status).toLowerCase()];
  if (!st) return reject(source, ['statut non reconnu'], `statut non reconnu : « ${present.status} » (SUCCESS/FAILED/PENDING/REVERSED attendus)`);
  input.status = st;
  if (st === 'FAILED') {
    if (present.errorCode === undefined) { issues.push('code erreur absent sur transaction échouée'); bumpIssue('code erreur absent'); }
    input.errorCode = present.errorCode !== undefined ? String(present.errorCode) : '91';
  }

  // --- Frais & taxe DÉCLARÉS (assurance des revenus, fiscalité) --------------
  const fee = Number(present.feeAmount);
  if (!Number.isFinite(fee) || fee < 0) return reject(source, ['frais invalides'], `fee_amount invalide : « ${present.feeAmount} »`);
  input.feeDeclared = fee;
  const tax = Number(present.taxAmount);
  if (!Number.isFinite(tax) || tax < 0) return reject(source, ['taxe invalide'], `tax_amount invalide : « ${present.taxAmount} »`);
  input.taxDeclared = tax;
  // Incohérences retenues comme ANOMALIES à instruire, pas comme rejets : ce sont
  // précisément les écarts que le dispositif a vocation à constater.
  if (fee > amount) { issues.push('frais supérieurs au montant principal'); bumpIssue('frais > montant'); }
  if (tax > fee) { issues.push('taxe supérieure aux frais'); bumpIssue('taxe > frais'); }

  // --- Parties ---------------------------------------------------------------
  input.senderMsisdn = String(present.senderMsisdn);
  input.receiverMsisdn = String(present.receiverMsisdn);
  if (present.senderWalletId) input.senderWalletId = String(present.senderWalletId);
  if (present.receiverWalletId) input.receiverWalletId = String(present.receiverWalletId);
  if (present.receiverOperatorId && ref.byId.get(present.receiverOperatorId)) input.receiverOperatorId = present.receiverOperatorId;
  else if (present.receiverOperatorId) { issues.push(`opérateur de contrepartie « ${present.receiverOperatorId} » hors référentiel`); bumpIssue('contrepartie hors référentiel'); }
  if (present.counterpartyBank) input.counterpartyBank = String(present.counterpartyBank);

  if (present.senderKyc !== undefined) {
    const k = KYC_MAP[String(present.senderKyc).toLowerCase()];
    if (k) input.senderKyc = k;
    else { issues.push(`niveau KYC « ${present.senderKyc} » non reconnu`); bumpIssue('KYC non reconnu'); }
  }

  if (present.agentId) input.agentId = String(present.agentId);
  if (present.merchantId) input.merchantId = String(present.merchantId);
  if (present.sessionId) input.sessionId = String(present.sessionId);
  if (present.platformRef) input.platformRef = String(present.platformRef);

  // --- Qualité de service : la latence n'est JAMAIS inventée -----------------
  if (present.latencyMs !== undefined) {
    const l = Number(present.latencyMs);
    if (Number.isFinite(l) && l >= 0) input.latencyMs = l;
    else { issues.push('latence invalide (ignorée)'); bumpIssue('latence invalide'); }
  } else { issues.push('latence non transmise → indicateur QoS non calculable sur cet enregistrement'); bumpIssue('latence absente'); }

  // --- Localisation (palier P3) : jamais devinée -----------------------------
  if (present.cellOriginId && ref.cellById.get(present.cellOriginId)) input.cellOriginId = present.cellOriginId;
  else if (present.cellOriginId) { issues.push('cellule hors référentiel (ignorée)'); bumpIssue('cellule inconnue'); }
  if (present.lacTac) input.lacTac = String(present.lacTac);
  if (present.cityName) {
    const city = ref.cityByName.get(String(present.cityName)) || ref.CITIES.find((c) => c.name.toLowerCase() === String(present.cityName).toLowerCase());
    if (city) input.cityName = city.name;
    else { issues.push(`ville « ${present.cityName} » inconnue (ignorée)`); bumpIssue('ville inconnue'); }
  }
  if (!input.cellOriginId && !input.cityName) { issues.push('localisation non transmise → cellule INCONNUE'); bumpIssue('localisation absente'); }

  // Complétude = part des champs du dictionnaire (M + O) effectivement renseignés.
  const ALL = Object.keys(ALIASES);
  const filled = ALL.filter((k) => present[k] !== undefined).length;
  const completeness = +(filled / ALL.length).toFixed(2);

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

module.exports = { normalizeObject, fromCsv, getStats, noteIso, REQUIRED, ALIASES };
