'use strict';

// =============================================================================
// SUMo — Supervision Unifiée du Mobile Money (modèle inspiré de M3).
// Serveur HTTP(S) + WebSocket. Initialise les magasins, REJOUE le registre pour
// reconstruire l'entrepôt et les détecteurs, lance le pipeline temps réel, et
// diffuse les TDR (masqués + cloisonnés par opérateur).
// PROTOTYPE / DÉMONSTRATION — données simulées, sans mandat officiel.
// =============================================================================

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const logger = require('./lib/logger');
const ref = require('./lib/referentiel');
const config = require('./lib/config');
const ledger = require('./lib/ledger');
const audit = require('./lib/audit');
const warehouse = require('./lib/warehouse');
const cases = require('./lib/cases');
const db = require('./lib/db');
const pipeline = require('./lib/pipeline');
const model = require('./lib/model');
const simulator = require('./lib/simulator');
const auth = require('./lib/auth');
const users = require('./lib/users');
const probes = require('./lib/probes');
const postal = require('./lib/postal');
const assignments = require('./lib/assignments');
const nomenclature = require('./lib/nomenclature');
const scanner = require('./lib/scanner');
const connectors = require('./lib/connectors');
const anchor = require('./lib/anchor');
const retention = require('./lib/retention');
const metrics = require('./lib/metrics');
const { createApp, originAllowed } = require('./lib/createApp');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = ledger.DATA_DIR;
const TLS_DIR = path.join(DATA_DIR, 'tls');
const REPLAY_MAX = Number(process.env.SUMO_REPLAY_MAX) || 8000;

// Correctif P0 n°8 — fond de carte SOUVERAIN. Aucun fournisseur de tuiles par
// défaut : les tuiles précédentes venaient d'un CDN étranger, à qui chaque
// déplacement de la carte révélait la zone examinée par l'enquêteur. Sans URL
// configurée, la carte se dessine sur un fond local (graticule + villes du
// référentiel) — parfaitement lisible, et rien ne sort du système d'information.
const TILE_URL = process.env.SUMO_TILE_URL || null;
const TILE_ATTRIBUTION = process.env.SUMO_TILE_ATTRIBUTION || '';

// --- Rôle de l'instance (correctif P2 n°23) ---------------------------------
// Premier pas concret vers le multi-instance. Le registre impose UN SEUL
// écrivain — c'est ce qui a détruit 108 457 enregistrements le 8 août 2026 quand
// deux processus ont écrit ensemble. On ne peut donc pas multiplier les
// instances complètes ; on peut, en revanche, multiplier les LECTEURS.
//
//   SUMO_ROLE=writer (défaut) : prend le verrou, ingère, simule, sonde, purge
//   SUMO_ROLE=reader          : ne prend AUCUN verrou, n'écrit rien, sert la
//                               console et les rapports depuis le volume partagé
//
// Un lecteur peut donc être déployé en plusieurs exemplaires derrière le
// répartiteur pour absorber la consultation, sans jamais menacer la chaîne.
// Restent à externaliser pour un vrai multi-instance : les sessions (aujourd'hui
// en mémoire, donc à affinité de session) et l'entrepôt analytique.
const ROLE = process.env.SUMO_ROLE === 'reader' ? 'reader' : 'writer';
const IS_READER = ROLE === 'reader';

const DEMO_LOGIN = process.env.NODE_ENV !== 'production' && process.env.SUMO_DEMO_LOGIN !== '0';
// Derrière un reverse proxy terminant le TLS (Caddy/nginx) — cf. docker-compose.
const BEHIND_TLS_PROXY = ['1', 'true', 'yes'].includes(String(process.env.SUMO_TRUST_PROXY || '').toLowerCase());

// ---- Initialisation des magasins -------------------------------------------
ref.validate();
config.load();
assignments.load(); // affectations de modules (dispatch admin système)
fs.mkdirSync(DATA_DIR, { recursive: true });

// Correctif C1 : chaque chaîne prend un VERROU D'ÉCRIVAIN EXCLUSIF. Si une autre
// instance vit déjà sur ce SUMO_DATA_DIR, on refuse de démarrer plutôt que d'aller
// entrelacer les écritures et rompre la chaîne — c'est exactement ce qui a détruit
// 108 457 enregistrements le 8 août 2026.
try {
  if (IS_READER) {
    // Ouverture SANS verrou : un lecteur ne doit jamais empêcher l'écrivain de
    // démarrer, ni prétendre écrire.
    ledger.openReadOnly();
    audit.openReadOnly();
    probes.journal.openReadOnly();
    require('./lib/archives').openReadOnly();
    logger.info('role.reader', { note: 'instance en lecture seule — aucun verrou pris, aucune écriture' });
  } else {
    ledger.init();
    audit.init();
    probes.init(); // journal probant N3 (chaîne signée dédiée)
    require('./lib/archives').init(); // registre des ARCHIVES de dossiers (M15)
    require('./lib/archives').seedFromChain();
  }
} catch (e) {
  logger.error('ledger.lock.refused', { error: e.message });
  console.error('\n  DÉMARRAGE REFUSÉ — ' + e.message + '\n');
  process.exit(1);
}
cases.load();
// Correctif B3 : les identifiants individuels sont matérialisés AU DÉMARRAGE, pas
// à la première tentative de connexion — sinon le fichier de remise des mots de
// passe initiaux n'existerait pas encore quand l'exploitant vient le chercher.
users.ensureCredentials();
// Correctif P1 n°11 : identifiants de connecteur PAR ASSUJETTI (fin de la clé
// partagée), matérialisés au démarrage comme les identités humaines.
connectors.load();

// Correctif C1/C3 : contrôle d'intégrité INTÉGRAL au démarrage — chaînage et
// continuité de séquence sur 100 % des enregistrements, signatures échantillonnées.
// Une chaîne rompue n'est pas un incident d'exploitation à constater plus tard sur
// un écran : c'est une décision humaine. Le service refuse de repartir sauf
// SUMO_ALLOW_BROKEN_LEDGER=1 (reprise explicite, sous responsabilité).
const ALLOW_BROKEN = process.env.SUMO_ALLOW_BROKEN_LEDGER === '1';
const startupIntegrity = {};
if (process.env.SUMO_VERIFY_ON_START !== '0') {
  for (const [label, chain] of [['tdr', ledger], ['audit', audit], ['probes', probes.journal]]) {
    const t0 = Date.now();
    const v = label === 'audit' ? audit.verify({ signatures: 'sample' }) : chain.verifyChain({ signatures: 'sample' });
    startupIntegrity[label] = { ...v, at: new Date().toISOString(), durationMs: Date.now() - t0 };
    if (v.valid) logger.info('ledger.verified', { chain: label, records: v.checked, signatures: v.signaturesChecked, ms: Date.now() - t0 });
    else {
      logger.error('ledger.broken', { chain: label, brokenAt: v.brokenAt, reason: v.reason, checked: v.checked });
      console.error(`\n  INTÉGRITÉ ROMPUE — chaîne « ${label} » : ${v.reason} au numéro de séquence ${v.brokenAt} (${v.checked} enregistrements contrôlés).`);
      if (!ALLOW_BROKEN) {
        console.error('  Le service refuse de démarrer sur un registre rompu. Constatez, archivez, puis relancez avec SUMO_ALLOW_BROKEN_LEDGER=1.\n');
        process.exit(1);
      }
      console.error('  SUMO_ALLOW_BROKEN_LEDGER=1 — démarrage forcé : les enregistrements antérieurs ne sont PLUS probants.\n');
    }
  }
}
require('./lib/workflow').load(); // M15 — dossiers persistés (ensemencement au 1er démarrage)
db.init().catch((e) => logger.warn('db.init.error', { error: e.message })); // entrepôt PostgreSQL optionnel

// Reconstruction de l'entrepôt + des détecteurs depuis le registre signé.
(function replay() {
  // Lecture arrière bornée : seule la fenêtre rejouée est lue/parsée (le fichier
  // complet peut peser plusieurs Go après des semaines de flux continu).
  const slice = ledger.readTail(REPLAY_MAX);
  for (const r of slice) { pipeline.enrich(r.payload); warehouse.ingest(r.payload); }
  // Réamorçage de l'idempotence : sans lui, un redémarrage rouvrirait une fenêtre
  // pendant laquelle un rejeu passerait pour une transaction neuve.
  connectors.seedFromLedger(slice);
  if (slice.length) logger.info('replay.done', { replayed: slice.length, total: ledger.stats().total });
}());

const STREAM_MS = () => config.get().stream.intervalMs;
const tlsEnabled = fs.existsSync(path.join(TLS_DIR, 'server.key')) && fs.existsSync(path.join(TLS_DIR, 'server.crt'));

// ---- App + serveur ----------------------------------------------------------
// Instantané d'état de l'entrepôt, rafraîchi hors du chemin de collecte : la
// route /metrics doit répondre vite et sans requête réseau.
const dbSnapshot = { enabled: false };
const dbSnapshotTimer = setInterval(() => {
  db.status().then((s) => Object.assign(dbSnapshot, s)).catch(() => {});
}, 15_000);
dbSnapshotTimer.unref();

metrics.startLagProbe();

const app = createApp({ tlsEnabled, dbStatus: dbSnapshot, behindTlsProxy: BEHIND_TLS_PROXY, demoLogin: DEMO_LOGIN, startupIntegrity, tileUrl: TILE_URL, broadcast: (obj) => broadcast(obj) });

let server;
if (tlsEnabled) server = https.createServer({ key: fs.readFileSync(path.join(TLS_DIR, 'server.key')), cert: fs.readFileSync(path.join(TLS_DIR, 'server.crt')) }, app);
else server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  verifyClient: ({ origin }, done) => {
    if (originAllowed(origin)) return done(true);
    logger.warn('ws.origin.rejected', { origin });
    return done(false, 403, 'Origine non autorisée');
  },
});

function broadcast(obj) {
  metrics.setWsClients(wss.clients.size);
  const msg = JSON.stringify(obj);
  const isTx = obj && obj.type === 'TX';
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > 1_000_000) continue;
    if (isTx && client.scope && obj.data && !warehouse.matchesOperator(obj.data, client.scope.operatorId)) continue;
    client.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  const cookies = auth.parseCookies(req.headers.cookie);
  const session = auth.getSession(cookies[auth.SESSION_COOKIE]);
  if (!session) { try { ws.close(4401, 'Authentification requise'); } catch { /* ignore */ } return; }
  ws.scope = { role: session.role, operatorId: session.operatorId };

  const inScope = (t) => warehouse.matchesOperator(t, ws.scope.operatorId);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({
    type: 'INIT',
    data: {
      service: 'SUMo', operators: ref.OPERATORS, engines: ref.ENGINES, channels: ref.CHANNELS, txTypes: ref.TX_TYPES,
      cities: ref.CITIES, ledger: ledger.stats(), tls: tlsEnabled,
      basemap: { url: TILE_URL, attribution: TILE_ATTRIBUTION },
      scope: ws.scope, permissions: users.permissions(session), demo: DEMO_LOGIN,
    },
  }));
  const backfill = warehouse.recentTx(60, ws.scope.operatorId ? { operatorId: ws.scope.operatorId } : {})
    .filter(inScope).map((t) => model.toPublic(t, { reveal: false }));
  ws.send(JSON.stringify({ type: 'BACKFILL', data: backfill }));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30_000);

// Diffuseur UNIQUE — pipeline temps réel (cadence pilotée par la config).
let streamTimer = null;
function scheduleStream() {
  if (streamTimer) clearTimeout(streamTimer);
  const tick = () => {
    try {
      const tdr = simulator.generate();
      pipeline.ingest(tdr); // TDR neuf : enrichissement + effets de bord (réclamations M14)
      const rec = ledger.append(tdr);
      warehouse.ingest(tdr);
      db.persist(tdr, rec); // entrepôt PostgreSQL optionnel (no-op si DATABASE_URL absent)
      broadcast({ type: 'TX', data: model.toPublic(tdr, { reveal: false }), ledger: { seq: rec.seq, hash: rec.hash } });
    } catch (e) { logger.error('stream.tick.failed', { error: e.message }); }
    streamTimer = setTimeout(tick, STREAM_MS());
  };
  streamTimer = setTimeout(tick, STREAM_MS());
}
// Un lecteur n'ingère pas : ni simulateur, ni sondes, ni activité postale.
if (!IS_READER) scheduleStream();

// ---- Preuve : ancrage périodique + contrôle d'intégrité planifié -----------
// Correctif P1 n°13 — un reçu d'ancrage n'a de valeur que DÉPOSÉ, et un dépôt
// annuel ne protège pas l'année écoulée. L'émission est donc périodique ; le
// dépôt chez le tiers reste l'acte organisationnel qui lui donne sa portée.
// Correctif P1 n°14 — le contrôle intégral ne peut pas n'avoir lieu qu'au
// démarrage : une machine qui tourne six mois ne vérifierait rien pendant six
// mois. Il est planifié, et une rupture est une ALERTE, pas une ligne de journal.
const ANCHOR_MS = Number(process.env.SUMO_ANCHOR_INTERVAL_MS) || 24 * 3600_000;
const VERIFY_MS = Number(process.env.SUMO_VERIFY_INTERVAL_MS) || 6 * 3600_000;

function emettreAncrage(motif) {
  try {
    const recu = anchor.emit(ledger, { note: motif });
    audit.record({
      action: 'ANCRAGE_PERIODIQUE', actor: 'systeme', role: 'SYSTEME', target: String(recu.seq),
      meta: { headHash: recu.headHash, note: motif },
    });
  } catch (e) { logger.warn('anchor.periodic.failed', { error: e.message }); }
}

function controleIntegral() {
  for (const [nom, chaine] of [['tdr', ledger], ['audit', audit], ['probes', probes.journal]]) {
    const t0 = Date.now();
    const v = nom === 'audit' ? audit.verify({ signatures: 'sample' }) : chaine.verifyChain({ signatures: 'sample' });
    startupIntegrity[nom] = { ...v, at: new Date().toISOString(), durationMs: Date.now() - t0, planifie: true };
    if (v.valid) { logger.info('integrity.scheduled.ok', { chain: nom, records: v.checked, ms: Date.now() - t0 }); continue; }

    // Une chaîne rompue en exploitation est un évènement à escalader, pas à
    // constater sur un écran que personne ne regarde.
    logger.error('integrity.scheduled.BROKEN', { chain: nom, brokenAt: v.brokenAt, reason: v.reason });
    console.error(`\n  ALERTE INTÉGRITÉ — chaîne « ${nom} » rompue (${v.reason}) au numéro ${v.brokenAt}.`);
    console.error('  Les enregistrements concernés ne sont plus probants. Constatez et archivez.\n');
    try {
      audit.record({
        action: 'ALERTE_INTEGRITE', actor: 'systeme', role: 'SYSTEME', target: nom,
        meta: { brokenAt: v.brokenAt, reason: v.reason, checked: v.checked },
      });
    } catch { /* la chaîne d'audit peut être elle-même touchée */ }
  }
  // La confrontation au dernier reçu déposé détecte ce que la chaîne, cohérente
  // avec elle-même, ne peut pas voir : une réécriture par l'exploitant.
  const verdict = anchor.verifyAgainst(ledger, anchor.latestFor('tdr'));
  if (verdict.anchored && verdict.valid === false) {
    logger.error('anchor.mismatch', { reason: verdict.reason });
    console.error(`\n  ALERTE ANCRAGE — ${verdict.reason}\n`);
    try { audit.record({ action: 'ALERTE_ANCRAGE', actor: 'systeme', role: 'SYSTEME', target: 'tdr', meta: { reason: verdict.reason } }); } catch { /* ignore */ }
  }
}

// Correctif P1 n°16 — la purge est PLANIFIÉE. Une échéance de conservation qui
// dépend d'un geste manuel n'est pas une garantie : c'est une intention.
const PURGE_MS = Number(process.env.SUMO_PURGE_INTERVAL_MS) || 24 * 3600_000;
function purgeEcheances() {
  try {
    const r = retention.runPurge({ record: (e) => audit.record(e) });
    if (r.segments.length) {
      logger.warn('retention.purge.scheduled', { segments: r.segments.map((s) => `${s.tier}:${s.segment}`) });
      // Le registre a changé de lisibilité : on ré-ancre pour que le reçu déposé
      // atteste de l'état POSTÉRIEUR à la purge.
      emettreAncrage('ré-ancrage après purge des échéances de conservation');
    }
  } catch (e) { logger.error('retention.purge.failed', { error: e.message }); }
}
const purgeTimer = IS_READER ? null : setInterval(purgeEcheances, PURGE_MS);
if (purgeTimer) purgeTimer.unref();

// Ancrage et purge ÉCRIVENT : ils n'ont pas lieu d'être sur un lecteur. Le
// contrôle d'intégrité, lui, est une lecture — un lecteur peut donc le faire, et
// c'est même utile : il vérifie ce que l'écrivain produit.
const anchorTimer = IS_READER ? null : setInterval(() => emettreAncrage('ancrage périodique automatique'), ANCHOR_MS);
const verifyTimer = setInterval(controleIntegral, VERIFY_MS);
if (anchorTimer) anchorTimer.unref();
verifyTimer.unref();

// ---- Module M14 : campagnes de sondes N3 + activité postale simulée --------
const PROBES_MS = Number(process.env.SUMO_PROBES_MS) || 90_000;
if (!IS_READER) { probes.runCampaign(); postal.tick(60); }
const probesTimer = IS_READER ? null : setInterval(() => {
  try { probes.runCampaign(); postal.tick(); } catch (e) { logger.error('probes.campaign.failed', { error: e.message }); }
}, PROBES_MS);

server.listen(PORT, HOST, () => {
  const scheme = tlsEnabled ? 'https' : 'http';
  logger.info('server.started', { service: 'SUMo', scheme, host: HOST, port: PORT, tls: tlsEnabled });
  console.log('==============================================================');
  console.log(' SUMo — Supervision Unifiée du Mobile Money (PROTOTYPE / DÉMO)');
  console.log('  Modèle inspiré de M3 · données simulées · sans mandat officiel');
  console.log(`  Interface : ${scheme}://localhost:${PORT}`);
  console.log(`  TLS       : ${tlsEnabled ? 'ACTIF (direct)' : (BEHIND_TLS_PROXY ? 'terminé au reverse proxy (cookies Secure + HSTS actifs)' : "INACTIF (HTTP — 'npm run gen-certs' pour HTTPS/WSS)")}`);
  console.log(`  Registre  : ${ledger.stats().total} TDR signés (ECDSA P-256) · audit : ${audit.stats().total} évènements`);
  console.log(`  Comptes   : ${users.count()} intervenants — organigramme ARCEP, ${nomenclature.DIRECTIONS.length} entités (page : /login.html)`);
  console.log('  Dispatch  : modules affectés par direction/compte — compte « admin-systeme »');
  console.log(`  Rôle      : ${ROLE.toUpperCase()}${IS_READER ? ' (lecture seule — aucun verrou, aucune écriture)' : ' (écrivain unique du registre)'}`);
  console.log(`  Login démo: ${DEMO_LOGIN ? "ACTIVÉ (accès 'un clic', DEV)" : 'désactivé'}`);
  const ident = users.credentials.summary();
  console.log(`  Identités : ${ident.comptes} comptes · ${ident.secretsDistincts} secrets distincts · ${ident.totpRequis} profils à second facteur`);
  if (ident.changementRequis) {
    console.log(`  ATTENTION : ${ident.changementRequis} compte(s) doivent changer leur mot de passe initial.`);
    console.log(`              Mots de passe de remise : ${users.credentials.HANDOVER_FILE}`);
    console.log('              À distribuer en main propre PUIS DÉTRUIRE.');
  }
  const canal = connectors.summary();
  console.log(`  Connecteurs: ${canal.connecteurs} assujettis · ${canal.clesDistinctes} clés distinctes · anti-rejeu ${canal.antiRejeu.fenetreMs / 1000}s`);
  if (fs.existsSync(connectors.HANDOVER_FILE)) {
    console.log(`              Identifiants de remise : ${connectors.HANDOVER_FILE}`);
    console.log('              À transmettre par canal sûr PUIS DÉTRUIRE.');
  }
  console.log('==============================================================');
  if (DEMO_LOGIN) logger.warn('auth.demo-login.enabled', { note: 'Connexion sans mot de passe active (DEV uniquement)' });
});

function shutdown(signal) {
  logger.warn('server.shutdown', { signal });
  if (streamTimer) clearTimeout(streamTimer);
  clearInterval(heartbeat);
  if (probesTimer) clearInterval(probesTimer);
  if (anchorTimer) clearInterval(anchorTimer);
  clearInterval(verifyTimer);
  if (purgeTimer) clearInterval(purgeTimer);
  clearInterval(dbSnapshotTimer);
  metrics.stopLagProbe();
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  db.close();
  scanner.close(); // arrête le fil de parcours du registre
  // Ferme les descripteurs d'écriture ET libère les verrous : sans cela, un
  // redémarrage rapide buterait sur son propre verrou résiduel.
  try { ledger.close(); audit.close(); probes.close(); require('./lib/archives').close(); } catch { /* arrêt best-effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { logger.error('uncaughtException', { error: err.message, stack: err.stack }); shutdown('uncaughtException'); });
process.on('unhandledRejection', (reason) => { logger.error('unhandledRejection', { reason: String(reason) }); });
