'use strict';

// =============================================================================
// Module 8 — Gestion de cas / Investigation (cahier §2 #8).
// Dossiers d'enquête persistés : création (depuis une alerte ou manuelle), statut,
// notes, transactions liées, et TRAÇAGE DE CHAÎNES de transactions (drill-down :
// suivre un MSISDN/wallet à travers le registre, identifier les contreparties).
// Accès réservé aux corps de métier habilités (antifraude/juridique) et tracé au
// journal d'audit (accès nominatif encadré — cahier Phase 3).
// =============================================================================

const path = require('path');
const crypto = require('crypto');
const ref = require('./referentiel');
const ledger = require('./ledger');
const store = require('./store');
const vault = require('./crypto-store');
const scanner = require('./scanner');
const model = require('./model');

const CASES_FILE = path.join(store.DATA_DIR, 'cases.json');

const STATUSES = ['OUVERT', 'EN_COURS', 'CLOS'];
let cases = [];

function load() {
  cases = store.readJson(CASES_FILE, [], 'cases');
  return cases;
}

function persist() {
  store.writeJson(CASES_FILE, cases, 'cases');
}

function create({ title, severity, subjectMsisdn, createdBy, linkedTdrIds, fromAlert }) {
  const now = new Date().toISOString();
  const c = {
    id: 'CAS-' + crypto.randomUUID().slice(0, 8).toUpperCase(),
    title: title || 'Dossier sans titre',
    status: 'OUVERT',
    severity: severity || 'MOYENNE',
    subjectMsisdn: subjectMsisdn || null,
    createdBy: createdBy || 'inconnu',
    createdAt: now, updatedAt: now,
    linkedTdrIds: Array.isArray(linkedTdrIds) ? linkedTdrIds : [],
    fromAlert: fromAlert || null,
    notes: [],
  };
  cases.unshift(c);
  persist();
  return c;
}

function get(id) { return cases.find((c) => c.id === id) || null; }

function list({ status, limit = 100 } = {}) {
  let l = cases;
  if (status) l = l.filter((c) => c.status === status);
  return l.slice(0, limit).map((c) => ({ ...c, notesCount: c.notes.length, linkedCount: c.linkedTdrIds.length, notes: undefined }));
}

function update(id, patch, actor) {
  const c = get(id);
  if (!c) return null;
  if (patch.status && STATUSES.includes(patch.status)) c.status = patch.status;
  if (patch.severity) c.severity = patch.severity;
  if (patch.note) c.notes.push({ at: new Date().toISOString(), by: actor || 'inconnu', text: String(patch.note).slice(0, 2000) });
  if (Array.isArray(patch.linkTdrIds)) for (const t of patch.linkTdrIds) if (!c.linkedTdrIds.includes(t)) c.linkedTdrIds.push(t);
  c.updatedAt = new Date().toISOString();
  persist();
  return c;
}

// Fenêtre par défaut du traçage. Correctif D1 (coût) ET exigence de
// PROPORTIONNALITÉ (AIPD) : reconstituer l'historique transactionnel d'une personne
// sur toute la durée de conservation n'est pas un acte anodin. La fenêtre est donc
// bornée et explicite ; l'élargir est une décision, pas un défaut.
const TRACE_DEFAULT_DAYS = Number(process.env.SUMO_TRACE_DEFAULT_DAYS) || 90;
const TRACE_MAX_DAYS = Number(process.env.SUMO_TRACE_MAX_DAYS) || 730;
const TRACE_MAX_RECORDS = 1000;
const DAY_MS = 86_400_000;

// Traçage de chaîne : toutes les transactions impliquant un MSISDN (émetteur ou
// récepteur) sur la fenêtre demandée, triées, + contreparties distinctes.
// `reveal` contrôle le démasquage des numéros (à journaliser par l'appelant).
//
// Le parcours du registre est DÉPORTÉ dans un fil dédié (correctif D1) : il ne
// bloque plus l'event loop. La sélection se fait sur l'empreinte HMAC déterministe
// du numéro — sans déchiffrer quoi que ce soit — et seuls les enregistrements
// retenus sont descellés.
async function traceChain(msisdn, { reveal = false, limit = 200, days, start, end } = {}) {
  const to = end ? new Date(end).getTime() : Date.now();
  const span = Math.min(Math.max(Number(days) || TRACE_DEFAULT_DAYS, 1), TRACE_MAX_DAYS);
  const from = start ? new Date(start).getTime() : to - span * DAY_MS;

  const raw = await scanner.scan({
    kind: 'subject',
    file: ledger.file,
    subjectKey: vault.indexOf(msisdn),
    subjectPlain: msisdn,
    from, to,
    limit: Math.min(Number(limit) || 200, TRACE_MAX_RECORDS),
  });
  const { records, scanStats } = scanner.materialize(raw, model.fromSealed);
  // L'agrégation des contreparties est clé sur le MSISDN RÉEL : deux numéros
  // distincts peuvent partager le même libellé masqué (préfixe + 2 derniers
  // chiffres) et seraient sinon fusionnés en une seule ligne.
  const counterparties = new Map();
  const tx = records.map(({ seq, hash, payload }) => {
    const counterMsisdn = payload.sender.msisdn === msisdn ? payload.receiver.msisdn : payload.sender.msisdn;
    const direction = payload.sender.msisdn === msisdn ? 'ENVOI' : 'RECEPTION';
    const display = reveal ? counterMsisdn : ref.maskMsisdn(counterMsisdn);
    if (!counterparties.has(counterMsisdn)) counterparties.set(counterMsisdn, { counterparty: display, count: 0, sumXaf: 0 });
    const e = counterparties.get(counterMsisdn); e.count++; e.sumXaf += payload.amountXaf;
    return {
      seq, hash, tdrId: payload.id, epoch: payload.epoch, type: payload.type, channel: payload.channel,
      amountXaf: payload.amountXaf, status: payload.status, direction,
      counterparty: display,
      operatorId: payload.operator.id, city: payload.cellOrigin ? payload.cellOrigin.city : null,
    };
  }).sort((a, b) => a.epoch - b.epoch);
  return {
    subject: reveal ? msisdn : ref.maskMsisdn(msisdn),
    // La fenêtre effective est renvoyée : un total ne veut rien dire si l'on ignore
    // sur quelle période il porte, et une troncature doit se voir.
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days: span },
    totalTx: tx.length,
    sumXaf: tx.reduce((s, t) => s + t.amountXaf, 0),
    counterparties: [...counterparties.values()].sort((a, b) => b.sumXaf - a.sumXaf),
    transactions: tx,
    scanStats,
  };
}

function stats() {
  return {
    total: cases.length,
    ouvert: cases.filter((c) => c.status === 'OUVERT').length,
    enCours: cases.filter((c) => c.status === 'EN_COURS').length,
    clos: cases.filter((c) => c.status === 'CLOS').length,
  };
}

module.exports = { STATUSES, load, create, get, list, update, traceChain, stats, TRACE_DEFAULT_DAYS, TRACE_MAX_DAYS };
