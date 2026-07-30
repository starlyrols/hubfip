'use strict';

// =============================================================================
// Modules 3 & 4 — Référentiel de données (entrepôt analytique) & Observatoire.
// Entrepôt en mémoire alimenté à chaque TDR (cahier §2 #3/#4) : agrégats volumes/
// valeurs/parts de marché, séries temporelles, indicateurs QoS et revenus.
// Le LAC DE DONNÉES brut = registre signé (ledger.jsonl) ; ici on maintient les
// AGRÉGATS (reconstruits depuis le registre au démarrage). Les rapports sur période
// arbitraire relisent le registre (module reporting).
// =============================================================================

const ref = require('./referentiel');

const BUFFER_MAX = 5000; // fenêtre récente pour les ventilations détaillées
const buffer = []; // TDR enrichis récents

// Compteurs « depuis le démarrage » (tout l'historique chargé).
const lifetime = {
  count: 0, sumXaf: 0, feeXaf: 0, expectedFeeXaf: 0,
  success: 0, failed: 0, interop: 0, crossBorder: 0, alerts: 0,
  byOperator: new Map(),
};

function opLife(id) {
  if (!lifetime.byOperator.has(id)) lifetime.byOperator.set(id, { count: 0, sumXaf: 0, feeXaf: 0, expectedFeeXaf: 0, success: 0, failed: 0 });
  return lifetime.byOperator.get(id);
}

function ingest(tdr) {
  buffer.push(tdr);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  lifetime.count++;
  lifetime.sumXaf += tdr.amountXaf;
  lifetime.feeXaf += tdr.fee.amount;
  lifetime.expectedFeeXaf += tdr.fee.expected;
  if (tdr.status === 'SUCCESS') lifetime.success++; else lifetime.failed++;
  if (tdr.interop) lifetime.interop++;
  if (tdr.crossBorder) lifetime.crossBorder++;
  if (tdr.alerts && tdr.alerts.length) lifetime.alerts += tdr.alerts.length;
  const o = opLife(tdr.operator.id);
  o.count++; o.sumXaf += tdr.amountXaf; o.feeXaf += tdr.fee.amount; o.expectedFeeXaf += tdr.fee.expected;
  if (tdr.status === 'SUCCESS') o.success++; else o.failed++;
}

function rebuildFrom(records) {
  for (const r of records) ingest(r.payload || r);
}

// Prédicat UNIQUE du cloisonnement multi-tenant : une transaction appartient au
// périmètre d'un opérateur s'il en est l'émetteur OU le récepteur (interop).
// Toute règle de scope (API, WebSocket, rapports) doit passer par ici.
function matchesOperator(t, operatorId) {
  return !operatorId || t.operator.id === operatorId || t.receiverOperator.id === operatorId;
}

// Sélectionne la fenêtre récente filtrée (scope opérateur, période, type, canal).
function selectRecent({ operatorId, sinceEpoch, untilEpoch, type, channel } = {}) {
  return buffer.filter((t) =>
    matchesOperator(t, operatorId)
    && (!sinceEpoch || t.epoch >= sinceEpoch)
    && (!untilEpoch || t.epoch <= untilEpoch)
    && (!type || t.type === type)
    && (!channel || t.channel === channel));
}

function tally(list) {
  const by = (keyFn) => {
    const m = new Map();
    for (const t of list) {
      const k = keyFn(t); if (k == null) continue;
      if (!m.has(k)) m.set(k, { key: k, count: 0, sumXaf: 0, feeXaf: 0, success: 0, failed: 0 });
      const e = m.get(k);
      e.count++; e.sumXaf += t.amountXaf; e.feeXaf += t.fee.amount;
      if (t.status === 'SUCCESS') e.success++; else e.failed++;
    }
    return [...m.values()].sort((a, b) => b.sumXaf - a.sumXaf);
  };
  return by;
}

// Parts de marché en valeur (mutation en place) — base = somme des volumes.
function marketShares(rows) {
  const base = rows.reduce((s, e) => s + e.sumXaf, 0) || 1;
  rows.forEach((e) => { e.marketSharePct = +(100 * e.sumXaf / base).toFixed(2); });
  return rows;
}

// Série temporelle par minute (n dernières minutes) à partir de la fenêtre.
function minuteSeries(list, minutes = 20) {
  const now = Date.now();
  const m = new Map();
  for (const t of list) {
    const k = Math.floor(t.epoch / 60000);
    if (!m.has(k)) m.set(k, { count: 0, sumXaf: 0 });
    const e = m.get(k); e.count++; e.sumXaf += t.amountXaf;
  }
  const out = [];
  const startMin = Math.floor(now / 60000) - (minutes - 1);
  for (let k = startMin; k <= Math.floor(now / 60000); k++) {
    const e = m.get(k) || { count: 0, sumXaf: 0 };
    out.push({ t: k * 60000, count: e.count, sumXaf: e.sumXaf });
  }
  return out;
}

// Instantané analytique pour l'observatoire.
function snapshot(opts = {}) {
  const list = selectRecent(opts);
  const by = tally(list);

  const totals = list.reduce((s, t) => {
    s.count++; s.sumXaf += t.amountXaf; s.feeXaf += t.fee.amount; s.expectedFeeXaf += t.fee.expected;
    if (t.status === 'SUCCESS') s.success++; else s.failed++;
    if (t.interop) s.interop++; if (t.crossBorder) s.crossBorder++;
    s.latencySum += t.latencyMs || 0; if (t.alerts) s.alerts += t.alerts.length;
    return s;
  }, { count: 0, sumXaf: 0, feeXaf: 0, expectedFeeXaf: 0, success: 0, failed: 0, interop: 0, crossBorder: 0, latencySum: 0, alerts: 0 });

  const byOperator = marketShares(by((t) => t.operator.id).map((e) => {
    const op = ref.byId.get(e.key);
    return { ...e, name: op ? op.name : e.key, engine: op ? op.engine : null, color: op ? op.color : null };
  }));

  const byType = by((t) => t.type).map((e) => ({ ...e, label: (ref.txTypeById.get(e.key) || {}).label || e.key }));
  const byChannel = by((t) => t.channel);
  const byProvince = by((t) => t.cellOrigin.province);

  // Cloisonnement : une session opérateur ne reçoit que SES compteurs cumulés,
  // jamais les agrégats nationaux (données de marché sensibles).
  const lifetimeOut = opts.operatorId
    ? { ...(lifetime.byOperator.get(opts.operatorId) || { count: 0, sumXaf: 0, feeXaf: 0, expectedFeeXaf: 0, success: 0, failed: 0 }) }
    : { ...lifetime, byOperator: undefined };

  return {
    windowSize: list.length,
    lifetime: lifetimeOut,
    totals: {
      ...totals,
      successRate: totals.count ? +(totals.success / totals.count).toFixed(4) : 1,
      avgLatencyMs: totals.count ? Math.round(totals.latencySum / totals.count) : 0,
    },
    byOperator, byType, byChannel, byProvince,
    series: minuteSeries(list, opts.minutes || 20),
  };
}

const recentTx = (limit = 50, opts = {}) => selectRecent(opts).slice(-limit).reverse();
const size = () => buffer.length;
const all = () => buffer.slice();

module.exports = { ingest, rebuildFrom, snapshot, selectRecent, matchesOperator, tally, marketShares, recentTx, size, all, lifetime };
