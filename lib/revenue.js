'use strict';

// =============================================================================
// Module 5 — Assurance des revenus & redevances (cahier §2 #5).
// Suivi des frais par opérateur, assiette des contributions réglementaires
// (redevance), et DÉTECTION DES ÉCARTS entre frais perçus (déclarés dans le TDR)
// et frais ATTENDUS (recalculés depuis la grille tarifaire officielle). Un écart
// = sous-déclaration potentielle → revenu et redevance manquants.
// =============================================================================

const ref = require('./referentiel');
const config = require('./config');
const warehouse = require('./warehouse');

// Tolérance (XAF) avant de compter une transaction comme sous-déclarée.
const UNDER_TOLERANCE_XAF = 1;
const isUnderReported = (t) => t.status === 'SUCCESS' && t.fee.amount < t.fee.expected - UNDER_TOLERANCE_XAF;

// Agrégats frais perçus/attendus par opérateur sur une liste de TDR — source
// UNIQUE de la logique d'assurance-revenus (fenêtre temps réel comme rapports
// réglementaires sur période) : opId -> { n, collected, expected, under }.
function feeAggregates(list) {
  const byOp = new Map();
  for (const t of list) {
    if (t.status !== 'SUCCESS') continue;
    let e = byOp.get(t.operator.id);
    if (!e) byOp.set(t.operator.id, e = { n: 0, collected: 0, expected: 0, under: 0 });
    e.n++; e.collected += t.fee.amount; e.expected += t.fee.expected;
    if (isUnderReported(t)) e.under++;
  }
  return byOp;
}

// Redevance réglementaire due sur les frais perçus.
const contributionDue = (collectedXaf, rate) => Math.round(collectedXaf * rate);

function report(opts = {}) {
  const cfg = config.get();
  const rate = cfg.contributionRate;
  const agg = feeAggregates(warehouse.selectRecent(opts));

  const byOperator = ref.OPERATORS
    .filter((op) => !opts.operatorId || op.id === opts.operatorId)
    .map((op) => {
      const e = agg.get(op.id) || { n: 0, collected: 0, expected: 0, under: 0 };
      const discrepancy = e.expected - e.collected; // >0 = manque à percevoir/déclarer
      return {
        operatorId: op.id, name: op.name, color: op.color,
        transactions: e.n,
        feeCollectedXaf: e.collected,
        feeExpectedXaf: e.expected,
        discrepancyXaf: discrepancy,
        discrepancyPct: e.expected ? +(100 * discrepancy / e.expected).toFixed(2) : 0,
        underReportedCount: e.under,
        contributionDueXaf: contributionDue(e.collected, rate),
        contributionOnExpectedXaf: contributionDue(e.expected, rate),
      };
    });

  const totals = byOperator.reduce((s, o) => {
    s.feeCollectedXaf += o.feeCollectedXaf; s.feeExpectedXaf += o.feeExpectedXaf;
    s.discrepancyXaf += o.discrepancyXaf; s.contributionDueXaf += o.contributionDueXaf;
    s.underReportedCount += o.underReportedCount;
    return s;
  }, { feeCollectedXaf: 0, feeExpectedXaf: 0, discrepancyXaf: 0, contributionDueXaf: 0, underReportedCount: 0 });

  return { contributionRate: rate, totals, byOperator };
}

// TDR récents présentant un écart de frais (pour drill-down / investigation).
function discrepancies(opts = {}, limit = 50) {
  return warehouse.selectRecent(opts)
    .filter(isUnderReported)
    .slice(-limit).reverse()
    .map((t) => ({
      tdrId: t.id, epoch: t.epoch, type: t.type, operatorId: t.operator.id, operatorName: t.operator.name,
      amountXaf: t.amountXaf, feeCollected: t.fee.amount, feeExpected: t.fee.expected,
      gapXaf: t.fee.expected - t.fee.amount, city: t.cellOrigin.city,
    }));
}

module.exports = { report, discrepancies, feeAggregates, contributionDue };
