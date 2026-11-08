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

