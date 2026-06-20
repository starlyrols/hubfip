'use strict';

// =============================================================================
// Module 11 — Reporting réglementaire (cahier §2 #11).
// Modèles de rapports personnalisables sur PÉRIODE ARBITRAIRE, calculés depuis le
// registre signé (lac de données) : observatoire, redevances, QoS, AML. Export
// CSV/JSON (signé par l'endpoint via la clé du registre). Diffusion = téléchargement.
// =============================================================================

const ref = require('./referentiel');
const ledger = require('./ledger');
const config = require('./config');

const TEMPLATES = [
  { id: 'observatoire', label: 'Observatoire du marché', description: 'Volumes, valeurs, parts de marché, ventilation par type et canal.' },
  { id: 'redevances', label: 'Revenus & redevances', description: 'Frais perçus vs attendus, écarts, redevance réglementaire due.' },
  { id: 'qos', label: 'Qualité de service', description: 'Taux de succès, latence et codes d\'erreur par opérateur.' },
  { id: 'aml', label: 'Antifraude / AML', description: 'Alertes par règle et transactions au-dessus du seuil de déclaration.' },
];

function loadTdr({ start, end, operatorId }) {
  const from = start ? new Date(start).getTime() : -Infinity;
  const to = end ? new Date(end).getTime() : Infinity;
  return ledger.readAll((p) =>
    p.epoch >= from && p.epoch <= to
    && (!operatorId || p.operator.id === operatorId || p.receiverOperator.id === operatorId)
  ).map((r) => r.payload);
}

function kpisOf(list) {
  const sumXaf = list.reduce((s, t) => s + t.amountXaf, 0);
  const feeXaf = list.reduce((s, t) => s + t.fee.amount, 0);
  const success = list.filter((t) => t.status === 'SUCCESS').length;
  return {
    transactions: list.length, volumeXaf: sumXaf, fraisXaf: feeXaf,
    tauxSucces: list.length ? +(success / list.length).toFixed(4) : 1,
  };
}

function observatoire(list) {
  const base = list.reduce((s, t) => s + t.amountXaf, 0) || 1;
  const byOp = {};
  for (const t of list) {
    const e = byOp[t.operator.id] || (byOp[t.operator.id] = { count: 0, sumXaf: 0 });
    e.count++; e.sumXaf += t.amountXaf;
  }
  const opRows = Object.entries(byOp).map(([id, e]) => ({
    operateur: (ref.byId.get(id) || {}).name || id, transactions: e.count, volume_xaf: e.sumXaf,
    part_marche_pct: +(100 * e.sumXaf / base).toFixed(2),
  })).sort((a, b) => b.volume_xaf - a.volume_xaf);

  const byType = {};
  for (const t of list) { const e = byType[t.type] || (byType[t.type] = { count: 0, sumXaf: 0 }); e.count++; e.sumXaf += t.amountXaf; }
  const typeRows = Object.entries(byType).map(([id, e]) => ({ type: (ref.txTypeById.get(id) || {}).label || id, transactions: e.count, volume_xaf: e.sumXaf }));

  return {
    kpis: kpisOf(list),
    sections: [
      { title: 'Parts de marché par opérateur', columns: ['operateur', 'transactions', 'volume_xaf', 'part_marche_pct'], rows: opRows },
      { title: 'Ventilation par type de transaction', columns: ['type', 'transactions', 'volume_xaf'], rows: typeRows },
    ],
    main: { columns: ['operateur', 'transactions', 'volume_xaf', 'part_marche_pct'], rows: opRows },
  };
}

function redevances(list) {
  const rate = config.get().contributionRate;
  const byOp = {};
  for (const t of list) {
    if (t.status !== 'SUCCESS') continue;
    const e = byOp[t.operator.id] || (byOp[t.operator.id] = { collected: 0, expected: 0, under: 0, n: 0 });
    e.collected += t.fee.amount; e.expected += t.fee.expected; e.n++;
    if (t.fee.amount < t.fee.expected - 1) e.under++;
  }
  const rows = Object.entries(byOp).map(([id, e]) => ({
    operateur: (ref.byId.get(id) || {}).name || id, transactions: e.n,
    frais_percus_xaf: e.collected, frais_attendus_xaf: e.expected,
    ecart_xaf: e.expected - e.collected, sous_declarations: e.under,
    redevance_due_xaf: Math.round(e.collected * rate),
  })).sort((a, b) => b.ecart_xaf - a.ecart_xaf);
  return { kpis: { taux_redevance: rate, ...kpisOf(list) }, sections: [{ title: 'Revenus & redevances par opérateur', columns: Object.keys(rows[0] || { operateur: 1 }), rows }], main: { columns: ['operateur', 'frais_percus_xaf', 'frais_attendus_xaf', 'ecart_xaf', 'redevance_due_xaf'], rows } };
}

function qos(list) {
  const byOp = {};
  for (const t of list) {
    const e = byOp[t.operator.id] || (byOp[t.operator.id] = { n: 0, ok: 0, lat: [] });
    e.n++; if (t.status === 'SUCCESS') e.ok++; e.lat.push(t.latencyMs || 0);
  }
  const rows = Object.entries(byOp).map(([id, e]) => {
    e.lat.sort((a, b) => a - b);
    return {
      operateur: (ref.byId.get(id) || {}).name || id, transactions: e.n,
      taux_succes_pct: e.n ? +(100 * e.ok / e.n).toFixed(2) : 100,
      latence_moy_ms: e.n ? Math.round(e.lat.reduce((s, n) => s + n, 0) / e.n) : 0,
      latence_p95_ms: e.lat[Math.floor(0.95 * e.lat.length)] || 0,
    };
  }).sort((a, b) => a.taux_succes_pct - b.taux_succes_pct);
  return { kpis: kpisOf(list), sections: [{ title: 'Qualité de service par opérateur', columns: Object.keys(rows[0] || { operateur: 1 }), rows }], main: { columns: ['operateur', 'transactions', 'taux_succes_pct', 'latence_moy_ms', 'latence_p95_ms'], rows } };
}

function aml(list) {
  const thr = config.getRules().reportingThresholdXaf;
  const byRule = {};
  let flagged = 0;
  const overThreshold = [];
  for (const t of list) {
    if (t.alerts && t.alerts.length) {
      flagged++;
      for (const a of t.alerts) byRule[a.ruleId] = (byRule[a.ruleId] || 0) + 1;
    }
    if (t.amountXaf >= thr) {
      overThreshold.push({
        date: new Date(t.epoch).toISOString(), operateur: (ref.byId.get(t.operator.id) || {}).name || t.operator.id,
        type: t.type, montant_xaf: t.amountXaf, msisdn: ref.maskMsisdn(t.sender.msisdn), ville: t.cellOrigin.city,
      });
    }
  }
  const ruleRows = Object.entries(byRule).map(([id, count]) => ({ regle: id, alertes: count })).sort((a, b) => b.alertes - a.alertes);
  return {
    kpis: { seuil_declaration_xaf: thr, transactions_signalees: flagged, transactions_sur_seuil: overThreshold.length },
    sections: [
      { title: 'Alertes par règle', columns: ['regle', 'alertes'], rows: ruleRows },
      { title: 'Transactions au-dessus du seuil de déclaration', columns: ['date', 'operateur', 'type', 'montant_xaf', 'msisdn', 'ville'], rows: overThreshold.slice(-200).reverse() },
    ],
    main: { columns: ['date', 'operateur', 'type', 'montant_xaf', 'msisdn', 'ville'], rows: overThreshold.slice(-500).reverse() },
  };
}

const BUILDERS = { observatoire, redevances, qos, aml };

function generate(templateId, opts = {}) {
  const tpl = TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw new Error(`Modèle de rapport inconnu: ${templateId}`);
  const list = loadTdr(opts);
  const body = BUILDERS[templateId](list);
  return {
    template: tpl.id, label: tpl.label,
    period: { start: opts.start || null, end: opts.end || null, operatorId: opts.operatorId || null },
    generatedAt: new Date().toISOString(),
    recordCount: list.length,
    ...body,
  };
}

function toCsv(report) {
  const { columns, rows } = report.main || { columns: [], rows: [] };
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

module.exports = { TEMPLATES, generate, toCsv };
