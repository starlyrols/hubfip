'use strict';

// =============================================================================
// Tests de non-régression de la série P2 :
//   n°23 rôle lecteur (multi-instance) · n°24 durcissement de la chaîne de
//   construction · n°25 métriques et alertes · n°26 durabilité groupée
// =============================================================================

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

process.env.SUMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-p2-'));
process.env.SUMO_KEY_PASSPHRASE = 'phrase-p2-eprouvee-2026';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/config').load();
const ledger = require('../lib/ledger');
ledger.init();
require('../lib/audit').init();
const metrics = require('../lib/metrics');
const model = require('../lib/model');
const { createApp } = require('../lib/createApp');
const { externalInput } = require('./helpers');

const RACINE = path.resolve(__dirname, '..');
const listen = (app) => new Promise((r) => { const s = http.createServer(app); s.listen(0, () => r(s)); });
const base = (s) => `http://127.0.0.1:${s.address().port}`;

// ---------------------------------------------------------------------------
// n°25 — métriques
// ---------------------------------------------------------------------------
test('P2-25 : l\'exposition suit le format Prometheus et porte les métriques métier', () => {
  const corps = metrics.render({
    ledger: { total: 42 },
    integrity: { tdr: { valid: true, at: new Date().toISOString() } },
    anchor: { anchored: true, valid: true, receipt: { seq: 42 } },
    retention: { aPurger: [{ tier: 'P2', segment: '2023-01' }], politique: { P2: { purges: 3 } } },
    connectors: { connecteurs: 3, clesDistinctes: 3, avecMtls: 0 },
    credentials: { comptes: 31, secretsDistincts: 31, changementRequis: 0, expires: 0, verrouilles: 0, totpActifs: 6, totpRequis: 6 },
    revenue: { declarationCoverage: 0.98, byOperator: [{ operatorId: 'airtel', discrepancyXaf: 3353, underReportedCount: 2 }] },
    scanner: { queued: 0, busy: false },
  });

  // Format : chaque métrique porte son HELP et son TYPE.
  for (const nom of ['sumo_ledger_records_total', 'sumo_ledger_integrity_valid', 'sumo_anchor_valid',
    'sumo_retention_segments_due', 'sumo_declaration_coverage_ratio', 'sumo_accounts_distinct_secrets',
    'sumo_eventloop_lag_seconds']) {
    assert.ok(corps.includes(`# HELP ${nom} `), `HELP manquant pour ${nom}`);
    assert.ok(corps.includes(`# TYPE ${nom} `), `TYPE manquant pour ${nom}`);
  }

  // Les valeurs métier sont bien celles fournies, avec leurs étiquettes.
  assert.match(corps, /sumo_ledger_records_total\{chain="tdr"\} 42/);
  assert.match(corps, /sumo_declaration_coverage_ratio 0\.98/);
  assert.match(corps, /sumo_revenue_discrepancy_xaf\{operator="airtel"\} 3353/);
  assert.match(corps, /sumo_retention_segments_due 1/);
  assert.match(corps, /sumo_anchor_valid 1/);

  // Une chaîne rompue doit produire 0, pas l'absence de la métrique : une alerte
  // ne peut pas se déclencher sur une série absente.
  const rompu = metrics.render({ integrity: { tdr: { valid: false, at: new Date().toISOString() } } });
  assert.match(rompu, /sumo_ledger_integrity_valid\{chain="tdr"\} 0/);
});

test('P2-25 : la collecte est refusée hors du réseau interne', async () => {
  const s = await listen(createApp({ serveStatic: false, behindTlsProxy: true }));
  const distant = await fetch(base(s) + '/metrics', { headers: { 'X-Forwarded-For': '41.158.20.7' } });
  assert.equal(distant.status, 403);

  const local = await fetch(base(s) + '/metrics');
  assert.equal(local.status, 200);
  assert.match(local.headers.get('content-type') || '', /text\/plain/);
  assert.match(await local.text(), /sumo_process_uptime_seconds/);
  s.close();
});

test('P2-25 : les règles d\'alerte couvrent les incidents PROBANTS, pas seulement techniques', () => {
  const brut = fs.readFileSync(path.join(RACINE, 'docs', 'observabilite', 'alertes-prometheus.yml'), 'utf8');
  // Les alertes critiques doivent viser la preuve et la conformité.
  for (const alerte of ['SumoChaineRompue', 'SumoReecritureDetectee', 'SumoEcheanceConservationDepassee',
    'SumoSecretPartageEntreComptes', 'SumoCouvertureDeclarativeDegradee']) {
    assert.ok(brut.includes(`alert: ${alerte}`), `règle manquante : ${alerte}`);
  }
  // Chaque règle dit QUOI FAIRE : une alerte sans conduite à tenir finit ignorée.
  const nbAlertes = (brut.match(/- alert: /g) || []).length;
  const nbActions = (brut.match(/^\s+action: /gm) || []).length;
  assert.equal(nbActions, nbAlertes, 'chaque alerte doit porter une conduite à tenir');

  // Les métriques citées doivent exister dans l'exposition.
  const expose = metrics.render({});
  for (const m of ['sumo_ledger_integrity_valid', 'sumo_anchor_valid', 'sumo_eventloop_lag_seconds']) {
    assert.ok(brut.includes(m), `règle ne référence pas ${m}`);
  }
  assert.ok(expose.includes('sumo_eventloop_lag_seconds'));
});

// ---------------------------------------------------------------------------
// n°26 — durabilité groupée et débit
// ---------------------------------------------------------------------------
test('P2-26 : la validation groupée préserve l\'intégrité de la chaîne', () => {
  for (let i = 0; i < 500; i++) ledger.append(model.buildTDR(externalInput({ amount: 1000 + i })));
  const v = ledger.verifyChain();
  assert.equal(v.valid, true, 'regrouper les synchronisations ne doit rien changer au chaînage');
  assert.ok(v.checked >= 500);
});

test('P2-26 : une fermeture propre force la synchronisation — aucun enregistrement perdu', () => {
  const avant = ledger.stats().total;
  ledger.append(model.buildTDR(externalInput({ amount: 4242 })));
  ledger.close();
  // Relecture depuis le disque, dans l'état où une reprise le trouverait.
  const lignes = fs.readFileSync(ledger.file, 'utf8').trimEnd().split('\n');
  assert.equal(lignes.length, avant + 1, 'le dernier enregistrement doit être sur le disque');
  ledger.init();
});

// ---------------------------------------------------------------------------
// n°23 — rôle lecteur
// ---------------------------------------------------------------------------
test('P2-23 : un lecteur démarre SANS verrou, à côté d\'un écrivain', () => {
  // L'écrivain (ce processus) détient le verrou. Un lecteur doit pouvoir ouvrir
  // le même répertoire — c'est tout l'intérêt du rôle.
  const script = `
    process.env.SUMO_DATA_DIR = ${JSON.stringify(process.env.SUMO_DATA_DIR)};
    process.env.SUMO_KEY_PASSPHRASE = ${JSON.stringify(process.env.SUMO_KEY_PASSPHRASE)};
    const l = require(${JSON.stringify(path.resolve(__dirname, '../lib/ledger'))});
    try { l.openReadOnly(); console.log('LECTURE:' + l.stats().total); }
    catch (e) { console.log('REFUSE:' + e.message); }
  `;
  const sortie = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
  assert.match(sortie, /^LECTURE:\d+/, `le lecteur doit pouvoir ouvrir le registre — reçu : ${sortie}`);

  // Et un second ÉCRIVAIN reste refusé : le correctif C1 tient toujours.
  const scriptW = script.replace('l.openReadOnly()', 'l.init()');
  const sortieW = execFileSync(process.execPath, ['-e', scriptW], { encoding: 'utf8' }).trim();
  assert.match(sortieW, /^REFUSE:.*déjà ouvert en écriture/);
});

// ---------------------------------------------------------------------------
// n°24 — durcissement de la chaîne de construction
// ---------------------------------------------------------------------------
test('P2-24 : l\'image est épinglée, multi-étages et sans script d\'installation', () => {
  const df = fs.readFileSync(path.join(RACINE, 'Dockerfile'), 'utf8');
  assert.match(df, /FROM node:\d+\.\d+\.\d+-alpine[\d.]+/, 'la base doit être épinglée à une version exacte');
  assert.ok(!/FROM node:\d+-alpine\s*$/m.test(df), 'un tag majeur seul se déplacerait entre deux constructions');
  assert.match(df, /AS deps/, 'construction en deux étages');
  assert.match(df, /--ignore-scripts/, 'aucune exécution de code de paquet à l\'installation');
  assert.match(df, /USER 10001:10001/, 'exécution en utilisateur non privilégié explicite');
});

test('P2-24 : le conteneur applicatif est confiné et le réseau segmenté', () => {
  const compose = fs.readFileSync(path.join(RACINE, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /read_only: true/, 'système de fichiers applicatif en lecture seule');
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /internal: true/, 'le réseau applicatif ne doit pas avoir d\'accès sortant');
  assert.match(compose, /limits: \{ cpus/, 'limites de ressources posées');
});

test('P2-24 : la chaîne d\'intégration bloque sur les vulnérabilités', () => {
  const ci = fs.readFileSync(path.join(RACINE, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm audit --omit=dev --audit-level=high/, 'l\'audit doit être bloquant');
  assert.ok(!/npm audit --omit=dev \|\| true[\s\S]*audit-level/.test(ci), 'l\'audit bloquant ne doit pas être neutralisé');
  assert.match(ci, /trivy-action/, 'analyse de vulnérabilités de l\'image');
  assert.match(ci, /exit-code: '1'/, 'l\'analyse d\'image doit faire échouer la chaîne');
});

test('P2-24 : le proxy pose les en-têtes de sécurité et neutralise l\'en-tête de certificat', () => {
  const caddy = fs.readFileSync(path.join(RACINE, 'Caddyfile'), 'utf8');
  for (const h of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    assert.ok(caddy.includes(h), `en-tête manquant : ${h}`);
  }
  // Sans mTLS actif, un client ne doit pas pouvoir se forger une empreinte.
  assert.match(caddy, /header_up -X-Client-Cert-Fingerprint/);
});

after(() => require('../lib/scanner').close());
