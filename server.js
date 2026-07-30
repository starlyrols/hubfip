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
const crypto = require('crypto');
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
const assignments = require('./lib/assignments');
const nomenclature = require('./lib/nomenclature');
const { createApp, originAllowed } = require('./lib/createApp');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = ledger.DATA_DIR;
const TLS_DIR = path.join(DATA_DIR, 'tls');
const REPLAY_MAX = Number(process.env.SUMO_REPLAY_MAX) || 8000;

const DEMO_LOGIN = process.env.NODE_ENV !== 'production' && process.env.SUMO_DEMO_LOGIN !== '0';
// Derrière un reverse proxy terminant le TLS (Caddy/nginx) — cf. docker-compose.
const BEHIND_TLS_PROXY = ['1', 'true', 'yes'].includes(String(process.env.SUMO_TRUST_PROXY || '').toLowerCase());

// ---- Initialisation des magasins -------------------------------------------
ref.validate();
config.load();
assignments.load(); // affectations de modules (dispatch admin système)
fs.mkdirSync(DATA_DIR, { recursive: true });
ledger.init();
audit.init();
cases.load();
db.init().catch((e) => logger.warn('db.init.error', { error: e.message })); // entrepôt PostgreSQL optionnel

// Reconstruction de l'entrepôt + des détecteurs depuis le registre signé.
(function replay() {
  // Lecture arrière bornée : seule la fenêtre rejouée est lue/parsée (le fichier
  // complet peut peser plusieurs Go après des semaines de flux continu).
  const slice = ledger.readTail(REPLAY_MAX);
  for (const r of slice) { pipeline.enrich(r.payload); warehouse.ingest(r.payload); }
  if (slice.length) logger.info('replay.done', { replayed: slice.length, total: ledger.stats().total });
}());

const STREAM_MS = () => config.get().stream.intervalMs;
const tlsEnabled = fs.existsSync(path.join(TLS_DIR, 'server.key')) && fs.existsSync(path.join(TLS_DIR, 'server.crt'));

function loadApiCredentials() {
  const file = path.join(DATA_DIR, 'keys', 'api-credentials.json');
  if (process.env.SUMO_API_KEY && process.env.SUMO_API_SECRET) return { key: process.env.SUMO_API_KEY, secret: process.env.SUMO_API_SECRET, source: 'env' };
  if (fs.existsSync(file)) return { ...JSON.parse(fs.readFileSync(file, 'utf8')), source: 'file' };
  const cred = { key: 'sumo-' + crypto.randomBytes(4).toString('hex'), secret: crypto.randomBytes(24).toString('hex') };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cred, null, 2), { mode: 0o600 });
  return { ...cred, source: 'generated' };
}
const API = loadApiCredentials();

// ---- App + serveur ----------------------------------------------------------
const app = createApp({ api: API, tlsEnabled, behindTlsProxy: BEHIND_TLS_PROXY, demoLogin: DEMO_LOGIN, broadcast: (obj) => broadcast(obj) });

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
      pipeline.enrich(tdr);
      const rec = ledger.append(tdr);
      warehouse.ingest(tdr);
      db.persist(tdr, rec); // entrepôt PostgreSQL optionnel (no-op si DATABASE_URL absent)
      broadcast({ type: 'TX', data: model.toPublic(tdr, { reveal: false }), ledger: { seq: rec.seq, hash: rec.hash } });
    } catch (e) { logger.error('stream.tick.failed', { error: e.message }); }
    streamTimer = setTimeout(tick, STREAM_MS());
  };
  streamTimer = setTimeout(tick, STREAM_MS());
}
scheduleStream();

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
  console.log(`  Login démo: ${DEMO_LOGIN ? "ACTIVÉ (accès 'un clic', DEV)" : 'désactivé'}`);
  console.log(`  API key   : ${API.key}  (source: ${API.source})`);
  if (API.source !== 'env') console.log(`  API secret: ${API.secret}`);
  console.log('==============================================================');
  if (DEMO_LOGIN) logger.warn('auth.demo-login.enabled', { note: 'Connexion sans mot de passe active (DEV uniquement)' });
});

function shutdown(signal) {
  logger.warn('server.shutdown', { signal });
  if (streamTimer) clearTimeout(streamTimer);
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { logger.error('uncaughtException', { error: err.message, stack: err.stack }); shutdown('uncaughtException'); });
process.on('unhandledRejection', (reason) => { logger.error('unhandledRejection', { reason: String(reason) }); });
