'use strict';

// =============================================================================
// Pilote du parcours déporté du registre (correctif D1).
//
// AVANT : `ledger.readAll()` était appelé SYNCHRONEMENT dans le fil de requête par
// `/api/v1/trace`, `/reports/generate` et `/reports/export`. Chaque appel relisait
// et parsait l'intégralité du registre — 287 Mo au plus haut, plusieurs Go à
// l'échelle cible — en bloquant l'event loop : plus d'API, plus de WebSocket, plus
// d'ingestion. Un utilisateur légitime provoquait un déni de service, et le quota
// de 240 requêtes/minute n'y changeait rien.
//
// APRÈS : le parcours vit dans un fil dédié, avec
//   * une FILE bornée : au-delà, la requête est refusée (503) au lieu de s'empiler ;
//   * un DÉLAI MAXIMAL par tâche ;
//   * une PAGINATION obligatoire (nombre de lignes plafonné, troncature signalée) ;
//   * un CACHE court : deux appels identiques ne relisent pas deux fois le fichier.
// Le coût réel de chaque parcours est renvoyé à l'appelant (`scanStats`), plutôt
// que dissimulé.
// =============================================================================

const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('./logger');

const WORKER_FILE = path.join(__dirname, 'scanner-worker.js');
const JOB_TIMEOUT_MS = Number(process.env.SUMO_SCAN_TIMEOUT_MS) || 30_000;
const QUEUE_MAX = Number(process.env.SUMO_SCAN_QUEUE_MAX) || 8;
const CACHE_TTL_MS = Number(process.env.SUMO_SCAN_CACHE_MS) || 15_000;
const CACHE_MAX = 40;
// Le fil est recyclé après une période d'inactivité : un parcours de registre est
// une opération occasionnelle, il n'y a aucune raison d'immobiliser un fil (et de
// retenir le processus) entre deux rapports. Il est recréé à la demande.
const IDLE_MS = Number(process.env.SUMO_SCAN_IDLE_MS) || 10_000;

let worker = null;
let idleTimer = null;
let nextId = 1;
const pending = new Map();   // id -> { resolve, reject, timer }
const queue = [];            // tâches en attente d'un fil libre
let busy = false;

class ScannerBusyError extends Error {
  constructor() { super('Service de lecture du registre saturé : réessayez dans quelques instants.'); this.code = 'SCANNER_BUSY'; }
}

function cancelIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

function scheduleIdleShutdown() {
  cancelIdle();
  if (!worker || busy || queue.length) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (worker && !busy && !queue.length) {
      const w = worker; worker = null;
      w.terminate().catch(() => {});
      logger.debug('scanner.worker.idle.stopped', {});
    }
  }, IDLE_MS);
  idleTimer.unref(); // ne retient jamais le processus
}

function ensureWorker() {
  cancelIdle();
  if (worker) return worker;
  worker = new Worker(WORKER_FILE);
  worker.unref(); // ne retient pas le processus à l'arrêt
  worker.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    busy = false;
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error));
    drain();
    scheduleIdleShutdown();
    // Node re-référence le port de communication à chaque échange : sans ce
    // dé-référencement, un fil au repos empêcherait le processus de se terminer.
    if (worker) worker.unref();
  });
  worker.on('error', (err) => {
    logger.error('scanner.worker.error', { error: err.message });
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
    pending.clear(); busy = false; worker = null;
    drain();
  });
  worker.on('exit', () => { worker = null; busy = false; });
  return worker;
}

function drain() {
  if (busy || !queue.length) return;
  cancelIdle();
  const next = queue.shift();
  dispatch(next.job, next.resolve, next.reject);
}

function dispatch(job, resolve, reject) {
  busy = true;
  const w = ensureWorker();
  const timer = setTimeout(() => {
    pending.delete(job.id);
    busy = false;
    logger.warn('scanner.job.timeout', { kind: job.kind, ms: JOB_TIMEOUT_MS });
    reject(new Error(`Parcours du registre interrompu après ${JOB_TIMEOUT_MS} ms — restreignez la période demandée.`));
    // Le fil est probablement encore occupé : on le remplace pour ne pas rester bloqué.
    try { w.terminate(); } catch { /* ignore */ }
    worker = null;
    drain();
  }, JOB_TIMEOUT_MS);
  pending.set(job.id, { resolve, reject, timer });
  w.postMessage(job);
}

function submit(job) {
  job.id = nextId++;
  return new Promise((resolve, reject) => {
    if (!busy) return dispatch(job, resolve, reject);
    if (queue.length >= QUEUE_MAX) return reject(new ScannerBusyError());
    queue.push({ job, resolve, reject });
  });
}

// --- Cache court (les rapports sur période close sont immuables) ------------
const cache = new Map();
function cacheKey(job) { return [job.kind, job.file, job.from, job.to, job.operatorId, job.subjectKey, job.limit].join('|'); }

async function scan(job) {
  const key = cacheKey(job);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };
  const value = await submit(job);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { ...value, cached: false };
}

// Transforme le résultat brut (lignes JSON) en enregistrements descellés. Le
// déchiffrement n'a lieu qu'ici, sur les seuls enregistrements retenus.
function materialize(result, unseal) {
  const records = [];
  for (const line of result.lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    records.push({ seq: rec.seq, hash: rec.hash, payload: unseal ? unseal(rec.payload) : rec.payload });
  }
  return {
    records,
    scanStats: {
      scannedRecords: result.scanned,
      matchedRecords: result.matched,
      returnedRecords: records.length,
      truncated: result.truncated,
      durationMs: result.durationMs,
      usedIndex: result.usedIndex,
      cached: result.cached,
    },
  };
}

const stats = () => ({ queued: queue.length, busy, workerUp: !!worker, queueMax: QUEUE_MAX, timeoutMs: JOB_TIMEOUT_MS });

function close() {
  cancelIdle();
  queue.length = 0;
  for (const [, p] of pending) clearTimeout(p.timer);
  pending.clear();
  if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
}

module.exports = { scan, materialize, stats, close, ScannerBusyError, JOB_TIMEOUT_MS, QUEUE_MAX };
