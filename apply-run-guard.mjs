#!/usr/bin/env node

/**
 * apply-run-guard.mjs — a small, browser-agnostic lease and audit guard for
 * live application runs.
 *
 * This tool never opens a browser and never submits a form. It owns only the
 * machine log and a short-lived run lease under the current DATA_ROOT. The
 * prose log in data/application-runs.md remains human-maintained.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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

const CONTROL_LOCK_TTL_MS = 60 * 1000;
const CONTROL_LOCK_NAME = '.apply-run-control.lock';
const RUN_LOCK_NAME = '.apply-run.lock';
const LOG_NAME = 'apply-runs.jsonl';
const CONTROL_LOCK_RETRY_MS = 20;

const HELP = `Usage:
  node apply-run-guard.mjs start \\
    --company "Company" --role "Role" --url "https://..." \\
    --browser chrome|playwright --resume "output/tailored-resume.pdf" \\
    --cover-letter prepared|skip [--simplify]
  node apply-run-guard.mjs mark simplify_done
  node apply-run-guard.mjs mark user_change --note "reason"
  node apply-run-guard.mjs review_reached
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

function leaseAgeMs(record) {
  const timestamp = record?.started_at;
  const parsed = Date.parse(timestamp ?? '');
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : Infinity;
}

function leaseExpired(record) {
  return leaseAgeMs(record) >= APPLY_RUN_TTL_MS;
}

function replay(events) {
  const runs = new Map();
  for (const event of events) {
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
        finished_at: null,
        submitted_at: null,
        last_user_change_at: null,
        last_event_at: event.at ?? event.started_at,
      });
      continue;
    }
    const run = runs.get(event.run_id);
    if (!run) throw new GuardError(`Event ${event.event} refers to unknown run_id ${event.run_id}.`);
    run.last_event_at = event.at ?? run.last_event_at;
    if (event.event === 'simplify_done') {
      run.simplify_done_at ??= event.at;
    } else if (event.event === 'review_reached') {
      run.review_count += 1;
      run.review_reached_at ??= event.at;
      run.last_review_reached_at = event.at;
    } else if (event.event === 'user_change') {
      run.user_change_count += 1;
      run.last_user_change_at = event.at;
      run.last_user_change_note = event.note;
    } else if (event.event === 'run_finished') {
      run.status = event.status;
      run.finished_at = event.finished_at ?? event.at;
      run.finish_note = event.note ?? null;
      Object.assign(run, event);
    } else if (event.event === 'run_aborted') {
      run.status = event.status ?? 'aborted';
      run.finished_at = event.finished_at ?? event.at;
      run.abort_note = event.note ?? null;
      Object.assign(run, event);
    } else if (event.event === 'submission_confirmed') {
      run.status = 'submitted';
      run.submitted_at = event.submitted_at ?? event.at;
      Object.assign(run, event);
    }
  }
  return [...runs.values()];
}

function activeRuns(events) {
  return replay(events).filter((run) => run.status === 'active');
}

function runSnapshot(run, at, status, extra = {}) {
  const finishedAt = at;
  const totalSeconds = Math.max(0, secondsBetween(run.started_at, finishedAt));
  const simplifySeconds = run.simplify_done_at
    ? Math.max(0, secondsBetween(run.started_at, run.simplify_done_at))
    : 0;
  const agentEnd = run.review_reached_at ?? finishedAt;
  const agentStart = run.simplify_done_at ?? run.started_at;
  const agentSeconds = Math.max(0, secondsBetween(agentStart, agentEnd));
  const exceptionSeconds = Math.max(0, totalSeconds - simplifySeconds - agentSeconds);
  return {
    schema_version: SCHEMA_VERSION,
    event: 'run_finished',
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
    finished_at: finishedAt,
    total_seconds: totalSeconds,
    simplify_seconds: simplifySeconds,
    agent_seconds: agentSeconds,
    exception_seconds: exceptionSeconds,
    status,
    warnings: run.warnings ?? [],
    ...extra,
  };
}

function secondsBetween(start, end) {
  const delta = Date.parse(end ?? '') - Date.parse(start ?? '');
  return Number.isFinite(delta) ? Math.round(Math.max(0, delta) / 1000) : 0;
}

function ensurePersistentLock(info, run) {
  ensureDataDir(info);
  if (existsSync(info.runLock)) throw new GuardError('An apply run lock already exists.');
  mkdirSync(info.runLock);
  try {
    writeFileSync(join(info.runLock, 'owner.json'), JSON.stringify({
      schema_version: SCHEMA_VERSION,
      run_id: run.run_id,
      started_at: run.started_at,
      pid: process.pid,
    }, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    rmSync(info.runLock, { recursive: true, force: true });
    throw new GuardError(`Could not write apply-run lock: ${error.message}`);
  }
}

function removePersistentLock(info) {
  if (!existsSync(info.runLock)) return;
  const before = statSync(info.runLock);
  const after = statSync(info.runLock);
  if (!sameDirectory(before, after)) throw new GuardError('Apply-run lock changed while it was being released.');
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
  // Validate against real paths above, then store the canonical logical path
  // under output/. This avoids leaking /private/var spellings into logs on
  // macOS and keeps absolute and relative CLI inputs equivalent.
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

function activeRunForMutation(info, { allowMissingLock = false, allowExpired = false } = {}) {
  const events = readEvents(info);
  const runs = activeRuns(events);
  if (runs.length === 0) throw new GuardError('No active apply run.');
  if (runs.length > 1) throw new GuardError('More than one active apply run is recorded; run audit before continuing.');
  const run = runs[0];
  if (leaseExpired(run) && !allowExpired) throw new GuardError('The apply-run lease has expired; run abort/recovery before continuing.');
  const lock = readRunLock(info);
  if (!lock.exists || lock.owner?.run_id !== run.run_id) {
    if (allowMissingLock && !lock.exists) return run;
    throw new GuardError('The active apply run has no matching lease lock. Run audit before continuing.');
  }
  return run;
}

function expireRun(info, run, reason = 'apply-run lease expired after 45 minutes') {
  const at = now();
  appendEvent(info, {
    ...runSnapshot(run, at, 'expired', { event: 'run_aborted', note: reason }),
    event: 'run_aborted',
    status: 'expired',
    note: reason,
  });
}

function recoverBeforeStart(info, events) {
  let runs = replay(events);
  let active = runs.filter((run) => run.status === 'active');
  const lock = readRunLock(info);

  if (lock.exists) {
    const lockRun = lock.owner?.run_id ? runs.find((run) => run.run_id === lock.owner.run_id) : null;
    const lockExpired = !lock.owner || leaseExpired(lock.owner);
    if (lockRun && lockRun.status !== 'active') {
      removePersistentLock(info);
    } else if (!lockExpired || active.some((run) => !leaseExpired(run))) {
      throw new GuardError(`An active apply run is already in progress${lock.owner?.run_id ? ` (${lock.owner.run_id})` : ''}.`);
    } else {
      removePersistentLock(info);
      if (lockRun?.status === 'active') expireRun(info, lockRun);
    }
  }

  runs = replay(readEvents(info));
  active = runs.filter((run) => run.status === 'active');
  for (const run of active) {
    if (!leaseExpired(run)) throw new GuardError(`An active apply run is already in progress (${run.run_id}).`);
    expireRun(info, run);
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

function markCommand(kind, values, positional, info) {
  if (positional.length !== 0) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  if (!['simplify_done', 'review_reached', 'user_change'].includes(kind)) {
    throw new GuardError(`Unknown mark event: ${kind}`);
  }
  const note = values.note;
  if (kind === 'user_change') cleanText(note, '--note');
  else if (note !== undefined) throw new GuardError(`--note is not valid with mark ${kind}.`);

  return withControlLock(info, () => {
    const run = activeRunForMutation(info);
    if (kind === 'simplify_done') {
      if (run.browser !== 'chrome') throw new GuardError('simplify_done is not applicable to a Playwright run.');
      if (!run.simplify) throw new GuardError('This run was not started with --simplify.');
      if (run.simplify_done_at) throw new GuardError('simplify_done was already recorded for this run.');
    } else if (kind === 'review_reached') {
      if (run.review_count >= 2) throw new GuardError('Only one re-review is allowed, after a user_change.');
      if (run.review_count === 1 && run.user_change_count === 0) {
        throw new GuardError('A second review_reached requires user_change first.');
      }
    } else if (kind === 'user_change') {
      if (run.review_count !== 1) throw new GuardError('user_change is allowed only after the first review_reached.');
    }
    const at = now();
    appendEvent(info, { event: kind, run_id: run.run_id, at, ...(note ? { note: cleanText(note, '--note') } : {}) });
    if (kind === 'simplify_done') console.log(`Simplify checkpoint recorded: ${at}`);
    else if (kind === 'review_reached') console.log(`Review checkpoint recorded: ${at}`);
    else console.log(`User change recorded for ${run.run_id}.`);
  });
}

function finishCommand(values, positional, info) {
  if (positional.length) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  const status = cleanText(values.status, '--status');
  if (!['handed_off', 'blocked'].includes(status)) throw new GuardError('--status must be handed_off or blocked.');
  const note = values.note === undefined ? undefined : cleanText(values.note, '--note');
  if (status === 'blocked' && !note) throw new GuardError('finish --status blocked requires --note with the blocking reason.');
  return withControlLock(info, () => {
    const run = activeRunForMutation(info);
    if (status === 'handed_off') {
      if (run.review_count < 1) throw new GuardError('handed_off requires review_reached first.');
      if (run.last_user_change_at && Date.parse(run.last_user_change_at) > Date.parse(run.last_review_reached_at)) {
        throw new GuardError('A user_change occurred after the last review; reach Review again first.');
      }
    }
    const event = runSnapshot(run, now(), status, note ? { note } : {});
    appendEvent(info, event);
    removePersistentLock(info);
    console.log(`Run ${run.run_id} finished: ${status}.`);
  });
}

function abortCommand(values, positional, info) {
  if (positional.length) throw new GuardError(`Unexpected positional argument: ${positional[0]}`);
  const note = values.note === undefined ? 'aborted by operator' : cleanText(values.note, '--note');
  return withControlLock(info, () => {
    const run = activeRunForMutation(info, { allowMissingLock: true, allowExpired: true });
    const lock = readRunLock(info);
    const event = runSnapshot(run, now(), 'aborted', { event: 'run_aborted', note });
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
      status: 'submitted',
      note: 'Recorded only after the user explicitly confirmed submission.',
    });
    console.log(`Submission confirmation recorded for ${run.run_id}; this command did not submit anything.`);
  });
}

function auditCommand(values, positional, info) {
  if (Object.keys(values).length || positional.length) throw new GuardError('audit takes no arguments.');
  const events = readEvents(info);
  const runs = replay(events);
  const active = runs.filter((run) => run.status === 'active');
  const lock = readRunLock(info);
  if (active.length === 0) {
    console.log('No active apply run.');
    if (lock.exists) console.log(`Run lock present without an active log record: ${lock.owner?.run_id ?? 'unknown'}${leaseExpired(lock.owner ?? {}) ? ' (expired)' : ''}`);
  } else {
    for (const run of active) {
      console.log(`Active apply run: ${run.run_id} — ${run.company} / ${run.role}`);
      console.log(`Started: ${run.started_at}; age_minutes: ${Math.round(leaseAgeMs(run) / 60_000)}`);
      console.log(`Lease: ${lock.exists && lock.owner?.run_id === run.run_id && !leaseExpired(run) ? 'present' : 'missing or expired'}`);
      console.log(`Review count: ${run.review_count}; user changes: ${run.user_change_count}`);
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
  if (command === 'mark') {
    const kind = argv[1];
    if (!kind) throw new GuardError('mark requires simplify_done, review_reached, or user_change.');
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

