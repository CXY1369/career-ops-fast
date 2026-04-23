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
 *   "auto_submit": false,            // future: set true for fully automated
 *   "keep_open_seconds": 600         // how long to keep browser open for review
 * }
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

// --- helpers ----------------------------------------------------------------

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
  const input = page.locator(`#${id}`);
  if (await input.count() === 0) return false;

  await input.click();
  await page.waitForTimeout(400);

  // Type to filter options (narrows react-select menu, avoids ambiguous matches)
  try {
    await input.fill(optionSubstring.slice(0, 20));
    await page.waitForTimeout(400);
  } catch {}

  // Prefer visible role=option inside an open react-select menu.
  // Exclude intl-tel-input's country dropdown (class iti__country) which also uses role=option.
  // Case-sensitive exact-prefix regex to avoid matching substrings inside other options
  // (e.g. "No" inside "sponsorship now").
  const escaped = optionSubstring.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixRe = new RegExp('^\\s*' + escaped);
  const visibleOpt = page.locator(
    '[role="option"]:visible:not(.iti__country)',
    { hasText: prefixRe }
  ).first();

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
