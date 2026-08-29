'use strict';

// =============================================================================
// Application Express durcie — API REST de la plateforme SUMo (13 sous-modules
// du module « Monitoring »). Routes groupées par module ; visibilité calculée
// PAR UTILISATEUR depuis les affectations dispatchées par l'admin système
// (par direction de l'organigramme ARCEP et/ou par compte), cloisonnement
// opérateur (scope), minimisation des données (MSISDN masqués sauf profil
// habilité) et journalisation d'audit des actions sensibles.
// =============================================================================

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
const audit = require('./audit');
const config = require('./config');
const warehouse = require('./warehouse');
const rules = require('./rules');
const geo = require('./geo');
const ml = require('./ml');
const qos = require('./qos');
const revenue = require('./revenue');
const cases = require('./cases');
const reporting = require('./reporting');
const normalize = require('./normalize');
const subjects = require('./subjects');
const pipeline = require('./pipeline');
const db = require('./db');
const auth = require('./auth');
const users = require('./users');
const probes = require('./probes');
const thirdparty = require('./thirdparty');
const complaints = require('./complaints');
const postal = require('./postal');
const workflow = require('./workflow');
const modules = require('./modules');
const nomenclature = require('./nomenclature');
const scanner = require('./scanner');
const vault = require('./crypto-store');
const anchor = require('./anchor');
const connectors = require('./connectors');
const retention = require('./retention');
const metrics = require('./metrics');
const assignments = require('./assignments');

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Origine du serveur de tuiles, quand l'exploitant en configure un (SUMO_TILE_URL).
// Elle est la SEULE origine externe que la CSP puisse admettre, et seulement parce
// qu'un responsable l'a explicitement désignée. Le gabarit Leaflet `{s}` (sous-
// domaines a/b/c) devient un joker d'hôte.
function tileOrigin(url) {
  if (!url) return null;
  try {
    if (url.includes('{s}.')) {
      const u = new URL(url.replace('{s}.', ''));
      return `${u.protocol}//*.${u.host}`;
    }
    return new URL(url).origin;
  } catch { return null; }
}

function originAllowed(origin) {
  if (!origin) return true;
  if (CORS_ORIGINS.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function createApp(opts = {}) {
  const broadcast = typeof opts.broadcast === 'function' ? opts.broadcast : () => {};
  const tlsEnabled = !!opts.tlsEnabled;
  const serveStatic = opts.serveStatic !== false;
  const demoLogin = !!opts.demoLogin;
  // Résultat du contrôle d'intégrité INTÉGRAL effectué au démarrage (server.js) :
  // c'est la seule vérification ancrée à la genèse. Les contrôles servis en cours
  // d'exploitation sont bornés, et le disent (correctif C3).
  const startupIntegrity = opts.startupIntegrity || {};
  // Derrière un reverse proxy qui termine le TLS (Caddy/nginx) : la connexion
  // navigateur↔proxy est en HTTPS bien que l'app reçoive du HTTP en interne.
  const behindTlsProxy = !!opts.behindTlsProxy;
  const secure = tlsEnabled || behindTlsProxy; // sécurité « effective » (cookies, HSTS, CSP)

  const app = express();
  app.disable('x-powered-by');
  // Fait confiance au 1er proxy : X-Forwarded-Proto/For → req.secure et req.ip corrects.
  if (behindTlsProxy) app.set('trust proxy', 1);

  // Correctif P0 n°8 — CSP resserrée sur l'origine propre.
  // Disparaissent : `'unsafe-eval'` (imposé par le compilateur Tailwind qui
  // tournait dans le navigateur), le CDN Tailwind, Cloudflare (Font Awesome),
  // Google Fonts et le fournisseur de tuiles étranger. Toutes ces ressources sont
  // désormais servies par la plateforme, qui fonctionne donc hors ligne.
  //
  // `'unsafe-inline'` demeure sur style-src, et sur elle seule : Leaflet positionne
  // ses tuiles et ses marqueurs par attribut `style`, il n'y a pas de moyen de
  // l'éviter sans réécrire la bibliothèque. Le risque associé est sans commune
  // mesure avec celui d'un `'unsafe-eval'` sur script-src.
  const tiles = tileOrigin(opts.tileUrl);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: tiles ? ["'self'", 'data:', tiles] : ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        upgradeInsecureRequests: secure ? [] : null,
      },
    },
    hsts: secure ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({ origin: (origin, cb) => cb(originAllowed(origin) ? null : new Error('Origine non autorisée'), originAllowed(origin)) }));
  app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.use((req, _res, next) => {
    req.cookies = auth.parseCookies(req.headers.cookie);
    req.auth = auth.getSession(req.cookies[auth.SESSION_COOKIE]);
    next();
  });
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      logger.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 });
      metrics.noteHttp(req.method, res.statusCode);
    });
    next();
  });
  // Quota de la CONSOLE — dimensionné pour un usage humain.
  //
  // Il ne doit PAS s'appliquer au canal d'ingestion : celui-ci porte le flux
  // déclaratif de tout un marché et dispose de son propre quota, par assujetti
  // (connectors.js). Le test de charge l'a montré sans ambiguïté — à 240
  // requêtes/minute, soit 4 déclarations par seconde, la plateforme refusait
  // 97 % d'un flux légitime de 400 TDR/s. Une limite conçue pour protéger une
  // interface aurait ainsi rendu le dispositif inopérant à l'échelle visée.
  app.use('/api/', rateLimit({
    windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false,
    skip: (req) => req.path === '/v1/iso8583',
  }));

  // --------------------------------------------------------------------------
  // Helpers d'autorisation, de scope et d'audit
  // --------------------------------------------------------------------------
  const cookieSecure = secure;
  const setSession = (res, id) => res.setHeader('Set-Cookie', auth.serializeCookie(auth.SESSION_COOKIE, id, { httpOnly: true, sameSite: 'Strict', secure: cookieSecure, path: '/', maxAge: Math.floor(auth.TTL_MS / 1000) }));
  const clearSession = (res) => res.setHeader('Set-Cookie', auth.serializeCookie(auth.SESSION_COOKIE, '', { httpOnly: true, sameSite: 'Strict', secure: cookieSecure, path: '/', maxAge: 0 }));
  const publicUser = (s) => ({ username: s.username, displayName: s.displayName, role: s.role, direction: s.direction || null, operatorId: s.operatorId, scopeType: s.scopeType, title: s.title, permissions: users.permissions(s) });

  // Correctif B3 : tant que le titulaire n'a pas changé son mot de passe initial,
  // enrôlé son second facteur ou renouvelé un secret expiré, son accès aux modules
  // est SUSPENDU. La contrainte est évaluée à chaque requête — la lever prend effet
  // immédiatement, sans reconnexion — et ne bloque jamais les routes qui permettent
  // précisément de la lever.
  function credentialGate(req, res) {
    const g = users.accessGate(req.auth);
    if (!g.blocked) return false;
    res.status(403).json({ error: g.message || 'Accès suspendu.', code: g.reason });
    return true;
  }

  function requireAuth(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    if (credentialGate(req, res)) return;
    next();
  }
  // Gating de module PAR UTILISATEUR (affectations direction ∪ individuel),
  // recalculé à chaque requête : une révocation dispatchée par l'admin système
  // prend effet immédiatement, sans invalider les sessions.
  const requireModule = (moduleId) => (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    if (credentialGate(req, res)) return;
    if (!users.hasModule(req.auth, moduleId)) return res.status(403).json({ error: `Module « ${moduleId} » non affecté à votre profil.` });
    next();
  };
  const requireAdmin = (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    if (credentialGate(req, res)) return;
    if (!users.canAdmin(req.auth)) return res.status(403).json({ error: 'Action réservée à l\'administration.' });
    next();
  };
  const requireSystemAdmin = (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    if (credentialGate(req, res)) return;
    if (!users.isSystemAdmin(req.auth)) return res.status(403).json({ error: 'Action réservée à l\'administrateur système.' });
    next();
  };

  // Construit les options de filtrage (cloisonnement opérateur + filtres requête).
  function scopeOpts(req, extra = {}) {
    const o = { ...extra };
    if (req.auth && req.auth.role === users.ROLES.OPERATEUR && req.auth.operatorId) o.operatorId = req.auth.operatorId;
    else if (req.query.operatorId && ref.byId.get(req.query.operatorId)) o.operatorId = req.query.operatorId;
    if (req.query.type) o.type = req.query.type;
    if (req.query.channel) o.channel = req.query.channel;
    if (req.query.minutes) o.minutes = Math.min(120, Math.max(1, Number(req.query.minutes)));
    if (req.query.start) o.start = req.query.start;
    if (req.query.end) o.end = req.query.end;
    if (o.start) o.sinceEpoch = new Date(o.start).getTime();
    // La fenêtre demandée (minutes/end) borne réellement la sélection, pas
    // seulement la série du graphique — sinon les KPI couvrent tout le buffer.
    if (!o.sinceEpoch && o.minutes) o.sinceEpoch = Date.now() - o.minutes * 60_000;
    if (o.end) o.untilEpoch = reporting.periodEnd(o.end);
    return o;
  }
  const canReveal = (req) => !!req.auth && users.canReveal(req.auth);

  // Correctif P0 n°10 — les commodités de démonstration (catalogue des comptes,
  // connexion « un clic », mot de passe commun) ne sont servies qu'à un appelant
  // LOCAL. Publiée par un tunnel, l'instance a livré l'organigramme complet de
  // l'ARCEP et un accès sans mot de passe à quiconque avait le lien : le quota
  // d'API n'y changeait rien, puisque rien n'était interdit.
  // `SUMO_DEMO_LOGIN_UNSAFE=1` lève la restriction — délibérément, et journalisé.
  const DEMO_UNSAFE = process.env.SUMO_DEMO_LOGIN_UNSAFE === '1';
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  const isLocalCall = (req) => LOOPBACK.has(String(req.ip || '').trim());
  const demoAllowed = (req) => demoLogin && (DEMO_UNSAFE || isLocalCall(req));
  // override : { username, role } pour les actions où la session n'est pas encore
  // posée (connexion). On lit req.ip directement (et non via un spread qui perdrait
  // le getter Express).
  function auditEvent(req, action, target, meta, override) {
    const actor = override && override.username ? override.username : (req.auth ? req.auth.username : 'anonyme');
    const role = override && override.role ? override.role : (req.auth ? req.auth.role : null);
    audit.record({ action, actor, role, target, meta: { ip: req.ip || null, ...meta } });
  }

  // ==========================================================================
  // Authentification & sessions
  // ==========================================================================
  const authLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

  // Correctif B3 : la réponse distingue les motifs — un compte verrouillé, un
  // second facteur attendu et un identifiant faux n'appellent pas la même conduite,
  // ni du titulaire, ni de l'exploitant qui relit le journal.
  app.post('/api/v1/auth/login', authLimiter, (req, res) => {
    const body = req.body || {};
    const r = users.authenticate(body.username, String(body.password || ''), body.otp);
    if (r.error) {
      auditEvent(req, 'LOGIN_ECHEC', body.username, { motif: r.error });
      if (r.error === 'TOTP_REQUIS') return res.status(401).json({ error: 'Second facteur requis.', code: 'TOTP_REQUIS' });
      if (r.error === 'TOTP_INVALIDE') return res.status(401).json({ error: 'Code de second facteur invalide.', code: 'TOTP_INVALIDE' });
      if (r.error === 'VERROUILLE') return res.status(423).json({ error: `Compte temporairement verrouillé après ${users.credentials.MAX_FAILED} échecs.`, code: 'VERROUILLE', retryAt: r.retryAt });
      return res.status(401).json({ error: 'Identifiants invalides.', code: 'INVALIDE' });
    }
    setSession(res, auth.createSession(r.user));
    auditEvent(req, 'LOGIN', r.user.username, { role: r.user.role, secondFacteur: !!body.otp }, r.user);
    res.json({ user: publicUser(r.user), credential: users.credentials.describe(r.user.username) });
  });

  // --- Cycle de vie du secret personnel ------------------------------------
  // Accessible même sous contrainte : c'est la route qui permet de la lever.
  app.post('/api/v1/auth/password', authLimiter, (req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    const b = req.body || {};
    try {
      users.credentials.changePassword(req.auth.username, String(b.current || ''), String(b.next || ''));
      auditEvent(req, 'MOT_DE_PASSE_CHANGE', req.auth.username, {});
      res.json({ ok: true, credential: users.credentials.describe(req.auth.username) });
    } catch (e) {
      auditEvent(req, 'MOT_DE_PASSE_ECHEC', req.auth.username, { motif: e.message });
      res.status(400).json({ error: e.message });
    }
  });

  // --- Second facteur (profils habilités) ----------------------------------
  app.post('/api/v1/auth/totp/enroll', authLimiter, (req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    try {
      const r = users.credentials.beginTotpEnrollment(req.auth.username);
      auditEvent(req, 'TOTP_ENROLEMENT', req.auth.username, {});
      // Le secret n'est présenté QU'ICI, et une seule fois.
      res.json({ secret: r.secret, uri: r.uri });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/v1/auth/totp/activate', authLimiter, (req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    try {
      const r = users.credentials.activateTotp(req.auth.username, String((req.body || {}).code || ''));
      auditEvent(req, 'TOTP_ACTIVE', req.auth.username, {});
      // Codes de secours à usage unique — présentés une seule fois.
      res.json({ ok: true, recoveryCodes: r.recoveryCodes, credential: users.credentials.describe(req.auth.username) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/v1/auth/demo', authLimiter, (req, res) => {
    if (!demoLogin) return res.status(403).json({ error: 'Accès démo désactivé (mode production).' });
    if (!demoAllowed(req)) {
      auditEvent(req, 'DEMO_REFUS', (req.body || {}).username, { motif: 'appel non local' });
      return res.status(403).json({ error: 'La connexion de démonstration n\'est ouverte qu\'aux appels locaux.' });
    }
    const user = users.getByUsername((req.body || {}).username);
    if (!user) return res.status(404).json({ error: 'Compte de démonstration inconnu.' });
    setSession(res, auth.createSession(user));
    auditEvent(req, 'LOGIN_DEMO', user.username, { role: user.role }, user);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/v1/auth/logout', (req, res) => {
    if (req.auth) auditEvent(req, 'LOGOUT', req.auth.username, {});
    auth.destroySession(req.cookies[auth.SESSION_COOKIE]);
    clearSession(res);
    res.json({ ok: true });
  });

  app.get('/api/v1/auth/me', (req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'Non authentifié.' });
    res.json({
      user: publicUser(req.auth), demoLogin,
      credential: users.credentials.describe(req.auth.username),
      gate: users.accessGate(req.auth),
    });
  });
  // Le catalogue expose l'organigramme nominatif de l'autorité : il suit la même
  // règle que la connexion de démonstration, et le mot de passe commun n'est
  // jamais renvoyé à un appelant distant.
  app.get('/api/v1/auth/accounts', (req, res) => {
    const ouvert = demoAllowed(req);
    res.json({
      demoLogin: ouvert,
      password: ouvert ? users.DEMO_PASSWORD : undefined,
      accounts: ouvert ? users.catalog() : [],
      note: demoLogin && !ouvert ? 'Catalogue de démonstration réservé aux appels locaux.' : undefined,
    });
  });

  // ==========================================================================
  // Référentiel & santé
  // ==========================================================================
  // --- Exposition des métriques (correctif P2 n°25) ------------------------
  // Réservée au réseau interne : la collecte se fait depuis l'infrastructure,
  // et ces compteurs renseignent sur l'activité de supervision d'une autorité —
  // volumétrie, écarts constatés, comptes verrouillés. Un jeton peut être exigé
  // quand le collecteur n'est pas sur le même réseau que l'application.
  const METRICS_TOKEN = process.env.SUMO_METRICS_TOKEN || null;
  const PRIVE = /^(127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fd|fc)/;
  const metricsAllowed = (req) => {
    if (METRICS_TOKEN) {
      const porte = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      return porte.length === METRICS_TOKEN.length
        && crypto.timingSafeEqual(Buffer.from(porte), Buffer.from(METRICS_TOKEN));
    }
    return PRIVE.test(String(req.ip || ''));
  };

  app.get('/metrics', (req, res) => {
    if (!metricsAllowed(req)) return res.status(403).type('text/plain').send('# Collecte réservée au réseau interne (ou jeton SUMO_METRICS_TOKEN).\n');
    const corps = metrics.render({
      ledger: ledger.stats(),
      audit: audit.stats(),
      probes: probes.journal.stats(),
      integrity: startupIntegrity,
      anchor: anchor.verifyAgainst(ledger, anchor.latestFor('tdr')),
      db: opts.dbStatus || null,          // instantané rafraîchi par le serveur
      scanner: scanner.stats(),
      retention: retention.state(),
      connectors: connectors.summary(),
      credentials: users.credentials.summary(),
      revenue: revenue.report({}),
      normalize: normalize.getStats(),
      sessions: auth._sessions.size,
    });
    res.type(metrics.CONTENT_TYPE).send(corps);
  });

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'SUMo', uptimeSec: Math.round(process.uptime()), tls: tlsEnabled, ledger: ledger.stats().total, demo: demoLogin }));

  app.get('/api/v1/reference', requireAuth, (_req, res) => {
    res.json({
      operators: ref.OPERATORS.map((o) => ({ ...o, engineName: (ref.engineById.get(o.engine) || {}).name })),
      engines: ref.ENGINES, channels: ref.CHANNELS, txTypes: ref.TX_TYPES, errorCodes: ref.ERROR_CODES,
      currencies: ref.CURRENCIES, cities: ref.CITIES,
      counts: { operators: ref.OPERATORS.length, cells: ref.CELLS.length, agents: ref.AGENTS.length, subscribers: ref.SUBSCRIBERS.length },
    });
  });

  // ==========================================================================
  // Module 4 — Observatoire / statistiques
  // ==========================================================================
  app.get('/api/v1/stats', requireModule('observatoire'), (req, res) => res.json(warehouse.snapshot(scopeOpts(req))));
  app.get('/api/v1/tx/recent', requireAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    res.json({ records: warehouse.recentTx(limit, scopeOpts(req)).map((t) => model.toPublic(t, { reveal: false })) });
  });

  // ==========================================================================
  // Opérateurs, moteurs & réseau d'agents
  // ==========================================================================
  app.get('/api/v1/operators', requireModule('operators'), (req, res) => {
    const life = warehouse.lifetime.byOperator;
    res.json({
      operators: ref.OPERATORS.map((o) => ({
        id: o.id, name: o.name, engine: o.engine, engineName: (ref.engineById.get(o.engine) || {}).name,
        color: o.color, bg: o.bg, marketWeight: o.marketWeight,
        agents: ref.agentsOf(o.id).length, subscribers: ref.subscribersOf(o.id).length,
        lifetime: life.get(o.id) || { count: 0, sumXaf: 0, feeXaf: 0 },
      })),
      engines: ref.ENGINES,
    });
  });
  app.get('/api/v1/agents', requireAuth, (req, res) => {
    const o = scopeOpts(req);
    let list = ref.AGENTS;
    if (o.operatorId) list = ref.agentsOf(o.operatorId);
    res.json({ count: list.length, agents: list.slice(0, 200) });
  });

  // ==========================================================================
  // Module 5 — Revenus & redevances
  // ==========================================================================
  app.get('/api/v1/revenue', requireModule('revenus'), (req, res) => res.json(revenue.report(scopeOpts(req))));
  app.get('/api/v1/revenue/discrepancies', requireModule('revenus'), (req, res) => res.json({ items: revenue.discrepancies(scopeOpts(req), 60) }));

  // ==========================================================================
  // Module 6 — Qualité de service
  // ==========================================================================
  app.get('/api/v1/qos', requireModule('qos'), (req, res) => res.json(qos.report(scopeOpts(req))));

  // ==========================================================================
  // Module 7 — Antifraude / AML
  // ==========================================================================
  app.get('/api/v1/fraud/rules', requireModule('antifraude'), (_req, res) => res.json({ stats: rules.stats(), config: config.getRules() }));
  app.get('/api/v1/fraud/alerts', requireModule('antifraude'), (req, res) => {
    const o = scopeOpts(req);
    res.json({ alerts: rules.recent(120, { operatorId: o.operatorId, ruleId: req.query.ruleId, severity: req.query.severity }) });
  });

  // ==========================================================================
  // Module 9 — Géolocalisation
  // ==========================================================================
  // Palier P3 (localisation) : l'AIPD le classe « accès le plus restreint,
  // journalisé ». La consultation est donc tracée comme les autres accès sensibles.
  app.get('/api/v1/geo/cells', requireModule('geo'), (req, res) => {
    auditEvent(req, 'ACCES_P3', 'geo/cells', {});
    res.json({ cells: geo.cells(), stats: geo.stats() });
  });
  // Correctif P1 n°15 — les anomalies géographiques désignent des PERSONNES
  // (« ce numéro s'est déplacé de 300 km en 15 minutes ») : c'est du palier P3
  // NOMINATIF, pas de la cartographie. Le module dispatché ne suffit donc plus ;
  // la cartographie agrégée de `geo/cells`, elle, ne désigne personne et reste
  // ouverte au module.
  app.get('/api/v1/geo/anomalies', requireModule('geo'), (req, res) => {
    if (!users.canAccessP3(req.auth)) {
      auditEvent(req, 'ACCES_P3_REFUS', 'geo/anomalies', { motif: 'habilitation nominative P3 requise' });
      return res.status(403).json({
        error: 'La corrélation abonné ↔ déplacement relève du palier P3 : habilitation nominative requise (DCTLF, DJ, DHQR, Président, SE).',
        code: 'HABILITATION_P3_REQUISE',
      });
    }
    auditEvent(req, 'ACCES_P3', 'geo/anomalies', { palier: 'P3', nominatif: true });
    res.json({ anomalies: geo.recent(60) });
  });

  // ==========================================================================
  // Module 10 — Analytics / risque
  // ==========================================================================
  app.get('/api/v1/analytics/risk', requireModule('analytics'), (_req, res) => res.json({ stats: ml.stats(), top: ml.topRisky(25) }));

  // ==========================================================================
  // Module 8 — Investigation / cas + traçage de chaîne
  // ==========================================================================
  // Vue liste : MSISDN toujours masqué (minimisation) — le démasquage se fait sur
  // le détail d'un dossier (rôle habilité + entrée d'audit).
  app.get('/api/v1/cases', requireModule('investigation'), (req, res) => {
    const listed = cases.list({ status: req.query.status }).map((c) => ({ ...c, subjectMsisdn: c.subjectMsisdn ? ref.maskMsisdn(c.subjectMsisdn) : null }));
    res.json({ stats: cases.stats(), cases: listed });
  });
  app.post('/api/v1/cases', requireModule('investigation'), (req, res) => {
    if (!users.canWriteCases(req.auth)) return res.status(403).json({ error: 'Création de dossier non autorisée pour votre profil.' });
    const b = req.body || {};
    let subjectMsisdn = null;
    if (b.subjectToken) subjectMsisdn = subjects.resolve(b.subjectToken);
    const c = cases.create({ title: b.title, severity: b.severity, subjectMsisdn, createdBy: req.auth.username, linkedTdrIds: b.linkedTdrIds, fromAlert: b.fromAlert || null });
    auditEvent(req, 'CASE_CREATE', c.id, { subjectToken: b.subjectToken || null });
    res.status(201).json({ case: c });
  });
  app.get('/api/v1/cases/:id', requireModule('investigation'), (req, res) => {
    const c = cases.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Dossier introuvable.' });
    const reveal = canReveal(req);
    if (reveal && c.subjectMsisdn) auditEvent(req, 'MSISDN_REVEAL', c.id, { context: 'case' });
    const out = { ...c, subjectMsisdn: reveal ? c.subjectMsisdn : ref.maskMsisdn(c.subjectMsisdn) };
    res.json({ case: out });
  });
  app.patch('/api/v1/cases/:id', requireModule('investigation'), (req, res) => {
    if (!users.canWriteCases(req.auth)) return res.status(403).json({ error: 'Modification non autorisée.' });
    const c = cases.update(req.params.id, req.body || {}, req.auth.username);
    if (!c) return res.status(404).json({ error: 'Dossier introuvable.' });
    auditEvent(req, 'CASE_UPDATE', c.id, { fields: Object.keys(req.body || {}) });
    res.json({ case: c });
  });

  // Traçage d'un sujet : accès NOMINATIF au palier P2 (loi 001/2011).
  // Correctif B2 : le module « investigation » ne suffit plus. Reconstituer
  // l'historique transactionnel complet d'une personne EST l'acte de surveillance
  // ciblée que le décret et l'AIPD réservent aux profils habilités — la seule
  // révélation en clair des numéros ne l'était pas. `canReveal` gouverne donc les
  // deux, et l'accès est journalisé dans tous les cas.
  app.get('/api/v1/trace', requireModule('investigation'), async (req, res) => {
    if (!canReveal(req)) {
      auditEvent(req, 'TRACE_REFUS', String(req.query.token || ''), { motif: 'habilitation nominative requise' });
      return res.status(403).json({ error: 'Le traçage d\'un sujet est réservé aux profils habilités (antifraude / juridique).' });
    }
    const token = String(req.query.token || '');
    const msisdn = subjects.resolve(token);
    if (!msisdn) return res.status(404).json({ error: 'Sujet inconnu (jeton non résolu).' });
    const reveal = req.query.reveal === '1' && canReveal(req);
    const fenetre = { days: req.query.days, start: req.query.start, end: req.query.end };
    // La FENÊTRE consultée est journalisée avec l'accès : l'étendue d'une mesure de
    // surveillance fait partie de ce qui doit être contrôlable a posteriori.
    if (reveal) auditEvent(req, 'MSISDN_REVEAL', token, { context: 'trace', ...fenetre });
    else auditEvent(req, 'TRACE', token, fenetre);
    try {
      const chain = await cases.traceChain(msisdn, { reveal, ...fenetre, limit: req.query.limit });
      res.json({ chain });
    } catch (e) {
      if (e.code === 'SCANNER_BUSY') return res.status(503).json({ error: e.message });
      res.status(400).json({ error: e.message });
    }
  });

  // ==========================================================================
  // Module 1/2 — Connecteurs / Collecte & qualité d'ingestion
  // ==========================================================================
  app.get('/api/v1/connectors', requireModule('connecteurs'), (req, res) => {
    const list = ref.OPERATORS.filter((o) => !(req.auth.role === users.ROLES.OPERATEUR && req.auth.operatorId && o.id !== req.auth.operatorId));
    res.json({
      ingestion: normalize.getStats(),
      // Correctif P1 n°11 : l'état du canal est désormais observable par
      // assujetti — clé propre, quota, liste d'adresses, exigence de certificat.
      canal: connectors.summary(),
      connectors: list.map((o) => ({
        operatorId: o.id, name: o.name, engine: (ref.engineById.get(o.engine) || {}).name,
        endpoint: 'POST /api/v1/iso8583',
        auth: 'HMAC-SHA256 par opérateur · horodatage + nonce signés (anti-rejeu)',
        formats: ['ISO 8583', 'JSON', 'CSV'],
        signature: 'ECDSA P-256 (registre)',
        ...(connectors.describe(o.id) || {}),
      })),
    });
  });

  // Rotation du secret d'un connecteur. Le secret n'est présenté QU'ICI, une fois.
  app.post('/api/v1/connectors/:operatorId/rotate', requireAdmin, (req, res) => {
    try {
      const r = connectors.rotate(String(req.params.operatorId));
      auditEvent(req, 'CONNECTEUR_ROTATION', r.operatorId, {});
      res.json({ ...r, note: 'Transmettez ces identifiants à l\'assujetti par canal sûr : ils ne seront plus affichés.' });
    } catch (e) { res.status(404).json({ error: e.message }); }
  });

  // Garde-fous d'exploitation : liste d'adresses, quota, empreinte de certificat.
  app.put('/api/v1/connectors/:operatorId', requireAdmin, (req, res) => {
    try {
      const r = connectors.update(String(req.params.operatorId), req.body || {});
      auditEvent(req, 'CONNECTEUR_CONFIG', r.operatorId, { champs: Object.keys(req.body || {}) });
      res.json({ connector: r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ==========================================================================
  // Module 3 / 11 — Registre (lac de données) & vérification
  // ==========================================================================
  app.get('/api/v1/ledger', requireModule('registre'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 300);
    const o = scopeOpts(req);
    const records = ledger.getRecent(800)
      .filter((r) => warehouse.matchesOperator(r.payload, o.operatorId))
      .slice(0, limit)
      .map((r) => ({ seq: r.seq, ts: r.ts, hash: r.hash, payload: model.toPublic(r.payload, { reveal: false }) }));
    res.json({ stats: ledger.stats(), records });
  });
  // Par défaut : FENÊTRE RÉCENTE (rapide) — la réponse porte `scope`, `anchored`
  // et une note explicite : un contrôle borné ne certifie pas l'historique.
  // ?full=1 → parcours intégral depuis la genèse (chaînage + continuité de séquence
  // sur 100 % des enregistrements, signatures échantillonnées).
  app.get('/api/v1/ledger/verify', requireModule('registre'), (req, res) => {
    const full = req.query.full === '1';
    const result = full ? ledger.verifyChain({ signatures: 'sample' }) : ledger.verifyChain({ limit: 5000 });
    auditEvent(req, full ? 'VERIF_REGISTRE_INTEGRALE' : 'VERIF_REGISTRE', 'tdr', { valid: result.valid, scope: result.scope });
    res.json({ ...result, startupCheck: startupIntegrity.tdr || null });
  });
  app.get('/api/v1/pubkey', (_req, res) => res.json({ algorithm: ledger.stats().algorithm, publicKeyPem: ledger.getPublicKeyPem(), auditPublicKeyPem: audit.getPublicKeyPem() }));

  // --- Ancrage externe de la racine de chaîne (correctif C2) ---------------
  // Le chiffrement des clés protège du vol de volume, pas de l'exploitant. Le reçu
  // d'ancrage, une fois DÉPOSÉ chez un tiers, rend toute réécriture antérieure
  // détectable — y compris par qui détient la clé de signature.
  app.get('/api/v1/ledger/anchors', requireModule('registre'), (_req, res) => {
    res.json({
      anchors: anchor.list(50),
      verification: anchor.verifyAgainst(ledger, anchor.latestFor('tdr')),
      note: 'Le dépôt du reçu chez un tiers de confiance est un acte organisationnel, hors du périmètre logiciel.',
    });
  });

  app.post('/api/v1/ledger/anchors', requireAdmin, (req, res) => {
    try {
      const receipt = anchor.emit(ledger, { note: (req.body || {}).note });
      auditEvent(req, 'ANCRAGE_EMIS', String(receipt.seq), { headHash: receipt.headHash, note: receipt.note });
      res.status(201).json({ receipt });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ==========================================================================
  // Module 11 — Reporting réglementaire & exports signés
  // ==========================================================================
  app.get('/api/v1/reports/templates', requireModule('reporting'), (_req, res) => res.json({ templates: reporting.TEMPLATES }));
  app.get('/api/v1/reports/generate', requireModule('reporting'), async (req, res) => {
    try {
      const o = scopeOpts(req);
      res.json(await reporting.generate(String(req.query.template || 'observatoire'), o));
    } catch (e) {
      if (e.code === 'SCANNER_BUSY') return res.status(503).json({ error: e.message });
      res.status(400).json({ error: e.message });
    }
  });
  app.get('/api/v1/reports/export', requireModule('reporting'), async (req, res) => {
    try {
      const o = scopeOpts(req);
      const report = await reporting.generate(String(req.query.template || 'observatoire'), o);
      const format = String(req.query.format || 'csv').toLowerCase();
      let body; let mime; let ext;
      if (format === 'json') { body = JSON.stringify(report, null, 2); mime = 'application/json'; ext = 'json'; }
      else { body = reporting.toCsv(report); mime = 'text/csv'; ext = 'csv'; }
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      auditEvent(req, 'EXPORT', report.template, { format, records: report.recordCount, truncated: report.truncated });
      // Un export tronqué le porte dans ses en-têtes : il ne doit pas pouvoir être
      // présenté comme exhaustif au seul vu du fichier.
      if (report.truncated) res.setHeader('X-Report-Truncated', 'true');
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="sumo-${report.template}-${Date.now()}.${ext}"`);
      res.setHeader('X-Content-SHA256', sha256);
      res.setHeader('X-Signature-ECDSA-P256', ledger.signHashHex(sha256));
      res.send(body);
    } catch (e) {
      if (e.code === 'SCANNER_BUSY') return res.status(503).json({ error: e.message });
      res.status(400).json({ error: e.message });
    }
  });

  // ==========================================================================
  // Module M15 — Gestion des dossiers (moteur de workflow, standard BPM)
  // ==========================================================================
  // Vue d'ensemble : référentiel des types, statistiques, corbeille de la
  // session et dossiers visibles (cloisonnement RG-16 appliqué côté serveur).
  app.get('/api/v1/workflow', requireModule('workflow'), (req, res) => {
    res.json({
      types: workflow.TYPES.map((t) => ({ id: t.id, label: t.label, couloir: t.couloir, pilote: t.pilote, avis: t.avis, decision: t.decision, slaJours: t.slaJours, pieces: t.pieces })),
      statuts: workflow.STATUTS,
      stats: workflow.stats(req.auth),
      corbeille: workflow.corbeille(req.auth),
      dossiers: workflow.list(req.auth, { statut: req.query.statut, typeId: req.query.typeId }).slice(0, 200),
    });
  });
  app.get('/api/v1/workflow/dossiers/:id', requireModule('workflow'), (req, res) => {
    const d = workflow.get(req.params.id);
    if (!d || !workflow.visible(d, req.auth)) return res.status(404).json({ error: 'Dossier introuvable.' });
    res.json({ dossier: workflow.toPublicDossier(d, req.auth) });
  });
  // Dépôt (RG-01) : l'accusé de réception est immédiat et audité.
  app.post('/api/v1/workflow/dossiers', requireModule('workflow'), (req, res) => {
    try {
      const b = req.body || {};
      const demandeur = req.auth.operatorId
        ? { categorie: 'OPERATEUR', nom: req.auth.displayName, operatorId: req.auth.operatorId }
        : { categorie: 'INTERNE', nom: req.auth.displayName, direction: req.auth.direction };
      const d = workflow.deposer({ typeId: b.typeId, objet: b.objet, demandeur, priorite: b.priorite, directionSaisie: b.directionSaisie }, req.auth.username);
      auditEvent(req, 'WF_DEPOT_API', d.numero, { typeId: d.typeId });
      res.status(201).json({ dossier: workflow.toPublicDossier(d, req.auth) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Toute transition passe par UNE route : l'action est validée contre le
  // statut ET le rôle de la session (allowedActions) — jamais côté client.
  app.post('/api/v1/workflow/dossiers/:id/action', requireModule('workflow'), (req, res) => {
    try {
      const d = workflow.get(req.params.id);
      if (!d || !workflow.visible(d, req.auth)) return res.status(404).json({ error: 'Dossier introuvable.' });
      const b = req.body || {};
      const updated = workflow.executer(req.params.id, String(b.action || ''), b.params || {}, req.auth);
      auditEvent(req, 'WF_ACTION', updated.numero, { action: b.action });
      res.json({ dossier: workflow.toPublicDossier(updated, req.auth) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ==========================================================================
  // Module M14 — Supervision des services financiers numériques (P1–P7)
  // ==========================================================================
  // Mesure indépendante (N3) : rapport mesuré vs déclaré + journal probant.
  app.get('/api/v1/probes', requireModule('mesures'), (req, res) => res.json(probes.report(scopeOpts(req))));
  // Déclenchement manuel d'une campagne (audité — action réglementaire).
  // Une campagne est LOURDE et SYNCHRONE (une centaine de mesures, chacune
  // signée puis écrite au journal probant) : le quota général de l'API ne suffit
  // pas à la protéger. Quota dédié + verrou anti-concurrence.
  const campaignLimiter = rateLimit({ windowMs: 60_000, max: 6, standardHeaders: true, legacyHeaders: false });
  let campaignRunning = false;
  app.post('/api/v1/probes/campaign', requireModule('mesures'), campaignLimiter, (req, res) => {
    if (campaignRunning) return res.status(429).json({ error: 'Une campagne est déjà en cours.' });
    campaignRunning = true;
    try {
      const result = probes.runCampaign();
      auditEvent(req, 'CAMPAGNE_N3', 'probes', { measurements: result.measurements });
      res.status(202).json({ status: 'LANCEE', ...result });
    } finally { campaignRunning = false; }
  });
  app.get('/api/v1/probes/journal/verify', requireModule('mesures'), (_req, res) => res.json(probes.journal.verifyChain({ limit: 2000 })));

  // Accès des tiers (L8) : registre PSP, AT-01..04, plaintes discrimination.
  app.get('/api/v1/thirdparty', requireModule('tiers'), (req, res) => res.json(thirdparty.report(scopeOpts(req))));

  // Réclamations consommateurs (RC) corrélées aux incidents.
  app.get('/api/v1/complaints', requireModule('reclamations'), (req, res) => res.json(complaints.report(scopeOpts(req))));

  // Services financiers postaux (SP). Cloisonnement : l'opérateur postal
  // n'appartient pas au référentiel Mobile Money, donc AUCUN compte scopé sur un
  // opérateur n'a à consulter son réseau ni ses volumes — le rapport est global
  // par nature et ne saurait être filtré pour eux.
  app.get('/api/v1/postal', requireModule('postal'), (req, res) => {
    if (scopeOpts(req).operatorId) return res.status(403).json({ error: 'Volet postal hors du périmètre de votre opérateur.' });
    res.json(postal.report());
  });

  // ==========================================================================
  // Module 12 — Sécurité & journal d'audit
  // ==========================================================================
  // L'onglet Sécurité interroge cet endpoint toutes les 4 s : l'intégrité est
  // vérifiée sur une fenêtre bornée et mise en cache (TTL), sinon chaque poll
  // relirait et revérifierait tout le registre en bloquant l'event loop.
  let integrityCache = { at: 0, ledger: null, audit: null };
  const INTEGRITY_TTL_MS = 30_000;
  function integritySnapshot() {
    if (Date.now() - integrityCache.at > INTEGRITY_TTL_MS) {
      integrityCache = {
        at: Date.now(),
        // Contrôles BORNÉS (le poll de l'onglet Sécurité ne peut pas relire des Go
        // à chaque tick). Ils portent `scope: 'recent'` et `anchored: false` : le
        // seul contrôle ancré à la genèse est celui du démarrage, servi à côté.
        ledger: ledger.verifyChain({ limit: 1000 }),
        audit: audit.verify({ limit: 1000 }),
      };
    }
    return integrityCache;
  }
  app.get('/api/v1/security', requireModule('securite'), async (_req, res) => {
    const persistence = await db.status();
    const integrity = integritySnapshot();
    res.json({
      transport: { tls: secure, scheme: tlsEnabled ? 'https/wss (TLS direct)' : (behindTlsProxy ? 'https/wss (TLS terminé au reverse proxy)' : 'http/ws (dev)') },
      ledger: { ...ledger.stats(), integrity: integrity.ledger, integriteIntegrale: startupIntegrity.tdr || null },
      audit: { ...audit.stats(), integrity: integrity.audit, integriteIntegrale: startupIntegrity.audit || null },
      persistence, // entrepôt PostgreSQL (si DATABASE_URL défini)
      rbac: { roles: Object.keys(users.ROLES).length, modules: modules.LEAF_MODULE_IDS.length, dispatch: 'modules affectés par direction / compte (admin système)' },
      // Correctif B3 : l'imputabilité se mesure. « secretsDistincts » doit égaler
      // « comptes » — s'il vaut 1, le défaut d'origine est de retour.
      identites: { ...users.credentials.summary(), modeDemonstration: users.DEMO_MODE },
      // Correctifs C2/F1 : la posture de chiffrement au repos est annoncée telle
      // qu'elle est, mode dégradé compris — jamais présentée comme acquise.
      chiffrementAuRepos: vault.status(),
      conservation: retention.state(),
      canalIngestion: connectors.summary(),
      ancrageExterne: anchor.verifyAgainst(ledger, anchor.latestFor('tdr')),
      // Correctif D1 : le parcours du registre ne bloque plus l'event loop.
      lectureRegistre: { ...scanner.stats(), note: 'parcours hors du fil principal, file bornée, résultats plafonnés' },
      dataMinimization: { msisdnMaskedByDefault: true, revealRoles: ['PRESIDENT', 'SE', 'directions DCTLF & DJ'], revealAudited: true },
      // Ce que le registre garantit RÉELLEMENT, et contre qui. Sans ancrage
      // externe ni HSM, la propriété offerte est la détection de falsification par
      // un tiers SANS accès à l'hôte — pas la non-répudiation face à l'exploitant.
      valeurProbante: {
        ecrivainUnique: 'verrou exclusif par chaîne (refus de démarrage si déjà détenu)',
        durabilite: 'fsync à chaque enregistrement ; ligne terminale tronquée détectée et journalisée',
        controleAuDemarrage: 'chaînage + continuité de séquence sur 100 % des enregistrements, signatures échantillonnées',
        limite: 'clés privées détenues par l\'hôte : un accès système permettrait de réécrire ET de resigner. Ancrage externe (tiers de confiance / RFC 3161) requis pour opposer le registre à l\'exploitant lui-même.',
      },
      // Cette liste doit rester EXACTE : y laisser une garantie désormais livrée
      // ferait mentir l'écran dans l'autre sens, et l'honnêteté de cette section
      // est ce qui lui donne sa valeur devant un tiers.
      notImplemented: [
        vault.hasPassphrase()
          ? 'Conservation des clés en HSM/KMS souverain (la phrase secrète vit en mémoire du processus)'
          : 'CHIFFREMENT AU REPOS INACTIF — définir SUMO_KEY_PASSPHRASE',
        'mTLS mutuel exigé de tous les assujettis (mécanisme livré ; PKI et empreintes à déclarer)',
        'Dépôt effectif des reçus d\'ancrage chez un tiers de confiance (acte organisationnel)',
        'Horodatage qualifié RFC 3161 (autorité d\'horodatage externe)',
        'Suppression physique du palier P1 (exige la segmentation du fichier de registre)',
        'Test d\'intrusion externe (engagement de l\'AIPD, non réalisé)',
        'Certification ISO 27001',
        persistence.enabled ? 'Réplication HA / multi-instances PostgreSQL' : 'Persistance distribuée / HA (activer DATABASE_URL → PostgreSQL)',
        'Sessions partagées entre instances (le rôle « reader » impose l\'affinité de session)',
      ],
    });
  });
  app.get('/api/v1/db/status', requireModule('securite'), async (_req, res) => res.json(await db.status()));

  // --- Conservation & effacement (correctif P1 n°16) ------------------------
  app.get('/api/v1/retention', requireModule('securite'), (_req, res) => res.json(retention.state()));

  // La purge est IRRÉVERSIBLE : elle s'exécute à blanc par défaut, et ne détruit
  // qu'à la demande explicite (`confirm: true`).
  app.post('/api/v1/retention/purge', requireAdmin, (req, res) => {
    const confirme = (req.body || {}).confirm === true;
    const r = retention.runPurge({
      dryRun: !confirme,
      actor: req.auth.username,
      record: (e) => audit.record(e),
    });
    auditEvent(req, confirme ? 'PURGE_EXECUTEE' : 'PURGE_SIMULEE', 'retention', { segments: r.segments.length });
    res.json({
      ...r,
      note: confirme
        ? 'Clés détruites : les identifiants de ces périodes sont définitivement illisibles.'
        : 'Simulation. Renvoyez { "confirm": true } pour détruire réellement les clés — l\'opération est irréversible.',
    });
  });
  app.get('/api/v1/audit', requireModule('securite'), (req, res) => res.json({ stats: audit.stats(), events: audit.recent(Math.min(Number(req.query.limit) || 100, 300)) }));
  app.get('/api/v1/audit/verify', requireModule('securite'), (_req, res) => res.json(audit.verify()));

  // ==========================================================================
  // Module 13 — Administration & configuration
  // ==========================================================================
  app.get('/api/v1/config', requireModule('admin'), (_req, res) => res.json({ config: config.get(), defaults: config.defaults() }));
  app.put('/api/v1/config', requireAdmin, (req, res) => {
    try {
      const next = config.update(req.body || {});
      auditEvent(req, 'CONFIG_UPDATE', 'config', { keys: Object.keys(req.body || {}) });
      res.json({ config: next });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/v1/config/reset', requireAdmin, (req, res) => {
    const next = config.reset();
    auditEvent(req, 'CONFIG_RESET', 'config', {});
    res.json({ config: next });
  });

  // ==========================================================================
  // Dispatch des modules (ADMIN_SYSTEME) — affectation par direction / compte
  // ==========================================================================
  app.get('/api/v1/dispatch/state', requireSystemAdmin, (_req, res) => {
    const st = assignments.state();
    const accounts = users.USERS.filter((u) => u.role !== users.ROLES.ADMIN_SYSTEME);
    const membersByDir = new Map();
    for (const u of accounts) {
      if (!u.direction) continue;
      if (!membersByDir.has(u.direction)) membersByDir.set(u.direction, []);
      membersByDir.get(u.direction).push({ username: u.username, displayName: u.displayName, role: u.role });
    }
    res.json({
      modules: modules.tree(),
      directions: nomenclature.DIRECTIONS.map((d) => ({
        code: d.code, nom: d.nom, type: d.type,
        modules: st.directions[d.code] || [],
        membres: membersByDir.get(d.code) || [],
      })),
      users: accounts.map((u) => ({
        username: u.username, displayName: u.displayName, role: u.role, direction: u.direction,
        individualModules: st.users[u.username] || [],
        effectiveModules: users.effectiveModules(u),
      })),
      // Entrées persistées qui ne correspondent plus à la nomenclature / aux
      // comptes : inertes, mais signalées pour nettoyage.
      orphans: {
        directions: Object.keys(st.directions).filter((c) => !nomenclature.isDirection(c)),
        users: Object.keys(st.users).filter((n) => !users.getByUsername(n)),
      },
    });
  });

  app.put('/api/v1/dispatch/directions/:code', requireSystemAdmin, (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    if (!nomenclature.isDirection(code)) return res.status(404).json({ error: `Direction inconnue : « ${code} ».` });
    try {
      const r = assignments.setDirection(code, (req.body || {}).modules);
      auditEvent(req, 'DISPATCH_DIRECTION', code, { added: r.added, removed: r.removed });
      res.json({ direction: code, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.put('/api/v1/dispatch/users/:username', requireSystemAdmin, (req, res) => {
    const target = users.getByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: 'Compte inconnu.' });
    if (target.role === users.ROLES.ADMIN_SYSTEME) return res.status(400).json({ error: 'Le compte admin système ne reçoit pas de modules métier.' });
    try {
      const r = assignments.setUser(target.username, (req.body || {}).modules);
      auditEvent(req, 'DISPATCH_USER', target.username, { added: r.added, removed: r.removed });
      res.json({ username: target.username, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ==========================================================================
  // Connecteur d'injection externe (HMAC) — ISO 8583 / JSON / CSV
  // ==========================================================================
  // Correctif P1 n°11 — l'authentification du connecteur est NOMINATIVE.
  // La clé partagée a disparu : chaque assujetti a son secret, sa signature couvre
  // horodatage et nonce (anti-rejeu), et il ne peut déclarer que pour lui-même.
  // Tout refus est journalisé au registre d'audit : le canal qui porte la preuve
  // doit lui-même être traçable.
  function authenticate(req, res, next) {
    const corps = req.body || {};
    const declare = corps.operatorId || (corps.record || {}).operatorId || null;
    const verdict = connectors.verify({
      key: req.get('x-sumo-key'),
      signature: req.get('x-sumo-signature'),
      timestamp: req.get('x-sumo-timestamp'),
      nonce: req.get('x-sumo-nonce'),
      rawBody: req.rawBody,
      ip: req.ip,
      // Empreinte transmise par le proxy qui termine le mTLS (cf. Caddyfile).
      clientCertFingerprint: req.get('x-client-cert-fingerprint') || null,
      declaredOperatorId: declare,
    });
    if (!verdict.ok) {
      audit.record({
        action: 'INGESTION_REFUS', actor: verdict.operatorId || 'inconnu', role: 'CONNECTEUR',
        target: declare, meta: { code: verdict.code, ip: req.ip },
      });
      metrics.noteIngestion(verdict.code);
      return res.status(verdict.status).json({ status: 'REJECTED', code: verdict.code, error: verdict.error });
    }
    req.connectorOperatorId = verdict.operatorId;
    next();
  }

  app.post('/api/v1/iso8583', authenticate, (req, res) => {
    try {
      const p = req.body || {};
      let tdr;
      if (typeof p.message === 'string') {
        // La norme ISO 8583 ne porte NI les frais NI la taxe : le contrat
        // d'interfaçage impose donc de les transmettre dans l'enveloppe. Sans eux,
        // l'assurance des revenus n'aurait rien à confronter — on rejette plutôt
        // que de recalculer et de faire passer le barème pour une déclaration.
        const missing = [];
        if (p.feeAmount == null) missing.push('feeAmount');
        if (p.taxAmount == null) missing.push('taxAmount');
        if (missing.length) {
          normalize.noteIso('connecteur:iso8583', false);
          return res.status(400).json({ status: 'REJECTED', error: `Enveloppe incomplète : ${missing.join(', ')} (non portés par ISO 8583, obligatoires au contrat).` });
        }
        tdr = model.fromIso8583(p.message, {
          operatorId: p.operatorId, channel: p.channel,
          senderMsisdn: p.senderMsisdn, receiverMsisdn: p.receiverMsisdn, senderKyc: p.senderKyc,
          cityName: p.cityName, cellOriginId: p.cellOriginId,
          operatorRef: p.transactionId, datetime: p.timestamp,
          feeDeclared: p.feeAmount, taxDeclared: p.taxAmount, latencyMs: p.latencyMs,
          feeGrid: config.getFees(),
        });
        normalize.noteIso('connecteur:iso8583', true);
      } else {
        const norm = p.format === 'csv'
          ? normalize.fromCsv(p.line, p.columns, { operatorId: p.operatorId, source: 'connecteur:csv' })
          : normalize.normalizeObject(p.record || p, { operatorId: p.operatorId || (p.record || p).operatorId, source: 'connecteur:json' });
        if (!norm.ok) return res.status(400).json({ status: 'REJECTED', error: norm.error, quality: norm.quality });
        tdr = model.buildTDR({ ...norm.input, feeGrid: config.getFees() });
        tdr._quality = norm.quality;
      }
      // Correctif P1 n°11 (volet A5) — idempotence effective. Deux envois de la
      // même transaction ne produisent qu'un enregistrement : sans cela, un
      // rattrapage après incident gonflerait volumes et redevance.
      const deja = connectors.knownRef(req.connectorOperatorId, tdr.operatorRef);
      if (deja) {
        metrics.noteIngestion('DUPLICATE');
        return res.status(200).json({
          status: 'DUPLICATE', code: 'DEJA_ENREGISTREE',
          id: deja.id, seq: deja.seq, operatorRef: tdr.operatorRef,
          note: 'Transaction déjà enregistrée sous cette référence — aucun doublon créé.',
        });
      }

      pipeline.ingest(tdr); // TDR neuf : enrichissement + effets de bord (réclamations M14)
      const rec = ledger.append(tdr);
      connectors.rememberRef(req.connectorOperatorId, tdr.operatorRef, { id: tdr.id, seq: rec.seq });
      warehouse.ingest(tdr);
      db.persist(tdr, rec); // entrepôt PostgreSQL optionnel
      broadcast({ type: 'TX', data: model.toPublic(tdr, { reveal: false }), ledger: { seq: rec.seq, hash: rec.hash } });
      metrics.noteIngestion('ACCEPTED');
      res.status(202).json({
        status: 'ACCEPTED', id: tdr.id, operatorRef: tdr.operatorRef,
        seq: rec.seq, hash: rec.hash, type: tdr.type, datetime: tdr.datetime,
        alerts: (tdr.alerts || []).length, risk: tdr.risk ? tdr.risk.score : 0,
        quality: tdr._quality,
        // L'assujetti voit ce que la plateforme a retenu de sa déclaration et ce
        // qu'elle considère comme non transmis : le contradictoire commence ici.
        provenance: tdr.provenance,
        fee: { declared: tdr.fee.amount, expected: tdr.fee.expected, ecart: tdr.fee.amount == null ? null : tdr.fee.expected - tdr.fee.amount },
        iso8583: tdr.iso8583.message,
      });
    } catch (e) {
      res.status(400).json({ status: 'REJECTED', error: e.message });
    }
  });

  // --------------------------------------------------------------------------
  // Statique (espace de travail protégé)
  // --------------------------------------------------------------------------
  if (serveStatic) {
    const root = path.join(__dirname, '..');
    app.get(['/', '/index.html'], (req, res, next) => {
      if (!req.auth) return res.redirect(302, '/login.html');
      next();
    });
    app.use(express.static(path.join(root, 'public')));
    // Bibliothèques et ressources servies depuis le dépôt : aucune n'est chargée
    // depuis un tiers, la console reste utilisable sur un site isolé.
    app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules', 'leaflet', 'dist')));
    app.use('/vendor/chartjs', express.static(path.join(root, 'node_modules', 'chart.js', 'dist')));
    app.use('/vendor/fontawesome', express.static(path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free')));
    app.use('/vendor/inter', express.static(path.join(root, 'node_modules', '@fontsource', 'inter', 'files')));
  }

  app.use((err, _req, res, _next) => {
    logger.error('unhandled.request', { error: err.message });
    res.status(500).json({ status: 'ERROR', error: 'Erreur interne.' });
  });

  return app;
}

module.exports = { createApp, originAllowed };
