'use strict';

// =============================================================================
// Fil d'exécution dédié au parcours du registre (correctif D1).
//
// Le registre est un fichier JSONL qui peut peser plusieurs Go. Le parcourir dans
// le fil principal gelait TOUT le serveur — API, WebSocket, ingestion, heartbeat —
// pendant toute la lecture : une seule requête suffisait à provoquer un déni de
// service. Le parcours vit désormais ici.
//
// Ce fil ne détient AUCUNE clé : il filtre sur les champs restés en clair dans la
// forme scellée (rang, horodatage, opérateur, empreinte HMAC du sujet) et renvoie
// les LIGNES BRUTES retenues. Le déchiffrement n'a lieu que dans le fil principal,
// et seulement sur les enregistrements effectivement sélectionnés.
//
// Un index de blocs (checkpoints) est entretenu opportunément : chaque parcours
// intégral le régénère, et les parcours suivants sautent les blocs dont la plage
// d'horodatage ne croise pas la période demandée.
// =============================================================================

const fs = require('fs');
const { parentPort } = require('worker_threads');

const READ_CHUNK = 4 * 1024 * 1024;
const BLOCK = 2000; // enregistrements par bloc d'index

// Parcourt le fichier en flux à partir d'un offset, en fournissant à la fois la
// ligne et sa position — indispensable pour construire l'index de blocs.
function forEachLineFrom(file, startOffset, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(READ_CHUNK);
    let rest = Buffer.alloc(0);
    let pos = Math.min(startOffset || 0, size);
    let lineStart = pos;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, READ_CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        if (nl === -1) break;
        if (nl > start) {
          if (onLine(chunk.toString('utf8', start, nl), lineStart) === false) return;
        }
        lineStart += (nl - start) + 1;
        start = nl + 1;
      }
      rest = Buffer.from(chunk.subarray(start));
    }
    if (rest.length) onLine(rest.toString('utf8'), lineStart);
  } finally { fs.closeSync(fd); }
}

const ckptPath = (file) => file.replace(/\.jsonl$/, '') + '.ckpt';

function loadCheckpoints(file) {
  const p = ckptPath(file);
  if (!fs.existsSync(p)) return null;
  try {
    const blocks = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (!blocks.length) return null;
    // Index périmé si le fichier a rétréci sous le dernier bloc indexé.
    if (fs.statSync(file).size < blocks[blocks.length - 1].endOffset) return null;
    return blocks;
  } catch { return null; }
}

function saveCheckpoints(file, blocks) {
  try { fs.writeFileSync(ckptPath(file), blocks.map((b) => JSON.stringify(b)).join('\n') + '\n'); } catch { /* index advisoire */ }
}

// Filtres applicables SANS clé de déchiffrement.
function matches(payload, job) {
  if (job.kind === 'period') {
    if (payload.epoch < job.from || payload.epoch > job.to) return false;
    if (job.operatorId && payload.operator.id !== job.operatorId && payload.receiverOperator.id !== job.operatorId) return false;
    return true;
  }
  // kind === 'subject'
  if (job.from != null && (payload.epoch < job.from || payload.epoch > job.to)) return false;
  if (payload.sealed) return payload.sender.idx === job.subjectKey || payload.receiver.idx === job.subjectKey;
  // Enregistrements hérités, écrits avant le scellement du registre.
  return payload.sender.msisdn === job.subjectPlain || payload.receiver.msisdn === job.subjectPlain;
}

function run(job) {
  const t0 = Date.now();
  if (!fs.existsSync(job.file)) return { lines: [], scanned: 0, matched: 0, truncated: false, durationMs: 0, usedIndex: false };

  const blocks = loadCheckpoints(job.file);
  // Un bloc est ignorable si sa plage d'horodatage ne croise pas la période demandée.
  const wanted = (b) => !(job.from != null && (b.maxEpoch < job.from || b.minEpoch > job.to));
  const useIndex = !!blocks && job.from != null;

  const out = [];
  let scanned = 0; let truncated = false;
  const rebuilt = []; let cur = null;

  const consume = (line, offset) => {
    let rec; try { rec = JSON.parse(line); } catch { return; }
    scanned++;
    // Reconstruction opportuniste de l'index pendant le parcours intégral.
    if (!useIndex) {
      if (!cur || rec.seq >= cur.fromSeq + BLOCK) {
        if (cur) rebuilt.push(cur);
        cur = { fromSeq: rec.seq, toSeq: rec.seq, offset, endOffset: offset + Buffer.byteLength(line, 'utf8') + 1, minEpoch: rec.payload.epoch, maxEpoch: rec.payload.epoch };
      } else {
        cur.toSeq = rec.seq;
        cur.endOffset = offset + Buffer.byteLength(line, 'utf8') + 1;
        if (rec.payload.epoch < cur.minEpoch) cur.minEpoch = rec.payload.epoch;
        if (rec.payload.epoch > cur.maxEpoch) cur.maxEpoch = rec.payload.epoch;
      }
    }
    if (!matches(rec.payload, job)) return;
    if (out.length >= job.limit) { truncated = true; return false; }
    out.push(line);
    return undefined;
  };

  if (useIndex) {
    for (const b of blocks) {
      if (!wanted(b)) continue;
      let stop = false;
      forEachLineFrom(job.file, b.offset, (line, off) => {
        if (off >= b.endOffset) return false;
        const r = consume(line, off);
        if (r === false) { stop = true; return false; }
        return undefined;
      });
      if (stop) break;
    }
    // La queue écrite depuis la dernière régénération n'est pas indexée.
    const last = blocks[blocks.length - 1];
    forEachLineFrom(job.file, last.endOffset, (line, off) => consume(line, off));
  } else {
    forEachLineFrom(job.file, 0, (line, off) => consume(line, off));
    if (cur) rebuilt.push(cur);
    if (rebuilt.length) saveCheckpoints(job.file, rebuilt);
  }

  return { lines: out, scanned, matched: out.length, truncated, durationMs: Date.now() - t0, usedIndex: useIndex };
}

parentPort.on('message', (job) => {
  try { parentPort.postMessage({ id: job.id, ok: true, result: run(job) }); } catch (e) {
    parentPort.postMessage({ id: job.id, ok: false, error: e.message });
  }
});
