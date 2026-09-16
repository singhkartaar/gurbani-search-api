'use strict';
/**
 * Optional multi-process mode, off by default.
 *
 *   CLUSTER_WORKERS unset or 1   one process, exactly as before
 *   CLUSTER_WORKERS=N            N workers behind the OS accept queue
 *   CLUSTER_WORKERS=auto         one per CPU
 *
 * WHAT THIS BUYS. A free-text query is an ONNX forward pass; measured under a
 * 32-query flood, a first-letter lookup that normally takes 1ms was occasionally
 * stalled to 632ms behind it. More workers means a cheap request can be picked
 * up by a process that is not busy.
 *
 * WHAT IT COSTS, AND IT IS NOT SMALL. Every worker loads its own copy of the
 * vectors and its own ONNX session, so memory multiplies almost exactly by N: a
 * one-index deployment is ~114MB with one worker and ~340MB with three. Nothing
 * is shared. Check the memory your host gives you BEFORE raising this; the
 * default of one worker is what fits a 256MB tier.
 *
 * The rate limiter is per-process and in-memory, so N workers means a client
 * gets up to N times the configured limit. Divide RATE_LIMIT_PER_MINUTE by the
 * worker count, or do the limiting in a proxy that sees every request.
 *
 * Nothing else is affected: the service holds no other state, every worker reads
 * the same read-only files, and results are identical because the vectors are
 * frozen.
 */
const cluster = require('node:cluster');
const os = require('node:os');

function desiredWorkers(env = process.env) {
  const raw = String(env.CLUSTER_WORKERS || '').trim().toLowerCase();
  if (!raw) return 1;
  if (raw === 'auto') return Math.max(1, os.availableParallelism ? os.availableParallelism() : os.cpus().length);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * Returns true if this process became the supervisor and should NOT go on to
 * load the index and listen. Returns false in a worker, and in single-process
 * mode, where the caller carries on exactly as it did before this file existed.
 */
function startCluster(env = process.env, log = console) {
  const n = desiredWorkers(env);
  if (n <= 1 || !cluster.isPrimary) return false;

  log.log(`cluster: starting ${n} workers`);
  log.log(`cluster: memory is roughly ${n}x a single process -- each worker loads `
    + 'its own vectors and ONNX session, and nothing is shared');
  if (env.RATE_LIMIT_PER_MINUTE) {
    log.warn(`cluster: RATE_LIMIT_PER_MINUTE is per process, so a client gets up to `
      + `${n}x ${env.RATE_LIMIT_PER_MINUTE}/min across ${n} workers`);
  }
  // The Ask burst guard is per process too; only the daily counters, which are
  // on disk, are shared -- and those take one writer at a time.
  log.warn(`cluster: ASK_PER_MINUTE (${env.ASK_PER_MINUTE || 10}) is per process as well; `
    + `the daily counters on disk are shared and serialised across the ${n} workers`);

  for (let i = 0; i < n; i++) cluster.fork();

  // A worker that dies is replaced, unless we are shutting down -- otherwise a
  // single crash quietly reduces capacity until there is none.
  //
  // With a crash-loop guard, because "replace it" plus "it fails at startup"
  // is an infinite fork loop that pins a CPU and floods the log. If workers
  // keep dying within seconds of starting, the fault is configuration, not
  // luck, and the right thing is to stop and say so.
  let stopping = false;
  const started = new Map();
  let rapidFailures = 0;
  const track = w => started.set(w.id, Date.now());
  for (const w of Object.values(cluster.workers || {})) track(w);
  cluster.on('fork', track);
  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return;
    const lived = Date.now() - (started.get(worker.id) || 0);
    started.delete(worker.id);
    if (lived < 5000) {
      if (++rapidFailures >= 5) {
        log.error('cluster: workers keep failing within seconds of starting. '
          + 'That is a configuration problem, not a crash to retry -- giving up.');
        stopping = true;
        process.exit(1);
      }
    } else {
      rapidFailures = 0;
    }
    log.warn(`cluster: worker ${worker.process.pid} exited (${signal || code}); starting a replacement`);
    cluster.fork();
  });

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log.log('cluster: shutting down');
    for (const w of Object.values(cluster.workers || {})) w.kill();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return true;
}

module.exports = { startCluster, desiredWorkers };
