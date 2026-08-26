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

// Correctif A2/A4 : la latence n'est calculée que sur les transactions dont la
// latence a été RÉELLEMENT transmise (`latencyMs` non nul) — auparavant, les
// enregistrements sans mesure comptaient pour 0 ms, ou pire portaient une valeur
// aléatoire. Le taux de succès ne porte que sur les transactions DÉNOUÉES : une
// transaction en attente ou annulée n'est ni un succès ni un échec.
function aggregate(list) {
  const total = list.length;
  const success = list.filter((t) => t.status === 'SUCCESS').length;
  const failed = list.filter((t) => t.status === 'FAILED').length;
  const pending = list.filter((t) => t.status === 'PENDING').length;
  const reversed = list.filter((t) => t.status === 'REVERSED').length;
  const settled = success + failed;

  const measured = list.filter((t) => typeof t.latencyMs === 'number' && Number.isFinite(t.latencyMs));
  const latencies = measured.map((t) => t.latencyMs).sort((a, b) => a - b);

  const errors = {};
  for (const t of list) if (t.status === 'FAILED' && t.errorCode) errors[t.errorCode] = (errors[t.errorCode] || 0) + 1;
  return {
    total, success, failed, pending, reversed, settled,
    successRate: settled ? +(success / settled).toFixed(4) : 1,
    // Échantillon et couverture : un indicateur de latence calculé sur 3 mesures
    // ne vaut pas celui calculé sur 3 000 — l'écran doit pouvoir le dire.
    latencySample: measured.length,
    latencyCoverage: total ? +(measured.length / total).toFixed(4) : 0,
    avgLatencyMs: measured.length ? Math.round(latencies.reduce((s, n) => s + n, 0) / measured.length) : null,
    p95LatencyMs: measured.length ? percentile(latencies, 0.95) : null,
    errors: Object.entries(errors)
      .map(([code, count]) => ({ code, label: (ref.errorByCode.get(code) || {}).label || code, count }))
      .sort((a, b) => b.count - a.count),
  };
}

// Échantillon minimal avant qu'un indicateur puisse fonder un manquement opposable.
const MIN_SAMPLE = 20;

function report(opts = {}) {
  const q = config.getQos();
  const list = warehouse.selectRecent(opts);

  const byOperator = ref.OPERATORS
    .filter((op) => !opts.operatorId || op.id === opts.operatorId)
    .map((op) => {
      const sub = list.filter((t) => t.operator.id === op.id);
      const agg = aggregate(sub);
      const breaches = [];
      // Correctif A8 : un manquement ne se constate pas sur un échantillon d'une
      // transaction. Les deux seuils exigent désormais le même socle statistique.
      if (agg.settled >= MIN_SAMPLE && agg.successRate < q.minSuccessRate) breaches.push(`Taux de succès ${(agg.successRate * 100).toFixed(1)}% < ${(q.minSuccessRate * 100).toFixed(0)}% (sur ${agg.settled} transactions dénouées)`);
      if (agg.latencySample >= MIN_SAMPLE && agg.avgLatencyMs > q.maxLatencyMs) breaches.push(`Latence moyenne ${agg.avgLatencyMs} ms > ${q.maxLatencyMs} ms (sur ${agg.latencySample} mesures)`);
      return { operatorId: op.id, name: op.name, engine: op.engine, color: op.color, ...agg, breaches };
    });

  const byChannel = ref.CHANNELS.map((ch) => {
    const sub = list.filter((t) => t.channel === ch.id);
    return { channel: ch.id, label: ch.label, ...aggregate(sub) };
  });

  const overall = aggregate(list);
  return { thresholds: q, overall, byOperator, byChannel };
}

module.exports = { report, aggregate, percentile };
