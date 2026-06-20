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

function report(opts = {}) {
  const cfg = config.get();
  const rate = cfg.contributionRate;
  const list = warehouse.selectRecent(opts);

  const byOperator = ref.OPERATORS
    .filter((op) => !opts.operatorId || op.id === opts.operatorId)
    .map((op) => {
      const sub = list.filter((t) => t.operator.id === op.id && t.status === 'SUCCESS');
      const collected = sub.reduce((s, t) => s + t.fee.amount, 0);
      const expected = sub.reduce((s, t) => s + t.fee.expected, 0);
      const discrepancy = expected - collected; // >0 = manque à percevoir/déclarer
      const underReported = sub.filter((t) => t.fee.amount < t.fee.expected - 1).length;
      return {
        operatorId: op.id, name: op.name, color: op.color,
        transactions: sub.length,
        feeCollectedXaf: collected,
        feeExpectedXaf: expected,
        discrepancyXaf: discrepancy,
        discrepancyPct: expected ? +(100 * discrepancy / expected).toFixed(2) : 0,
        underReportedCount: underReported,
        contributionDueXaf: Math.round(collected * rate),
        contributionOnExpectedXaf: Math.round(expected * rate),
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
    .filter((t) => t.status === 'SUCCESS' && t.fee.amount < t.fee.expected - 1)
    .slice(-limit).reverse()
    .map((t) => ({
      tdrId: t.id, epoch: t.epoch, type: t.type, operatorId: t.operator.id, operatorName: t.operator.name,
      amountXaf: t.amountXaf, feeCollected: t.fee.amount, feeExpected: t.fee.expected,
      gapXaf: t.fee.expected - t.fee.amount, city: t.cellOrigin.city,
    }));
}

module.exports = { report, discrepancies };
