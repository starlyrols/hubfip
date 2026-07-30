'use strict';

// =============================================================================
// Modèle TDR (Transaction Detail Record) — cahier des charges §3.
// Entité centrale du système. Une transaction Mobile Money normalisée porte :
//  - type / canal / montant / devise / frais / statut (+ code d'erreur)
//  - opérateur émetteur & récepteur (interopérabilité), MSISDN & wallets
//  - agent (cash-in/cash-out), cellules/stations de base émettrice & réceptrice
//  - écritures en partie double ÉQUILIBRÉES (intégrité comptable)
//  - message ISO 8583 réel (normalisation), clé d'idempotence
//
// Minimisation des données : le TDR conserve le MSISDN complet (lac de données
// souverain, accès tracé) mais expose un MSISDN masqué via toPublic() à l'égress.
// =============================================================================

const crypto = require('crypto');
const ref = require('./referentiel');
const iso = require('./iso8583');
const subjects = require('./subjects');

const STATUS = Object.freeze(['SUCCESS', 'FAILED']);
const FAIL_RATE_DEFAULT = 0.06;

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

function resolveSub(msisdn, operatorId) {
  if (msisdn && ref.subByMsisdn.has(msisdn)) return ref.subByMsisdn.get(msisdn);
  // Abonné hors-pool (ex. injection externe) : entité minimale.
  return { msisdn: msisdn || null, operatorId, walletId: null, kyc: 'INCONNU', accountLevel: null, registeredAt: null };
}

function latencyFor(channel, status, errorCode) {
  // Latence simulée (ms) — exploitée par le module QoS. Échecs timeout = longs.
  if (status === 'FAILED' && errorCode === '91') return 8000 + Math.floor(Math.random() * 7000);
  const base = { USSD: 900, STK: 1200, APP: 600, SMS: 2500 }[channel] || 1000;
  return base + Math.floor(Math.random() * base);
}

// -----------------------------------------------------------------------------
// Construit un TDR normalisé et équilibré à partir d'une entrée (simulateur ou
// connecteur externe). Champs manquants → dérivés/validés.
// -----------------------------------------------------------------------------
function buildTDR(input = {}) {
  const senderOp = ref.byId.get(input.senderOperatorId || input.operatorId);
  if (!senderOp) throw new Error(`Opérateur émetteur inconnu: ${input.senderOperatorId || input.operatorId}`);

  const type = ref.txTypeById.has(input.type) ? input.type : 'P2P';
  const channel = ref.CHANNELS.some((c) => c.id === input.channel) ? input.channel : 'USSD';
  const currency = ref.CURRENCIES[input.currency] ? input.currency : 'XAF';

  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Montant invalide');
  const amountXaf = ref.toXaf(amount, currency);

  // Récepteur : opérateur récepteur (interop) éventuellement distinct.
  const receiverOp = ref.byId.get(input.receiverOperatorId) || senderOp;
  const crossBorder = type === 'XBORDER';
  const interop = receiverOp.id !== senderOp.id || crossBorder;

  const sender = resolveSub(input.senderMsisdn, senderOp.id);
  const receiver = (type === 'AIRTIME' || type === 'BILL')
    ? { msisdn: input.receiverMsisdn || null, operatorId: receiverOp.id, walletId: `BILLER-${type}`, kyc: 'N/A', accountLevel: null }
    : resolveSub(input.receiverMsisdn, receiverOp.id);

  const agent = (type === 'CASHIN' || type === 'CASHOUT')
    ? (ref.agentById.get(input.agentId) || ref.agentsOf(senderOp.id)[0] || null)
    : null;

  const status = STATUS.includes(input.status) ? input.status : 'SUCCESS';
  const errorCode = status === 'FAILED' ? (input.errorCode || '91') : null;

  // Cellules émettrice / réceptrice (corrélation réseau). Un partenaire externe ne
  // connaît pas les IDs de cellules internes : il peut fournir une ville (cityName).
  const inputCity = input.cityName
    ? (ref.cityByName.get(input.cityName) || ref.CITIES.find((c) => c.name.toLowerCase() === String(input.cityName).toLowerCase()) || null)
    : null;
  const cellOrigin = ref.cellById.get(input.cellOriginId)
    || (inputCity ? ref.cellsOf(inputCity.name)[0] : null)
    || (agent ? ref.cellsOf(agent.city)[0] : null)
    || ref.CELLS[0];
  const cellDest = ref.cellById.get(input.cellDestId)
    || (interop ? ref.cellsOf(cellOrigin.city)[0] : cellOrigin);

  const when = input.datetime ? new Date(input.datetime) : new Date();
  const stan = input.stan || nextStan();
  const id = input.id || crypto.randomUUID();

  // Frais perçus (revenu opérateur). feeOverride permet de simuler des écarts
  // de reporting (assurance des revenus). Aucun frais sur transaction échouée.
  const expectedFee = computeFee(type, amountXaf, input.feeGrid);
  const fee = status === 'FAILED' ? 0
    : (input.feeOverride != null ? Math.max(0, Math.round(input.feeOverride)) : expectedFee);

  const legs = legsFor(type, amountXaf, sender, receiver, agent);
  const net = legs.reduce((s, l) => s + (l.direction === 'DEBIT' ? -l.amount : l.amount), 0);
  if (net !== 0) throw new Error('Écritures déséquilibrées (partie double rompue)');

  const idempotencyKey = input.idempotencyKey || crypto.createHash('sha256')
    .update(`${senderOp.id}|${type}|${amountXaf}|${stan}|${when.getTime()}`).digest('hex').slice(0, 24);

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
    rrn: ('R' + stan + String(when.getTime()).slice(-5)).slice(0, 12),
    responseCode: status === 'FAILED' ? errorCode : '00',
    terminalId: ('T' + senderOp.id.toUpperCase()).slice(0, 8),
    cardAcceptorLocation: `${cellOrigin.city}, GA`,
    currency: ref.CURRENCIES[currency].num,
  });

  return {
    id, idempotencyKey,
    epoch: when.getTime(),
    datetime: when.toISOString(),
    type, channel,
    amount, currency, amountXaf,
    fee: { amount: fee, expected: expectedFee, currency: 'XAF', operatorId: senderOp.id },
    status, errorCode,
    interop, crossBorder,
    operator: { id: senderOp.id, name: senderOp.name, engine: senderOp.engine, color: senderOp.color },
    receiverOperator: { id: receiverOp.id, name: receiverOp.name },
    sender: { operatorId: sender.operatorId, msisdn: sender.msisdn, walletId: sender.walletId, kyc: sender.kyc, accountLevel: sender.accountLevel },
    receiver: { operatorId: receiver.operatorId, msisdn: receiver.msisdn, walletId: receiver.walletId, kyc: receiver.kyc },
    agent: agent ? { id: agent.id, name: agent.name, operatorId: agent.operatorId } : null,
    cellOrigin: { id: cellOrigin.id, city: cellOrigin.city, province: cellOrigin.province, lat: cellOrigin.lat, lng: cellOrigin.lng, siteType: cellOrigin.siteType },
    cellDest: cellDest ? { id: cellDest.id, city: cellDest.city, province: cellDest.province, lat: cellDest.lat, lng: cellDest.lng } : null,
    legs,
    latencyMs: input.latencyMs != null ? Number(input.latencyMs) : latencyFor(channel, status, errorCode),
    source: input.source === 'EXTERNAL' ? 'EXTERNAL' : 'SIMULATION',
    iso8583: { mti: '0200', stan, message: isoMessage },
  };
}

// Reconstruit un TDR depuis un message ISO 8583 entrant (injection connecteur).
function fromIso8583(message, meta = {}) {
  const { fields } = iso.unpack(message);
  const operatorId = meta.operatorId || (fields.acquirerId || '').toLowerCase();
  const typeEntry = ref.TX_TYPES.find((t) => t.processingCode === fields.processingCode);
  return buildTDR({
    senderOperatorId: operatorId,
    receiverOperatorId: meta.receiverOperatorId,
    type: typeEntry ? typeEntry.id : 'P2P',
    channel: meta.channel,
    amount: Number(fields.amountMinor),
    senderMsisdn: meta.senderMsisdn,
    cityName: meta.cityName,
    feeGrid: meta.feeGrid, // grille tarifaire courante (Admin) — sans elle, repli sur les tarifs par défaut
    status: fields.responseCode === '00' ? 'SUCCESS' : 'FAILED',
    errorCode: fields.responseCode === '00' ? null : fields.responseCode,
    source: 'EXTERNAL',
    stan: fields.stan,
  });
}

// Vue PUBLIQUE compacte (diffusion WS / listings) : MSISDN masqués par défaut,
// jeton de sujet pour le traçage, enrichissement (alertes/risque) inclus.
function toPublic(tdr, { reveal = false } = {}) {
  const m = (msisdn) => (reveal ? msisdn : ref.maskMsisdn(msisdn));
  return {
    id: tdr.id, epoch: tdr.epoch, datetime: tdr.datetime,
    type: tdr.type, channel: tdr.channel,
    amount: tdr.amount, currency: tdr.currency, amountXaf: tdr.amountXaf,
    fee: { amount: tdr.fee.amount, expected: tdr.fee.expected },
    status: tdr.status, errorCode: tdr.errorCode,
    interop: tdr.interop, crossBorder: tdr.crossBorder,
    operator: tdr.operator, receiverOperator: tdr.receiverOperator,
    sender: { operatorId: tdr.sender.operatorId, msisdn: m(tdr.sender.msisdn), kyc: tdr.sender.kyc, subjectToken: subjects.token(tdr.sender.msisdn) },
    receiver: { operatorId: tdr.receiver.operatorId, msisdn: m(tdr.receiver.msisdn) },
    agent: tdr.agent,
    cellOrigin: tdr.cellOrigin, latencyMs: tdr.latencyMs,
    source: tdr.source,
    risk: tdr.risk ? { score: tdr.risk.score, level: tdr.risk.level } : null,
    alerts: tdr.alerts || [],
    anomaly: tdr.anomaly || { flagged: false },
    iso8583: { mti: tdr.iso8583.mti, stan: tdr.iso8583.stan },
  };
}

module.exports = { STATUS, FAIL_RATE_DEFAULT, buildTDR, fromIso8583, toPublic, computeFee, nextStan };
