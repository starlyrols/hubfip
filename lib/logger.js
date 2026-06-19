'use strict';

// Logger structuré minimal (JSON lines). Évite une dépendance externe tout en
// produisant des logs exploitables par une stack d'observabilité.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < MIN) return;
  const rec = { ts: new Date().toISOString(), level, msg, ...fields };
  const line = JSON.stringify(rec);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  debug: (msg, f) => emit('debug', msg, f),
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),
};
