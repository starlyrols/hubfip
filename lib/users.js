'use strict';

// =============================================================================
// Intervenants & RBAC PAR CORPS DE MÉTIER (cahier §1 gouvernance, §8 équipe, §2 #12).
// Accès cloisonné par métier du régulateur + comptes opérateurs (vue restreinte à
// leurs propres flux) + auditeur (lecture seule) + administrateur (SI).
// La révélation des MSISDN (accès nominatif) est réservée aux corps habilités et
// systématiquement journalisée (loi 001/2011 — minimisation/traçabilité).
// =============================================================================

const ref = require('./referentiel');
const { hashPassword } = require('./auth');

const ROLES = Object.freeze({
  REGULATEUR: 'REGULATEUR',     // Direction / supervision nationale — tout
  OBSERVATOIRE: 'OBSERVATOIRE', // Observatoire / statistiques de marché
  REVENUS: 'REVENUS',           // Régulation économique / revenus & redevances
  QOS: 'QOS',                   // Technique / qualité de service
  ANTIFRAUDE: 'ANTIFRAUDE',     // Antifraude / AML / investigation
  JURIDIQUE: 'JURIDIQUE',       // Juridique / conformité
  CONSO: 'CONSO',               // Protection des consommateurs
  ADMIN: 'ADMIN',               // Système d'information (SI)
  AUDITEUR: 'AUDITEUR',         // Audit (lecture seule)
  OPERATEUR: 'OPERATEUR',       // Opérateur Mobile Money (scopé)
});

// Modules (= onglets) accessibles par rôle. 'admin' = configuration ; 'securite' = audit/PKI.
const ALL_MODULES = ['observatoire', 'operators', 'revenus', 'qos', 'antifraude', 'investigation', 'geo', 'analytics', 'connecteurs', 'registre', 'reporting', 'securite', 'admin'];

const ROLE_MODULES = {
  REGULATEUR: ALL_MODULES.slice(),
  OBSERVATOIRE: ['observatoire', 'operators', 'geo', 'registre', 'reporting'],
  REVENUS: ['observatoire', 'revenus', 'registre', 'reporting'],
  QOS: ['observatoire', 'qos', 'connecteurs', 'geo', 'registre', 'reporting'],
  ANTIFRAUDE: ['observatoire', 'antifraude', 'investigation', 'geo', 'analytics', 'registre', 'reporting'],
  JURIDIQUE: ['observatoire', 'antifraude', 'investigation', 'securite', 'registre', 'reporting'],
  CONSO: ['observatoire', 'qos', 'registre', 'reporting'],
  ADMIN: ['observatoire', 'connecteurs', 'geo', 'admin', 'securite', 'registre'],
  AUDITEUR: ['observatoire', 'registre', 'reporting', 'securite'],
  OPERATEUR: ['observatoire', 'qos', 'revenus', 'connecteurs', 'registre', 'reporting'],
};

const REVEAL_ROLES = new Set([ROLES.ANTIFRAUDE, ROLES.JURIDIQUE, ROLES.REGULATEUR]);
const CASE_WRITE_ROLES = new Set([ROLES.ANTIFRAUDE, ROLES.JURIDIQUE, ROLES.REGULATEUR]);
const ADMIN_ROLES = new Set([ROLES.ADMIN, ROLES.REGULATEUR]);

const DEMO_PASSWORD = process.env.SUMO_DEMO_PASSWORD || 'demo123';
const DEMO_HASH = hashPassword(DEMO_PASSWORD);
const CAT_SUPERVISION = 'Régulateur (corps de métier)';

const SUPERVISION = [
  { username: 'regulateur', displayName: 'Direction / Supervision', role: ROLES.REGULATEUR, title: 'Supervision nationale — accès à tous les modules', icon: 'fa-landmark', bg: 'bg-emerald-700' },
  { username: 'observatoire', displayName: 'Observatoire du marché', role: ROLES.OBSERVATOIRE, title: 'Statistiques de marché & parts de marché', icon: 'fa-chart-pie', bg: 'bg-emerald-600' },
  { username: 'revenus', displayName: 'Régulation économique', role: ROLES.REVENUS, title: 'Revenus, redevances & écarts de frais', icon: 'fa-coins', bg: 'bg-amber-600' },
  { username: 'qos', displayName: 'Technique / QoS', role: ROLES.QOS, title: 'Qualité de service & disponibilité', icon: 'fa-gauge-high', bg: 'bg-sky-600' },
  { username: 'antifraude', displayName: 'Antifraude / AML', role: ROLES.ANTIFRAUDE, title: 'Détection, investigation, accès nominatif encadré', icon: 'fa-user-shield', bg: 'bg-red-700' },
  { username: 'juridique', displayName: 'Juridique / Conformité', role: ROLES.JURIDIQUE, title: 'Conformité, dossiers & audit', icon: 'fa-scale-balanced', bg: 'bg-indigo-700' },
  { username: 'conso', displayName: 'Protection consommateurs', role: ROLES.CONSO, title: 'Qualité de service vue consommateur', icon: 'fa-users', bg: 'bg-teal-700' },
  { username: 'admin', displayName: 'Administrateur SI', role: ROLES.ADMIN, title: 'Configuration, connecteurs, sécurité & PKI', icon: 'fa-gears', bg: 'bg-purple-700' },
  { username: 'auditeur', displayName: 'Audit / Contrôle', role: ROLES.AUDITEUR, title: 'Vérification & exports (lecture seule)', icon: 'fa-magnifying-glass-chart', bg: 'bg-slate-600' },
];

function build() {
  const list = SUPERVISION.map((u) => ({ ...u, operatorId: null, scopeType: null, category: CAT_SUPERVISION }));
  for (const op of ref.OPERATORS) {
    list.push({
      username: op.id, displayName: op.name, role: ROLES.OPERATEUR,
      title: `Espace opérateur — moteur ${ (ref.engineById.get(op.engine) || {}).name || op.engine }`,
      operatorId: op.id, scopeType: 'Opérateur', category: 'Opérateurs Mobile Money',
      icon: 'fa-mobile-screen-button', bg: op.bg, color: op.color,
    });
  }
  return list.map((u) => ({ ...u, passwordHash: DEMO_HASH }));
}

const USERS = build();
const byUsername = new Map(USERS.map((u) => [u.username, u]));

function getByUsername(username) { return byUsername.get(String(username || '').toLowerCase()) || null; }

function authenticate(username, password) {
  const u = getByUsername(username);
  if (!u) return null;
  const { verifyPassword } = require('./auth');
  if (!verifyPassword(password, u.passwordHash)) return null;
  return u;
}

const modulesFor = (role) => ROLE_MODULES[role] || ['observatoire'];
const canReveal = (role) => REVEAL_ROLES.has(role);
const canWriteCases = (role) => CASE_WRITE_ROLES.has(role);
const canAdmin = (role) => ADMIN_ROLES.has(role);

function permissions(user) {
  return {
    modules: modulesFor(user.role),
    canReveal: canReveal(user.role),
    canWriteCases: canWriteCases(user.role),
    canAdmin: canAdmin(user.role),
    operatorId: user.operatorId || null,
  };
}

function catalog() {
  return USERS.map((u) => ({
    username: u.username, displayName: u.displayName, role: u.role, title: u.title,
    category: u.category, icon: u.icon, bg: u.bg || null, color: u.color || null,
    operatorId: u.operatorId, scopeType: u.scopeType,
  }));
}

const count = () => USERS.length;

module.exports = {
  ROLES, ALL_MODULES, ROLE_MODULES, DEMO_PASSWORD, USERS, byUsername,
  getByUsername, authenticate, catalog, count,
  modulesFor, canReveal, canWriteCases, canAdmin, permissions,
};
