'use strict';

// =============================================================================
// Modèle TDR (Transaction Detail Record) — cahier des charges §3, dictionnaire de
// données de la « Fiche d'interfaçage opérateur ↔ ARCEP ».
//
// PRINCIPE DIRECTEUR (correctif A2) : la plateforme ne FABRIQUE JAMAIS une valeur
// qu'un assujetti ne lui a pas transmise. Un champ non déclaré vaut `null` et
// porte un DRAPEAU DE PROVENANCE ; il n'est jamais remplacé par une estimation
// plausible, car le TDR est ensuite haché, chaîné et signé — une valeur inventée
// revêtue d'une signature acquerrait l'apparence d'une preuve.
//
// Drapeaux de provenance (tdr.provenance) :
//   DECLARE     — transmis par l'assujetti (valeur opposable)
//   DEDUIT      — dérivé d'un autre champ déclaré (ex. cellule depuis la ville)
//   BAREME      — recalculé par la plateforme depuis la grille officielle
//   RECEPTION   — horodatage d'arrivée à la plateforme (et non de la transaction)
//   SIMULE      — produit par le simulateur de démonstration (jamais opposable)
//   SANS_OBJET  — le champ n'a pas lieu d'être (frais sur transaction échouée)
//   INCONNU     — non transmis : la valeur est null, elle est exclue des agrégats
//
// Minimisation : le TDR conserve le MSISDN complet (lac de données souverain,
// accès tracé) mais expose un MSISDN masqué via toPublic() à l'égress.
// =============================================================================

const crypto = require('crypto');
const ref = require('./referentiel');
const iso = require('./iso8583');
const subjects = require('./subjects');
const vault = require('./crypto-store');

// Énumération complète du contrat d'interfaçage (correctif A4) : une transaction
// en attente ou annulée n'est PAS une transaction réussie.
const STATUS = Object.freeze(['SUCCESS', 'FAILED', 'PENDING', 'REVERSED']);
// Seuls les états DÉNOUÉS entrent au dénominateur du taux de succès.
const SETTLED = Object.freeze(['SUCCESS', 'FAILED']);
const FAIL_RATE_DEFAULT = 0.06;

// Code réponse ISO 8583 (DE39) par statut, pour les états sans code d'erreur.
const ISO_RESPONSE = { SUCCESS: '00', PENDING: '09', REVERSED: '17' };

let stanCounter = Math.floor(Date.now() % 1000000);
function nextStan() {
  stanCounter = (stanCounter + 1) % 1000000;
  return String(stanCounter).padStart(6, '0');
}

// Frais = clamp(min, pct% × montant + flat, cap). Grille configurable (Admin).
function computeFee(typeId, amountXaf, grid) {
  const g = (grid && grid[typeId]) || ref.DEFAULT_FEES[typeId] || { pct: 0, flat: 0, min: 0, cap: 0 };
  let fee = amountXaf * (g.pct / 100) + (g.flat || 0);
  if (g.cap > 0) fee = Math.min(fee, g.cap);
  if (g.min > 0 && fee > 0) fee = Math.max(fee, g.min);
  return Math.max(0, Math.round(fee));
}

// Écritures en partie double selon le type de transaction (net = 0).
function legsFor(type, amountXaf, sender, receiver, agent) {
  const w = (s) => `acct:wallet:${s.walletId || s.msisdn}`;
  const ag = (a) => `acct:agent:${a ? a.id : 'UNKNOWN'}`;
  switch (type) {
    case 'CASHIN':
      return [{ account: ag(agent), direction: 'DEBIT', amount: amountXaf, currency: 'XAF' },
        { account: w(receiver), direction: 'CREDIT', amount: amountXaf, currency: 'XAF' }];
    case 'CASHOUT':
      return [{ account: w(sender), direction: 'DEBIT', amount: amountXaf, currency: 'XAF' },
        { account: ag(agent), direction: 'CREDIT', amount: amountXaf, currency: 'XAF' }];
    case 'MERCHANT':
      return [{ account: w(sender), direction: 'DEBIT', amount: amountXaf, currency: 'XAF' },
        { account: `acct:merchant:${receiver.walletId || receiver.msisdn}`, direction: 'CREDIT', amount: amountXaf, currency: 'XAF' }];
    case 'AIRTIME':
      return [{ account: w(sender), direction: 'DEBIT', amount: amountXaf, currency: 'XAF' },
        { account: `acct:airtime:${sender.operatorId}`, direction: 'CREDIT', amount: amountXaf, currency: 'XAF' }];
    case 'BILL':
      return [{ account: w(sender), direction: 'DEBIT', amount: amountXaf, currency: 'XAF' },
        { account: 'acct:biller:national', direction: 'CREDIT', amount: amountXaf, currency: 'XAF' }];
    case 'XBORDER':
      return [{ account: w(sender), direction: 'DEBIT', amount: amountXaf, currency: 'XAF' },
        { account: `acct:corridor:${receiver.operatorId}`, direction: 'CREDIT', amount: amountXaf, currency: 'XAF' }];
    default: // P2P
      return [{ account: w(sender), direction: 'DEBIT', amount: amountXaf, currency: 'XAF' },
        { account: w(receiver), direction: 'CREDIT', amount: amountXaf, currency: 'XAF' }];
  }
}

function isoDateTimeParts(d) {
  const p = (n, l) => String(n).padStart(l, '0');
  const MM = p(d.getUTCMonth() + 1, 2); const DD = p(d.getUTCDate(), 2);
  const hh = p(d.getUTCHours(), 2); const mm = p(d.getUTCMinutes(), 2); const ss = p(d.getUTCSeconds(), 2);
  return { transmissionDateTime: MM + DD + hh + mm + ss, localTime: hh + mm + ss, localDate: MM + DD };
}

function resolveSub(msisdn, operatorId, declaredKyc) {
  if (msisdn && ref.subByMsisdn.has(msisdn)) return ref.subByMsisdn.get(msisdn);
  // Abonné hors-pool (injection externe) : le niveau KYC DÉCLARÉ par l'opérateur
  // fait foi ; à défaut seulement, il est INCONNU (correctif A10 — sans quoi toute
  // injection externe déclencherait mécaniquement une alerte RISKY_KYC).
  return { msisdn: msisdn || null, operatorId, walletId: null, kyc: declaredKyc || 'INCONNU', accountLevel: null, registeredAt: null };
}

// Latence SIMULÉE (ms) — réservée au simulateur de démonstration. Jamais appliquée
// à un TDR issu d'un connecteur : une latence inventée fausserait la QoS opposable.
function simulatedLatency(channel, status, errorCode) {
  if (status === 'FAILED' && errorCode === '91') return 8000 + Math.floor(Math.random() * 7000);
  const base = { USSD: 900, STK: 1200, APP: 600, SMS: 2500 }[channel] || 1000;
  return base + Math.floor(Math.random() * base);
}

// -----------------------------------------------------------------------------
// Construit un TDR normalisé et équilibré à partir d'une entrée (simulateur ou
// connecteur externe). Les champs absents restent null + drapeau de provenance.
// -----------------------------------------------------------------------------
function buildTDR(input = {}) {
  const external = input.source === 'EXTERNAL';
  const simulated = !external; // seul le simulateur a le droit de synthétiser
  const prov = {};

  const senderOp = ref.byId.get(input.senderOperatorId || input.operatorId);
  if (!senderOp) throw new Error(`Opérateur émetteur inconnu: ${input.senderOperatorId || input.operatorId}`);

  // Type / canal / devise : sur le chemin externe, le normaliseur les a déjà
  // validés contre l'énumération du contrat ; on ne retombe donc jamais en douce
  // sur une valeur par défaut ici.
  if (external && !ref.txTypeById.has(input.type)) throw new Error(`Type de transaction non reconnu: ${input.type}`);
  if (external && !ref.CHANNELS.some((c) => c.id === input.channel)) throw new Error(`Canal non reconnu: ${input.channel}`);
  const type = ref.txTypeById.has(input.type) ? input.type : 'P2P';
  const channel = ref.CHANNELS.some((c) => c.id === input.channel) ? input.channel : 'USSD';
  const currency = ref.CURRENCIES[input.currency] ? input.currency : 'XAF';
  prov.type = input.type ? 'DECLARE' : 'SIMULE';
  prov.channel = input.channel ? 'DECLARE' : 'SIMULE';

  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Montant invalide');
  const amountXaf = ref.toXaf(amount, currency);

  const receiverOp = ref.byId.get(input.receiverOperatorId) || senderOp;
  const crossBorder = type === 'XBORDER';
  const interop = receiverOp.id !== senderOp.id || crossBorder;

  const sender = resolveSub(input.senderMsisdn, senderOp.id, input.senderKyc);
  const receiver = (type === 'AIRTIME' || type === 'BILL')
    ? { msisdn: input.receiverMsisdn || null, operatorId: receiverOp.id, walletId: input.receiverWalletId || `BILLER-${type}`, kyc: 'N/A', accountLevel: null }
    : resolveSub(input.receiverMsisdn, receiverOp.id, null);
  if (input.senderWalletId) sender.walletId = input.senderWalletId;
  if (input.receiverWalletId) receiver.walletId = input.receiverWalletId;
  prov.senderKyc = ref.subByMsisdn.has(input.senderMsisdn) ? 'DECLARE'
    : (input.senderKyc ? 'DECLARE' : 'INCONNU');

  const agent = (type === 'CASHIN' || type === 'CASHOUT')
    ? (ref.agentById.get(input.agentId) || (simulated ? ref.agentsOf(senderOp.id)[0] : null) || null)
    : null;

  if (external && !STATUS.includes(input.status)) throw new Error(`Statut non reconnu: ${input.status}`);
  const status = STATUS.includes(input.status) ? input.status : 'SUCCESS';
  prov.status = input.status ? 'DECLARE' : 'SIMULE';
  const errorCode = status === 'FAILED' ? (input.errorCode || '91') : null;

  // --- Localisation (palier P3) --------------------------------------------
  // Correctif A2 : à défaut de cellule ou de ville DÉCLARÉE, la localisation est
  // INCONNUE. Elle n'est plus rabattue sur la première cellule du référentiel,
  // ce qui biaisait la cartographie et déclenchait de faux « déplacements
  // impossibles ».
  const inputCity = input.cityName
    ? (ref.cityByName.get(input.cityName) || ref.CITIES.find((c) => c.name.toLowerCase() === String(input.cityName).toLowerCase()) || null)
    : null;
  const declaredCell = ref.cellById.get(input.cellOriginId) || null;
  const deducedCell = declaredCell ? null
    : (inputCity ? ref.cellsOf(inputCity.name)[0] : null) || (agent ? ref.cellsOf(agent.city)[0] : null) || null;
  const cellOrigin = declaredCell || deducedCell || (simulated ? ref.CELLS[0] : null);
  prov.cellOrigin = declaredCell ? 'DECLARE' : (deducedCell ? 'DEDUIT' : (cellOrigin ? 'SIMULE' : 'INCONNU'));
  const cellDest = ref.cellById.get(input.cellDestId)
    || (cellOrigin ? (interop ? ref.cellsOf(cellOrigin.city)[0] : cellOrigin) : null);

  // --- Horodatage ------------------------------------------------------------
  // Correctif A1/A2 : l'heure de la TRANSACTION est celle déclarée par l'assujetti.
  // L'heure de réception ne s'y substitue jamais en silence ; quand elle sert de
  // repli (simulateur), le drapeau le dit.
  const declaredWhen = input.datetime ? new Date(input.datetime) : null;
  const validDeclared = declaredWhen && Number.isFinite(declaredWhen.getTime());
  if (external && !validDeclared) throw new Error('Horodatage de transaction manquant ou invalide');
  const when = validDeclared ? declaredWhen : new Date();
  prov.datetime = validDeclared ? 'DECLARE' : (simulated ? 'SIMULE' : 'RECEPTION');
  const receivedAt = new Date().toISOString();

  const stan = input.stan || nextStan();
  const id = input.id || crypto.randomUUID();
  // Référence de l'assujetti (transaction_id du contrat) — indispensable à la
  // réconciliation et à la procédure contradictoire. Conservée telle quelle.
  const operatorRef = input.operatorRef != null ? String(input.operatorRef) : null;

  // --- Frais & taxes ---------------------------------------------------------
  // Correctif A3 : les frais PERÇUS sont ceux DÉCLARÉS par l'assujetti. La
  // plateforme recalcule les frais ATTENDUS depuis la grille officielle et
  // CONFRONTE les deux. Elle ne substitue plus l'attendu au perçu — sans quoi
  // l'écart serait nul par construction et l'assurance des revenus inopérante.
  const expectedFee = computeFee(type, amountXaf, input.feeGrid);
  let fee; let feeProv;
  if (input.feeDeclared != null && Number.isFinite(Number(input.feeDeclared))) {
    fee = Math.max(0, Math.round(Number(input.feeDeclared))); feeProv = 'DECLARE';
  } else if (status !== 'SUCCESS') {
    fee = 0; feeProv = 'SANS_OBJET';
  } else if (input.feeOverride != null) {
    fee = Math.max(0, Math.round(input.feeOverride)); feeProv = 'SIMULE';
  } else if (simulated) {
    fee = expectedFee; feeProv = 'SIMULE';
  } else {
    fee = null; feeProv = 'INCONNU';
  }
  prov.fee = feeProv;

  let tax; let taxProv;
  if (input.taxDeclared != null && Number.isFinite(Number(input.taxDeclared))) {
    tax = Math.max(0, Math.round(Number(input.taxDeclared))); taxProv = 'DECLARE';
  } else if (status !== 'SUCCESS') {
    tax = 0; taxProv = 'SANS_OBJET';
  } else if (simulated) {
    tax = Math.round((fee || 0) * ref.VAT_RATE); taxProv = 'SIMULE';
  } else {
    tax = null; taxProv = 'INCONNU';
  }
  prov.tax = taxProv;

  const legs = legsFor(type, amountXaf, sender, receiver, agent);
  const net = legs.reduce((s, l) => s + (l.direction === 'DEBIT' ? -l.amount : l.amount), 0);
  if (net !== 0) throw new Error('Écritures déséquilibrées (partie double rompue)');

  // Clé d'idempotence : ancrée sur la référence de l'assujetti quand elle existe
  // (seule base stable pour dédoublonner un rejeu), sinon sur le contenu.
  const idempotencyKey = input.idempotencyKey || (operatorRef
    ? crypto.createHash('sha256').update(`${senderOp.id}|${operatorRef}`).digest('hex').slice(0, 24)
    : crypto.createHash('sha256').update(`${senderOp.id}|${type}|${amountXaf}|${stan}|${when.getTime()}`).digest('hex').slice(0, 24));

  // --- Latence (QoS) ---------------------------------------------------------
  // Correctif A2 : plus aucune latence aléatoire sur le chemin externe.
  let latencyMs; let latProv;
  if (input.latencyMs != null && Number.isFinite(Number(input.latencyMs))) {
    latencyMs = Number(input.latencyMs); latProv = 'DECLARE';
  } else if (simulated) {
    latencyMs = simulatedLatency(channel, status, errorCode); latProv = 'SIMULE';
  } else {
    latencyMs = null; latProv = 'INCONNU';
  }
  prov.latencyMs = latProv;

  // Message ISO 8583 (normalisation / connecteur authentique).
  const dt = isoDateTimeParts(when);
  const panDigits = String(sender.msisdn || senderOp.id).replace(/\D/g, '').slice(-19) || '0';
  const isoMessage = iso.pack('0200', {
    pan: panDigits,
    processingCode: ref.txTypeById.get(type).processingCode,
    amountMinor: amountXaf,
    transmissionDateTime: dt.transmissionDateTime,
    stan,
    localTime: dt.localTime,
    localDate: dt.localDate,
    acquirerId: senderOp.id.toUpperCase().slice(0, 11),
    rrn: (operatorRef || ('R' + stan + String(when.getTime()).slice(-5))).slice(0, 12),
    responseCode: status === 'FAILED' ? errorCode : (ISO_RESPONSE[status] || '00'),
    terminalId: ('T' + senderOp.id.toUpperCase()).slice(0, 8),
    cardAcceptorLocation: `${cellOrigin ? cellOrigin.city : 'NON DECLARE'}, GA`,
    currency: ref.CURRENCIES[currency].num,
  });

  return {
    id, operatorRef, idempotencyKey,
    epoch: when.getTime(),
    datetime: when.toISOString(),
    receivedAt,
    type, channel,
    amount, currency, amountXaf,
    fee: { amount: fee, expected: expectedFee, currency: 'XAF', operatorId: senderOp.id },
    tax: { amount: tax, currency: 'XAF' },
    status, errorCode,
    interop, crossBorder,
    operator: { id: senderOp.id, name: senderOp.name, engine: senderOp.engine, color: senderOp.color },
    receiverOperator: { id: receiverOp.id, name: receiverOp.name },
    sender: { operatorId: sender.operatorId, msisdn: sender.msisdn, walletId: sender.walletId, kyc: sender.kyc, accountLevel: sender.accountLevel },
    receiver: { operatorId: receiver.operatorId, msisdn: receiver.msisdn, walletId: receiver.walletId, kyc: receiver.kyc },
    agent: agent ? { id: agent.id, name: agent.name, operatorId: agent.operatorId } : null,
    merchantId: input.merchantId || null,
    sessionId: input.sessionId || null,
    cellOrigin: cellOrigin
      ? { id: cellOrigin.id, city: cellOrigin.city, province: cellOrigin.province, lat: cellOrigin.lat, lng: cellOrigin.lng, siteType: cellOrigin.siteType }
      : null,
    cellDest: cellDest ? { id: cellDest.id, city: cellDest.city, province: cellDest.province, lat: cellDest.lat, lng: cellDest.lng } : null,
    lacTac: input.lacTac || null,
    legs,
    latencyMs,
    provenance: prov,
    source: external ? 'EXTERNAL' : 'SIMULATION',
    iso8583: { mti: '0200', stan, message: isoMessage },
  };
}

// Reconstruit un TDR depuis un message ISO 8583 entrant (injection connecteur).
// Le message porte la date/heure de transmission (DE7) et la référence (DE37) ;
// les frais et taxes n'existent pas dans la norme : ils DOIVENT accompagner le
// message dans l'enveloppe d'injection, faute de quoi l'assurance des revenus
// n'aurait rien à confronter.
function fromIso8583(message, meta = {}) {
  const { fields } = iso.unpack(message);
  const operatorId = meta.operatorId || (fields.acquirerId || '').toLowerCase();
  const typeEntry = ref.TX_TYPES.find((t) => t.processingCode === fields.processingCode);
  if (!typeEntry) throw new Error(`Code de traitement ISO inconnu: ${fields.processingCode}`);
  const status = fields.responseCode === '00' ? 'SUCCESS'
    : (fields.responseCode === '09' ? 'PENDING' : (fields.responseCode === '17' ? 'REVERSED' : 'FAILED'));
  return buildTDR({
    senderOperatorId: operatorId,
    receiverOperatorId: meta.receiverOperatorId,
    type: typeEntry.id,
    channel: meta.channel,
    amount: Number(fields.amountMinor),
    senderMsisdn: meta.senderMsisdn,
    receiverMsisdn: meta.receiverMsisdn,
    senderKyc: meta.senderKyc,
    cityName: meta.cityName,
    cellOriginId: meta.cellOriginId,
    datetime: meta.datetime || isoTimestamp(fields),
    operatorRef: meta.operatorRef || fields.rrn || null,
    feeDeclared: meta.feeDeclared,
    taxDeclared: meta.taxDeclared,
    latencyMs: meta.latencyMs,
    feeGrid: meta.feeGrid, // grille tarifaire courante (Admin)
    status,
    errorCode: status === 'FAILED' ? fields.responseCode : null,
    source: 'EXTERNAL',
    stan: fields.stan,
  });
}

// DE7 (MMDDhhmmss, UTC) → horodatage ISO. L'année n'est pas portée par la norme :
// on retient l'année courante, et l'année précédente si la date obtenue est dans
// le futur (message de fin décembre reçu début janvier).
function isoTimestamp(fields) {
  const s = String(fields.transmissionDateTime || '');
  if (!/^\d{10}$/.test(s)) return null;
  const now = new Date();
  const mk = (year) => Date.UTC(year, Number(s.slice(0, 2)) - 1, Number(s.slice(2, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)), Number(s.slice(8, 10)));
  let t = mk(now.getUTCFullYear());
  if (t > now.getTime() + 60_000) t = mk(now.getUTCFullYear() - 1);
  return new Date(t).toISOString();
}

// Les frais de ce TDR ont-ils été DÉCLARÉS par l'assujetti — par opposition à
// recalculés depuis le barème ou absents ? C'est la question qui commande à la
// fois l'assurance des revenus et la couverture déclarative affichée à
// l'observatoire ; elle ne doit donc avoir qu'une seule définition, ici, sur le
// modèle. La dupliquer ferait tôt ou tard diverger deux écrans qui prétendent
// mesurer la même chose.
const hasDeclaredFee = (tdr) => !!tdr.fee && tdr.fee.amount != null
  && (!tdr.provenance || tdr.provenance.fee !== 'BAREME');

// Vue PUBLIQUE compacte (diffusion WS / listings) : MSISDN masqués par défaut,
// jeton de sujet pour le traçage, enrichissement (alertes/risque) et DRAPEAUX DE
// PROVENANCE inclus — l'interface doit pouvoir distinguer un chiffre déclaré d'un
// chiffre recalculé ou absent.
function toPublic(tdr, { reveal = false } = {}) {
  const m = (msisdn) => (reveal ? msisdn : ref.maskMsisdn(msisdn));
  return {
    id: tdr.id, operatorRef: tdr.operatorRef || null,
    epoch: tdr.epoch, datetime: tdr.datetime, receivedAt: tdr.receivedAt || null,
    type: tdr.type, channel: tdr.channel,
    amount: tdr.amount, currency: tdr.currency, amountXaf: tdr.amountXaf,
    fee: { amount: tdr.fee.amount, expected: tdr.fee.expected },
    tax: tdr.tax ? { amount: tdr.tax.amount } : { amount: null },
    status: tdr.status, errorCode: tdr.errorCode,
    interop: tdr.interop, crossBorder: tdr.crossBorder,
    operator: tdr.operator, receiverOperator: tdr.receiverOperator,
    sender: { operatorId: tdr.sender.operatorId, msisdn: m(tdr.sender.msisdn), kyc: tdr.sender.kyc, subjectToken: subjects.token(tdr.sender.msisdn) },
    receiver: { operatorId: tdr.receiver.operatorId, msisdn: m(tdr.receiver.msisdn) },
    agent: tdr.agent,
    cellOrigin: tdr.cellOrigin || null, latencyMs: tdr.latencyMs,
    provenance: tdr.provenance || {},
    source: tdr.source,
    risk: tdr.risk ? { score: tdr.risk.score, level: tdr.risk.level } : null,
    alerts: tdr.alerts || [],
    anomaly: tdr.anomaly || { flagged: false },
    iso8583: { mti: tdr.iso8583.mti, stan: tdr.iso8583.stan },
  };
}

// =============================================================================
// Scellement AU REPOS (correctif F1). Le registre est un lac de données souverain
// qui conserve les identifiants nominatifs : une copie du fichier ne doit livrer
// ni numéro, ni portefeuille, ni localisation précise.
//
//   Palier P2 (nominatif)     → MSISDN, wallets et message ISO 8583 (qui porte le
//                               PAN, donc le numéro) chiffrés AES-256-GCM.
//   Palier P3 (localisation)  → cellule précise (identifiant + coordonnées)
//                               chiffrée ; ville et province restent en clair, à
//                               la granularité déjà publiée dans les statistiques.
//   Index                     → empreinte HMAC déterministe des numéros, en clair,
//                               seul moyen de retrouver les transactions d'un
//                               sujet sans déchiffrer tout le registre.
//
// Le hachage/chaînage/signature portent sur la forme SCELLÉE : la vérification
// d'intégrité fonctionne sans jamais avoir à déchiffrer.
// =============================================================================
const SEALED_MARK = 'v1';

// La fabrique de chaînes est générique : elle peut recevoir un contenu qui n'est
// pas un TDR (marqueur d'exploitation, entrée de test). Un tel contenu ne porte
// aucun identifiant nominatif — on le laisse tel quel plutôt que de rompre.
const looksLikeTdr = (p) => !!(p && p.sender && p.receiver && p.iso8583 && Array.isArray(p.legs));

function toSealed(tdr) {
  if (!looksLikeTdr(tdr)) return tdr;
  // Correctif P1 n°16 — chaque palier est chiffré par la clé de SA période. Les
  // échéances de conservation de l'AIPD diffèrent selon le palier (2 ans pour le
  // nominatif, 10 ans pour la donnée de transaction) : des clés distinctes
  // permettent d'oublier l'un sans perdre l'autre.
  const ep = tdr.epoch;
  const encP2 = (v) => vault.encryptField(v, { tier: 'P2', epoch: ep });
  const encP3 = (v) => vault.encryptField(v, { tier: 'P3', epoch: ep });
  const cell = tdr.cellOrigin;
  const dest = tdr.cellDest;
  return {
    ...tdr,
    sealed: SEALED_MARK,
    sender: {
      ...tdr.sender,
      msisdn: encP2(tdr.sender.msisdn),
      walletId: encP2(tdr.sender.walletId),
      idx: vault.indexOf(tdr.sender.msisdn),
    },
    receiver: {
      ...tdr.receiver,
      msisdn: encP2(tdr.receiver.msisdn),
      walletId: encP2(tdr.receiver.walletId),
      idx: vault.indexOf(tdr.receiver.msisdn),
    },
    // Granularité publiable conservée en clair ; identité précise scellée.
    cellOrigin: cell ? { city: cell.city, province: cell.province } : null,
    cellOriginSealed: cell ? encP3(JSON.stringify(cell)) : null,
    cellDest: null,
    cellDestSealed: dest ? encP3(JSON.stringify(dest)) : null,
    // Les écritures en partie double portent des identifiants de compte dérivés du
    // portefeuille — à défaut de portefeuille, du NUMÉRO lui-même. Elles fuiteraient
    // donc les MSISDN si on les laissait en clair. Les montants et le sens restent
    // lisibles : ce sont eux qui prouvent l'équilibre comptable.
    legs: tdr.legs.map((l) => ({ ...l, account: encP2(l.account) })),
    iso8583: { ...tdr.iso8583, message: encP2(tdr.iso8583.message) },
  };
}

function fromSealed(p) {
  if (!p || p.sealed !== SEALED_MARK) return p; // enregistrement hérité, en clair
  if (!looksLikeTdr(p)) return p;
  const dec = vault.decryptField;
  // Une localisation dont la clé a été détruite n'est pas une localisation
  // absente : on le dit, plutôt que de laisser croire qu'elle n'a jamais existé.
  const parse = (v) => {
    const s = dec(v);
    if (!s) return null;
    if (vault.isPurged(s)) return { purge: true };
    try { return JSON.parse(s); } catch { return null; }
  };
  const out = {
    ...p,
    sender: { ...p.sender, msisdn: dec(p.sender.msisdn), walletId: dec(p.sender.walletId) },
    receiver: { ...p.receiver, msisdn: dec(p.receiver.msisdn), walletId: dec(p.receiver.walletId) },
    cellOrigin: p.cellOriginSealed ? parse(p.cellOriginSealed) : p.cellOrigin,
    cellDest: p.cellDestSealed ? parse(p.cellDestSealed) : p.cellDest,
    legs: (p.legs || []).map((l) => ({ ...l, account: dec(l.account) })),
    iso8583: { ...p.iso8583, message: dec(p.iso8583.message) },
  };
  delete out.cellOriginSealed; delete out.cellDestSealed; delete out.sealed;
  delete out.sender.idx; delete out.receiver.idx;
  return out;
}

module.exports = { STATUS, SETTLED, FAIL_RATE_DEFAULT, hasDeclaredFee, buildTDR, fromIso8583, toPublic, computeFee, nextStan, isoTimestamp, toSealed, fromSealed, SEALED_MARK };
