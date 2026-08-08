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
const assignments = require('./assignments');

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

function originAllowed(origin) {
  if (!origin) return true;
  if (CORS_ORIGINS.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function createApp(opts = {}) {
  const api = opts.api || { key: null, secret: null };
  const broadcast = typeof opts.broadcast === 'function' ? opts.broadcast : () => {};
  const tlsEnabled = !!opts.tlsEnabled;
  const serveStatic = opts.serveStatic !== false;
  const demoLogin = !!opts.demoLogin;
  // Derrière un reverse proxy qui termine le TLS (Caddy/nginx) : la connexion
  // navigateur↔proxy est en HTTPS bien que l'app reçoive du HTTP en interne.
  const behindTlsProxy = !!opts.behindTlsProxy;
  const secure = tlsEnabled || behindTlsProxy; // sécurité « effective » (cookies, HSTS, CSP)

  const app = express();
  app.disable('x-powered-by');
  // Fait confiance au 1er proxy : X-Forwarded-Proto/For → req.secure et req.ip corrects.
  if (behindTlsProxy) app.set('trust proxy', 1);

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
        frameAncestors: ["'none'"], objectSrc: ["'none'"],
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
    res.on('finish', () => logger.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }));
    next();
  });
  app.use('/api/', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }));

  // --------------------------------------------------------------------------
  // Helpers d'autorisation, de scope et d'audit
  // --------------------------------------------------------------------------
  const cookieSecure = secure;
  const setSession = (res, id) => res.setHeader('Set-Cookie', auth.serializeCookie(auth.SESSION_COOKIE, id, { httpOnly: true, sameSite: 'Strict', secure: cookieSecure, path: '/', maxAge: Math.floor(auth.TTL_MS / 1000) }));
  const clearSession = (res) => res.setHeader('Set-Cookie', auth.serializeCookie(auth.SESSION_COOKIE, '', { httpOnly: true, sameSite: 'Strict', secure: cookieSecure, path: '/', maxAge: 0 }));
  const publicUser = (s) => ({ username: s.username, displayName: s.displayName, role: s.role, direction: s.direction || null, operatorId: s.operatorId, scopeType: s.scopeType, title: s.title, permissions: users.permissions(s) });

  function requireAuth(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    next();
  }
  // Gating de module PAR UTILISATEUR (affectations direction ∪ individuel),
  // recalculé à chaque requête : une révocation dispatchée par l'admin système
  // prend effet immédiatement, sans invalider les sessions.
  const requireModule = (moduleId) => (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    if (!users.hasModule(req.auth, moduleId)) return res.status(403).json({ error: `Module « ${moduleId} » non affecté à votre profil.` });
    next();
  };
  const requireAdmin = (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
    if (!users.canAdmin(req.auth)) return res.status(403).json({ error: 'Action réservée à l\'administration.' });
    next();
  };
  const requireSystemAdmin = (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentification requise.' });
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

  app.post('/api/v1/auth/login', authLimiter, (req, res) => {
    const body = req.body || {};
    const user = users.authenticate(body.username, String(body.password || ''));
    if (!user) { auditEvent(req, 'LOGIN_ECHEC', body.username, {}); return res.status(401).json({ error: 'Identifiants invalides.' }); }
    setSession(res, auth.createSession(user));
    auditEvent(req, 'LOGIN', user.username, { role: user.role }, user);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/v1/auth/demo', authLimiter, (req, res) => {
    if (!demoLogin) return res.status(403).json({ error: 'Accès démo désactivé (mode production).' });
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
    res.json({ user: publicUser(req.auth), demoLogin });
  });
  app.get('/api/v1/auth/accounts', (_req, res) => {
    res.json({ demoLogin, password: demoLogin ? users.DEMO_PASSWORD : undefined, accounts: demoLogin ? users.catalog() : [] });
  });

  // ==========================================================================
  // Référentiel & santé
  // ==========================================================================
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
  app.get('/api/v1/geo/cells', requireModule('geo'), (_req, res) => res.json({ cells: geo.cells(), stats: geo.stats() }));
  app.get('/api/v1/geo/anomalies', requireModule('geo'), (_req, res) => res.json({ anomalies: geo.recent(60) }));

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

  // Traçage : résout le jeton → MSISDN (serveur). Révélation des numéros gated + auditée.
  app.get('/api/v1/trace', requireModule('investigation'), (req, res) => {
    const token = String(req.query.token || '');
    const msisdn = subjects.resolve(token);
    if (!msisdn) return res.status(404).json({ error: 'Sujet inconnu (jeton non résolu).' });
    const reveal = req.query.reveal === '1' && canReveal(req);
    if (reveal) auditEvent(req, 'MSISDN_REVEAL', token, { context: 'trace' });
    else auditEvent(req, 'TRACE', token, {});
    res.json({ chain: cases.traceChain(msisdn, { reveal }) });
  });

  // ==========================================================================
  // Module 1/2 — Connecteurs / Collecte & qualité d'ingestion
  // ==========================================================================
  app.get('/api/v1/connectors', requireModule('connecteurs'), (req, res) => {
    const list = ref.OPERATORS.filter((o) => !(req.auth.role === users.ROLES.OPERATEUR && req.auth.operatorId && o.id !== req.auth.operatorId));
    res.json({
      ingestion: normalize.getStats(),
      connectors: list.map((o) => ({
        operatorId: o.id, name: o.name, engine: (ref.engineById.get(o.engine) || {}).name,
        endpoint: 'POST /api/v1/iso8583', auth: 'HMAC-SHA256', formats: ['ISO 8583', 'JSON', 'CSV'],
        signature: 'ECDSA P-256 (registre)',
      })),
    });
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
  // Par défaut : fenêtre récente (rapide). ?full=1 → parcours intégral depuis la
  // genèse (peut prendre plusieurs dizaines de secondes sur un gros registre).
  app.get('/api/v1/ledger/verify', requireModule('registre'), (req, res) => res.json(ledger.verifyChain(req.query.full === '1' ? {} : { limit: 5000 })));
  app.get('/api/v1/pubkey', (_req, res) => res.json({ algorithm: ledger.stats().algorithm, publicKeyPem: ledger.getPublicKeyPem(), auditPublicKeyPem: audit.getPublicKeyPem() }));

  // ==========================================================================
  // Module 11 — Reporting réglementaire & exports signés
  // ==========================================================================
  app.get('/api/v1/reports/templates', requireModule('reporting'), (_req, res) => res.json({ templates: reporting.TEMPLATES }));
  app.get('/api/v1/reports/generate', requireModule('reporting'), (req, res) => {
    try {
      const o = scopeOpts(req);
      res.json(reporting.generate(String(req.query.template || 'observatoire'), o));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/v1/reports/export', requireModule('reporting'), (req, res) => {
    try {
      const o = scopeOpts(req);
      const report = reporting.generate(String(req.query.template || 'observatoire'), o);
      const format = String(req.query.format || 'csv').toLowerCase();
      let body; let mime; let ext;
      if (format === 'json') { body = JSON.stringify(report, null, 2); mime = 'application/json'; ext = 'json'; }
      else { body = reporting.toCsv(report); mime = 'text/csv'; ext = 'csv'; }
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      auditEvent(req, 'EXPORT', report.template, { format, records: report.recordCount });
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="sumo-${report.template}-${Date.now()}.${ext}"`);
      res.setHeader('X-Content-SHA256', sha256);
      res.setHeader('X-Signature-ECDSA-P256', ledger.signHashHex(sha256));
      res.send(body);
    } catch (e) { res.status(400).json({ error: e.message }); }
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
      integrityCache = { at: Date.now(), ledger: ledger.verifyChain({ limit: 1000 }), audit: audit.verify() };
    }
    return integrityCache;
  }
  app.get('/api/v1/security', requireModule('securite'), async (_req, res) => {
    const persistence = await db.status();
    const integrity = integritySnapshot();
    res.json({
      transport: { tls: secure, scheme: tlsEnabled ? 'https/wss (TLS direct)' : (behindTlsProxy ? 'https/wss (TLS terminé au reverse proxy)' : 'http/ws (dev)') },
      ledger: { ...ledger.stats(), integrity: integrity.ledger },
      audit: { ...audit.stats(), integrity: integrity.audit },
      persistence, // entrepôt PostgreSQL (si DATABASE_URL défini)
      rbac: { roles: Object.keys(users.ROLES).length, modules: modules.LEAF_MODULE_IDS.length, dispatch: 'modules affectés par direction / compte (admin système)' },
      dataMinimization: { msisdnMaskedByDefault: true, revealRoles: ['PRESIDENT', 'SE', 'directions DCTLF & DJ'], revealAudited: true },
      notImplemented: ['mTLS mutuel (PKI émise par une autorité de confiance)', 'Horodatage qualifié RFC 3161', 'Certification ISO 27001', persistence.enabled ? 'Réplication HA / multi-instances PostgreSQL' : 'Persistance distribuée / HA (activer DATABASE_URL → PostgreSQL)'],
    });
  });
  app.get('/api/v1/db/status', requireModule('securite'), async (_req, res) => res.json(await db.status()));
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
  function authenticate(req, res, next) {
    const key = req.get('x-sumo-key') || req.get('x-hubfip-key');
    const sig = req.get('x-sumo-signature') || req.get('x-hubfip-signature');
    if (!api.secret || key !== api.key || !sig || !req.rawBody) return res.status(401).json({ status: 'REJECTED', error: 'Authentification requise (clé + signature HMAC).' });
    const expected = crypto.createHmac('sha256', api.secret).update(req.rawBody).digest('hex');
    const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return res.status(401).json({ status: 'REJECTED', error: 'Signature HMAC invalide.' });
    next();
  }

  app.post('/api/v1/iso8583', authenticate, (req, res) => {
    try {
      const p = req.body || {};
      let tdr;
      if (typeof p.message === 'string') {
        tdr = model.fromIso8583(p.message, { operatorId: p.operatorId, channel: p.channel, senderMsisdn: p.senderMsisdn, cityName: p.cityName, feeGrid: config.getFees() });
        normalize.noteIso('connecteur:iso8583', true);
      } else {
        const norm = p.format === 'csv'
          ? normalize.fromCsv(p.line, p.columns, { operatorId: p.operatorId, source: 'connecteur:csv' })
          : normalize.normalizeObject(p.record || p, { operatorId: p.operatorId || (p.record || p).operatorId, source: 'connecteur:json' });
        if (!norm.ok) return res.status(400).json({ status: 'REJECTED', error: norm.error, quality: norm.quality });
        tdr = model.buildTDR({ ...norm.input, feeGrid: config.getFees() });
        tdr._quality = norm.quality;
      }
      pipeline.ingest(tdr); // TDR neuf : enrichissement + effets de bord (réclamations M14)
      const rec = ledger.append(tdr);
      warehouse.ingest(tdr);
      db.persist(tdr, rec); // entrepôt PostgreSQL optionnel
      broadcast({ type: 'TX', data: model.toPublic(tdr, { reveal: false }), ledger: { seq: rec.seq, hash: rec.hash } });
      res.status(202).json({ status: 'ACCEPTED', id: tdr.id, seq: rec.seq, hash: rec.hash, type: tdr.type, alerts: (tdr.alerts || []).length, risk: tdr.risk ? tdr.risk.score : 0, quality: tdr._quality, iso8583: tdr.iso8583.message });
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
    app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules', 'leaflet', 'dist')));
    app.use('/vendor/chartjs', express.static(path.join(root, 'node_modules', 'chart.js', 'dist')));
  }

  app.use((err, _req, res, _next) => {
    logger.error('unhandled.request', { error: err.message });
    res.status(500).json({ status: 'ERROR', error: 'Erreur interne.' });
  });

  return app;
}

module.exports = { createApp, originAllowed };
