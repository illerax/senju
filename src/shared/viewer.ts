// How viewers show a file: its format, from what the agent asked for or from
// the file's extension, and what the daemon sends of its content.

/** How a viewer renders its file. */
export type ViewerKind = 'markdown' | 'json' | 'yaml' | 'html' | 'csv' | 'image' | 'code' | 'text';

export interface ViewerFormat {
  kind: ViewerKind;
  /** For code: the language to highlight, e.g. "typescript". */
  language?: string;
  /** For csv: the separator. */
  separator?: string;
}

/** What the daemon sends of a viewer's file. */
export interface ViewerContent {
  /** The file's text, or base64 for images. */
  data: string;
  encoding: 'utf8' | 'base64';
  /** Size of the whole file in bytes. */
  size: number;
  /** The file is larger than MAX_VIEWER_BYTES; only its start is sent. */
  truncated: boolean;
  mtime: number;
  /** Why the file can't be read, e.g. it was deleted. */
  error?: string;
}

/** The most of a file a viewer shows; larger files show their start. */
export const MAX_VIEWER_BYTES = 5 * 1024 * 1024;

const images: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** Extensions and format names that name a language to highlight, by that language. */
const languages: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  graphql: 'graphql',
  dart: 'dart',
  scala: 'scala',
  vue: 'xml',
  svelte: 'xml',
};

const kinds: Record<string, ViewerKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  geojson: 'json',
  ipynb: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  html: 'html',
  htm: 'html',
  csv: 'csv',
  tsv: 'csv',
  txt: 'text',
  text: 'text',
  log: 'text',
};

/** The extension of a file name in lower case, or the whole name for names like Dockerfile. */
function extension(file: string): string {
  const name = file.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : name;
}

/**
 * How to show a file: the format asked for, as a format name ("markdown",
 * "json", "image"…), a language ("python") or an extension ("md"); otherwise
 * from the file's extension. Anything unknown is plain text.
 */
export function viewerFormat(file: string, asked?: string): ViewerFormat {
  for (const name of [asked?.trim().toLowerCase(), extension(file)]) {
    if (!name) continue;
    if (name === 'image' || images[name]) return { kind: 'image' };
    if (name === 'code') return { kind: 'code', language: languages[extension(file)] };
    if (kinds[name]) return kinds[name] === 'csv' ? { kind: 'csv', separator: name === 'tsv' ? '\t' : ',' } : { kind: kinds[name] };
    if (languages[name]) return { kind: 'code', language: languages[name] };
    if (Object.values(languages).includes(name)) return { kind: 'code', language: name };
    // An unknown format asked for still leaves the extension to tell.
  }
  return { kind: 'text' };
}

/** The media type of an image file, for showing it. */
export function imageType(file: string): string {
  return images[extension(file)] ?? 'application/octet-stream';
}

/** An extension for content an agent sends without a file, so its file tells its format too. */
export function extensionFor(format: string | undefined): string {
  const name = format?.trim().toLowerCase() ?? '';
  if (!name) return 'txt';
  if (kinds[name] || languages[name]) return name;
  const language = Object.entries(languages).find(([, l]) => l === name);
  return language ? language[0] : 'txt';
}

/** The tab name of a viewer: the name it was given, or its file's name. */
export function viewerLabel(viewer: { file: string; name?: string } | undefined): string {
  if (!viewer) return '';
  return viewer.name || viewer.file.split(/[\\/]/).pop() || viewer.file;
}
