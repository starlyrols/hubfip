'use strict';

// =============================================================================
// Comptes & RBAC — alimentés par l'ORGANIGRAMME OFFICIEL ARCEP (nomenclature,
// Délibération N°0002/ARCEP/CR/2024) : 27 comptes internes (gouvernance,
// exécutif, 11 directions), 1 compte ADMIN_SYSTEME (dispatch des modules) et
// les comptes opérateurs Mobile Money (vue cloisonnée sur leurs propres flux).
//
// La VISIBILITÉ des modules n'est plus figée par rôle : elle découle des
// AFFECTATIONS (assignments.js) dispatchées par l'admin système, par direction
// et/ou par compte. Capacités nominatives — mapping explicite :
//   - Révélation MSISDN (accès nominatif, loi 001/2011, journalisée) et
//     écriture des dossiers d'enquête : directions DCTLF (fraude) & DJ
//     (juridique) + rôles PRESIDENT/SE. Choix par direction/rôle explicites,
//     PAS par « niveau hiérarchique ≥ 4 » : dans arcep-digital le
//     SECRETARIAT_CABINET est niveau 4 hiérarchique mais niveau de LECTURE 2.
//   - Config métier : quiconque a le module « admin » dispatché.
//   - Dispatch des modules : rôle ADMIN_SYSTEME uniquement (dérivé du rôle,
//     jamais affectable — l'admin ne peut pas se verrouiller dehors).
// =============================================================================

const ref = require('./referentiel');
const { hashPassword } = require('./auth');
const nomenclature = require('./nomenclature');
const assignments = require('./assignments');

const ROLES = Object.freeze({
  PRESIDENT: 'PRESIDENT',                     // Président du Conseil de Régulation
  CONSEILLER: 'CONSEILLER',                   // Membre du Conseil de Régulation
  CABINET: 'CABINET',                         // Cabinet du Président
  SECRETARIAT_CABINET: 'SECRETARIAT_CABINET', // Secrétariat du Cabinet (guichet unique)
  SE: 'SE',                                   // Secrétaire Exécutif
  SE_ADJOINT: 'SE_ADJOINT',                   // Secrétaire Exécutif Adjoint
  DIRECTEUR: 'DIRECTEUR',                     // Directeur (une direction)
  AGENT: 'AGENT',                             // Agent / instructeur
  ADMIN_SYSTEME: 'ADMIN_SYSTEME',             // Dispatch des modules (hors métier)
  OPERATEUR: 'OPERATEUR',                     // Opérateur Mobile Money (scopé)
});

const ROLE_LABELS = Object.freeze({
  PRESIDENT: 'Président du CR', CONSEILLER: 'Conseiller du CR', CABINET: 'Cabinet du Président',
  SECRETARIAT_CABINET: 'Secrétariat du Cabinet', SE: 'Secrétaire Exécutif', SE_ADJOINT: 'SE Adjoint',
  DIRECTEUR: 'Directeur', AGENT: 'Agent', ADMIN_SYSTEME: 'Admin Système', OPERATEUR: 'Opérateur',
});

// Périmètre nominal : révélation MSISDN + écriture des dossiers d'enquête.
const REVEAL_DIRECTIONS = new Set(['DCTLF', 'DJ']);
const REVEAL_ROLES = new Set([ROLES.PRESIDENT, ROLES.SE]);

const DEMO_PASSWORD = process.env.SUMO_DEMO_PASSWORD || 'Arcep@2026';
const DEMO_HASH = hashPassword(DEMO_PASSWORD);

// Habillage du catalogue de connexion par rôle.
const ROLE_UI = {
  PRESIDENT: { icon: 'fa-landmark', bg: 'bg-emerald-700' },
  CONSEILLER: { icon: 'fa-users-rectangle', bg: 'bg-emerald-600' },
  CABINET: { icon: 'fa-user-tie', bg: 'bg-teal-700' },
  SECRETARIAT_CABINET: { icon: 'fa-inbox', bg: 'bg-teal-600' },
  SE: { icon: 'fa-stamp', bg: 'bg-sky-700' },
  SE_ADJOINT: { icon: 'fa-stamp', bg: 'bg-sky-600' },
  DIRECTEUR: { icon: 'fa-briefcase', bg: 'bg-indigo-700' },
  AGENT: { icon: 'fa-user-pen', bg: 'bg-slate-600' },
  ADMIN_SYSTEME: { icon: 'fa-sitemap', bg: 'bg-purple-700' },
};

// Groupes du catalogue : gouvernance et exécutif regroupés, une entrée par
// direction, l'ordre d'insertion (nomenclature) fait foi côté client.
function categoryOf(direction) {
  const d = nomenclature.directionByCode.get(direction) || {};
  if (d.type === 'GOUVERNANCE') return 'Gouvernance (Conseil & Cabinet)';
  if (d.type === 'EXECUTIF') return 'Secrétariat Exécutif';
  return `${direction} — ${d.nom || direction}`;
}

function build() {
  const list = [];
  const seen = new Set();
  for (const u of nomenclature.USERS) {
    if (seen.has(u.username) || u.username === 'admin-systeme') throw new Error(`Nomenclature : username en double ou réservé « ${u.username} »`);
    seen.add(u.username);
    const ui = ROLE_UI[u.role] || ROLE_UI.AGENT;
    list.push({
      username: u.username, displayName: u.nom, role: u.role, direction: u.direction,
      title: `${ROLE_LABELS[u.role] || u.role} · ${u.direction}`,
      category: categoryOf(u.direction), icon: ui.icon, bg: ui.bg,
      operatorId: null, scopeType: null,
    });
  }
  list.push({
    username: 'admin-systeme', displayName: 'Administrateur Système', role: ROLES.ADMIN_SYSTEME,
    direction: null, // hors organigramme métier : séparation des tâches, aucun héritage de modules
    title: 'Dispatch des modules aux directions et aux comptes',
    category: 'Administration système', icon: ROLE_UI.ADMIN_SYSTEME.icon, bg: ROLE_UI.ADMIN_SYSTEME.bg,
    operatorId: null, scopeType: null,
  });
  for (const op of ref.OPERATORS) {
    if (seen.has(op.id)) throw new Error(`Collision d'username entre la nomenclature et l'opérateur « ${op.id} »`);
    list.push({
      username: op.id, displayName: op.name, role: ROLES.OPERATEUR, direction: null,
      title: `Espace opérateur — moteur ${(ref.engineById.get(op.engine) || {}).name || op.engine}`,
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

// --- Capacités (calculées sur l'objet user/session, plus sur le seul rôle) ---
const canReveal = (user) => !!user && (REVEAL_DIRECTIONS.has(user.direction) || REVEAL_ROLES.has(user.role));
const canWriteCases = (user) => canReveal(user);
const isSystemAdmin = (user) => !!user && user.role === ROLES.ADMIN_SYSTEME;

// Modules effectifs : affectations (direction ∪ individuel) ; le module
// « dispatch » est dérivé du rôle ADMIN_SYSTEME, jamais des affectations.
function effectiveModules(user) {
  if (!user) return [];
  const assigned = assignments.modulesForUser(user);
  return isSystemAdmin(user) ? ['dispatch', ...assigned] : assigned;
}
const hasModule = (user, moduleId) => effectiveModules(user).includes(moduleId);
const canAdmin = (user) => hasModule(user, 'admin');

function permissions(user) {
  const mods = effectiveModules(user);
  return {
    modules: mods,
    canReveal: canReveal(user),
    canWriteCases: canWriteCases(user),
    canAdmin: mods.includes('admin'),
    operatorId: user.operatorId || null,
    direction: user.direction || null,
  };
}

function catalog() {
  return USERS.map((u) => ({
    username: u.username, displayName: u.displayName, role: u.role, title: u.title,
    category: u.category, icon: u.icon, bg: u.bg || null, color: u.color || null,
    operatorId: u.operatorId, scopeType: u.scopeType, direction: u.direction,
  }));
}

const count = () => USERS.length;

module.exports = {
  ROLES, ROLE_LABELS, DEMO_PASSWORD, USERS, byUsername,
  getByUsername, authenticate, catalog, count,
  effectiveModules, hasModule, canReveal, canWriteCases, canAdmin, isSystemAdmin, permissions,
};
