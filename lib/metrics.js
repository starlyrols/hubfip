'use strict';

// =============================================================================
// Exposition de métriques au format Prometheus (correctif P2 n°25).
//
// Le constat était qu'aucune métrique ne sortait de la machine : des journaux
// structurés que personne ne collectait, et pas une alerte. Or les incidents que
// ce système doit signaler ne sont pas seulement techniques — une chaîne rompue,
// un écart d'ingestion qui s'installe, une échéance de purge dépassée sont des
// évènements RÉGLEMENTAIRES. Ils méritent d'être vus le jour où ils surviennent,
// pas au prochain audit.
//
// Aucune dépendance : le format d'exposition Prometheus est du texte, et un
// client de plus dans une plateforme souveraine est un client de plus à auditer.
// =============================================================================

const os = require('os');

// --- Compteurs de trafic ----------------------------------------------------
const http = new Map();        // "METHOD|status" -> n
const ingestion = new Map();   // code de refus -> n
let ingestionAccepted = 0;
let ingestionDuplicate = 0;
let wsClients = 0;

const noteHttp = (method, status) => {
  const k = `${method}|${status}`;
  http.set(k, (http.get(k) || 0) + 1);
};
const noteIngestion = (code) => {
  if (code === 'ACCEPTED') { ingestionAccepted++; return; }
  if (code === 'DUPLICATE') { ingestionDuplicate++; return; }
  ingestion.set(code, (ingestion.get(code) || 0) + 1);
};
const setWsClients = (n) => { wsClients = n; };

// --- Retard de la boucle d'évènements ---------------------------------------
// Mesuré en continu : c'est l'indicateur qui aurait révélé le déni de service du
// constat D1 avant qu'un utilisateur ne s'en plaigne.
let lagSeconds = 0;
let lagTimer = null;
function startLagProbe(intervalMs = 1000) {
  if (lagTimer) return;
  let attendu = Date.now() + intervalMs;
  lagTimer = setInterval(() => {
    const maintenant = Date.now();
    lagSeconds = Math.max(0, maintenant - attendu) / 1000;
    attendu = maintenant + intervalMs;
  }, intervalMs);
  lagTimer.unref();
}
const stopLagProbe = () => { if (lagTimer) { clearInterval(lagTimer); lagTimer = null; } };

// --- Formatage --------------------------------------------------------------
const lignes = [];
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

function metrique(nom, type, aide, valeurs) {
  const points = Array.isArray(valeurs) ? valeurs : [{ value: valeurs }];
  const utiles = points.filter((p) => Number.isFinite(Number(p.value)));
  if (!utiles.length) return;
  lignes.push(`# HELP ${nom} ${aide}`);
  lignes.push(`# TYPE ${nom} ${type}`);
  for (const p of utiles) {
    const etiquettes = p.labels
      ? '{' + Object.entries(p.labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',') + '}'
      : '';
    lignes.push(`${nom}${etiquettes} ${Number(p.value)}`);
  }
}

// ---------------------------------------------------------------------------
// Rendu. `sources` est injecté par l'appelant pour éviter que ce module ne
// dépende de la moitié de la plateforme (et ne crée des cycles de chargement).
// ---------------------------------------------------------------------------
function render(sources = {}) {
  lignes.length = 0;
  const { ledger, audit, probes, integrity, anchor, db, scanner, retention, connectors, credentials, revenue, normalize, sessions } = sources;

  // --- Preuve : ce qui doit réveiller quelqu'un la nuit ---------------------
  if (ledger) {
    metrique('sumo_ledger_records_total', 'gauge', 'Enregistrements scellés par chaîne.', [
      { labels: { chain: 'tdr' }, value: ledger.total },
      audit ? { labels: { chain: 'audit' }, value: audit.total } : null,
      probes ? { labels: { chain: 'probes' }, value: probes.total } : null,
    ].filter(Boolean));
  }
  if (integrity) {
    metrique('sumo_ledger_integrity_valid', 'gauge',
      'Intégrité de chaîne au dernier contrôle (1 = valide, 0 = ROMPUE). Une valeur à 0 est un incident probant.',
      Object.entries(integrity).map(([chain, v]) => ({ labels: { chain }, value: v && v.valid ? 1 : 0 })));
    metrique('sumo_ledger_integrity_checked_at', 'gauge', 'Horodatage (epoch, s) du dernier contrôle d\'intégrité.',
      Object.entries(integrity).map(([chain, v]) => ({ labels: { chain }, value: v && v.at ? Math.floor(new Date(v.at).getTime() / 1000) : null })));
  }
  if (anchor) {
    metrique('sumo_anchor_valid', 'gauge',
      'Concordance entre le registre et le dernier reçu d\'ancrage déposé (1 = conforme, 0 = RÉÉCRITURE détectée, absent = aucun reçu).',
      anchor.anchored ? (anchor.valid ? 1 : 0) : null);
    metrique('sumo_anchor_seq', 'gauge', 'Rang du dernier reçu d\'ancrage émis.', anchor.receipt ? anchor.receipt.seq : null);
  }

  // --- Ingestion : l'écart déclaratif est un indicateur RÉGLEMENTAIRE -------
  metrique('sumo_ingestion_accepted_total', 'counter', 'Déclarations acceptées.', ingestionAccepted);
  metrique('sumo_ingestion_duplicate_total', 'counter', 'Déclarations rejouées et dédoublonnées (aucun doublon créé).', ingestionDuplicate);
  metrique('sumo_ingestion_rejected_total', 'counter', 'Déclarations refusées, par motif.',
    [...ingestion.entries()].map(([code, value]) => ({ labels: { code }, value })));
  if (normalize) {
    metrique('sumo_ingestion_completeness_ratio', 'gauge', 'Complétude moyenne des déclarations reçues.', normalize.completenessRate);
  }
  if (revenue) {
    metrique('sumo_declaration_coverage_ratio', 'gauge',
      'Part de l\'assiette dont les frais ont été DÉCLARÉS, donc contrôlables. Une dégradation est un manquement au raccordement.',
      revenue.declarationCoverage);
    metrique('sumo_revenue_discrepancy_xaf', 'gauge',
      'Écart cumulé entre frais attendus et frais déclarés, par opérateur (XAF).',
      (revenue.byOperator || []).map((o) => ({ labels: { operator: o.operatorId }, value: o.discrepancyXaf })));
    metrique('sumo_revenue_underreported_total', 'gauge', 'Transactions en sous-déclaration constatée, par opérateur.',
      (revenue.byOperator || []).map((o) => ({ labels: { operator: o.operatorId }, value: o.underReportedCount })));
  }
  if (connectors) {
    metrique('sumo_connectors_total', 'gauge', 'Connecteurs déclarés.', connectors.connecteurs);
    metrique('sumo_connectors_distinct_keys', 'gauge',
      'Clés distinctes. Doit égaler le nombre de connecteurs : une valeur inférieure signale un secret partagé.',
      connectors.clesDistinctes);
    metrique('sumo_connectors_with_mtls', 'gauge', 'Connecteurs exigeant un certificat client.', connectors.avecMtls);
  }

  // --- Conservation ---------------------------------------------------------
  if (retention) {
    metrique('sumo_retention_segments_due', 'gauge',
      'Segments dont l\'échéance de conservation est dépassée et la clé encore vivante. Doit revenir à 0 après chaque purge.',
      (retention.aPurger || []).length);
    metrique('sumo_retention_segments_purged', 'gauge', 'Segments dont la clé a été détruite, par palier.',
      Object.entries(retention.politique || {}).map(([tier, p]) => ({ labels: { tier }, value: p.purges })));
  }

  // --- Identités ------------------------------------------------------------
  if (credentials) {
    metrique('sumo_accounts_total', 'gauge', 'Comptes déclarés.', credentials.comptes);
    metrique('sumo_accounts_distinct_secrets', 'gauge',
      'Secrets distincts. Doit égaler le nombre de comptes : sinon l\'imputabilité individuelle est perdue.',
      credentials.secretsDistincts);
    metrique('sumo_accounts_pending_password_change', 'gauge', 'Comptes n\'ayant pas encore changé leur secret initial.', credentials.changementRequis);
    metrique('sumo_accounts_expired', 'gauge', 'Comptes au secret expiré.', credentials.expires);
    metrique('sumo_accounts_locked', 'gauge', 'Comptes temporairement verrouillés.', credentials.verrouilles);
    metrique('sumo_accounts_mfa_active', 'gauge', 'Profils habilités ayant activé leur second facteur.', credentials.totpActifs);
    metrique('sumo_accounts_mfa_required', 'gauge', 'Profils habilités devant porter un second facteur.', credentials.totpRequis);
  }
  if (sessions != null) metrique('sumo_sessions_active', 'gauge', 'Sessions ouvertes.', sessions);

  // --- Entrepôt & lecture ---------------------------------------------------
  if (db) {
    const sante = { OK: 0, RETARD: 1, PERTE: 2, DEGRADE: 3 };
    metrique('sumo_db_enabled', 'gauge', 'Entrepôt relationnel actif.', db.enabled ? 1 : 0);
    metrique('sumo_db_health', 'gauge', 'Santé de l\'entrepôt : 0 OK, 1 retard, 2 perte, 3 dégradé.', db.sante != null ? sante[db.sante] : null);
    metrique('sumo_db_queue_depth', 'gauge', 'Profondeur de la file d\'écriture.', db.enFile);
    if (db.metriques) {
      metrique('sumo_db_written_total', 'counter', 'Enregistrements écrits à l\'entrepôt.', db.metriques.ecrits);
      metrique('sumo_db_dropped_total', 'counter', 'Enregistrements ABANDONNÉS par contre-pression. Toute valeur non nulle est un incident.', db.metriques.abandonnes);
      metrique('sumo_db_flush_failures_total', 'counter', 'Échecs d\'écriture de lot.', db.metriques.echecs);
    }
  }
  if (scanner) {
    metrique('sumo_scanner_queue_depth', 'gauge', 'Parcours de registre en attente.', scanner.queued);
    metrique('sumo_scanner_busy', 'gauge', 'Fil de parcours occupé.', scanner.busy ? 1 : 0);
  }

  // --- Trafic & processus ---------------------------------------------------
  metrique('sumo_http_requests_total', 'counter', 'Requêtes HTTP servies.',
    [...http.entries()].map(([k, value]) => {
      const [method, status] = k.split('|');
      return { labels: { method, status }, value };
    }));
  metrique('sumo_ws_clients', 'gauge', 'Clients WebSocket connectés.', wsClients);
  metrique('sumo_eventloop_lag_seconds', 'gauge',
    'Retard de la boucle d\'évènements. Une valeur durablement élevée signale un traitement bloquant dans le fil principal.',
    lagSeconds);
  metrique('sumo_process_resident_memory_bytes', 'gauge', 'Mémoire résidente du processus.', process.memoryUsage().rss);
  metrique('sumo_process_heap_used_bytes', 'gauge', 'Tas utilisé.', process.memoryUsage().heapUsed);
  metrique('sumo_process_uptime_seconds', 'gauge', 'Durée de fonctionnement du processus.', Math.round(process.uptime()));
  metrique('sumo_host_load1', 'gauge', 'Charge système à 1 minute.', os.loadavg()[0]);

  return lignes.join('\n') + '\n';
}

module.exports = { render, noteHttp, noteIngestion, setWsClients, startLagProbe, stopLagProbe, CONTENT_TYPE: 'text/plain; version=0.0.4; charset=utf-8' };
