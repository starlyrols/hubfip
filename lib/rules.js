'use strict';

// =============================================================================
// Module 7 — Moteur de règles Fraude / AML (cahier §2 #7).
// Détection par règles PARAMÉTRABLES (seuils, vélocité, fractionnement/structuring,
// contreparties à risque, transfrontalier). Évalue chaque TDR et produit des alertes.
// État glissant par MSISDN (vélocité/structuring). Tous les seuils proviennent de
// la configuration (module Admin) → modifiables à chaud.
// =============================================================================

const ref = require('./referentiel');
const config = require('./config');
const subjects = require('./subjects');

const RULES = [
  { id: 'SEUIL', label: 'Transaction au-dessus du seuil de déclaration', severity: 'MOYENNE' },
  { id: 'HIGH_VALUE', label: 'Transaction de montant très élevé', severity: 'ELEVEE' },
  { id: 'STRUCTURING', label: 'Fractionnement (structuring) sous le seuil', severity: 'ELEVEE' },
  { id: 'VELOCITY', label: 'Vélocité anormale (rafale de transactions)', severity: 'MOYENNE' },
  { id: 'RISKY_KYC', label: 'Montant élevé sur compte faiblement vérifié (KYC)', severity: 'ELEVEE' },
  { id: 'XBORDER', label: 'Transfert transfrontalier à examiner', severity: 'MOYENNE' },
];
const ruleById = new Map(RULES.map((r) => [r.id, r]));

// Historique glissant par MSISDN émetteur : [{epoch, amountXaf}].
const history = new Map();
const HIST_MAX = 60;

// Stats globales + alertes récentes (pour l'onglet Antifraude).
const counters = Object.fromEntries(RULES.map((r) => [r.id, 0]));
const recentAlerts = [];
const ALERTS_MAX = 400;

function pushHistory(msisdn, epoch, amountXaf) {
  if (!msisdn) return [];
  let h = history.get(msisdn);
  if (!h) { h = []; history.set(msisdn, h); }
  h.push({ epoch, amountXaf });
  if (h.length > HIST_MAX) h.shift();
  return h;
}

function withinWindow(h, epoch, windowMin) {
  const from = epoch - windowMin * 60000;
  return h.filter((e) => e.epoch >= from);
}

// Évalue un TDR → tableau d'alertes. Met à jour l'état et les compteurs.
function evaluate(tdr) {
  const r = config.getRules();
  const alerts = [];
  const add = (id, detail) => {
    const meta = ruleById.get(id);
    alerts.push({ ruleId: id, label: meta.label, severity: meta.severity, detail });
  };

  const msisdn = tdr.sender.msisdn;
  const h = pushHistory(msisdn, tdr.epoch, tdr.amountXaf);

  // Règle SEUIL / HIGH_VALUE
  if (tdr.amountXaf >= r.highValueXaf) add('HIGH_VALUE', `${tdr.amountXaf.toLocaleString('fr-FR')} XAF`);
  else if (tdr.amountXaf >= r.reportingThresholdXaf) add('SEUIL', `${tdr.amountXaf.toLocaleString('fr-FR')} XAF ≥ seuil`);

  // Règle STRUCTURING : N transactions dans la fenêtre, chacune dans [near, seuil[.
  const lo = r.reportingThresholdXaf * r.structuring.nearRatio;
  const hi = r.reportingThresholdXaf;
  const recentStruct = withinWindow(h, tdr.epoch, r.structuring.windowMin).filter((e) => e.amountXaf >= lo && e.amountXaf < hi);
  if (tdr.amountXaf >= lo && tdr.amountXaf < hi && recentStruct.length >= r.structuring.minCount) {
    add('STRUCTURING', `${recentStruct.length} montants entre ${Math.round(lo).toLocaleString('fr-FR')} et ${hi.toLocaleString('fr-FR')} XAF`);
  }

  // Règle VELOCITY : trop de transactions dans la fenêtre.
  const recentVel = withinWindow(h, tdr.epoch, r.velocity.windowMin);
  if (recentVel.length > r.velocity.maxCount) {
    add('VELOCITY', `${recentVel.length} transactions en ${r.velocity.windowMin} min`);
  }

  // Règle RISKY_KYC : KYC faible + montant notable.
  if (r.riskyKyc.includes(tdr.sender.kyc) && tdr.amountXaf >= r.reportingThresholdXaf * 0.5) {
    add('RISKY_KYC', `KYC=${tdr.sender.kyc}, ${tdr.amountXaf.toLocaleString('fr-FR')} XAF`);
  }

  // Règle XBORDER : transfrontalier à examiner.
  if (tdr.crossBorder && tdr.amountXaf >= r.crossBorderReviewXaf) {
    add('XBORDER', `Corridor ${tdr.operator.id}→${tdr.receiverOperator.id}, ${tdr.amountXaf.toLocaleString('fr-FR')} XAF`);
  }

  // Enregistrement des alertes (compteurs + ring buffer).
  for (const a of alerts) {
    counters[a.ruleId]++;
    recentAlerts.push({
      tdrId: tdr.id, epoch: tdr.epoch, type: tdr.type, channel: tdr.channel,
      operatorId: tdr.operator.id, operatorName: tdr.operator.name,
      msisdnMasked: ref.maskMsisdn(tdr.sender.msisdn), subjectToken: subjects.token(tdr.sender.msisdn), amountXaf: tdr.amountXaf,
      city: tdr.cellOrigin.city, ruleId: a.ruleId, severity: a.severity, label: a.label, detail: a.detail,
    });
    if (recentAlerts.length > ALERTS_MAX) recentAlerts.shift();
  }
  return alerts;
}

function stats() {
  return {
    rules: RULES.map((r) => ({ ...r, count: counters[r.id] })),
    totalAlerts: Object.values(counters).reduce((s, n) => s + n, 0),
    trackedMsisdn: history.size,
  };
}

const recent = (limit = 100, opts = {}) => {
  let list = recentAlerts;
  if (opts.operatorId) list = list.filter((a) => a.operatorId === opts.operatorId);
  if (opts.ruleId) list = list.filter((a) => a.ruleId === opts.ruleId);
  if (opts.severity) list = list.filter((a) => a.severity === opts.severity);
  return list.slice(-limit).reverse();
};

module.exports = { RULES, evaluate, stats, recent };
