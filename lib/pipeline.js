'use strict';

// =============================================================================
// Pipeline d'enrichissement — colonne vertébrale temps réel.
// Chaque TDR (simulateur OU connecteur externe) traverse les détecteurs :
//   règles AML/fraude (Module 7) → géolocalisation/anomalies (Module 9) →
//   scoring de risque/anomalies (Module 10).
// Les alertes et le score sont attachés au TDR avant scellement au registre et
// agrégation. Partagé pour garantir un traitement identique de toutes les sources.
// =============================================================================

const rules = require('./rules');
const geo = require('./geo');
const ml = require('./ml');

const SEV_RANK = { ELEVEE: 3, MOYENNE: 2, FAIBLE: 1 };

function enrich(tdr) {
  const alerts = rules.evaluate(tdr);
  const geoAlert = geo.evaluate(tdr);
  if (geoAlert) alerts.push(geoAlert);
  const risk = ml.evaluate(tdr, alerts);

  let severity = null;
  for (const a of alerts) if (!severity || SEV_RANK[a.severity] > SEV_RANK[severity]) severity = a.severity;

  tdr.alerts = alerts;
  tdr.geoAlert = geoAlert || null;
  tdr.risk = risk;
  tdr.anomaly = {
    flagged: alerts.length > 0,
    severity,
    reason: alerts.length ? alerts[0].label : (tdr.status === 'FAILED' ? 'Transaction échouée' : null),
  };
  return tdr;
}

module.exports = { enrich };
