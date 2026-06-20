'use strict';

// =============================================================================
// Module 6 — Qualité de service (cahier §2 #6).
// Taux d'échec, disponibilité (estimée), performance (latence) par opérateur et
// par canal, ventilation des codes d'erreur, et détection de manquements aux
// seuils (config Admin : taux de succès minimal, latence maximale).
// =============================================================================

const ref = require('./referentiel');
const config = require('./config');
const warehouse = require('./warehouse');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function aggregate(list) {
  const total = list.length;
  const success = list.filter((t) => t.status === 'SUCCESS').length;
  const failed = total - success;
  const latencies = list.map((t) => t.latencyMs || 0).sort((a, b) => a - b);
  const errors = {};
  for (const t of list) if (t.status === 'FAILED' && t.errorCode) errors[t.errorCode] = (errors[t.errorCode] || 0) + 1;
  return {
    total, success, failed,
    successRate: total ? +(success / total).toFixed(4) : 1,
    avgLatencyMs: total ? Math.round(latencies.reduce((s, n) => s + n, 0) / total) : 0,
    p95LatencyMs: percentile(latencies, 0.95),
    errors: Object.entries(errors)
      .map(([code, count]) => ({ code, label: (ref.errorByCode.get(code) || {}).label || code, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function report(opts = {}) {
  const q = config.getQos();
  const list = warehouse.selectRecent(opts);

  const byOperator = ref.OPERATORS
    .filter((op) => !opts.operatorId || op.id === opts.operatorId)
    .map((op) => {
      const sub = list.filter((t) => t.operator.id === op.id);
      const agg = aggregate(sub);
      const breaches = [];
      if (agg.total >= 20 && agg.successRate < q.minSuccessRate) breaches.push(`Taux de succès ${(agg.successRate * 100).toFixed(1)}% < ${(q.minSuccessRate * 100).toFixed(0)}%`);
      if (agg.avgLatencyMs > q.maxLatencyMs) breaches.push(`Latence moyenne ${agg.avgLatencyMs} ms > ${q.maxLatencyMs} ms`);
      return { operatorId: op.id, name: op.name, engine: op.engine, color: op.color, ...agg, breaches };
    });

  const byChannel = ref.CHANNELS.map((ch) => {
    const sub = list.filter((t) => t.channel === ch.id);
    return { channel: ch.id, label: ch.label, ...aggregate(sub) };
  });

  const overall = aggregate(list);
  return { thresholds: q, overall, byOperator, byChannel };
}

module.exports = { report };
