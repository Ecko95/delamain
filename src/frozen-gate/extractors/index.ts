// src/frozen-gate/extractors/index.ts
//
// Extractor registry. Pluggable strategies dispatched by `extractor` field
// in FrozenContractEntry. Plan 32-02 adds file_sha256_v1; 32-03 adds
// ts_export_surface_v1; 32-04 adds json_schema_v1 and wires them into
// the gate orchestrator.

import type { ExtractorName } from '../types.js';
import { extractFileSha256 } from './file-sha256.js';
import { extractTsExportSurface } from './ts-export-surface.js';
import { extractJsonSchema } from './json-schema.js';

export type ExtractorResult = {
  sha256?: string;
  normalized?: string;
};

export type Extractor = (
  repo: string,
  relPath: string,
) => Promise<ExtractorResult>;

export const extractors: Partial<Record<ExtractorName, Extractor>> = {
  file_sha256_v1: extractFileSha256,
  ts_export_surface_v1: extractTsExportSurface,
  json_schema_v1: extractJsonSchema,
};

export { extractFileSha256, FrozenGateFileNotFoundError } from './file-sha256.js';
export {
  extractTsExportSurface,
  type ExportInfo,
  type ExportKind,
  type TsExportSurfaceResult,
} from './ts-export-surface.js';
export {
  extractJsonSchema,
  FrozenGateJsonParseError,
} from './json-schema.js';
