'use strict';

// Référentiel des INTERVENANTS (comptes utilisateurs) de la plateforme, dérivé du
// référentiel métier (lib/referentiel.js). Quatre rôles fonctionnels :
//
//   REGULATEUR : supervision nationale (BEAC / ARCEP) — vue globale de tous les flux.
//   ADMIN      : administration technique — système, intégrité du registre, PKI.
//   AUDITEUR   : audit & conformité — vérification du registre signé + exports (lecture seule).
//   OPERATEUR  : une institution (banque / MoMo / EMF / passerelle) — vue RESTREINTE
//                à ses propres transactions (filtrage appliqué côté serveur).
//
// NOTE DÉMONSTRATION : tous les comptes partagent un mot de passe de démonstration et
// l'accès « un clic » est réservé au mode démo (cf. createApp/server : demoLogin).

const ref = require('./referentiel');
const { hashPassword } = require('./auth');

const ROLES = Object.freeze({
  REGULATEUR: 'REGULATEUR',
  OPERATEUR: 'OPERATEUR',
  ADMIN: 'ADMIN',
  AUDITEUR: 'AUDITEUR',
});

const DEMO_PASSWORD = process.env.HUBFIP_DEMO_PASSWORD || 'demo123';
// Même mot de passe pour tous les comptes de démo : un seul hachage scrypt (perf au démarrage).
const DEMO_HASH = hashPassword(DEMO_PASSWORD);

const CAT_SUPERVISION = 'Régulation & supervision';

function iconForType(type) {
  switch (type) {
    case ref.TYPES.BANK: return 'fa-building-columns';
    case ref.TYPES.MOMO: return 'fa-mobile-screen-button';
    case ref.TYPES.EMF: return 'fa-hand-holding-dollar';
    case ref.TYPES.GATEWAY: return 'fa-network-wired';
    default: return 'fa-user';
  }
}

function build() {
  const list = [
    {
      username: 'regulateur',
      displayName: 'Superviseur national',
      role: ROLES.REGULATEUR,
      title: 'Régulateur — supervision des flux (BEAC / ARCEP)',
      operatorId: null,
      scopeType: null,
      category: CAT_SUPERVISION,
      icon: 'fa-landmark',
      bg: 'bg-emerald-700',
    },
    {
      username: 'admin',
      displayName: 'Administrateur technique',
      role: ROLES.ADMIN,
      title: 'Administration système, intégrité & PKI',
      operatorId: null,
      scopeType: null,
      category: CAT_SUPERVISION,
      icon: 'fa-gears',
      bg: 'bg-purple-700',
    },
    {
      username: 'auditeur',
      displayName: 'Auditeur / Conformité',
      role: ROLES.AUDITEUR,
      title: 'Audit, vérification du registre & exports (lecture seule)',
      operatorId: null,
      scopeType: null,
      category: CAT_SUPERVISION,
      icon: 'fa-magnifying-glass-chart',
      bg: 'bg-amber-600',
    },
  ];

  for (const op of ref.OPERATORS) {
    list.push({
      username: op.id,
      displayName: op.name,
      role: ROLES.OPERATEUR,
      title: `Espace opérateur — ${op.type}`,
      operatorId: op.id,
      scopeType: op.type,
      category: op.type,
      icon: iconForType(op.type),
      bg: op.bg,
      color: op.color,
    });
  }

  // Attache le hachage du mot de passe à chaque compte.
  return list.map((u) => ({ ...u, passwordHash: DEMO_HASH }));
}

const USERS = build();
const byUsername = new Map(USERS.map((u) => [u.username, u]));

function getByUsername(username) {
  return byUsername.get(String(username || '').toLowerCase()) || null;
}

function authenticate(username, password) {
  const u = getByUsername(username);
  if (!u) return null;
  const { verifyPassword } = require('./auth');
  if (!verifyPassword(password, u.passwordHash)) return null;
  return u;
}

// Catalogue PUBLIC pour la page de connexion (sans hachage de mot de passe).
function catalog() {
  return USERS.map((u) => ({
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    title: u.title,
    category: u.category,
    icon: u.icon,
    bg: u.bg || null,
    color: u.color || null,
    operatorId: u.operatorId,
    scopeType: u.scopeType,
  }));
}

function count() { return USERS.length; }

module.exports = {
  ROLES,
  DEMO_PASSWORD,
  USERS,
  byUsername,
  getByUsername,
  authenticate,
  catalog,
  count,
};
