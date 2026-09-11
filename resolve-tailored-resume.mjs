#!/usr/bin/env node
/**
 * Resolve one generated PDF before opening a browser file picker.
 *
 * Usage:
 *   node resolve-tailored-resume.mjs Biohub "Research Engineer, AI"
 *
 * The command prints exactly one absolute path on success. It refuses to
 * guess when no file or multiple files match the company-role slug — this
 * is deliberate: fuzzy-matching a role name risks silently attaching the
 * wrong company's tailored resume to an application. On zero exact matches,
 * it lists same-company PDFs as suggestions (never auto-selects one) so the
 * caller can see the exact slug to pass instead of guessing blind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';

const OUTPUT_DIR = path.join(getCareerOpsRoot(), 'output');

function slugify(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error('Usage: node resolve-tailored-resume.mjs <company> <role>');
  process.exit(2);
}

const [company, ...roleParts] = process.argv.slice(2);
if (!company || roleParts.length === 0) usage('company and role are required');

const companySlug = slugify(company);
const roleSlug = slugify(roleParts.join(' '));
const suffix = `-${companySlug}-${roleSlug}`;

let allPdfStems;
try {
  allPdfStems = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
    .map(entry => entry.name);
} catch (err) {
  console.error(`Could not read output directory ${OUTPUT_DIR}: ${err.message}`);
  process.exit(1);
}

const candidates = allPdfStems
  .filter(name => {
    const stem = name.slice(0, -4).toLowerCase();
    return stem.endsWith(suffix) || new RegExp(`${suffix}-\\d{4}-\\d{2}-\\d{2}$`).test(stem);
  })
  .sort();

if (candidates.length === 0) {
  console.error(`No tailored PDF matched ${companySlug}/${roleSlug} in ${OUTPUT_DIR}`);
  // Refuse to guess, but surface same-company PDFs as candidates so the
  // caller can see the exact slug actually used at generation time instead
  // of re-guessing blind (e.g. "...-austin" exists but "...-austin-office"
  // was passed — this won't auto-select it, just shows what's really there).
  const sameCompany = allPdfStems
    .filter(name => name.slice(0, -4).toLowerCase().includes(`-${companySlug}-`))
    .sort();
  if (sameCompany.length > 0) {
    console.error(`Same-company PDFs found (pass the exact role slug from one of these instead):`);
    for (const name of sameCompany) console.error(`- ${name}`);
  }
  process.exit(1);
}

if (candidates.length > 1) {
  console.error(`Multiple tailored PDFs matched ${companySlug}/${roleSlug}:`);
  for (const candidate of candidates) console.error(`- ${candidate}`);
  console.error('Refusing to guess; choose the intended version explicitly.');
  process.exit(3);
}

console.log(path.join(OUTPUT_DIR, candidates[0]));
