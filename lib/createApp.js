'use strict';

// Construit l'application Express durcie (routes + middlewares) SANS démarrer
// d'écoute, afin d'être testable en isolation. Le WebSocket et le serveur HTTP(S)
// sont gérés par server.js.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const logger = require('./logger');
const ref = require('./referentiel');
const model = require('./model');
const ledger = require('./ledger');
const auth = require('./auth');
const users = require('./users');

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

function originAllowed(origin) {
  if (!origin) return true; // outils non-navigateur (curl, intégrations)
  if (CORS_ORIGINS.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// opts : { api: {key, secret}, broadcast: fn, tlsEnabled: bool, serveStatic: bool, demoLogin: bool }
function createApp(opts = {}) {
  const api = opts.api || { key: null, secret: null };
  const broadcast = typeof opts.broadcast === 'function' ? opts.broadcast : () => {};
  const tlsEnabled = !!opts.tlsEnabled;
  const serveStatic = opts.serveStatic !== false;
  const demoLogin = !!opts.demoLogin; // accès « un clic » réservé au mode démo (jamais en prod)

  const app = express();
  app.disable('x-powered-by');

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

  app.use(cors({ origin: (origin, cb) => cb(originAllowed(origin) ? null : new Error('Origine non autorisée'), originAllowed(origin)) }));
  app.use(express.json({ limit: '32kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // Cookies + session : rattache req.auth (session courante ou null) à chaque requête.
  app.use((req, _res, next) => {
    req.cookies = auth.parseCookies(req.headers.cookie);
    req.auth = auth.getSession(req.cookies[auth.SESSION_COOKIE]);
    next();
  });

  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => logger.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
    next();
  });

  app.use('/api/', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));

  // ----- Authentification & sessions -----
  const cookieSecure = tlsEnabled;
  const setSession = (res, id) => res.setHeader('Set-Cookie', auth.serializeCookie(auth.SESSION_COOKIE, id, { httpOnly: true, sameSite: 'Strict', secure: cookieSecure, path: '/', maxAge: Math.floor(auth.TTL_MS / 1000) }));
  const clearSession = (res) => res.setHeader('Set-Cookie', auth.serializeCookie(auth.SESSION_COOKIE, '', { httpOnly: true, sameSite: 'Strict', secure: cookieSecure, path: '/', maxAge: 0 }));
  const publicUser = (s) => ({ username: s.username, displayName: s.displayName, role: s.role, operatorId: s.operatorId, scopeType: s.scopeType, title: s.title });

  function requireAuth(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    next();
  }

  // Filtre de données selon le rôle : un OPÉRATEUR ne voit QUE ses propres transactions.
  function scopeOf(session) {
    if (session && session.role === users.ROLES.OPERATEUR && session.operatorId) {
      return (t) => !!t && !!t.operator && t.operator.id === session.operatorId;
    }
    return () => true;
  }

  const authLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

  app.post('/api/v1/auth/login', authLimiter, (req, res) => {
    const body = req.body || {};
    const user = users.authenticate(body.username, String(body.password || ''));
    if (!user) return res.status(401).json({ error: 'Identifiants invalides.' });
    setSession(res, auth.createSession(user));
    logger.info('auth.login', { username: user.username, role: user.role });
    res.json({ user: publicUser(user) });
  });

  app.post('/api/v1/auth/demo', authLimiter, (req, res) => {
    if (!demoLogin) return res.status(403).json({ error: 'Accès démo désactivé (mode production).' });
    const user = users.getByUsername((req.body || {}).username);
    if (!user) return res.status(404).json({ error: 'Compte de démonstration inconnu.' });
    setSession(res, auth.createSession(user));
    logger.warn('auth.demo-login', { username: user.username, role: user.role });
    res.json({ user: publicUser(user) });
  });

  app.post('/api/v1/auth/logout', (req, res) => {
    auth.destroySession(req.cookies[auth.SESSION_COOKIE]);
    clearSession(res);
    res.json({ ok: true });
  });

  app.get('/api/v1/auth/me', (req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'Non authentifié.' });
    res.json({ user: publicUser(req.auth), demoLogin });
  });

  app.get('/api/v1/auth/accounts', (_req, res) => {
    res.json({ demoLogin, password: demoLogin ? users.DEMO_PASSWORD : undefined, accounts: demoLogin ? users.catalog() : [] });
  });

  if (serveStatic) {
    const root = path.join(__dirname, '..');
    // L'espace de travail (index.html) est protégé : redirection vers la page de connexion.
    app.get(['/', '/index.html'], (req, res, next) => {
      if (!req.auth) return res.redirect(302, '/login.html');
      next();
    });
    app.use(express.static(path.join(root, 'public')));
    app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules', 'leaflet', 'dist')));
    app.use('/vendor/chartjs', express.static(path.join(root, 'node_modules', 'chart.js', 'dist')));
  }

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptimeSec: Math.round(process.uptime()), tls: tlsEnabled, ledger: ledger.stats().total, demo: true });
  });

  app.get('/api/v1/operators', requireAuth, (_req, res) => res.json({ types: ref.TYPES, operators: ref.OPERATORS, cities: ref.CITIES }));
  app.get('/api/v1/pubkey', (_req, res) => res.json({ algorithm: ledger.stats().algorithm, publicKeyPem: ledger.getPublicKeyPem() }));
  app.get('/api/v1/ledger', requireAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const scope = scopeOf(req.auth);
    const records = ledger.getRecent(500).filter((r) => scope(r.payload)).slice(0, limit);
    res.json({ stats: ledger.stats(), records });
  });
  app.get('/api/v1/ledger/verify', requireAuth, (_req, res) => res.json(ledger.verifyChain()));

  app.get('/api/v1/export', requireAuth, (req, res) => {
    const format = String(req.query.format || 'json').toLowerCase();
    const type = req.query.type && req.query.type !== 'all' ? String(req.query.type) : null;
    const scope = scopeOf(req.auth);
    let records = ledger.getRecent(500).map((r) => r.payload).filter(scope);
    if (type) records = records.filter((t) => t.operator.type === type);

    let body; let mime; let ext;
    if (format === 'csv') {
      const head = 'datetime,operator,type,city,amount_xaf,currency,status,iso_stan';
      const rows = records.map((t) => [t.datetime, t.operator.name, t.operator.type, t.location.city, t.amount, t.currency, t.status, t.iso8583.stan].join(','));
      body = [head, ...rows].join('\n'); mime = 'text/csv'; ext = 'csv';
    } else {
      body = JSON.stringify({ generatedAt: new Date().toISOString(), count: records.length, records }, null, 2);
      mime = 'application/json'; ext = 'json';
    }
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="hubfip-export-${Date.now()}.${ext}"`);
    res.setHeader('X-Content-SHA256', sha256);
    res.setHeader('X-Signature-ECDSA-P256', ledger.signHashHex(sha256));
    res.send(body);
  });

  function authenticate(req, res, next) {
    const key = req.get('x-hubfip-key');
    const sig = req.get('x-hubfip-signature');
    if (!api.secret || key !== api.key || !sig || !req.rawBody) {
      return res.status(401).json({ status: 'REJECTED', error: 'Authentification requise (clé + signature HMAC).' });
    }
    const expected = crypto.createHmac('sha256', api.secret).update(req.rawBody).digest('hex');
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

  app.use((err, _req, res, _next) => {
    logger.error('unhandled.request', { error: err.message });
    res.status(500).json({ status: 'ERROR', error: 'Erreur interne.' });
  });

  return app;
}

module.exports = { createApp, originAllowed };
