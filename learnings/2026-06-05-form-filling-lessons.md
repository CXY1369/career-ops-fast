# Form-Filling Lessons (Greenhouse + React-Select forms)

**Date:** 2026-06-05
**Triggered by:** Parse Biosciences application (report #016). v1 (existing `apply-form.mjs`) had 6 silent failures; v2 (`parse-apply-v2.mjs`) caught them all after a forced redesign.

## TL;DR — The Iron Rule

> **Inspect before you act.** Never write field-fill rules from assumptions about a form's structure. Dump the actual DOM first, then write the rules against ground truth.

## Failure modes seen, root causes, and fixes

| # | Symptom | Root cause | Permanent fix |
|---|---|---|---|
| 1 | Degree dropdown selected "Doctor of Medicine (M.D.)" instead of PhD | `first-match-wins` regex iteration — "M.D." came before "Ph.D." in the option list and the regex `/doctor/i` matched it first. | **Option scoring, not first-match.** Score each option (`PhD=10, doctorate=8, MD=0`), pick the highest > 0. See `pickByScore()` helper. |
| 2 | All dropdowns silently crashed mid-script | Used `CSS.escape()` which is a browser-context API, undefined in Node. Threw `ReferenceError` per dropdown. | **Use `[id="..."]` attribute selector** instead of class selector. No CSS API dependency. |
| 3 | Race dropdown (EEOC) never filled | The Race question is conditionally rendered AFTER answering Hispanic = No. First inspection pass didn't see it. | **Re-scan pass after dropdowns.** Diff the second inspection's combobox list against the first; fill the newly-appeared ones. |
| 4 | iti phone country picker's 250+ hidden options polluted dropdown searches → wrong picks or hangs | `[role="option"]` matches the iti country list even when hidden. Closest combobox's options aren't isolated. | **Scoped option search.** Read the combobox's `aria-controls` / `aria-owns` ID → search only `[id="LISTBOX_ID"] [role="option"]:visible`. Skip elements inside `.iti` / `[class*="intl-tel"]`. |
| 5 | Label extraction missed fieldset/legend structures (Disability Status, etc.) | `getLabelText` only walked up 6 levels looking for `<label>`. Greenhouse EEOC uses fieldset > legend or `role="group"`. | **6-strategy label fallback:** `<label for>` → `aria-labelledby` → `aria-label` → fieldset legend → `role=group` label → walk-up `:scope > label`. |
| 6 | "How did you become aware of this job opening?" not filled | Greenhouse rendered it as a text input, not a dropdown. No rule existed in `TEXT_RULES`. | Always add a `source/hear` text rule with default "LinkedIn". |
| 7 | "Scanpy/Seurat?" and "Workflow systems?" required-checkbox groups not filled | Script had **zero checkbox handling**. Only text/textarea/select/combobox/file were covered. | **New `CHECKBOX_GROUP_RULES` + Phase 2.7.** Walk up from each `input[type=checkbox]` to its question container (fieldset / `*` -terminated label / role=group), group by container, tick by label-regex → option-text-regex. |
| 8 | Phase 3 verify reported "7 required fields empty" but they were all filled | The hidden `<input type="text">` that backs each react-select widget reads as empty; the value lives in the `.select__single-value` div. Verify naively read `el.value`. | **`hasValue()` aware of widget types:** for `role=combobox`, walk up to react-select container and read `.singleValue` / `.single-value` text; for `checkbox`, walk up to question container and check if *any* sibling checkbox is checked. |
| 9 | Phase 4 reported "All required filled" — but 2 required checkbox groups were empty | `isRequired` only checked `el.required` / `aria-required` / nearest label's `*`. The `*` was on the question container, not the checkbox-level label. | `isRequired` now also looks at the **group container's label** (`<legend>`, `role=group > label`, walked-up parent labels). |

## Reusable engineering principles (write these on the wall)

1. **Inspect → Plan → Fill → Verify is the only safe order.** Skipping inspect = assumption-driven code = silent failures.
2. **Score, don't first-match.** Any time multiple options could plausibly match a rule (Degree, Country, Veteran), use a scorer that returns 0 for wrong answers, not just a regex.
3. **Scope every cross-element search.** `[role="option"]`, `:visible`, `:has-text`, `.iti` — all need scoping to the active widget, never the whole page.
4. **Conditionally-rendered fields exist.** Always add at least one re-scan pass after the first round of inputs.
5. **Widget types ≠ DOM types.** A "select" might be: native `<select>`, `<input role="combobox">` + react-select div, custom div trigger + listbox, or a checkbox-group masquerading as a multi-select. Each needs distinct read/write logic.
6. **Required ≠ `required` attribute.** Custom UI libraries put `*` on the question label, not the input. Detect required at the **group/container level**, not just the input.
7. **Browser APIs don't exist in Node context.** `CSS.escape`, `window.*`, `document.*` only run inside `page.evaluate()`. Anything outside must use Playwright-level selectors.

## Framing principle (added to `modes/_profile.md`)

When a form asks about *tools/frameworks/methodologies* the candidate could reasonably claim (Nextflow, AWS, Docker, specific languages) — **bias toward "Yes"**. Honesty firewall only applies to hard credentials: education, honors, employer, dates, publications. Defensive "No" answers knock the candidate out of the funnel for skills they could pick up in a week.

User's exact direction (2026-06-05): *"只要不是学历，荣誉证书 或者工作经历这种级别造假，就无伤大雅"* — "as long as it's not academic-credential / honors / work-history level falsification, it's harmless."

## Code artifacts internalized

- `apply-form.mjs` — production filler, upgraded to include:
  - Option scoring helper (`pickByScore`)
  - Scoped option search via `aria-controls` / `[id="..."]`
  - Re-scan phase for conditionally-rendered fields
  - Checkbox-group support (`checkbox_groups` config key)
  - Phase 4 required-empty detection with `hasValue` widget-aware
  - Inspection dump to `/tmp/form-inspection-{company}.json`
- `parse-apply-v2.mjs` — kept as reference implementation (do not delete — useful as a one-off template when production filler hits a new edge case).

## Checklist for next form-fill mission

Before invoking the filler:
- [ ] Run an inspect-only pass first; verify the field list matches expectations
- [ ] For every dropdown rule, confirm the scorer returns 0 for at least one wrong option (test the scorer's discrimination)
- [ ] Confirm checkbox groups are in the rules if the JD has any multi-select tooling questions
- [ ] Set `auto_submit: false` until Phase 4 reports zero empty required fields
- [ ] After submit, save the inspection JSON to the report's evidence folder for future reference
