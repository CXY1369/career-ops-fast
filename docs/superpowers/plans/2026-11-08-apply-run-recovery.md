# Apply Run Recovery Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure browser recovery invalidates stale Review checkpoints, preserves accurate pause timing, and prevents handoff from an outdated application state.

**Architecture:** Keep the existing browser-agnostic Guard and JSONL event model. Add a derived `review_valid` state: `review_reached` makes it valid, user changes and browser recovery invalidate it, and `finish --status handed_off` requires a current valid checkpoint. Recovery also starts a fresh Review epoch so the re-established page can be checkpointed without losing historical JSONL events. Update the apply protocol to pause before OTP/user intervention or session interruption; no browser automation code is changed.

**Tech Stack:** Node.js ESM, `node:test`, JSONL event replay, Markdown house rules.

---

### Task 1: Add regression tests for stale Review invalidation

**Files:**
- Modify: `tests/apply-run-guard.test.mjs`

- [x] **Step 1: Add a test that recovery after Review requires a fresh Review checkpoint**

Add this test after the existing recovery tests:

```js
test('recovery invalidates a prior Review checkpoint until Review is reached again', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  assert.equal(run(sandbox, ['review_reached']).status, 0);

  const events = logLines(sandbox);
  const startedAt = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  events[0].started_at = startedAt;
  events[0].at = startedAt;
  writeEvents(sandbox, events);
  writeRunLock(sandbox, ownerFor(events[0], { last_active_since: startedAt }));

  assert.equal(run(sandbox, ['recover', '--run-id', events[0].run_id]).status, 0);
  const staleFinish = run(sandbox, ['finish', '--status', 'handed_off']);
  assert.notEqual(staleFinish.status, 0);
  assert.match(`${staleFinish.stdout}\n${staleFinish.stderr}`, /review|recover|current/i);

  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'handed_off']).status, 0);
});
```

- [x] **Step 2: Add a test that user changes also invalidate the checkpoint**

Add this test near the existing `user_change` tests:

```js
test('user_change invalidates Review until the corrected form reaches Review again', (t) => {
  const sandbox = box(t);
  assert.equal(run(sandbox, startArgs()).status, 0);
  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['mark', 'user_change', '--note', 'corrected application field']).status, 0);

  const staleFinish = run(sandbox, ['finish', '--status', 'handed_off']);
  assert.notEqual(staleFinish.status, 0);
  assert.match(`${staleFinish.stdout}\n${staleFinish.stderr}`, /review/i);

  assert.equal(run(sandbox, ['review_reached']).status, 0);
  assert.equal(run(sandbox, ['finish', '--status', 'handed_off']).status, 0);
});
```

- [x] **Step 3: Run the focused tests and confirm the new tests fail before implementation**

Run:

```bash
node --test tests/apply-run-guard.test.mjs
```

Expected before implementation: the recovery test fails because `finish` currently accepts the stale Review checkpoint; the user-change test also exposes the same stale-state behavior.

### Task 2: Implement current-Review validity in the Guard

**Files:**
- Modify: `apply-run-guard.mjs:311-400, 760-815`

- [x] **Step 1: Track current Review validity during event replay**

Initialize `review_valid: false` and `review_invalidated_at: null` in the `run_started` state. Apply these transitions:

```js
// run_started state
review_valid: false,
review_invalidated_at: null,

// review_reached
run.review_valid = true;
run.last_review_reached_at = event.at;

// user_change
run.review_valid = false;
run.review_invalidated_at = event.at;

// run_recovered after a prior Review
if (run.review_valid || run.review_count > 0) {
  run.review_valid = false;
  run.review_invalidated_at = recoveredAt;
  run.review_count = 0;
  run.review_reached_at = null;
  run.last_review_reached_at = null;
  run.user_change_count = 0;
  run.last_user_change_at = null;
}
```

The JSONL event history remains the historical record. The replayed counters represent only the current Review epoch, while `review_valid` represents whether that checkpoint still describes the current browser state.

- [x] **Step 2: Require a valid current Review for handoff**

Change the `finishCommand` handoff gate from a historical count check to a current-state check:

```js
if (!run.review_valid) {
  throw new GuardError('handed_off requires a current Review checkpoint after the latest user change or recovery.');
}
if (run.last_user_change_at && Date.parse(run.last_user_change_at) > Date.parse(run.last_review_reached_at)) {
  throw new GuardError('A user_change occurred after the last review; reach Review again first.');
}
if (run.recovered_at && Date.parse(run.recovered_at) > Date.parse(run.last_review_reached_at)) {
  throw new GuardError('The run was recovered after the last Review; reach the current Review page again first.');
}
```

- [x] **Step 3: Treat recovery as a new Review epoch**

When replaying `run_recovered`, reset the current Review epoch as shown above. The historical `review_reached` and `user_change` events remain in JSONL, but the recovered run must reach a fresh Review before handoff. Because the current epoch starts with `review_count: 0`, the existing two-review/user-change rule remains sufficient:

```js
if (run.review_count >= 2) throw new GuardError('Only one re-review is allowed, after a user_change.');
if (run.review_count === 1 && run.user_change_count === 0) {
  throw new GuardError('A second review_reached requires user_change first.');
}
```

When handling `review_reached`, set `run.review_valid = true` after incrementing the count.

- [x] **Step 4: Include the validity state in snapshots used by audit and finish records**

Add these fields to `runSnapshot`:

```js
review_valid: run.review_valid,
review_invalidated_at: run.review_invalidated_at,
```

- [x] **Step 5: Run the focused tests and confirm they pass**

Run:

```bash
node --test tests/apply-run-guard.test.mjs
```

Expected: all Guard tests pass, including both new stale-Review regression tests.

### Task 3: Make the apply protocol explicit about browser interruption

**Files:**
- Modify: `modes/_custom.md:35-74`

- [x] **Step 1: Clarify pause/recovery and final handoff rules**

Update P0.0 so it explicitly requires pausing before OTP, user intervention, connector loss, or tab recovery; state that recovery invalidates any prior Review checkpoint and that `review_reached` must be recorded again before handoff. Keep the native Chrome-first rule unchanged.

Use this wording in the lifecycle section:

```markdown
4. **If the run must wait or the browser session is interrupted:**
   Run `node apply-run-guard.mjs pause --note "<reason>"` before handing control to the user or waiting for OTP/CAPTCHA. This also applies when the Chrome connector loses the tab or the page must be reopened. After the intervention, use `resume`; if the active lease has expired, use `recover --run-id "<run-id>"` only for this same application. Recovery preserves the run ID but invalidates any earlier Review checkpoint, so the current Review page must be reached and recorded again before handoff.

6. **After handoff to the user:**
   Only call `finish --status handed_off` when the current real Chrome tab visibly shows the latest Review page. A Review page seen before a browser interruption is stale and cannot satisfy handoff.
```

- [x] **Step 2: Update the guard rules summary**

Replace the historical-only rule with:

```markdown
- `finish --status handed_off` requires a current valid `review_reached` checkpoint; a checkpoint is invalidated by `user_change` or browser recovery.
- After recovery, `review_reached` must be recorded again before handoff; do not start a second run for the same application.
```

### Task 4: Verify the complete change

**Files:**
- Verify: `apply-run-guard.mjs`
- Verify: `tests/apply-run-guard.test.mjs`
- Verify: `modes/_custom.md`

- [x] **Step 1: Run the Guard test suite**

```bash
node --test tests/apply-run-guard.test.mjs
```

Expected: exit code 0 and no failed tests.

- [x] **Step 2: Run syntax validation**

```bash
node scripts/check-syntax.mjs apply-run-guard.mjs tests/apply-run-guard.test.mjs
```

Expected: exit code 0.

- [x] **Step 3: Inspect the diff and confirm scope**

```bash
git diff --check
git diff --stat
git status --short
```

Expected: only `apply-run-guard.mjs`, `tests/apply-run-guard.test.mjs`, `modes/_custom.md`, and this plan are changed by the repair; pre-existing `tmp_jds/` remains untouched.
