// tests/apply-run-guard.test.mjs — local apply-run lease, state and audit guard.
// Browser tools are deliberately out of scope: every test uses a temporary
// DATA_ROOT and a fixture PDF.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'apply-run-guard.mjs');
const NODE = process.execPath;

function box(t, { useDataDir = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-apply-guard-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(join(root, 'output', 'resume.pdf'), '%PDF fixture\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, useDataDir };
}

function envFor(sandbox) {
  return {
    ...process.env,
    CAREER_OPS_ROOT: sandbox.useDataDir ? '' : sandbox.root,
    CAREER_OPS_DATA_DIR: sandbox.useDataDir ? sandbox.root : '',
    CAREER_OPS_TRACKER: '',
    CAREER_OPS_PROFILE: '',
  };
}

function run(sandbox, args) {
  return spawnSync(NODE, [SCRIPT, ...args], {
    cwd: ROOT,
    env: envFor(sandbox),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function logLines(sandbox) {
  const path = join(sandbox.root, 'data', 'apply-runs.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function startArgs(overrides = {}) {
  const values = {
    company: 'Acme AI',
    role: 'Senior Research Engineer',
    url: 'https://jobs.example.test/acme/123',
    browser: 'chrome',
    resume: 'output/resume.pdf',
    'cover-letter': 'prepared',
    ...overrides,
  };
  const args = [
    'start',
    '--company', values.company,
    '--role', values.role,
    '--url', values.url,
    '--browser', values.browser,
    '--resume', values.resume,
    '--cover-letter', values['cover-letter'],
  ];
  if (values.simplify) args.push('--simplify');
  return args;
}

function writeEvents(sandbox, events) {
  writeFileSync(
    join(sandbox.root, 'data', 'apply-runs.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
}

function writeRunLock(sandbox, owner) {
  mkdirSync(join(sandbox.root, 'data', '.apply-run.lock'), { recursive: true });
  writeFileSync(
    join(sandbox.root, 'data', '.apply-run.lock', 'owner.json'),
    `${JSON.stringify(owner, null, 2)}\n`,
  );
}

function fixtureRun({
  runId = 'fixture-run',
  startedAt = new Date(Date.now() - 60_000).toISOString(),
  company = 'Fixture Co',
  role = 'Fixture Role',
  url = 'https://jobs.example.test/fixture',
  browser = 'chrome',
  simplify = false,
  coverLetter = 'skip',
} = {}) {
  return {
    event: 'run_started',
    schema_version: 1,
    run_id: runId,
    company,
    role,
    url,
    browser,
    simplify,
    resume: 'output/resume.pdf',
    cover_letter: coverLetter,
    started_at: startedAt,
    at: startedAt,
    warnings: [],
  };
}

function ownerFor(run, overrides = {}) {
  return {
    schema_version: 1,
    run_id: run.run_id,
    started_at: run.started_at,
    pid: 999_999_999,
    state: 'active',
    lease_active_ms: 0,
    last_active_since: run.started_at,
    paused_at: null,
    recover_count: 0,
    ...overrides,
  };
}

function lockOwner(sandbox) {
  return JSON.parse(readFileSync(join(sandbox.root, 'data', '.apply-run.lock', 'owner.json'), 'utf8'));
}

test('start validates inputs, creates one lease, and rejects a second active run', (t) => {
  const sandbox = box(t);
  const started = run(sandbox, startArgs({ simplify: true }));
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /Run Card/);

  const [first] = logLines(sandbox);
  assert.equal(first.event, 'run_started');
  assert.equal(first.browser, 'chrome');
  assert.equal(first.simplify, true);
  assert.equal(first.resume, 'output/resume.pdf');
  assert.equal(first.cover_letter, 'prepared');
  assert.ok(first.run_id);
  assert.ok(!Number.isNaN(Date.parse(first.started_at)));
  assert.equal(existsSync(join(sandbox.root, 'data', 'application-runs.md')), false);

  const owner = lockOwner(sandbox);
  assert.equal(owner.run_id, first.run_id);
  assert.ok(Number.isInteger(owner.pid) && owner.pid > 0);
  assert.ok(!Number.isNaN(Date.parse(owner.started_at)));
  assert.equal(owner.state, 'active');
  assert.equal(owner.lease_active_ms, 0);
  assert.equal(owner.last_active_since, first.started_at);

  const second = run(sandbox, startArgs({ company: 'Other' }));
  assert.notEqual(second.status, 0);
  assert.match(`${second.stdout}\n${second.stderr}`, /active|lock|run/i);

  const aborted = run(sandbox, ['abort', '--note', 'test cleanup']);
  assert.equal(aborted.status, 0, aborted.stderr);
  assert.equal(existsSync(join(sandbox.root, 'data', '.apply-run.lock')), false);
  assert.equal(logLines(sandbox).at(-1).event, 'run_aborted');
});

test('start rejects malformed flags, unsafe URLs, invalid resume paths, and Playwright Simplify', (t) => {
  const sandbox = box(t);
  const cases = [
    [...startArgs(), '--unknown'],
    startArgs({ url: 'http://jobs.example.test/acme/123' }),
    startArgs({ url: 'https://', }),
    startArgs({ resume: '../resume.pdf' }),
    startArgs({ resume: '/tmp/resume.pdf' }),
    startArgs({ browser: 'safari' }),
    startArgs({ browser: 'playwright', simplify: true }),
  ];
  for (const args of cases) {
    const result = run(sandbox, args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(existsSync(join(sandbox.root, 'data', '.apply-run.lock')), false);
  }
});

test('state guards enforce the minimal review sequence and leave human logs untouched', (t) => {
  const sandbox = box(t);
  writeFileSync(join(sandbox.root, 'data', 'application-runs.md'), 'human log\n');
  assert.equal(run(sandbox, startArgs({ simplify: true })).status, 0);

  assert.equal(run(sandbox, ['mark', 'simplify_done']).status, 0);
  assert.notEqual(run(sandbox, ['mark', 'simplify_done']).status, 0);
  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.notEqual(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['mark', 'user_change', '--note', 'Add the prepared cover letter']).status, 0);
  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'handed_off']).status, 0);
  assert.equal(existsSync(join(sandbox.root, 'data', '.apply-run.lock')), false);
  assert.equal(readFileSync(join(sandbox.root, 'data', 'application-runs.md'), 'utf8'), 'human log\n');

  const finished = logLines(sandbox).find((entry) => entry.event === 'run_finished');
  assert.equal(finished.status, 'handed_off');
  assert.ok(!Number.isNaN(Date.parse(finished.finished_at)));
  assert.ok(finished.review_reached_at);
  assert.ok(finished.simplify_done_at);
  assert.ok(Number.isFinite(finished.total_seconds));
  assert.ok(Number.isFinite(finished.simplify_seconds));
  assert.ok(Number.isFinite(finished.agent_seconds));
  assert.ok(Number.isFinite(finished.exception_seconds));
  assert.ok(Array.isArray(finished.warnings));

  const confirmed = run(sandbox, ['confirm-submitted']);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(logLines(sandbox).at(-1).event, 'submission_confirmed');
  assert.notEqual(run(sandbox, ['confirm-submitted']).status, 0);
});

test('Playwright cannot record Simplify, but it can still reach Review and finish', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs({ browser: 'playwright' })).status, 0);
  const simplify = run(sandbox, ['mark', 'simplify_done']);
  assert.notEqual(simplify.status, 0);
  assert.match(`${simplify.stdout}\n${simplify.stderr}`, /playwright|simplify/i);
  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'handed_off']).status, 0);
});

test('Chrome without --simplify skips the Simplify checkpoint', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  assert.notEqual(run(sandbox, ['mark', 'simplify_done']).status, 0);
  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'handed_off']).status, 0);
});

test('blocked finish requires a reason, while abort always clears the lease', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  assert.notEqual(run(sandbox, ['finish', '--status', 'blocked']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'blocked', '--note', 'Portal is unreadable']).status, 0);
  assert.equal(existsSync(join(sandbox.root, 'data', '.apply-run.lock')), false);

  assert.equal(run(sandbox, startArgs({ company: 'Next Co' })).status, 0);
  assert.equal(run(sandbox, ['abort']).status, 0);
  assert.equal(existsSync(join(sandbox.root, 'data', '.apply-run.lock')), false);
});

test('expired leases are recorded and recovered without touching the prose log', (t) => {
  const sandbox = box(t);
  const old = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  const oldRun = {
    event: 'run_started',
    schema_version: 1,
    run_id: 'old-run',
    company: 'Old Co',
    role: 'Old Role',
    url: 'https://jobs.example.test/old',
    browser: 'chrome',
    simplify: false,
    resume: 'output/resume.pdf',
    cover_letter: 'skip',
    started_at: old,
    at: old,
  };
  writeFileSync(join(sandbox.root, 'data', 'apply-runs.jsonl'), `${JSON.stringify(oldRun)}\n`);
  mkdirSync(join(sandbox.root, 'data', '.apply-run.lock'));
  writeFileSync(join(sandbox.root, 'data', '.apply-run.lock', 'owner.json'), JSON.stringify({
    run_id: 'old-run',
    started_at: old,
    pid: 999_999_999,
  }));

  const started = run(sandbox, startArgs({ company: 'New Co' }));
  assert.equal(started.status, 0, started.stderr);
  const events = logLines(sandbox);
  assert.equal(events[1].event, 'run_aborted');
  assert.equal(events[1].run_id, 'old-run');
  assert.equal(events[1].status, 'expired');
  assert.equal(events.at(-1).event, 'run_started');
  assert.equal(events.at(-1).company, 'New Co');
  assert.equal(run(sandbox, ['abort', '--note', 'test cleanup']).status, 0);
});

test('audit reports an empty data root without creating a lock or prose log', (t) => {
  const sandbox = box(t, { useDataDir: true });
  const result = run(sandbox, ['audit']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No active apply run/);
  assert.equal(existsSync(join(sandbox.root, 'data', '.apply-run.lock')), false);
  assert.equal(existsSync(join(sandbox.root, 'data', 'apply-runs.jsonl')), false);
  assert.equal(existsSync(join(sandbox.root, 'data', 'application-runs.md')), false);
});

test('audit with an active run reports run details', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  const result = run(sandbox, ['audit']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active apply run/);
  assert.match(result.stdout, /Acme AI/);
  assert.match(result.stdout, /Lease.*present/);
  run(sandbox, ['abort']);
});

test('audit with orphan lock (no active log record) reports the lock without crashing', (t) => {
  const sandbox = box(t);
  const old = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  mkdirSync(join(sandbox.root, 'data', '.apply-run.lock'), { recursive: true });
  writeFileSync(join(sandbox.root, 'data', '.apply-run.lock', 'owner.json'), JSON.stringify({
    run_id: 'orphan-run',
    started_at: old,
    pid: 999_999_999,
  }));
  const result = run(sandbox, ['audit']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No active apply run/);
  assert.match(result.stdout, /orphan-run/);
  assert.match(result.stdout, /expired/);
});

test('finish without review_reached is rejected', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  const result = run(sandbox, ['finish', '--status', 'handed_off']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /review/i);
  run(sandbox, ['abort']);
});

test('user_change before review_reached is rejected', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  const result = run(sandbox, ['mark', 'user_change', '--note', 'premature change']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /review/i);
  run(sandbox, ['abort']);
});

test('pause freezes the active lease while wall-clock time advances', (t) => {
  const sandbox = box(t);
  const nowMs = Date.now();
  const startedAt = new Date(nowMs - 50 * 60 * 1000).toISOString();
  const pausedAt = new Date(nowMs - 40 * 60 * 1000).toISOString();
  const runRecord = fixtureRun({ runId: 'pause-freeze', startedAt });
  writeEvents(sandbox, [
    runRecord,
    {
      event: 'run_paused',
      schema_version: 1,
      run_id: runRecord.run_id,
      paused_at: pausedAt,
      at: pausedAt,
      lease_active_ms: 10 * 60 * 1000,
      note: 'waiting for login',
    },
  ]);
  writeRunLock(sandbox, ownerFor(runRecord, {
    state: 'paused',
    lease_active_ms: 10 * 60 * 1000,
    last_active_since: null,
    paused_at: pausedAt,
  }));

  const resumed = run(sandbox, ['resume']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(lockOwner(sandbox).state, 'active');
  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'handed_off']).status, 0);
});

test('pause without an active run is rejected', (t) => {
  const sandbox = box(t);
  const result = run(sandbox, ['pause']);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(sandbox.root, 'data', 'apply-runs.jsonl')), false);
});

test('resume while active is rejected', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  assert.notEqual(run(sandbox, ['resume']).status, 0);
  run(sandbox, ['abort']);
});

test('double pause is rejected', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  assert.equal(run(sandbox, ['pause', '--note', 'waiting']).status, 0);
  assert.notEqual(run(sandbox, ['pause']).status, 0);
  run(sandbox, ['abort']);
});

test('a resumed run can reach Review and finish handed_off', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  assert.equal(run(sandbox, ['pause']).status, 0);
  assert.equal(run(sandbox, ['resume']).status, 0);
  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'handed_off']).status, 0);
});

test('a paused run blocks a new start', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  assert.equal(run(sandbox, ['pause']).status, 0);
  const result = run(sandbox, startArgs({ company: 'Other Co' }));
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /paused|run|lock/i);
  run(sandbox, ['abort']);
});

test('a paused run can finish as blocked', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  assert.equal(run(sandbox, ['pause', '--note', 'login required']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'blocked', '--note', 'User login required']).status, 0);
  assert.equal(existsSync(join(sandbox.root, 'data', '.apply-run.lock')), false);
});

test('recover accepts an active run whose lease expired before start materialized expired status', (t) => {
  const sandbox = box(t);
  const startedAt = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  const runRecord = fixtureRun({ runId: 'recover-active-expired', startedAt });
  writeEvents(sandbox, [runRecord]);
  writeRunLock(sandbox, ownerFor(runRecord));

  const recovered = run(sandbox, ['recover', '--run-id', runRecord.run_id]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const owner = lockOwner(sandbox);
  assert.equal(owner.run_id, runRecord.run_id);
  assert.equal(owner.lease_active_ms, 0);
  const events = logLines(sandbox);
  const recovery = events.at(-1);
  assert.equal(recovery.event, 'run_recovered');
  assert.equal(recovery.lease_active_ms_before >= 45 * 60 * 1000, true);
  assert.equal(recovery.recover_count, 1);
  assert.equal(run(sandbox, ['finish', '--status', 'blocked', '--note', 'test cleanup']).status, 0);
  const finished = logLines(sandbox).at(-1);
  assert.equal(finished.active_seconds >= 45 * 60, true);
});

test('recover rejects a mismatched run id without changing state', (t) => {
  const sandbox = box(t);
  const startedAt = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  const runRecord = fixtureRun({ runId: 'recover-target', startedAt });
  writeEvents(sandbox, [runRecord]);
  writeRunLock(sandbox, ownerFor(runRecord));
  const before = readFileSync(join(sandbox.root, 'data', 'apply-runs.jsonl'), 'utf8');
  const result = run(sandbox, ['recover', '--run-id', 'wrong-run']);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(sandbox.root, 'data', 'apply-runs.jsonl'), 'utf8'), before);
});

test('a run can be recovered at most once', (t) => {
  const sandbox = box(t);
  const startedAt = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  const runRecord = fixtureRun({ runId: 'recover-once', startedAt });
  writeEvents(sandbox, [runRecord]);
  writeRunLock(sandbox, ownerFor(runRecord));
  assert.equal(run(sandbox, ['recover', '--run-id', runRecord.run_id]).status, 0);
  assert.notEqual(run(sandbox, ['recover', '--run-id', runRecord.run_id]).status, 0);
  assert.equal(logLines(sandbox).filter((event) => event.event === 'run_recovered').length, 1);
  run(sandbox, ['abort']);
});

test('a later run prevents recovery of an older expired run', (t) => {
  const sandbox = box(t);
  const startedAt = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  const oldRun = fixtureRun({ runId: 'old-recover-target', startedAt });
  writeEvents(sandbox, [oldRun]);
  writeRunLock(sandbox, ownerFor(oldRun));
  assert.equal(run(sandbox, startArgs({ company: 'New Co' })).status, 0);
  const result = run(sandbox, ['recover', '--run-id', oldRun.run_id]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /newer|active|run|recover/i);
  run(sandbox, ['abort']);
});

test('a paused run older than 24 hours is expired by the next start', (t) => {
  const sandbox = box(t);
  const nowMs = Date.now();
  const startedAt = new Date(nowMs - 26 * 60 * 60 * 1000).toISOString();
  const pausedAt = new Date(nowMs - 25 * 60 * 60 * 1000).toISOString();
  const oldRun = fixtureRun({ runId: 'old-paused', startedAt });
  writeEvents(sandbox, [
    oldRun,
    {
      event: 'run_paused',
      schema_version: 1,
      run_id: oldRun.run_id,
      paused_at: pausedAt,
      at: pausedAt,
      lease_active_ms: 60_000,
    },
  ]);
  writeRunLock(sandbox, ownerFor(oldRun, {
    state: 'paused',
    lease_active_ms: 60_000,
    last_active_since: null,
    paused_at: pausedAt,
  }));
  assert.equal(run(sandbox, startArgs({ company: 'New Co' })).status, 0);
  const events = logLines(sandbox);
  const expired = events.find((event) => event.run_id === oldRun.run_id && event.status === 'expired');
  assert.ok(expired);
  assert.equal(events.at(-1).event, 'run_started');
  run(sandbox, ['abort']);
});

test('recover rebuilds a missing run lock', (t) => {
  const sandbox = box(t);
  const startedAt = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  const runRecord = fixtureRun({ runId: 'rebuild-lock', startedAt });
  writeEvents(sandbox, [runRecord]);
  const recovered = run(sandbox, ['recover', '--run-id', runRecord.run_id]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(lockOwner(sandbox).run_id, runRecord.run_id);
  run(sandbox, ['abort']);
});

test('JSONL state wins over a conflicting owner cache', (t) => {
  const sandbox = box(t);
  const startedAt = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  const runRecord = fixtureRun({ runId: 'jsonl-authority', startedAt });
  writeEvents(sandbox, [runRecord]);
  writeRunLock(sandbox, ownerFor(runRecord, {
    state: 'paused',
    lease_active_ms: 0,
    last_active_since: null,
    paused_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  }));
  assert.equal(run(sandbox, ['recover', '--run-id', runRecord.run_id]).status, 0);
  assert.equal(lockOwner(sandbox).state, 'active');
  run(sandbox, ['abort']);
});

test('multiple pause and resume intervals accumulate paused_seconds', (t) => {
  const sandbox = box(t);
  const nowMs = Date.now();
  const startedAt = new Date(nowMs - 100_000).toISOString();
  const pause1 = new Date(nowMs - 90_000).toISOString();
  const resume1 = new Date(nowMs - 80_000).toISOString();
  const pause2 = new Date(nowMs - 70_000).toISOString();
  const resume2 = new Date(nowMs - 60_000).toISOString();
  const runRecord = fixtureRun({ runId: 'timing-intervals', startedAt });
  writeEvents(sandbox, [
    runRecord,
    { event: 'run_paused', schema_version: 1, run_id: runRecord.run_id, paused_at: pause1, at: pause1, lease_active_ms: 10_000 },
    { event: 'run_resumed', schema_version: 1, run_id: runRecord.run_id, resumed_at: resume1, at: resume1, lease_active_ms: 10_000 },
    { event: 'run_paused', schema_version: 1, run_id: runRecord.run_id, paused_at: pause2, at: pause2, lease_active_ms: 20_000 },
    { event: 'run_resumed', schema_version: 1, run_id: runRecord.run_id, resumed_at: resume2, at: resume2, lease_active_ms: 20_000 },
  ]);
  writeRunLock(sandbox, ownerFor(runRecord, {
    lease_active_ms: 20_000,
    last_active_since: resume2,
  }));
  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'handed_off']).status, 0);
  const finished = logLines(sandbox).at(-1);
  assert.equal(finished.pause_count, 2);
  assert.ok(finished.paused_seconds >= 19 && finished.paused_seconds <= 21);
  assert.ok(finished.active_seconds >= 79 && finished.active_seconds <= 82);
  assert.ok(finished.total_seconds >= finished.active_seconds + finished.paused_seconds);
});

