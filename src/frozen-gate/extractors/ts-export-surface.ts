// src/frozen-gate/extractors/ts-export-surface.ts
//
// ts_export_surface_v1 extractor.
//
// Parses a TypeScript source file with tree-sitter + tree-sitter-typescript,
// walks `export_statement` nodes, and emits a stable normalized JSON
// description of the exported surface (names + signatures, sorted by name).
//
// Tree-walking pattern cherry-picked from
//   ~/dev/projects/gsd-skill-creator/src/intelligence/analyzer/languages/typescript.ts
//   - parser construction / grammar set: lines 34-42 (getTsParser)
//   - export_statement walk + childForFieldName('name') pattern: lines 52-99
//     (extractExports)
// gsd-skill-creator's complexity / unused-export / import analysis is NOT
// used — this extractor is surface-only.
//
// Idempotent and side-effect-free. Throws FrozenGateFileNotFoundError on
// missing artifacts (re-uses the typed error class from file-sha256.ts to
// keep the error contract uniform across extractors).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import { FrozenGateFileNotFoundError } from './file-sha256.js';

export type ExportKind = 'class' | 'function' | 'const' | 'interface' | 'type';

export type ExportInfo = {
  kind: ExportKind;
  name: string;
  signature: string;
};

export type TsExportSurfaceResult = {
  sha256: string;
  normalized: string;
  exports: ExportInfo[];
};

// tree-sitter-typescript ships its own .d.ts (bindings/node/index.d.ts) so
// the `Language` shape is typed via the package. setLanguage expects the
// grammar object directly.
const parser = new Parser();
parser.setLanguage(TS.typescript as unknown as Parameters<typeof parser.setLanguage>[0]);

export async function extractTsExportSurface(
  repo: string,
  relPath: string,
): Promise<TsExportSurfaceResult> {
  const absPath = join(repo, relPath);
  let source: string;
  try {
    source = await readFile(absPath, 'utf8');
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      throw new FrozenGateFileNotFoundError(absPath, err);
    }
    throw err;
  }

  const tree = parser.parse(source);
  const exports: ExportInfo[] = walkExports(tree.rootNode, source);
  exports.sort((a, b) => a.name.localeCompare(b.name));

  const value = {
    extractor: 'ts_export_surface_v1' as const,
    source_file: relPath,
    exports,
  };
  const normalized = stableStringify(value);
  const sha256 = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return { sha256, normalized, exports };
}

// --- helpers ---------------------------------------------------------------

function walkExports(root: Parser.SyntaxNode, source: string): ExportInfo[] {
  const out: ExportInfo[] = [];
  // Iterative walk; no recursion to keep stack small on large files.
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'export_statement') {
      const info = parseExportStatement(node, source);
      if (info) out.push(info);
      // Don't descend into export_statements — its children are handled
      // by parseExportStatement.
      continue;
    }
    // Push children; order doesn't matter because we sort by name later.
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return out;
}

function parseExportStatement(
  node: Parser.SyntaxNode,
  source: string,
): ExportInfo | null {
  // Look at named children for the underlying declaration.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    switch (child.type) {
      case 'class_declaration':
        return parseClass(child, source);
      case 'function_declaration':
        return parseFunction(child, source);
      case 'lexical_declaration':
      case 'variable_declaration':
        return parseLexical(child, source);
      case 'interface_declaration':
        return parseInterface(child, source);
      case 'type_alias_declaration':
        return parseTypeAlias(child, source);
      default:
        // Skip re-exports, default exports, etc. — surface-only contract.
        break;
    }
  }
  return null;
}

function parseClass(node: Parser.SyntaxNode, source: string): ExportInfo {
  const name = childText(node, 'name', source) ?? '<anonymous>';
  const body = node.childForFieldName('body');
  const members: string[] = [];
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const m = body.namedChild(i);
      if (!m) continue;
      if (m.type === 'method_definition' || m.type === 'method_signature') {
        // Skip private / protected — surface is the *public* contract.
        if (hasModifier(m, 'private') || hasModifier(m, 'protected')) continue;
        members.push(serializeMethod(m, source));
      } else if (
        m.type === 'public_field_definition' ||
        m.type === 'property_signature' ||
        m.type === 'field_definition'
      ) {
        if (hasModifier(m, 'private') || hasModifier(m, 'protected')) continue;
        members.push(serializeProperty(m, source));
      }
    }
  }
  return {
    kind: 'class',
    name,
    signature: `class ${name} { ${members.join('; ')}${members.length ? ';' : ''} }`,
  };
}

function parseFunction(node: Parser.SyntaxNode, source: string): ExportInfo {
  const name = childText(node, 'name', source) ?? '<anonymous>';
  const params = childText(node, 'parameters', source) ?? '()';
  const ret = childText(node, 'return_type', source) ?? '';
  return {
    kind: 'function',
    name,
    signature: `function ${name}${collapseWs(params)}${ret ? collapseWs(ret) : ''}`,
  };
}

function parseLexical(node: Parser.SyntaxNode, source: string): ExportInfo | null {
  // Only the first declarator's name + type — surface contract is the
  // exposed binding, not the value.
  for (let i = 0; i < node.namedChildCount; i++) {
    const decl = node.namedChild(i);
    if (!decl || decl.type !== 'variable_declarator') continue;
    const name = childText(decl, 'name', source) ?? '<anonymous>';
    const typeAnno = childText(decl, 'type', source) ?? '';
    return {
      kind: 'const',
      name,
      signature: `const ${name}${typeAnno ? collapseWs(typeAnno) : ''}`,
    };
  }
  return null;
}

function parseInterface(node: Parser.SyntaxNode, source: string): ExportInfo {
  const name = childText(node, 'name', source) ?? '<anonymous>';
  const body = node.childForFieldName('body');
  const members: string[] = [];
  if (body) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const m = body.namedChild(i);
      if (!m) continue;
      members.push(collapseWs(m.text).replace(/[;,]\s*$/, ''));
    }
  }
  return {
    kind: 'interface',
    name,
    signature: `interface ${name} { ${members.join('; ')}${members.length ? ';' : ''} }`,
  };
}

function parseTypeAlias(node: Parser.SyntaxNode, source: string): ExportInfo {
  const name = childText(node, 'name', source) ?? '<anonymous>';
  const value = childText(node, 'value', source) ?? '';
  return {
    kind: 'type',
    name,
    signature: `type ${name} = ${collapseWs(value)}`,
  };
}

function serializeMethod(node: Parser.SyntaxNode, source: string): string {
  const name = childText(node, 'name', source) ?? '<anonymous>';
  const params = childText(node, 'parameters', source) ?? '()';
  const ret = childText(node, 'return_type', source) ?? '';
  return `${name}${collapseWs(params)}${ret ? collapseWs(ret) : ''}`;
}

function serializeProperty(node: Parser.SyntaxNode, source: string): string {
  return collapseWs(node.text).replace(/[;,]\s*$/, '');
}

function hasModifier(node: Parser.SyntaxNode, mod: 'private' | 'protected'): boolean {
  // Modifiers like 'private' / 'protected' / 'readonly' / 'public' appear as
  // direct children of method_definition / public_field_definition before
  // the property_identifier. Walk anonymous (non-named) children too.
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'accessibility_modifier' && c.text === mod) return true;
    if (c.type === mod) return true;
  }
  return false;
}

function childText(
  node: Parser.SyntaxNode,
  field: string,
  source: string,
): string | null {
  const child = node.childForFieldName(field);
  if (!child) return null;
  return source.slice(child.startIndex, child.endIndex);
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer, 2) + '\n';
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
