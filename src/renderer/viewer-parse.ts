// Parsing of the formats viewers show as trees and tables; no DOM, so tests run it.

import { parseAllDocuments } from 'yaml';

/** JSON, also with the comments and trailing commas of JSONC; throws with the parser's message. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const relaxed = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string) => string ?? '').replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(relaxed);
    } catch {
      throw err;
    }
  }
}

/** The documents of a YAML file: one value, or a list when it holds several. Throws on errors. */
export function parseYaml(text: string): unknown {
  const docs = parseAllDocuments(text);
  const list = Array.isArray(docs) ? docs : [docs];
  const error = list.flatMap((d) => d.errors)[0];
  if (error) throw new Error(error.message);
  const values = list.map((d) => d.toJS({ maxAliasCount: 1000 }));
  return values.length === 1 ? values[0] : values;
}

/** Rows of CSV or TSV, with quoted fields as RFC 4180 has them. */
export function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === separator) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
