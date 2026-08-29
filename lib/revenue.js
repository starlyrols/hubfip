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

// Correctif A3 : seule une transaction dont les frais ont été DÉCLARÉS par
// l'assujetti peut être confrontée au barème. Tant que les frais n'étaient pas
// ingérés, la plateforme y substituait le montant attendu — l'écart était donc
// nul par construction et le module ne pouvait rien détecter.
const { hasDeclaredFee } = require('./model'); // définition unique, portée par le modèle
const isUnderReported = (t) => t.status === 'SUCCESS' && hasDeclaredFee(t) && t.fee.amount < t.fee.expected - UNDER_TOLERANCE_XAF;
const isOverReported = (t) => t.status === 'SUCCESS' && hasDeclaredFee(t) && t.fee.amount > t.fee.expected + UNDER_TOLERANCE_XAF;

// Agrégats frais perçus/attendus par opérateur sur une liste de TDR — source
// UNIQUE de la logique d'assurance-revenus (fenêtre temps réel comme rapports
// réglementaires sur période).
// opId -> { n, declared, undeclared, collected, expected, tax, under, over }
// Seules les transactions à frais DÉCLARÉS alimentent l'assiette : les frais non
// transmis sont comptés à part (`undeclared`), jamais estimés.
function feeAggregates(list) {
  const byOp = new Map();
  for (const t of list) {
    if (t.status !== 'SUCCESS') continue;
    let e = byOp.get(t.operator.id);
    if (!e) byOp.set(t.operator.id, e = { n: 0, declared: 0, undeclared: 0, collected: 0, expected: 0, tax: 0, under: 0, over: 0 });
    e.n++;
    if (!hasDeclaredFee(t)) { e.undeclared++; continue; }
    e.declared++;
    e.collected += t.fee.amount; e.expected += t.fee.expected;
    if (t.tax && t.tax.amount != null) e.tax += t.tax.amount;
    if (isUnderReported(t)) e.under++;
    if (isOverReported(t)) e.over++;
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
      const e = agg.get(op.id) || { n: 0, declared: 0, undeclared: 0, collected: 0, expected: 0, tax: 0, under: 0, over: 0 };
      const discrepancy = e.expected - e.collected; // >0 = manque à percevoir/déclarer
      return {
        operatorId: op.id, name: op.name, color: op.color,
        transactions: e.n,
        // Assiette effectivement confrontable au barème.
        feeDeclaredCount: e.declared,
        // Transactions dont les frais n'ont pas été transmis : hors assiette, à
        // réclamer à l'assujetti — jamais comblées par une estimation.
        feeUndeclaredCount: e.undeclared,
        feeCollectedXaf: e.collected,
        feeExpectedXaf: e.expected,
        taxCollectedXaf: e.tax,
        discrepancyXaf: discrepancy,
        discrepancyPct: e.expected ? +(100 * discrepancy / e.expected).toFixed(2) : 0,
        underReportedCount: e.under,
        overReportedCount: e.over,
        contributionDueXaf: contributionDue(e.collected, rate),
        contributionOnExpectedXaf: contributionDue(e.expected, rate),
      };
    });

  const totals = byOperator.reduce((s, o) => {
    s.feeCollectedXaf += o.feeCollectedXaf; s.feeExpectedXaf += o.feeExpectedXaf;
    s.taxCollectedXaf += o.taxCollectedXaf;
    s.discrepancyXaf += o.discrepancyXaf; s.contributionDueXaf += o.contributionDueXaf;
    s.underReportedCount += o.underReportedCount; s.overReportedCount += o.overReportedCount;
    s.feeDeclaredCount += o.feeDeclaredCount; s.feeUndeclaredCount += o.feeUndeclaredCount;
    return s;
  }, { feeCollectedXaf: 0, feeExpectedXaf: 0, taxCollectedXaf: 0, discrepancyXaf: 0, contributionDueXaf: 0, underReportedCount: 0, overReportedCount: 0, feeDeclaredCount: 0, feeUndeclaredCount: 0 });

  // Couverture déclarative : part de l'assiette réellement contrôlable. Un taux
  // dégradé est en soi un manquement au raccordement, pas un détail technique.
  const coverage = totals.feeDeclaredCount + totals.feeUndeclaredCount;
  return {
    contributionRate: rate,
    declarationCoverage: coverage ? +(totals.feeDeclaredCount / coverage).toFixed(4) : 1,
    totals, byOperator,
  };
}

// TDR récents présentant un écart de frais (pour drill-down / investigation).
function discrepancies(opts = {}, limit = 50) {
  return warehouse.selectRecent(opts)
    .filter(isUnderReported)
    .slice(-limit).reverse()
    .map((t) => ({
      tdrId: t.id, epoch: t.epoch, type: t.type, operatorId: t.operator.id, operatorName: t.operator.name,
      amountXaf: t.amountXaf, feeCollected: t.fee.amount, feeExpected: t.fee.expected,
      gapXaf: t.fee.expected - t.fee.amount, city: t.cellOrigin ? t.cellOrigin.city : null,
    }));
}

module.exports = { report, discrepancies, feeAggregates, contributionDue, hasDeclaredFee, isUnderReported, isOverReported };
