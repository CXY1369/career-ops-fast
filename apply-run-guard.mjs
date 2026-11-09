#!/usr/bin/env node

/**
 * apply-run-guard.mjs — a small, browser-agnostic lease and audit guard for
 * live application runs.
 *
 * This tool never opens a browser and never submits a form. It owns only the
 * machine log and a run lease under the current DATA_ROOT. The prose log in
 * data/application-runs.md remains human-maintained.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { releaseOrWarn, tryAcquireDirLockSync } from './lib/dir-lock.mjs';

export const SCHEMA_VERSION = 1;
export const APPLY_RUN_TTL_MS = 45 * 60 * 1000;
export const PAUSED_RUN_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_RECOVERIES = 1;

const CONTROL_LOCK_TTL_MS = 60 * 1000;
const CONTROL_LOCK_NAME = '.apply-run-control.lock';
const RUN_LOCK_NAME = '.apply-run.lock';
const LOG_NAME = 'apply-runs.jsonl';
const CONTROL_LOCK_RETRY_MS = 20;

const HELP = `Usage:
  node apply-run-guard.mjs start --company "Company" --role "Role" --url "https://..." --browser chrome|playwright --resume "output/tailored-resume.pdf" --cover-letter prepared|skip [--simplify]
  node apply-run-guard.mjs pause [--note "reason"]
  node apply-run-guard.mjs resume
  node apply-run-guard.mjs recover --run-id "<run-id>"
  node apply-run-guard.mjs mark simplify_done
  node apply-run-guard.mjs mark user_change --note "reason"
  node apply-run-guard.mjs review_reached
  node apply-run-guard.mjs mark browser_handoff --visible true --method markHandoff
  node apply-run-guard.mjs finish --status handed_off|blocked [--note "reason"]
  node apply-run-guard.mjs confirm-submitted
  node apply-run-guard.mjs abort [--note "reason"]
  node apply-run-guard.mjs audit
  node apply-run-guard.mjs --help

The guard writes data/apply-runs.jsonl and data/.apply-run.lock under the
current DATA_ROOT. It never opens a browser or submits an application.`;

class GuardError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

function paths() {
  const dataRoot = getCareerOpsRoot();
  const dataDir = join(dataRoot, 'data');
  return {
    dataRoot,
    dataDir,
    outputDir: join(dataRoot, 'output'),
    logPath: join(dataDir, LOG_NAME),
    runLock: join(dataDir, RUN_LOCK_NAME),
    controlLock: join(dataDir, CONTROL_LOCK_NAME),
  };
}

function now() {
  return new Date().toISOString();
}

function cleanText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GuardError(`${label} is required and must be non-empty.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new GuardError(`${label} must not contain control characters.`);
  }
  return value.trim();
}

function parseArgs(args, valueFlags = [], { allowSimplify = false } = {}) {
  const values = {};
  const positional = [];
  const allowedValues = new Set(valueFlags);
  const seen = new Set();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (arg === '--simplify') {
      if (!allowSimplify) throw new GuardError(`Unknown argument: ${arg}`);
      if (seen.has(arg)) throw new GuardError(`Duplicate flag: ${arg}`);
      seen.add(arg);
      values.simplify = true;
      continue;
    }
    if (!allowedValues.has(arg)) throw new GuardError(`Unknown argument: ${arg}`);
    if (seen.has(arg)) throw new GuardError(`Duplicate flag: ${arg}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new GuardError(`${arg} requires a value.`);
    }
    seen.add(arg);
    values[arg.slice(2)] = value;
    i += 1;
  }
  return { values, positional };
}

function ensureDataDir(info) {
  mkdirSync(info.dataDir, { recursive: true });
}

function readEvents(info) {
  if (!existsSync(info.logPath)) return [];
  const text = readFileSync(info.logPath, 'utf8');
  const events = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || typeof event.event !== 'string' || typeof event.run_id !== 'string') {
        throw new Error('missing event/run_id');
      }
      events.push(event);
    } catch (error) {
      throw new GuardError(`Invalid apply-runs.jsonl at line ${index + 1}: ${error.message}`);
    }
  }
  return events;
}

function appendEvent(info, event) {
  ensureDataDir(info);
  appendFileSync(info.logPath, `${JSON.stringify({ schema_version: SCHEMA_VERSION, ...event })}\n`, 'utf8');
}

function timestampMs(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedMs(start, end) {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  if (startMs === null || endMs === null) return 0;
  return Math.max(0, endMs - startMs);
}

function intervalOverlapMs(leftStart, leftEnd, rightStart, rightEnd) {
  const leftStartMs = timestampMs(leftStart);
  const leftEndMs = timestampMs(leftEnd);
  const rightStartMs = timestampMs(rightStart);
  const rightEndMs = timestampMs(rightEnd);
  if ([leftStartMs, leftEndMs, rightStartMs, rightEndMs].some((value) => value === null)) return 0;
  return Math.max(0, Math.min(leftEndMs, rightEndMs) - Math.max(leftStartMs, rightStartMs));
}

function sumIntervals(intervals, start, end) {
  return intervals.reduce(
    (sum, interval) => sum + intervalOverlapMs(interval.start, interval.end, start, end),
    0,
  );
}

function sameDirectory(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && (left.ino !== 0 || left.birthtimeMs === right.birthtimeMs);
}

function readRunLock(info) {
  if (!existsSync(info.runLock)) return { exists: false, owner: null, stat: null };
  let lockStat;
  try {
    lockStat = statSync(info.runLock);
  } catch (error) {
    throw new GuardError(`Cannot inspect apply-run lock: ${error.message}`);
  }
  const ownerPath = join(info.runLock, 'owner.json');
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') {
      throw new GuardError(`Cannot read apply-run lock owner: ${error.message}`);
    }
  }
  return { exists: true, owner, stat: lockStat };
}

function currentLeaseActiveMs(run, at = now()) {
  const base = Number.isFinite(run?.lease_active_ms) ? Math.max(0, run.lease_active_ms) : 0;
  if (run?.status === 'active' && run.last_active_since) {
    return base + elapsedMs(run.last_active_since, at);
  }
  return base;
}

function currentPausedMs(run, at = now()) {
  if (run?.status !== 'paused' || !run.paused_at) return 0;
  return elapsedMs(run.paused_at, at);
}

function leaseExpired(run, at = now()) {
  return run?.status === 'active' && currentLeaseActiveMs(run, at) >= APPLY_RUN_TTL_MS;
}

function pausedExpired(run, at = now()) {
  return run?.status === 'paused' && currentPausedMs(run, at) >= PAUSED_RUN_TTL_MS;
}

function legacyLeaseExpired(record, at = now()) {
  return elapsedMs(record?.started_at, at) >= APPLY_RUN_TTL_MS;
}

function addActiveInterval(run, end) {
  if (!run.last_active_since) return 0;
  const delta = elapsedMs(run.last_active_since, end);
  if (delta > 0) {
    run._active_intervals.push({ start: run.last_active_since, end });
    run.active_total_ms += delta;
    run.lease_active_ms += delta;
  }
  run.last_active_since = null;
  return delta;
}

function addPausedInterval(run, end) {
  if (!run.paused_at) return 0;
  const delta = elapsedMs(run.paused_at, end);
  if (delta > 0) {
    run._paused_intervals.push({ start: run.paused_at, end });
    run.paused_total_ms += delta;
  }
  run.paused_at = null;
  return delta;
}

function activeDurationBetween(run, start, end) {
  let total = sumIntervals(run._active_intervals, start, end);
  if (run.status === 'active' && run.last_active_since) {
    total += intervalOverlapMs(run.last_active_since, end, start, end);
  }
  return total;
}

function pausedDurationBetween(run, start, end) {
  let total = sumIntervals(run._paused_intervals, start, end);
  if (run.status === 'paused' && run.paused_at) {
    total += intervalOverlapMs(run.paused_at, end, start, end);
  }
  return total;
}

function timingForRun(run, finishedAt) {
  const activeMs = activeDurationBetween(run, run.started_at, finishedAt);
  const pausedMs = pausedDurationBetween(run, run.started_at, finishedAt);
  const totalMs = elapsedMs(run.started_at, finishedAt);
  const simplifyMs = run.simplify_done_at
    ? activeDurationBetween(run, run.started_at, run.simplify_done_at)
    : 0;
  const agentEnd = run.review_reached_at ?? finishedAt;
  const agentStart = run.simplify_done_at ?? run.started_at;
  const agentMs = activeDurationBetween(run, agentStart, agentEnd);
  const exceptionMs = Math.max(0, activeMs - simplifyMs - agentMs);
  return {
    total_seconds: Math.round(totalMs / 1000),
    active_seconds: Math.round(activeMs / 1000),
    paused_seconds: Math.round(pausedMs / 1000),
    simplify_seconds: Math.round(simplifyMs / 1000),
    agent_seconds: Math.round(agentMs / 1000),
    exception_seconds: Math.round(exceptionMs / 1000),
    pause_count: run.pause_count,
    recovery_count: run.recovery_count,
  };
}

function applySummaryFields(run, event) {
  for (const key of [
    'total_seconds',
    'active_seconds',
    'paused_seconds',
    'simplify_seconds',
    'agent_seconds',
    'exception_seconds',
    'pause_count',
    'recovery_count',
  ]) {
    if (Object.prototype.hasOwnProperty.call(event, key)) run[key] = event[key];
  }
}

function clearBrowserHandoff(run) {
  run.browser_handoff_at = null;
  run.browser_handoff_valid = false;
  run.browser_handoff_method = null;
}

function replay(events) {
  const runs = new Map();
  for (const [index, event] of events.entries()) {
    if (event.event === 'run_started') {
      if (runs.has(event.run_id)) throw new GuardError(`Duplicate run_id in apply-runs.jsonl: ${event.run_id}`);
      runs.set(event.run_id, {
        ...event,
        status: 'active',
        review_count: 0,
        user_change_count: 0,
        simplify_done_at: null,
        review_reached_at: null,
        last_review_reached_at: null,
        review_valid: false,
        review_invalidated_at: null,
        browser_handoff_at: null,
        browser_handoff_valid: false,
        browser_handoff_method: null,
        finished_at: null,
        submitted_at: null,
        last_user_change_at: null,
        last_event_at: event.at ?? event.started_at,
        last_active_since: event.started_at,
        paused_at: null,
        lease_active_ms: 0,
        active_total_ms: 0,
        paused_total_ms: 0,
        pause_count: 0,
        recovery_count: 0,
        started_index: index,
        _active_intervals: [],
        _paused_intervals: [],
      });
      continue;
    }
    const run = runs.get(event.run_id);
    if (!run) throw new GuardError(`Event ${event.event} refers to unknown run_id ${event.run_id}.`);
    run.last_event_at = event.at ?? event.finished_at ?? event.recovered_at ?? run.last_event_at;
    if (event.event === 'simplify_done') {
      run.simplify_done_at ??= event.at;
    } else if (event.event === 'review_reached') {
      run.review_count += 1;
      run.review_reached_at ??= event.at;
      run.last_review_reached_at = event.at;
      run.review_valid = true;
      clearBrowserHandoff(run);
    } else if (event.event === 'browser_handoff') {
      if (!run.review_valid || run.browser !== 'chrome' || event.visible !== true || event.method !== 'markHandoff') {
        throw new GuardError(`Invalid browser_handoff event for run_id ${run.run_id}.`);
      }
      run.browser_handoff_valid = true;
      run.browser_handoff_at = event.at;
      run.browser_handoff_method = event.method;
    } else if (event.event === 'user_change') {
      run.user_change_count += 1;
      run.last_user_change_at = event.at;
      run.last_user_change_note = event.note;
      run.review_valid = false;
      run.review_invalidated_at = event.at;
      clearBrowserHandoff(run);
    } else if (event.event === 'run_paused') {
      const pausedAt = event.paused_at ?? event.at;
      if (run.status !== 'active' || !run.last_active_since) throw new GuardError(`Invalid pause event for run_id ${run.run_id}.`);
      addActiveInterval(run, pausedAt);
      run.status = 'paused';
      run.paused_at = pausedAt;
      run.pause_count += 1;
      if (Number.isFinite(event.lease_active_ms)) run.lease_active_ms = Math.max(0, event.lease_active_ms);
      run.last_pause_note = event.note ?? null;
    } else if (event.event === 'run_resumed') {
      const resumedAt = event.resumed_at ?? event.at;
      if (run.status !== 'paused' || !run.paused_at) throw new GuardError(`Invalid resume event for run_id ${run.run_id}.`);
      addPausedInterval(run, resumedAt);
      run.status = 'active';
      run.last_active_since = resumedAt;
      if (Number.isFinite(event.lease_active_ms)) run.lease_active_ms = Math.max(0, event.lease_active_ms);
    } else if (event.event === 'run_recovered') {
      const recoveredAt = event.recovered_at ?? event.at;
      if (run.status === 'active' && run.last_active_since) addActiveInterval(run, recoveredAt);
      if (run.status === 'paused' && run.paused_at) addPausedInterval(run, recoveredAt);
      run.status = 'active';
      run.finished_at = null;
      run.abort_note = null;
      run.lease_active_ms = 0;
      run.last_active_since = recoveredAt;
      run.paused_at = null;
      run.recovery_count = Number.isInteger(event.recover_count)
        ? event.recover_count
        : run.recovery_count + 1;
      run.recovered_at = recoveredAt;
      if (run.review_count > 0) {
        run.review_valid = false;
        run.review_invalidated_at = recoveredAt;
        run.review_count = 0;
        run.review_reached_at = null;
        run.last_review_reached_at = null;
        run.user_change_count = 0;
        run.last_user_change_at = null;
      }
      clearBrowserHandoff(run);
    } else if (event.event === 'run_finished') {
      const finishedAt = event.finished_at ?? event.at;
      if (run.status === 'active') addActiveInterval(run, finishedAt);
      else if (run.status === 'paused') addPausedInterval(run, finishedAt);
      run.status = event.status;
      run.finished_at = finishedAt;
      run.finish_note = event.note ?? null;
      applySummaryFields(run, event);
    } else if (event.event === 'run_aborted') {
      const finishedAt = event.finished_at ?? event.at;
      if (run.status === 'active') addActiveInterval(run, finishedAt);
      else if (run.status === 'paused') addPausedInterval(run, finishedAt);
      run.status = event.status ?? 'aborted';
      run.finished_at = finishedAt;
      run.abort_note = event.note ?? null;
      applySummaryFields(run, event);
    } else if (event.event === 'submission_confirmed') {
      run.status = 'submitted';
      run.submitted_at = event.submitted_at ?? event.at;
    } else {
      throw new GuardError(`Unknown event ${event.event} in apply-runs.jsonl.`);
    }
  }
  return [...runs.values()];
}

function runSnapshot(run, at, status, event = 'run_finished', extra = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    event,
    run_id: run.run_id,
    company: run.company,
    role: run.role,
    url: run.url,
    browser: run.browser,
    simplify: run.simplify,
    resume: run.resume,
    cover_letter: run.cover_letter,
    started_at: run.started_at,
    simplify_done_at: run.simplify_done_at,
    review_reached_at: run.review_reached_at,
    review_valid: run.review_valid,
    review_invalidated_at: run.review_invalidated_at,
    browser_handoff_at: run.browser_handoff_at,
    browser_handoff_valid: run.browser_handoff_valid,
    browser_handoff_method: run.browser_handoff_method,
    finished_at: at,
    ...timingForRun(run, at),
    status,
    warnings: run.warnings ?? [],
    ...extra,
  };
}

function writeOwner(info, owner) {
  ensureDataDir(info);
  if (!existsSync(info.runLock)) throw new GuardError('Cannot write apply-run owner without a lock.');
  const ownerPath = join(info.runLock, 'owner.json');
  const tempPath = join(info.runLock, `.owner.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
    renameSync(tempPath, ownerPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw new GuardError(`Could not update apply-run lock owner: ${error.message}`);
  }
}

function ownerForRun(run, at = now()) {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: run.run_id,
    started_at: run.started_at,
    pid: process.pid,
    state: run.status === 'paused' ? 'paused' : 'active',
    lease_active_ms: currentLeaseActiveMs(run, at),
    last_active_since: run.status === 'paused' ? null : (run.last_active_since ?? run.started_at),
    paused_at: run.status === 'paused' ? run.paused_at : null,
    recover_count: run.recovery_count,
  };
}

function writeOwnerFromRun(info, run, at = now()) {
  writeOwner(info, ownerForRun(run, at));
}

function sameRunLock(info, run) {
  const lock = readRunLock(info);
  return lock.exists && lock.owner?.run_id === run.run_id;
}

function ensurePersistentLock(info, run) {
  ensureDataDir(info);
  if (existsSync(info.runLock)) throw new GuardError('An apply run lock already exists.');
  mkdirSync(info.runLock);
  try {
    writeOwnerFromRun(info, run, run.started_at);
  } catch (error) {
    rmSync(info.runLock, { recursive: true, force: true });
    throw error;
  }
}

function rebuildPersistentLock(info, run, at = now()) {
  const existing = readRunLock(info);
  if (existing.exists && existing.owner?.run_id !== run.run_id) {
    throw new GuardError(`Another apply run lock is present (${existing.owner?.run_id ?? 'unknown'}).`);
  }
  if (!existing.exists) mkdirSync(info.runLock);
  writeOwnerFromRun(info, run, at);
}

function removePersistentLock(info) {
  if (!existsSync(info.runLock)) return;
  const before = statSync(info.runLock);
  if (!sameDirectory(before, statSync(info.runLock))) {
    throw new GuardError('Apply-run lock changed while it was being released.');
  }
  rmSync(info.runLock, { recursive: true, force: true });
}

function withControlLock(info, fn) {
  ensureDataDir(info);
  const lock = tryAcquireDirLockSync(info.controlLock, {
    staleMs: CONTROL_LOCK_TTL_MS,
    createParent: true,
    owner: { purpose: 'apply-run-guard-control' },
  });
  if (!lock) throw new GuardError(`Another apply-run guard command is updating state; retry in ${CONTROL_LOCK_RETRY_MS}ms.`);
  try {
    return fn();
  } finally {
    releaseOrWarn(lock);
  }
}

function resolveResume(dataRoot, ref) {
  const input = cleanText(ref, '--resume');
  const outputDir = resolve(dataRoot, 'output');
  if (!existsSync(outputDir)) throw new GuardError('Resume must be an existing file inside the data-root output/.');
  const candidate = isAbsolute(input) ? resolve(input) : resolve(dataRoot, input);
  if (!existsSync(candidate)) throw new GuardError(`Resume file does not exist: ${input}`);
  let outputReal;
  let candidateReal;
  try {
    outputReal = realpathSync(outputDir);
    candidateReal = realpathSync(candidate);
  } catch (error) {
    throw new GuardError(`Cannot resolve resume path: ${error.message}`);
  }
  const rel = relative(outputReal, candidateReal);
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new GuardError('Resume must be inside the current data-root output/.');
  }
  if (!statSync(candidateReal).isFile()) throw new GuardError('Resume path must be a regular file.');
  return join('output', relative(outputReal, candidateReal)).split(sep).join('/');
}

function validateStart(values, positional, info) {
  if (positional.length) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  const company = cleanText(values.company, '--company');
  const role = cleanText(values.role, '--role');
  const url = cleanText(values.url, '--url');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new GuardError('--url must be a valid HTTPS URL.');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) throw new GuardError('--url must be a valid HTTPS URL.');
  const browser = cleanText(values.browser, '--browser');
  if (!['chrome', 'playwright'].includes(browser)) throw new GuardError('--browser must be chrome or playwright.');
  const coverLetter = cleanText(values['cover-letter'], '--cover-letter');
  if (!['prepared', 'skip'].includes(coverLetter)) throw new GuardError('--cover-letter must be prepared or skip.');
  if (browser === 'playwright' && values.simplify) throw new GuardError('--simplify is only valid with --browser chrome.');
  return {
    company,
    role,
    url: parsed.toString(),
    browser,
    resume: resolveResume(info.dataRoot, values.resume),
    cover_letter: coverLetter,
    simplify: Boolean(values.simplify),
  };
}

function makeRun(input, startedAt = now()) {
  return {
    event: 'run_started',
    schema_version: SCHEMA_VERSION,
    run_id: `apply-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    ...input,
    started_at: startedAt,
    at: startedAt,
    warnings: [],
  };
}

function findSingleRun(info, statuses) {
  const runs = replay(readEvents(info)).filter((run) => statuses.includes(run.status));
  if (runs.length === 0) throw new GuardError('No matching apply run.');
  if (runs.length > 1) throw new GuardError('More than one live apply run is recorded; run audit before continuing.');
  return runs[0];
}

function findAbortRun(info) {
  const runs = replay(readEvents(info));
  const live = runs.filter((run) => run.status === 'active' || run.status === 'paused');
  if (live.length === 1) return live[0];
  if (live.length > 1) throw new GuardError('More than one live apply run is recorded; run audit before continuing.');
  const expired = runs.filter((run) => run.status === 'expired');
  if (expired.length === 1) return expired[0];
  if (expired.length > 1) throw new GuardError('More than one expired apply run is recorded; run audit before continuing.');
  throw new GuardError('No matching apply run.');
}

function requireLiveRun(info, statuses, { allowMissingLock = false, allowExpired = false } = {}) {
  const run = findSingleRun(info, statuses);
  const at = now();
  if (run.status === 'active' && leaseExpired(run, at) && !allowExpired) {
    throw new GuardError('The apply-run lease has expired; recover or abort before continuing.');
  }
  if (run.status === 'paused' && pausedExpired(run, at)) {
    throw new GuardError('The paused apply-run lease has expired; start cleanup before continuing.');
  }
  const lock = readRunLock(info);
  if (!lock.exists || lock.owner?.run_id !== run.run_id) {
    if (allowMissingLock && !lock.exists) return run;
    throw new GuardError('The live apply run has no matching lease lock. Run audit before continuing.');
  }
  return run;
}

function expireRun(info, run, reason) {
  const at = now();
  appendEvent(info, runSnapshot(
    run,
    at,
    'expired',
    'run_aborted',
    { note: reason ?? (run.status === 'paused'
      ? 'apply-run paused for more than 24 hours'
      : 'apply-run lease expired after 45 minutes') },
  ));
}

function recoverBeforeStart(info, events) {
  let runs = replay(events);
  const lock = readRunLock(info);

  if (lock.exists) {
    const lockRun = lock.owner?.run_id ? runs.find((run) => run.run_id === lock.owner.run_id) : null;
    if (lockRun?.status === 'active' && !leaseExpired(lockRun)) {
      throw new GuardError(`An active apply run is already in progress (${lockRun.run_id}).`);
    }
    if (lockRun?.status === 'paused' && !pausedExpired(lockRun)) {
      throw new GuardError(`An apply run is paused and still reserved (${lockRun.run_id}).`);
    }
    if (lockRun?.status === 'active' && leaseExpired(lockRun)) expireRun(info, lockRun);
    if (lockRun?.status === 'paused' && pausedExpired(lockRun)) expireRun(info, lockRun);
    if (!lockRun && lock.owner && !ownerExpired(lock.owner)) {
      throw new GuardError(`An apply run lock is already present (${lock.owner.run_id ?? 'unknown'}).`);
    }
    removePersistentLock(info);
  }

  runs = replay(readEvents(info));
  for (const run of runs) {
    if (run.status === 'active' && leaseExpired(run)) expireRun(info, run);
    else if (run.status === 'active') throw new GuardError(`An active apply run is already in progress (${run.run_id}).`);
    else if (run.status === 'paused' && pausedExpired(run)) expireRun(info, run);
    else if (run.status === 'paused') throw new GuardError(`An apply run is paused and still reserved (${run.run_id}).`);
  }
}

function printRunCard(run) {
  console.log([
    'Run Card',
    `run_id: ${run.run_id}`,
    `company: ${run.company}`,
    `role: ${run.role}`,
    `browser: ${run.browser}${run.simplify ? ' + Simplify' : ''}`,
    `resume: ${run.resume}`,
    `cover_letter: ${run.cover_letter}`,
    '',
    'Before browser interaction:',
    '- complete the prepared material checks first;',
    '- let Simplify own routine fields when available;',
    '- handle only sensitive, open-ended, and genuinely empty required fields;',
    `- cover letter decision is already ${run.cover_letter};`,
    '- reach Review before handoff; never auto-submit.',
  ].join('\n'));
}

function startCommand(values, positional, info) {
  const input = validateStart(values, positional, info);
  return withControlLock(info, () => {
    recoverBeforeStart(info, readEvents(info));
    const run = makeRun(input);
    ensurePersistentLock(info, run);
    try {
      appendEvent(info, run);
    } catch (error) {
      removePersistentLock(info);
      throw error;
    }
    printRunCard(run);
  });
}

function pauseCommand(values, positional, info) {
  if (positional.length) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  const note = values.note === undefined ? undefined : cleanText(values.note, '--note');
  return withControlLock(info, () => {
    const run = requireLiveRun(info, ['active']);
    const at = now();
    appendEvent(info, {
      event: 'run_paused',
      run_id: run.run_id,
      paused_at: at,
      at,
      lease_active_ms: currentLeaseActiveMs(run, at),
      ...(note ? { note } : {}),
    });
    const paused = replay(readEvents(info)).find((item) => item.run_id === run.run_id);
    writeOwnerFromRun(info, paused, at);
    console.log(`Run ${run.run_id} paused.`);
  });
}

function resumeCommand(values, positional, info) {
  if (Object.keys(values).length || positional.length) throw new GuardError('resume takes no arguments.');
  return withControlLock(info, () => {
    const run = requireLiveRun(info, ['paused'], { allowMissingLock: true });
    const at = now();
    appendEvent(info, {
      event: 'run_resumed',
      run_id: run.run_id,
      resumed_at: at,
      at,
      lease_active_ms: run.lease_active_ms,
    });
    const resumed = replay(readEvents(info)).find((item) => item.run_id === run.run_id);
    rebuildPersistentLock(info, resumed, at);
    console.log(`Run ${run.run_id} resumed.`);
  });
}

function recoverCommand(values, positional, info) {
  if (positional.length) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  const runId = cleanText(values['run-id'], '--run-id');
  return withControlLock(info, () => {
    const runs = replay(readEvents(info));
    const run = runs.find((item) => item.run_id === runId);
    if (!run) throw new GuardError(`No apply run found for --run-id ${runId}.`);
    if (run.recovery_count >= MAX_RECOVERIES) throw new GuardError('This apply run has already used its recovery allowance.');
    if (runs.some((item) => item.started_index > run.started_index)) {
      throw new GuardError('A newer apply run exists; the older run cannot be recovered.');
    }
    const otherLive = runs.find((item) => item.run_id !== run.run_id && (item.status === 'active' || item.status === 'paused'));
    if (otherLive) throw new GuardError(`Another live apply run exists (${otherLive.run_id}).`);
    const at = now();
    const eligible = run.status === 'expired' || (run.status === 'active' && leaseExpired(run, at));
    if (!eligible) throw new GuardError('Only an expired apply run can be recovered.');
    const lock = readRunLock(info);
    if (lock.exists && lock.owner?.run_id !== run.run_id) {
      throw new GuardError(`Another apply run lock is present (${lock.owner?.run_id ?? 'unknown'}).`);
    }
    const leaseBefore = currentLeaseActiveMs(run, at);
    appendEvent(info, {
      event: 'run_recovered',
      run_id: run.run_id,
      recovered_at: at,
      at,
      original_started_at: run.started_at,
      lease_active_ms_before: leaseBefore,
      recover_count: run.recovery_count + 1,
    });
    const recovered = replay(readEvents(info)).find((item) => item.run_id === run.run_id);
    rebuildPersistentLock(info, recovered, at);
    console.log(`Run ${run.run_id} recovered; lease reset to 45 minutes.`);
  });
}

function markCommand(kind, values, positional, info) {
  if (positional.length !== 0) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  if (!['simplify_done', 'review_reached', 'user_change'].includes(kind)) {
    throw new GuardError(`Unknown mark event: ${kind}`);
  }
  const note = values.note;
  if (kind === 'user_change') cleanText(note, '--note');
  else if (note !== undefined) throw new GuardError(`--note is not valid with mark ${kind}.`);

  return withControlLock(info, () => {
    const run = requireLiveRun(info, ['active']);
    if (kind === 'simplify_done') {
      if (run.browser !== 'chrome') throw new GuardError('simplify_done is not applicable to a Playwright run.');
      if (!run.simplify) throw new GuardError('This run was not started with --simplify.');
      if (run.simplify_done_at) throw new GuardError('simplify_done was already recorded for this run.');
    } else if (kind === 'review_reached') {
      if (run.review_count >= 2) throw new GuardError('Only one re-review is allowed, after a user_change.');
      if (run.review_count === 1 && run.user_change_count === 0) {
        throw new GuardError('A second review_reached requires user_change first.');
      }
    } else if (kind === 'user_change' && run.review_count !== 1) {
      throw new GuardError('user_change is allowed only after the first review_reached.');
    }
    const at = now();
    appendEvent(info, { event: kind, run_id: run.run_id, at, ...(note ? { note: cleanText(note, '--note') } : {}) });
    const updated = replay(readEvents(info)).find((item) => item.run_id === run.run_id);
    writeOwnerFromRun(info, updated, at);
    if (kind === 'simplify_done') console.log(`Simplify checkpoint recorded: ${at}`);
    else if (kind === 'review_reached') console.log(`Review checkpoint recorded: ${at}`);
    else console.log(`User change recorded for ${run.run_id}.`);
  });
}

function browserHandoffCommand(values, positional, info) {
  if (positional.length) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  const visible = cleanText(values.visible, '--visible');
  const method = cleanText(values.method, '--method');
  const note = values.note === undefined ? undefined : cleanText(values.note, '--note');
  if (visible !== 'true') {
    throw new GuardError('--visible must be true. Record the handoff only after the Review tab is still visible.');
  }
  if (method !== 'markHandoff') throw new GuardError('Chrome handoff --method must be markHandoff.');
  return withControlLock(info, () => {
    const run = requireLiveRun(info, ['active']);
    if (run.browser !== 'chrome') {
      throw new GuardError('browser_handoff applies to Connected Chrome. Playwright does not use tab.markHandoff().');
    }
    if (!run.review_valid) throw new GuardError('browser_handoff requires a current Review checkpoint.');
    if (run.browser_handoff_valid) throw new GuardError('browser_handoff was already recorded for this Review.');
    const at = now();
    appendEvent(info, {
      event: 'browser_handoff',
      run_id: run.run_id,
      at,
      visible: true,
      method: 'markHandoff',
      ...(note ? { note } : {}),
    });
    const updated = replay(readEvents(info)).find((item) => item.run_id === run.run_id);
    writeOwnerFromRun(info, updated, at);
    console.log(`Browser handoff recorded: ${at}`);
  });
}

function finishCommand(values, positional, info) {
  if (positional.length) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  const status = cleanText(values.status, '--status');
  if (!['handed_off', 'blocked'].includes(status)) throw new GuardError('--status must be handed_off or blocked.');
  const note = values.note === undefined ? undefined : cleanText(values.note, '--note');
  if (status === 'blocked' && !note) throw new GuardError('finish --status blocked requires --note with the blocking reason.');
  return withControlLock(info, () => {
    const run = requireLiveRun(info, status === 'blocked' ? ['active', 'paused'] : ['active']);
    if (status === 'handed_off') {
      if (!run.review_valid) {
        throw new GuardError('handed_off requires a current Review checkpoint after the latest user change or recovery.');
      }
      if (run.last_user_change_at && Date.parse(run.last_user_change_at) > Date.parse(run.last_review_reached_at)) {
        throw new GuardError('A user_change occurred after the last review; reach Review again first.');
      }
      if (run.recovered_at && Date.parse(run.recovered_at) > Date.parse(run.last_review_reached_at)) {
        throw new GuardError('The run was recovered after the last Review; reach the current Review page again first.');
      }
      if (run.browser === 'chrome' && !run.browser_handoff_valid) {
        throw new GuardError('handed_off requires a verified Chrome handoff after the current Review. Call tab.markHandoff(), confirm the Review tab is still visible, then mark browser_handoff --visible true --method markHandoff. Otherwise finish --status blocked.');
      }
    }
    const event = runSnapshot(run, now(), status, 'run_finished', note ? { note } : {});
    appendEvent(info, event);
    removePersistentLock(info);
    console.log(`Run ${run.run_id} finished: ${status}.`);
  });
}

function abortCommand(values, positional, info) {
  if (positional.length) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  const note = values.note === undefined ? 'aborted by operator' : cleanText(values.note, '--note');
  return withControlLock(info, () => {
    const run = findAbortRun(info);
    const lock = readRunLock(info);
    const event = runSnapshot(run, now(), 'aborted', 'run_aborted', { note });
    appendEvent(info, event);
    if (lock.exists && lock.owner?.run_id === run.run_id) removePersistentLock(info);
    console.log(`Run ${run.run_id} aborted.`);
  });
}

function confirmSubmittedCommand(values, positional, info) {
  if (Object.keys(values).length || positional.length) throw new GuardError('confirm-submitted takes no arguments.');
  return withControlLock(info, () => {
    const runs = replay(readEvents(info));
    const pending = runs.filter((run) => run.status === 'handed_off');
    if (pending.length === 0) throw new GuardError('No handed_off run is waiting for explicit submission confirmation.');
    if (pending.length > 1) throw new GuardError('More than one handed_off run is awaiting confirmation; confirmation is ambiguous.');
    const run = pending[0];
    const submittedAt = now();
    appendEvent(info, {
      event: 'submission_confirmed',
      run_id: run.run_id,
      company: run.company,
      role: run.role,
      url: run.url,
      browser: run.browser,
      submitted_at: submittedAt,
      at: submittedAt,
      status: 'submitted',
      note: 'Recorded only after the user explicitly confirmed submission.',
    });
    console.log(`Submission confirmation recorded for ${run.run_id}; this command did not submit anything.`);
  });
}

function ownerExpired(owner, at = now()) {
  if (owner?.state === 'paused') return elapsedMs(owner.paused_at, at) >= PAUSED_RUN_TTL_MS;
  if (Number.isFinite(owner?.lease_active_ms)) {
    const active = owner.last_active_since
      ? owner.lease_active_ms + elapsedMs(owner.last_active_since, at)
      : owner.lease_active_ms;
    return active >= APPLY_RUN_TTL_MS;
  }
  return legacyLeaseExpired(owner, at);
}

function auditCommand(values, positional, info) {
  if (Object.keys(values).length || positional.length) throw new GuardError('audit takes no arguments.');
  const runs = replay(readEvents(info));
  const live = runs.filter((run) => run.status === 'active' || run.status === 'paused');
  const lock = readRunLock(info);
  if (live.length === 0) {
    console.log('No active apply run.');
    if (lock.exists) console.log(`Run lock present without a live log record: ${lock.owner?.run_id ?? 'unknown'}${ownerExpired(lock.owner ?? {}) ? ' (expired)' : ''}`);
  } else {
    for (const run of live) {
      console.log(`${run.status === 'paused' ? 'Paused' : 'Active'} apply run: ${run.run_id} — ${run.company} / ${run.role}`);
      console.log(`Started: ${run.started_at}; age_minutes: ${Math.round(elapsedMs(run.started_at, now()) / 60_000)}`);
      const lease = run.status === 'paused'
        ? (pausedExpired(run) ? 'expired' : 'paused')
        : (sameRunLock(info, run) && !leaseExpired(run) ? 'present' : 'missing or expired');
      console.log(`Lease: ${lease}; lease_active_seconds: ${Math.round(currentLeaseActiveMs(run) / 1000)}`);
      console.log(`Review count: ${run.review_count}; user changes: ${run.user_change_count}; recoveries: ${run.recovery_count}`);
      if (run.browser === 'chrome') console.log(`Browser handoff: ${run.browser_handoff_valid ? 'recorded' : 'missing'}`);
    }
  }
  const latest = runs.at(-1);
  if (latest) console.log(`Latest event: ${latest.run_id} — ${latest.status}`);
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const command = argv[0];
  const info = paths();
  if (command === 'start') {
    const { values, positional } = parseArgs(argv.slice(1), ['--company', '--role', '--url', '--browser', '--resume', '--cover-letter'], { allowSimplify: true });
    startCommand(values, positional, info);
    return 0;
  }
  if (command === 'pause') {
    const { values, positional } = parseArgs(argv.slice(1), ['--note']);
    pauseCommand(values, positional, info);
    return 0;
  }
  if (command === 'resume') {
    const { values, positional } = parseArgs(argv.slice(1));
    resumeCommand(values, positional, info);
    return 0;
  }
  if (command === 'recover') {
    const { values, positional } = parseArgs(argv.slice(1), ['--run-id']);
    recoverCommand(values, positional, info);
    return 0;
  }
  if (command === 'mark') {
    const kind = argv[1];
    if (!kind) throw new GuardError('mark requires simplify_done, review_reached, user_change, or browser_handoff.');
    if (kind === 'browser_handoff') {
      const { values, positional } = parseArgs(argv.slice(2), ['--visible', '--method', '--note']);
      browserHandoffCommand(values, positional, info);
      return 0;
    }
    const { values, positional } = parseArgs(argv.slice(2), ['--note']);
    markCommand(kind, values, positional, info);
    return 0;
  }
  if (command === 'review_reached') {
    const { values, positional } = parseArgs(argv.slice(1));
    markCommand('review_reached', values, positional, info);
    return 0;
  }
  if (command === 'finish') {
    const { values, positional } = parseArgs(argv.slice(1), ['--status', '--note']);
    finishCommand(values, positional, info);
    return 0;
  }
  if (command === 'confirm-submitted') {
    const { values, positional } = parseArgs(argv.slice(1));
    confirmSubmittedCommand(values, positional, info);
    return 0;
  }
  if (command === 'abort') {
    const { values, positional } = parseArgs(argv.slice(1), ['--note']);
    abortCommand(values, positional, info);
    return 0;
  }
  if (command === 'audit') {
    const { values, positional } = parseArgs(argv.slice(1));
    auditCommand(values, positional, info);
    return 0;
  }
  throw new GuardError(`Unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.code && Number.isInteger(error.code) ? error.code : 1;
  }
}
