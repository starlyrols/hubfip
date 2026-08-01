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
const complaints = require('./complaints');

const SEV_RANK = { ELEVEE: 3, MOYENNE: 2, FAIBLE: 1 };

// `enrich` est PURE vis-à-vis de l'extérieur : elle n'écrit que sur le TDR reçu.
// C'est indispensable — le rejeu au démarrage la rappelle sur des TDR déjà
// scellés, et tout effet de bord y serait rejoué (ou dupliqué) à chaque
// redémarrage. Les effets propres à l'arrivée d'un TDR NEUF vivent dans
// `ingest` ci-dessous, appelée uniquement par les points d'entrée du flux.
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

// Enrichissement + effets de bord réservés à un TDR qui ENTRE dans le système
// (tick du simulateur, injection par connecteur) — jamais au rejeu.
// Module M14 : un échec technique peut générer une réclamation consommateur
// corrélée (id du TDR + code d'erreur, MSISDN masqué).
function ingest(tdr) {
  enrich(tdr);
  complaints.maybeFromTdr(tdr);
  return tdr;
}

module.exports = { enrich, ingest };
