'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const WebSocket = require('ws');

const logger = require('./lib/logger');
const ref = require('./lib/referentiel');
const model = require('./lib/model');
const ledger = require('./lib/ledger');
const simulator = require('./lib/simulator');

// ----------------------------------------------------------------------------
// Configuration (externalisée — corrige la config en dur)
// ----------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const STREAM_MS = Number(process.env.STREAM_MS) || 1500;
const TLS_DIR = path.join(__dirname, 'data', 'tls');
const DATA_DIR = path.join(__dirname, 'data');
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

ref.validate();
ledger.init();
fs.mkdirSync(DATA_DIR, { recursive: true });

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
// Application Express durcie
// ----------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

const tlsEnabled = fs.existsSync(path.join(TLS_DIR, 'server.key')) && fs.existsSync(path.join(TLS_DIR, 'server.crt'));

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.tailwindcss.com', "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'https://*.basemaps.cartocdn.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: tlsEnabled ? [] : null,
    },
  },
  hsts: tlsEnabled ? { maxAge: 31536000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false,
}));

function originAllowed(origin) {
  if (!origin) return true; // outils non-navigateur (curl, intégrations)
  if (CORS_ORIGINS.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
app.use(cors({ origin: (origin, cb) => cb(originAllowed(origin) ? null : new Error('Origine non autorisée'), originAllowed(origin)) }));

app.use(express.json({
  limit: '32kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Journalisation des requêtes
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => logger.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
  next();
});

const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

// Fichiers statiques + bibliothèques auto-hébergées (souveraineté : pas de CDN pour ces libs)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));
app.use('/vendor/chartjs', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

// ----------------------------------------------------------------------------
// API REST
// ----------------------------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptimeSec: Math.round(process.uptime()), tls: tlsEnabled, ledger: ledger.stats().total, demo: true });
});

app.get('/api/v1/operators', (_req, res) => {
  res.json({ types: ref.TYPES, operators: ref.OPERATORS, cities: ref.CITIES });
});

app.get('/api/v1/pubkey', (_req, res) => {
  res.json({ algorithm: ledger.stats().algorithm, publicKeyPem: ledger.getPublicKeyPem() });
});

app.get('/api/v1/ledger', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ stats: ledger.stats(), records: ledger.getRecent(limit) });
});

app.get('/api/v1/ledger/verify', (_req, res) => {
  res.json(ledger.verifyChain());
});

// Export signé (corrige EXPORT-1 : produit un vrai fichier + signature réelle)
app.get('/api/v1/export', (req, res) => {
  const format = String(req.query.format || 'json').toLowerCase();
  const type = req.query.type && req.query.type !== 'all' ? String(req.query.type) : null;
  let records = ledger.getRecent(500).map((r) => r.payload);
  if (type) records = records.filter((t) => t.operator.type === type);

  let body; let mime; let ext;
  if (format === 'csv') {
    const head = 'seq_datetime,operator,type,city,amount_xaf,currency,status,iso_stan';
    const rows = records.map((t) => [t.datetime, t.operator.name, t.operator.type, t.location.city, t.amount, t.currency, t.status, t.iso8583.stan].join(','));
    body = [head, ...rows].join('\n');
    mime = 'text/csv'; ext = 'csv';
  } else {
    body = JSON.stringify({ generatedAt: new Date().toISOString(), count: records.length, records }, null, 2);
    mime = 'application/json'; ext = 'json';
  }
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const signature = crypto.sign('sha256', Buffer.from(sha256, 'hex'), crypto.createPrivateKey(fs.readFileSync(path.join(DATA_DIR, 'keys', 'ledger_private.pem')))).toString('base64');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="hubfip-export-${Date.now()}.${ext}"`);
  res.setHeader('X-Content-SHA256', sha256);
  res.setHeader('X-Signature-ECDSA-P256', signature);
  res.send(body);
});

// Injection ISO 8583 authentifiée (corrige APP-2/APP-5 : auth HMAC + validation stricte)
function authenticate(req, res, next) {
  const key = req.get('x-hubfip-key');
  const sig = req.get('x-hubfip-signature');
  if (key !== API.key || !sig || !req.rawBody) {
    return res.status(401).json({ status: 'REJECTED', error: 'Authentification requise (clé + signature HMAC).' });
  }
  const expected = crypto.createHmac('sha256', API.secret).update(req.rawBody).digest('hex');
  const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return res.status(401).json({ status: 'REJECTED', error: 'Signature HMAC invalide.' });
  next();
}

app.post('/api/v1/iso8583', authenticate, (req, res) => {
  try {
    const p = req.body || {};
    let tx;
    if (typeof p.message === 'string') {
      tx = model.fromIso8583(p.message, { operatorId: p.operatorId, cityName: p.cityName });
    } else {
      if (!p.operatorId || !ref.byId.get(p.operatorId)) return res.status(400).json({ status: 'REJECTED', error: 'operatorId inconnu ou manquant.' });
      if (!(Number(p.amount) > 0)) return res.status(400).json({ status: 'REJECTED', error: 'amount invalide.' });
      tx = model.buildTransaction({ operatorId: p.operatorId, amount: p.amount, cityName: p.cityName, status: p.status, source: 'EXTERNAL' });
    }
    const rec = ledger.append(tx);
    broadcast({ type: 'TX', data: tx, ledger: { seq: rec.seq, hash: rec.hash } });
    res.status(202).json({ status: 'ACCEPTED', id: tx.id, seq: rec.seq, hash: rec.hash, iso8583: tx.iso8583.message });
  } catch (e) {
    res.status(400).json({ status: 'REJECTED', error: e.message });
  }
});

// Gestionnaire d'erreurs (corrige DEVOPS-5)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('unhandled.request', { error: err.message });
  res.status(500).json({ status: 'ERROR', error: 'Erreur interne.' });
});

// ----------------------------------------------------------------------------
// Serveur HTTP(S) + WebSocket
// ----------------------------------------------------------------------------
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
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > 1_000_000) continue; // backpressure : on saute les clients saturés
    client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({
    type: 'INIT',
    data: {
      operators: ref.OPERATORS,
      cities: ref.CITIES,
      types: ref.TYPES,
      ledger: ledger.stats(),
      pubkeyAlgorithm: ledger.stats().algorithm,
      tls: tlsEnabled,
      demo: true,
    },
  }));
  ws.send(JSON.stringify({ type: 'BACKFILL', data: ledger.getRecent(40).map((r) => ({ ...r.payload, _seq: r.seq, _hash: r.hash })) }));
});

// Heartbeat : termine les connexions mortes (corrige l'absence de gestion WS)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// Diffuseur UNIQUE (corrige INFRA-6 : un seul timer global, pas un par client)
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
  console.log(`  TLS       : ${tlsEnabled ? 'ACTIF' : "INACTIF (HTTP en clair — lancez 'npm run gen-certs' pour activer HTTPS/WSS)"}`);
  console.log(`  Registre  : ${ledger.stats().total} enregistrements signés (ECDSA P-256)`);
  console.log(`  API key   : ${API.key}  (source: ${API.source})`);
  if (API.source !== 'env') console.log(`  API secret: ${API.secret}`);
  console.log('==============================================================');
});

// ----------------------------------------------------------------------------
// Robustesse process : arrêt gracieux + erreurs non capturées (corrige DEVOPS-5)
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
