// src/frozen-eligibility/eligibility.ts
//
// Phase 37 plan 01: classifyFrozenBatch — conservative pre-flight check
// for `planning_mode = frozen` dispatches. Returns eligible:false with
// EVERY reason found (no short-circuit) so callers can surface the
// complete blocker list in one round-trip.
//
// Three condition checks (all exhaustive per phaseId):
//   1. FROZEN-CONTRACT.json exists in <repo>/.planning/phases/<phaseId>/
//      (matches '<phaseId>-FROZEN-CONTRACT.json', bare 'FROZEN-CONTRACT.json',
//      or any '*-FROZEN-CONTRACT.json' suffix).
//   2. Every '*-PLAN.md' in the phase dir has YAML frontmatter with
//      `type: execute` AND `autonomous: true` (boolean, not string).
//   3. No risky keyword in any '*-CONTEXT.md', '*-SPEC.md', or '*-PLAN.md'
//      file. Case-insensitive; word-boundary for short all-caps tokens.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  type FrozenEligibility,
  type FrozenEligibilityCheckOptions,
  RISKY_KEYWORDS,
} from './types.js';

const SHORT_ALLCAPS = new Set(['TODO', 'FIXME', 'WIP']);

export async function classifyFrozenBatch(
  repo: string,
  phaseIds: string[],
  options: FrozenEligibilityCheckOptions = {},
): Promise<FrozenEligibility> {
  if (phaseIds.length === 0) {
    return { eligible: false, reasons: ['classifyFrozenBatch: phaseIds is empty'] };
  }
  const keywords = options.riskyKeywords ?? RISKY_KEYWORDS;
  const wordBoundary = options.wordBoundary ?? true;

  const contractReasons: string[] = [];
  const frontmatterReasons: string[] = [];
  const keywordReasons: string[] = [];

  // Sort phaseIds for stable output ordering.
  const sortedPhaseIds = [...phaseIds].sort();

  for (const phaseId of sortedPhaseIds) {
    const phaseDir = join(repo, '.planning', 'phases', phaseId);
    let dirEntries: string[];
    try {
      dirEntries = await readdir(phaseDir);
    } catch (err) {
      contractReasons.push(
        `${phaseId}: phase directory missing or unreadable (${(err as Error).message})`,
      );
      continue;
    }

    // --- Condition 1: FROZEN-CONTRACT.json existence ---
    const contractCandidates = [
      `${phaseId}-FROZEN-CONTRACT.json`,
      'FROZEN-CONTRACT.json',
    ];
    const hasContract =
      dirEntries.some((e) => contractCandidates.includes(e)) ||
      dirEntries.some((e) => e.endsWith('-FROZEN-CONTRACT.json'));
    if (!hasContract) {
      contractReasons.push(`${phaseId}: FROZEN-CONTRACT.json missing`);
    }

    // --- Condition 2: frontmatter on every *-PLAN.md ---
    const planFiles = dirEntries.filter((e) => e.endsWith('-PLAN.md')).sort();
    if (planFiles.length === 0) {
      frontmatterReasons.push(`${phaseId}: no PLAN.md files found`);
    }
    for (const planFile of planFiles) {
      const planPath = join(phaseDir, planFile);
      let raw: string;
      try {
        raw = await readFile(planPath, 'utf8');
      } catch (err) {
        frontmatterReasons.push(
          `${phaseId}/${planFile}: unreadable (${(err as Error).message})`,
        );
        continue;
      }
      const fm = extractFrontmatter(raw);
      if (fm === null) {
        frontmatterReasons.push(`${phaseId}/${planFile}: no YAML frontmatter`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = yaml.load(fm);
      } catch (err) {
        frontmatterReasons.push(
          `${phaseId}/${planFile}: malformed frontmatter (${(err as Error).message})`,
        );
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') {
        frontmatterReasons.push(
          `${phaseId}/${planFile}: frontmatter is not a YAML object`,
        );
        continue;
      }
      const obj = parsed as Record<string, unknown>;
      if (obj.type !== 'execute') {
        frontmatterReasons.push(
          `${phaseId}/${planFile}: type is '${String(obj.type)}', expected 'execute'`,
        );
      }
      if (obj.autonomous !== true) {
        frontmatterReasons.push(
          `${phaseId}/${planFile}: autonomous is '${String(obj.autonomous)}', expected 'true'`,
        );
      }
    }

    // --- Condition 3: risky keywords in CONTEXT / SPEC / PLAN files ---
    const scanFiles = dirEntries
      .filter(
        (e) =>
          e.endsWith('-CONTEXT.md') ||
          e === 'CONTEXT.md' ||
          e.endsWith('-SPEC.md') ||
          e === 'SPEC.md' ||
          e.endsWith('-PLAN.md') ||
          e === 'PLAN.md',
      )
      .sort();
    for (const scanFile of scanFiles) {
      let body: string;
      try {
        body = await readFile(join(phaseDir, scanFile), 'utf8');
      } catch {
        // Already surfaced under condition 2 for PLAN files; quietly skip.
        continue;
      }
      for (const keyword of keywords) {
        if (matchesKeyword(body, keyword, wordBoundary)) {
          keywordReasons.push(
            `${phaseId}/${scanFile}: contains risky keyword '${keyword}'`,
          );
        }
      }
    }
  }

  const reasons = [...contractReasons, ...frontmatterReasons, ...keywordReasons];
  if (reasons.length === 0) {
    return { eligible: true };
  }
  return { eligible: false, reasons };
}

/**
 * Extract the YAML frontmatter block from a markdown file.
 * Returns the inner YAML body (no fences) or null if no leading
 * frontmatter block is present.
 */
function extractFrontmatter(raw: string): string | null {
  // Anchor at start; tolerate UTF-8 BOM and a leading newline.
  const trimmed = raw.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) return null;
  // Match the first '---' line followed by content until the next '---' line.
  const m = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  return m[1] ?? '';
}

function matchesKeyword(body: string, keyword: string, wordBoundary: boolean): boolean {
  if (wordBoundary && SHORT_ALLCAPS.has(keyword)) {
    // Word-boundary anchored, case-insensitive.
    const re = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i');
    return re.test(body);
  }
  // Substring, case-insensitive.
  return body.toLowerCase().includes(keyword.toLowerCase());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
