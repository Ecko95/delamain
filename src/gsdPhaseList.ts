// src/gsdPhaseList.ts
//
// Phase-ID parsing + range expansion for the spawn_gsd_phase_batch and
// inspect_gsd_milestone MCP tools. A "phase ID" follows the convention used
// by GSD (.planning/phases/<id>/): NN-slug or NN.M-slug where NN is the
// numeric prefix (decimal phases like 33.1 are valid).
//
// Range expression: "from..to" where both endpoints are either bare numeric
// prefixes (`02..04`) or full IDs (`02-task-service..04-http`). Expansion
// requires a known phase list (typically derived from listing the
// .planning/phases/ directory of the target repo). If the caller passes a
// range to spawn_gsd_phase_batch without supplying the phase list (no
// inspect-gsd run yet), the tool surfaces an error asking the caller to
// either pass exact phase IDs or run inspect_gsd_milestone first.

export type PhaseId = string;

export class InvalidPhaseRangeError extends Error {
  readonly code = "INVALID_PHASE_RANGE";
  constructor(message: string) {
    super(`spawn_gsd_phase_batch: ${message}`);
    this.name = "InvalidPhaseRangeError";
  }
}

const PHASE_ID_RE = /^(\d+(?:\.\d+)?)(?:-([A-Za-z0-9-]+))?$/;

/**
 * Validate a single phase ID. Returns the numeric prefix and optional slug or throws.
 */
export function parsePhaseId(id: string): { prefix: string; slug?: string } {
  const m = id.match(PHASE_ID_RE);
  if (!m) {
    throw new InvalidPhaseRangeError(
      `'${id}' is not a valid phase ID (expected NN-slug or NN.M-slug)`,
    );
  }
  return { prefix: m[1], slug: m[2] };
}

/**
 * Expand a single entry of `selected_phases`. If `entry` is an exact ID,
 * returns [entry]. If it's a `from..to` range, expands using the provided
 * `knownPhases` list (the result preserves the order of `knownPhases`).
 */
export function expandPhaseEntry(
  entry: string,
  knownPhases?: readonly string[],
): PhaseId[] {
  const sep = entry.indexOf("..");
  if (sep < 0) {
    parsePhaseId(entry); // validate shape; throws if malformed
    return [entry];
  }
  const fromRaw = entry.slice(0, sep);
  const toRaw = entry.slice(sep + 2);
  if (!fromRaw || !toRaw) {
    throw new InvalidPhaseRangeError(`range '${entry}' missing endpoint`);
  }
  if (!knownPhases || knownPhases.length === 0) {
    throw new InvalidPhaseRangeError(
      `range '${entry}' cannot be expanded without a known phase list — call inspect_gsd_milestone first or pass exact phase IDs`,
    );
  }
  const fromIdx = findIndex(knownPhases, fromRaw);
  const toIdx = findIndex(knownPhases, toRaw);
  if (fromIdx < 0) {
    throw new InvalidPhaseRangeError(
      `range '${entry}': start '${fromRaw}' not found in known phases`,
    );
  }
  if (toIdx < 0) {
    throw new InvalidPhaseRangeError(
      `range '${entry}': end '${toRaw}' not found in known phases`,
    );
  }
  if (fromIdx > toIdx) {
    throw new InvalidPhaseRangeError(
      `range '${entry}': start comes after end (${fromRaw} > ${toRaw})`,
    );
  }
  return [...knownPhases.slice(fromIdx, toIdx + 1)];
}

function findIndex(known: readonly string[], needle: string): number {
  // Exact ID match first.
  const exact = known.indexOf(needle);
  if (exact >= 0) return exact;
  // Numeric prefix match: "02" → first entry starting with "02-".
  const prefixHit = known.findIndex((id) => id.startsWith(`${needle}-`));
  return prefixHit;
}

/**
 * Expand the full selected_phases input. Deduplicates while preserving order.
 */
export function expandSelectedPhases(
  selected: readonly string[],
  knownPhases?: readonly string[],
): PhaseId[] {
  if (selected.length === 0) {
    throw new InvalidPhaseRangeError("selected_phases must be a non-empty array");
  }
  const out: PhaseId[] = [];
  const seen = new Set<string>();
  for (const entry of selected) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new InvalidPhaseRangeError(
        `selected_phases entry must be a non-empty string`,
      );
    }
    for (const id of expandPhaseEntry(entry.trim(), knownPhases)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}
