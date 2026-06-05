#!/usr/bin/env node
/**
 * apply-form.mjs — Playwright-powered form filler for /career-ops apply
 *
 * Bypasses Chrome extension file-upload restrictions by driving a Playwright
 * Chromium instance directly via CDP, which allows setInputFiles().
 *
 * Usage:
 *   node apply-form.mjs <config.json>
 *
 * Config JSON schema:
 * {
 *   "url": "https://job-boards.greenhouse.io/...",
 *   "pdf_path": "/absolute/path/to/cv.pdf",
 *   "cover_letter_pdf": "/optional/path.pdf",
 *   "fields": {                      // key = input id OR label text match
 *     "first_name": "Xingyu",
 *     "email": "cxy1368@gmail.com",
 *     ...
 *   },
 *   "custom_answers": {              // free-text questions, id -> answer
 *     "question_11592189007": "Yes, I will relocate..."
 *   },
 *   "dropdowns": {                   // combobox questions, id -> option text (substring match)
 *     "question_11592190007": "Yes, I am currently legally authorized",
 *     "question_11592191007": "No, I do not and will not"
 *   },
 *   "checkbox_groups": [             // NEW (2026-06-05): required-multi-select questions
 *     {
 *       "label_match": "single cell.*scanpy.*seurat",   // regex against question label (i flag added)
 *       "tick": ["Scanpy", "Seurat"]                    // option-text substrings to tick
 *     },
 *     {
 *       "label_match": "workflow management",
 *       "tick": ["Nextflow"]
 *     }
 *   ],
 *   "company_slug": "parsebiosciences",  // OPTIONAL: used for /tmp/form-inspection-{slug}.json dump
 *   "auto_submit": false,                // future: set true for fully automated
 *   "keep_open_seconds": 600             // how long to keep browser open for review
 * }
 *
 * See learnings/2026-06-05-form-filling-lessons.md for the design rationale
 * behind the inspect → fill → re-scan → verify pipeline.
 */

import { chromium } from 'playwright';
import fs from 'fs';

const configPath = process.argv[2];
if (!configPath || !fs.existsSync(configPath)) {
  console.error('Usage: node apply-form.mjs <config.json>');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const log = (...args) => console.log('[apply]', ...args);

// --- inspect/verify helpers (added 2026-06-05) ------------------------------

/**
 * Dump every visible form control on the page with its detected label.
 * Writes to /tmp/form-inspection-{slug}.json for debugging.
 * Returns the array so callers can branch on it.
 */
async function inspectForm(page, slug = 'unknown') {
  const inspection = await page.evaluate(() => {
    function txt(n) { return (n?.innerText || n?.textContent || '').trim().replace(/\s+/g, ' ').replace(/\*$/, ''); }
    function labelFor(el) {
      if (el.id) { const lab = document.querySelector(`label[for="${el.id}"]`); if (lab) return txt(lab); }
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const parts = lb.split(/\s+/).map(id => txt(document.getElementById(id))).filter(Boolean);
        if (parts.length) return parts.join(' ');
      }
      const al = el.getAttribute('aria-label'); if (al) return al.trim();
      let p = el.parentElement;
      for (let i = 0; i < 8 && p; i++) {
        if (p.tagName === 'FIELDSET') { const lg = p.querySelector('legend'); if (lg) return txt(lg); }
        if (p.getAttribute('role') === 'group') {
          const lab = p.querySelector('label, legend, [class*="label" i]');
          if (lab) return txt(lab);
        }
        const lab = p.querySelector(':scope > label, :scope > div > label');
        if (lab && lab !== el) return txt(lab);
        p = p.parentElement;
      }
      return '';
    }
    const result = [];
    for (const el of document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type])')) {
      result.push({ kind: 'text', id: el.id || '', name: el.name || '', label: labelFor(el) });
    }
    for (const el of document.querySelectorAll('textarea')) {
      if (el.name === 'g-recaptcha-response') continue;
      result.push({ kind: 'textarea', id: el.id || '', name: el.name || '', label: labelFor(el) });
    }
    for (const el of document.querySelectorAll('input[role="combobox"]')) {
      const isItiPhone = !!el.closest('.iti, .iti__country-container, [class*="intl-tel"]');
      result.push({ kind: 'combobox', id: el.id || '', name: el.name || '', label: labelFor(el), isItiPhone });
    }
    for (const el of document.querySelectorAll('select')) {
      result.push({ kind: 'select', id: el.id || '', name: el.name || '', label: labelFor(el), options: [...el.options].map(o => o.text) });
    }
    for (const el of document.querySelectorAll('input[type="file"]')) {
      result.push({ kind: 'file', id: el.id || '', name: el.name || '', label: labelFor(el) });
    }
    return result;
  });
  try { fs.writeFileSync(`/tmp/form-inspection-${slug}.json`, JSON.stringify(inspection, null, 2)); } catch {}
  return inspection;
}

/**
 * Tick checkbox groups by question-label regex → option-text substring match.
 * Use this for required multi-select questions like "Single cell tools? [Scanpy/Seurat/...]"
 * Lesson 7 (2026-06-05): apply-form.mjs originally had NO checkbox handling — silent failure on EEOC + tooling questions.
 */
async function fillCheckboxGroups(page, rules) {
  if (!rules || !rules.length) return;
  const groups = await page.evaluate(() => {
    function txt(n) { return (n?.innerText || n?.textContent || '').trim().replace(/\s+/g, ' '); }
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')].filter(cb => {
      const r = cb.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
    const groups = new Map();
    for (const cb of boxes) {
      let container = cb.parentElement;
      let foundLabel = '';
      for (let depth = 0; depth < 10 && container; depth++) {
        if (container.tagName === 'FIELDSET') {
          const lg = container.querySelector('legend');
          if (lg) { foundLabel = txt(lg); break; }
        }
        if (container.getAttribute('role') === 'group') {
          const lab = container.querySelector(':scope > label, :scope > div > label, :scope > .label, :scope > legend');
          if (lab) { foundLabel = txt(lab); break; }
        }
        // Heuristic: child element whose text ends with * or ? and isn't the cb's own label
        const candidates = container.querySelectorAll(':scope > div, :scope > label, :scope > p, :scope > span, :scope > legend');
        for (const c of candidates) {
          const t = txt(c);
          if (t && /[*?]\s*$/.test(t) && t.length > 20 && !c.contains(cb)) { foundLabel = t; break; }
        }
        if (foundLabel) break;
        container = container.parentElement;
      }
      if (!container || !foundLabel) continue;
      if (!container.dataset._gKey) container.dataset._gKey = 'grp-' + Math.random().toString(36).slice(2);
      const key = container.dataset._gKey;
      if (!groups.has(key)) groups.set(key, { label: foundLabel, options: [] });
      let optText = '';
      if (cb.id) { const l = document.querySelector(`label[for="${cb.id}"]`); if (l) optText = txt(l); }
      if (!optText) { const p = cb.parentElement; if (p) optText = txt(p).replace(/^\s*/, ''); }
      groups.get(key).options.push({ text: optText, id: cb.id || '', name: cb.name || '', checked: cb.checked });
    }
    return [...groups.values()].filter(g => g.options.length >= 2);
  });

  log(`[checkbox-groups] found ${groups.length} group(s):`);
  for (const g of groups) log(`  · "${g.label.slice(0,70)}" → opts: ${g.options.map(o => o.text).join(' | ')}`);

  for (const g of groups) {
    const rule = rules.find(r => new RegExp(r.label_match, 'i').test(g.label));
    if (!rule) { log(`  · skip "${g.label.slice(0,60)}" (no rule)`); continue; }
    const tickRxList = (rule.tick || []).map(s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    for (const opt of g.options) {
      if (!tickRxList.some(rx => rx.test(opt.text))) continue;
      if (opt.checked) { log(`  · "${opt.text}" already ticked`); continue; }
      try {
        const sel = opt.id ? `#${opt.id}` : `input[type="checkbox"][name="${opt.name}"]`;
        await page.locator(sel).first().check({ force: true, timeout: 4000 }).catch(async () => {
          if (opt.id) await page.locator(`label[for="${opt.id}"]`).first().click({ timeout: 4000 }).catch(() => {});
        });
        log(`  ✅ ticked "${opt.text}"`);
      } catch (e) {
        log(`  ❌ failed "${opt.text}": ${e.message.split('\n')[0]}`);
      }
    }
  }
}

/**
 * Detect required fields that remain empty after the fill pass.
 * Handles react-select widgets (value lives in .singleValue div) and
 * checkbox groups (any checked sibling = group filled).
 * Lessons 8 + 9 (2026-06-05): naive el.value reads silently lie.
 */
async function detectRequiredEmpty(page) {
  return await page.evaluate(() => {
    function txt(n) { return (n?.innerText || n?.textContent || '').trim().replace(/\s+/g, ' '); }
    function findLabel(el) {
      if (el.id) { const lab = document.querySelector(`label[for="${el.id}"]`); if (lab) return lab; }
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        for (const id of lb.split(/\s+/).filter(Boolean)) {
          const lab = document.getElementById(id); if (lab) return lab;
        }
      }
      let p = el.parentElement;
      for (let i = 0; i < 8 && p; i++) {
        if (p.tagName === 'FIELDSET') { const lg = p.querySelector('legend'); if (lg) return lg; }
        const lab = p.querySelector(':scope > label, :scope > div > label, :scope > legend');
        if (lab && lab !== el) return lab;
        p = p.parentElement;
      }
      return null;
    }
    function isRequired(el, label) {
      if (el.required) return true;
      if (el.getAttribute('aria-required') === 'true') return true;
      if (label && /\*\s*$/.test(txt(label))) return true;
      if (label && /\*/.test(label.innerHTML)) return true;
      // Walk up: question-container-level required (group label has *)
      let p = el.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        if (p.tagName === 'FIELDSET' || p.getAttribute('role') === 'group') {
          const lg = p.querySelector('legend, :scope > label, :scope > div > label');
          if (lg && /\*/.test(lg.innerHTML)) return true;
        }
        p = p.parentElement;
      }
      return false;
    }
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    }
    function hasValue(el) {
      if (el.value && el.value.trim()) return true;
      if (el.type === 'file' && el.files && el.files.length > 0) return true;
      if (el.type === 'checkbox') {
        if (el.checked) return true;
        let p = el.parentElement;
        for (let i = 0; i < 8 && p; i++) {
          if (p.querySelector('input[type="checkbox"]:checked')) return true;
          if (p.tagName === 'FIELDSET' || p.getAttribute('role') === 'group') break;
          p = p.parentElement;
        }
      }
      if (el.getAttribute('role') === 'combobox') {
        let p = el.parentElement;
        for (let i = 0; i < 6 && p; i++) {
          const sv = p.querySelector('[class*="singleValue" i], [class*="single-value" i]');
          if (sv && txt(sv) && !/select\.\.\./i.test(txt(sv))) return true;
          p = p.parentElement;
        }
      }
      return false;
    }
    const out = []; const seen = new Set();
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.name === 'g-recaptcha-response' || el.type === 'hidden') continue;
      if (!isVisible(el)) continue;
      if (el.closest('.iti, [class*="intl-tel"]')) continue;
      const label = findLabel(el);
      if (!isRequired(el, label)) continue;
      const labelText = label ? txt(label) : '';
      const key = labelText + '|' + (el.id || el.name || '');
      if (seen.has(key)) continue; seen.add(key);
      if (hasValue(el)) continue;
      out.push({ labelText: labelText.slice(0, 80), id: el.id || '', name: el.name || '', tag: el.tagName.toLowerCase(), type: el.type || '', role: el.getAttribute('role') || '' });
    }
    return out;
  });
}

// --- legacy helpers ---------------------------------------------------------

async function fillById(page, id, value) {
  const loc = page.locator(`#${id}`);
  if (await loc.count() === 0) return false;
  await loc.fill(String(value));
  return true;
}

async function fillByLabel(page, labelText, value) {
  try {
    const loc = page.getByLabel(labelText, { exact: false }).first();
    await loc.waitFor({ state: 'visible', timeout: 2000 });
    await loc.fill(String(value));
    return true;
  } catch {
    return false;
  }
}

async function selectGreenhouseCombobox(page, id, optionSubstring) {
  // Greenhouse uses react-select: click the input, then click option by text.
  // Use [id="..."] attribute selector instead of #id — avoids needing CSS.escape (which is browser-only).
  const input = page.locator(`[id="${id.replace(/"/g, '\\"')}"]`);
  if (await input.count() === 0) return false;

  await input.click();
  await page.waitForTimeout(400);

  // Type to filter options (narrows react-select menu, avoids ambiguous matches)
  try {
    await input.fill(optionSubstring.slice(0, 20));
    await page.waitForTimeout(400);
  } catch {}

  // Lesson 4 (2026-06-05): scope option search to the listbox this combobox controls.
  // Without this, the intl-tel-input country picker's 250+ hidden options pollute the search.
  const listboxId = await input.evaluate(el => el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '').catch(() => '');
  const escaped = optionSubstring.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixRe = new RegExp('^\\s*' + escaped);
  const scopeSel = listboxId
    ? `[id="${listboxId.replace(/"/g, '\\"')}"] [role="option"]:visible:not(.iti__country)`
    : `[role="option"]:visible:not(.iti__country)`;
  const visibleOpt = page.locator(scopeSel, { hasText: prefixRe }).first();

  try {
    await visibleOpt.waitFor({ state: 'visible', timeout: 3000 });
    await visibleOpt.click();
    return true;
  } catch {}

  // Fallback: press ArrowDown + Enter (react-select friendly)
  try {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    log(`  ⚠️ "${optionSubstring}" not found; picked first filtered match for ${id}`);
    return true;
  } catch {
    log(`  ❌ option "${optionSubstring}" not resolvable for ${id}`);
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

async function uploadResume(page, pdfPath) {
  const fileInputs = await page.locator('input[type="file"]').all();
  if (fileInputs.length === 0) {
    log('  ⚠️ no file input found');
    return false;
  }
  // Greenhouse typically has Resume/CV as first file input, Cover Letter as second
  await fileInputs[0].setInputFiles(pdfPath);
  log(`  ✅ uploaded resume: ${pdfPath}`);
  return true;
}

async function uploadCoverLetter(page, pdfPath) {
  const fileInputs = await page.locator('input[type="file"]').all();
  if (fileInputs.length < 2) {
    log('  ⚠️ no cover letter input');
    return false;
  }
  await fileInputs[1].setInputFiles(pdfPath);
  log(`  ✅ uploaded cover letter: ${pdfPath}`);
  return true;
}

// --- main -------------------------------------------------------------------

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
});
const page = await context.newPage();

log(`Navigating to ${cfg.url}`);
await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000); // allow Greenhouse React to hydrate

// Detect: are we on the JD page with an Apply button, or already on the form?
// Broad match: "Apply", "Apply now", "Apply for this job", "Apply Here" — on <button> or <a>
const applyBtn = page.locator(
  'button, a',
  { hasText: /^\s*Apply(\s+(now|here|for|to)\b.*)?\s*$/i }
).first();
if (await applyBtn.count() > 0 && await applyBtn.isVisible().catch(() => false)) {
  log('Clicking Apply button...');
  await applyBtn.click().catch(() => {});
  await page.waitForTimeout(2500);
}

// 0. Inspect — dump every field with its detected label (debugging gold)
const slug = cfg.company_slug || (cfg.url || 'unknown').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
log(`Inspecting form (dump → /tmp/form-inspection-${slug}.json)...`);
const inspection = await inspectForm(page, slug);
log(`  Found ${inspection.length} controls (text/textarea/combobox/select/file)`);

// 1. Fill text fields
log('Filling text fields...');
for (const [key, value] of Object.entries(cfg.fields || {})) {
  const ok = await fillById(page, key, value) || await fillByLabel(page, key, value);
  log(`  ${ok ? '✅' : '❌'} ${key} = "${String(value).slice(0, 50)}"`);
}

// 2. Custom free-text answers (by id)
log('Filling custom text answers...');
for (const [id, value] of Object.entries(cfg.custom_answers || {})) {
  const ok = await fillById(page, id, value);
  log(`  ${ok ? '✅' : '❌'} ${id}`);
}

// 3. Upload resume
if (cfg.pdf_path) {
  log('Uploading resume...');
  await uploadResume(page, cfg.pdf_path);
}

// 4a. Upload cover letter PDF if provided
if (cfg.cover_letter_pdf) {
  log('Uploading cover letter...');
  await uploadCoverLetter(page, cfg.cover_letter_pdf);
}

// 4b. Or enter cover letter manually as text
//     DOM-scoped locator: find the "Enter manually" button that sits inside
//     the Cover Letter section. Works whether or not resume has been uploaded.
if (cfg.cover_letter_text && !cfg.cover_letter_pdf) {
  log('Entering cover letter manually...');
  // Greenhouse renders a heading like "Cover Letter" followed by the button group.
  // Use :has-text on the parent container to scope.
  const clBtn = page.locator(
    'div:has(> *:is(h3,h4,label,div):has-text("Cover Letter")) button:has-text("Enter manually")'
  ).first();

  let clicked = false;
  if (await clBtn.count() > 0) {
    try {
      await clBtn.click({ timeout: 3000 });
      clicked = true;
    } catch {}
  }

  // Fallback: pick the last "Enter manually" on the page (cover letter usually follows resume).
  if (!clicked) {
    const all = page.locator('button', { hasText: /^Enter manually$/i });
    const n = await all.count();
    if (n >= 1) {
      await all.nth(n - 1).click();
      clicked = true;
    }
  }

  if (clicked) {
    await page.waitForTimeout(600);
    const ta = page.locator('textarea:not([name="g-recaptcha-response"])').last();
    await ta.fill(cfg.cover_letter_text);
    log('  ✅ cover letter typed');
  } else {
    log('  ⚠️ no Enter manually button found for cover letter');
  }
}

// 5. Handle dropdowns
log('Selecting dropdown options...');
for (const [id, optionText] of Object.entries(cfg.dropdowns || {})) {
  const ok = await selectGreenhouseCombobox(page, id, optionText);
  log(`  ${ok ? '✅' : '❌'} ${id} -> "${optionText.slice(0, 40)}"`);
}

// 5b. Checkbox groups (required multi-select like "Scanpy/Seurat", "Nextflow/Snakemake")
//     Added 2026-06-05 — see learnings/2026-06-05-form-filling-lessons.md
if (cfg.checkbox_groups && cfg.checkbox_groups.length) {
  log('Filling checkbox groups...');
  await fillCheckboxGroups(page, cfg.checkbox_groups);
}

// 5c. Strict required-empty detection (catches what naive verify misses)
log('Detecting required-empty fields...');
const stillEmpty = await detectRequiredEmpty(page);
if (stillEmpty.length === 0) {
  log('  ✅ All visible required fields appear filled.');
} else {
  log(`  ⚠️ ${stillEmpty.length} REQUIRED field(s) still EMPTY — auto_submit will be DISABLED:`);
  for (const r of stillEmpty) {
    log(`     ✗ "${r.labelText}"  [${r.tag}${r.role?' role='+r.role:''}, id=${r.id||r.name||'-'}]`);
  }
  // Safety override: never auto-submit a form with empty required fields
  if (cfg.auto_submit) {
    log('  🛡 Overriding auto_submit=true → false because required fields are empty');
    cfg.auto_submit = false;
  }
}

log('--- Form filled. ---');

// 6. Submit (or stop for review)
if (cfg.auto_submit) {
  log('auto_submit enabled — clicking Submit in 3s...');
  await page.waitForTimeout(3000);
  // Try multiple selectors (Greenhouse uses a regular button, not type=submit)
  const submitBtn = page.locator(
    'button:has-text("Submit application"), button:has-text("Submit Application"), button[type="submit"]'
  ).first();
  if (await submitBtn.count() > 0) {
    try {
      await submitBtn.scrollIntoViewIfNeeded();
      await submitBtn.click({ timeout: 10000 });
      log('✅ Clicked Submit — waiting for confirmation...');
      await page.waitForTimeout(8000);
      // Check for reCAPTCHA block or success page
      const url = page.url();
      log(`  Post-submit URL: ${url}`);
      if (/thank|confirm|success|submitted/i.test(url) || await page.locator('text=/thank you|application received|we.ll be in touch/i').count() > 0) {
        log('✅ Submission confirmed.');
      } else {
        log('⚠️ No success signal detected. reCAPTCHA or validation likely blocked. Keeping browser open for manual review.');
        await page.waitForTimeout((cfg.keep_open_seconds || 600) * 1000);
      }
    } catch (e) {
      log(`❌ Submit click failed: ${e.message}`);
      await page.waitForTimeout((cfg.keep_open_seconds || 600) * 1000);
    }
  } else {
    log('⚠️ No Submit button found.');
  }
} else {
  const keepOpen = cfg.keep_open_seconds || 600;
  log(`Browser stays open for ${keepOpen}s — review and click Submit manually.`);
  await page.waitForTimeout(keepOpen * 1000);
}

await browser.close();
process.exit(0);
