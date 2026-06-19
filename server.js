'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

const logger = require('./lib/logger');
const ref = require('./lib/referentiel');
const ledger = require('./lib/ledger');
const simulator = require('./lib/simulator');
const auth = require('./lib/auth');
const users = require('./lib/users');
const { createApp, originAllowed } = require('./lib/createApp');

// ----------------------------------------------------------------------------
// Configuration (externalisée)
// ----------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const STREAM_MS = Number(process.env.STREAM_MS) || 1500;
const DATA_DIR = ledger.DATA_DIR;
const TLS_DIR = path.join(DATA_DIR, 'tls');

// Accès démo « un clic » : actif hors production (à désactiver via NODE_ENV=production
// ou HUBFIP_DEMO_LOGIN=0). C'est un contournement d'authentification volontaire,
// réservé à la démonstration — JAMAIS en production.
const DEMO_LOGIN = process.env.NODE_ENV !== 'production' && process.env.HUBFIP_DEMO_LOGIN !== '0';

ref.validate();
ledger.init();
fs.mkdirSync(DATA_DIR, { recursive: true });

const tlsEnabled = fs.existsSync(path.join(TLS_DIR, 'server.key')) && fs.existsSync(path.join(TLS_DIR, 'server.crt'));

// Identifiants d'API pour l'injection externe (auth HMAC). Générés et persistés si absents.
function loadApiCredentials() {
  const file = path.join(DATA_DIR, 'keys', 'api-credentials.json');
  if (process.env.HUBFIP_API_KEY && process.env.HUBFIP_API_SECRET) {
    return { key: process.env.HUBFIP_API_KEY, secret: process.env.HUBFIP_API_SECRET, source: 'env' };
  }
  if (fs.existsSync(file)) return { ...JSON.parse(fs.readFileSync(file, 'utf8')), source: 'file' };
  const cred = { key: 'demo-' + crypto.randomBytes(4).toString('hex'), secret: crypto.randomBytes(24).toString('hex') };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cred, null, 2), { mode: 0o600 });
  return { ...cred, source: 'generated' };
}
const API = loadApiCredentials();

// ----------------------------------------------------------------------------
// App + serveur HTTP(S) + WebSocket
// ----------------------------------------------------------------------------
const app = createApp({ api: API, tlsEnabled, demoLogin: DEMO_LOGIN, broadcast: (obj) => broadcast(obj) });

let server;
if (tlsEnabled) {
  server = https.createServer({ key: fs.readFileSync(path.join(TLS_DIR, 'server.key')), cert: fs.readFileSync(path.join(TLS_DIR, 'server.crt')) }, app);
} else {
  server = http.createServer(app);
}

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
  const opId = isTx && obj.data && obj.data.operator ? obj.data.operator.id : null;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > 1_000_000) continue; // backpressure
    // Scoping : un opérateur ne reçoit que ses propres transactions.
    if (isTx && client.scope && client.scope.operatorId && opId !== client.scope.operatorId) continue;
    client.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  // Authentification du flux : la session (cookie) est requise. L'espace de travail
  // étant déjà protégé, tout client légitime possède un cookie de session valide.
  const cookies = auth.parseCookies(req.headers.cookie);
  const session = auth.getSession(cookies[auth.SESSION_COOKIE]);
  if (!session) { try { ws.close(4401, 'Authentification requise'); } catch { /* ignore */ } return; }
  ws.scope = { role: session.role, operatorId: session.operatorId };

  const inScope = (tx) => !ws.scope.operatorId || (tx.operator && tx.operator.id === ws.scope.operatorId);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({
    type: 'INIT',
    data: { operators: ref.OPERATORS, cities: ref.CITIES, types: ref.TYPES, ledger: ledger.stats(), pubkeyAlgorithm: ledger.stats().algorithm, tls: tlsEnabled, demo: true, scope: ws.scope },
  }));
  ws.send(JSON.stringify({ type: 'BACKFILL', data: ledger.getRecent(80).filter((r) => inScope(r.payload)).slice(0, 40).map((r) => ({ ...r.payload, _seq: r.seq, _hash: r.hash })) }));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// Diffuseur UNIQUE (un seul timer global, pas un par client)
const stream = setInterval(() => {
  const tx = simulator.generate();
  const rec = ledger.append(tx);
  broadcast({ type: 'TX', data: tx, ledger: { seq: rec.seq, hash: rec.hash } });
}, STREAM_MS);

server.listen(PORT, HOST, () => {
  const scheme = tlsEnabled ? 'https' : 'http';
  logger.info('server.started', { scheme, host: HOST, port: PORT, tls: tlsEnabled, stream_ms: STREAM_MS });
  console.log('==============================================================');
  console.log(' HuBFIP — PROTOTYPE / DÉMONSTRATION (données simulées)');
  console.log(`  Interface : ${scheme}://localhost:${PORT}`);
  console.log(`  TLS       : ${tlsEnabled ? 'ACTIF' : "INACTIF (HTTP en clair — 'npm run gen-certs' pour activer HTTPS/WSS)"}`);
  console.log(`  Registre  : ${ledger.stats().total} enregistrements signés (ECDSA P-256)`);
  console.log(`  Comptes   : ${users.count()} intervenants (page de connexion : /login.html)`);
  console.log(`  Login démo: ${DEMO_LOGIN ? "ACTIVÉ — accès 'un clic' (DEV). Désactiver en prod : NODE_ENV=production" : 'désactivé'}`);
  console.log(`  API key   : ${API.key}  (source: ${API.source})`);
  if (API.source !== 'env') console.log(`  API secret: ${API.secret}`);
  console.log('==============================================================');
  if (DEMO_LOGIN) logger.warn('auth.demo-login.enabled', { note: 'Connexion sans mot de passe active (DEV uniquement)' });
});

// ----------------------------------------------------------------------------
// Robustesse process : arrêt gracieux + erreurs non capturées
// ----------------------------------------------------------------------------
function shutdown(signal) {
  logger.warn('server.shutdown', { signal });
  clearInterval(stream);
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => { logger.error('uncaughtException', { error: err.message, stack: err.stack }); shutdown('uncaughtException'); });
process.on('unhandledRejection', (reason) => { logger.error('unhandledRejection', { reason: String(reason) }); });
