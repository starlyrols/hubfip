'use strict';

// Authentification & sessions — SANS dépendance externe (cohérent avec l'approche
// lean du projet). Mots de passe hachés avec scrypt (sel aléatoire, comparaison à
// temps constant). Sessions stockées côté serveur (Map en mémoire) avec identifiant
// aléatoire de 256 bits ; le cookie ne transporte que l'identifiant opaque.
//
// NOTE DÉMONSTRATION : le stockage en mémoire convient à un prototype mono-instance.
// En production il faudrait un magasin partagé (Redis) et une rotation des secrets.

const crypto = require('crypto');

const SESSION_COOKIE = 'sumo_sess';
const TTL_MS = Number(process.env.SUMO_SESSION_TTL_MS) || 8 * 3600 * 1000; // 8 h

// id -> { username, role, operatorId, scopeType, displayName, title, createdAt, expiresAt }
const sessions = new Map();

// ---------------------------------------------------------------------------
// Mots de passe (scrypt)
// ---------------------------------------------------------------------------
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(password), s, 32).toString('hex');
  return `scrypt$${s}$${dk}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const dk = crypto.scryptSync(String(password), salt, 32).toString('hex');
  const a = Buffer.from(dk, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
}

function createSession(user) {
  sweep();
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, {
    username: user.username,
    role: user.role,
    operatorId: user.operatorId || null,
    scopeType: user.scopeType || null,
    displayName: user.displayName,
    title: user.title || '',
    createdAt: now,
    expiresAt: now + TTL_MS,
  });
  return id;
}

function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) { sessions.delete(id); return null; }
  return s;
}

function destroySession(id) { if (id) sessions.delete(id); }

// ---------------------------------------------------------------------------
// Cookies (parse / serialize minimalistes, sans dépendance)
// ---------------------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  let str = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge != null) str += `; Max-Age=${Math.floor(opts.maxAge)}`;
  str += `; Path=${opts.path || '/'}`;
  if (opts.httpOnly !== false) str += '; HttpOnly';
  str += `; SameSite=${opts.sameSite || 'Strict'}`;
  if (opts.secure) str += '; Secure';
  return str;
}

module.exports = {
  SESSION_COOKIE,
  TTL_MS,
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  parseCookies,
  serializeCookie,
  _sessions: sessions,
};
