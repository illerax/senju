// Files of viewers: read for the windows that show them, only asynchronously,
// as a file may be on a network share that stopped answering; and content an
// agent sent without a file, kept in a folder of the viewer's.

import fs from 'node:fs';
import path from 'node:path';
import { extensionFor, MAX_VIEWER_BYTES, viewerFormat, type ViewerContent } from '../shared/viewer';

/** Reads a viewer's file; null when its mtime is still `known`. */
export async function readViewerFile(file: string, known?: number): Promise<ViewerContent | null> {
  const failed = (error: string): ViewerContent => ({ data: '', encoding: 'utf8', size: 0, truncated: false, mtime: 0, error });
  let handle: fs.promises.FileHandle | null = null;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return failed(`${file} is not a file`);
    if (known !== undefined && stat.mtimeMs === known) return null;
    const image = viewerFormat(file).kind === 'image';
    if (image && stat.size > MAX_VIEWER_BYTES) return failed(`The image is too large to show (${Math.round(stat.size / 1024 / 1024)} MB)`);
    handle = await fs.promises.open(file, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_VIEWER_BYTES));
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const data = buffer.subarray(0, read);
    return {
      data: image ? data.toString('base64') : data.toString('utf8'),
      encoding: image ? 'base64' : 'utf8',
      size: stat.size,
      truncated: stat.size > read,
      mtime: stat.mtimeMs,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return failed(code === 'ENOENT' ? `${file} does not exist (any more)` : code === 'EACCES' ? `No permission to read ${file}` : (err as Error).message);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** A file name for content sent without a file, from the name and format the agent gave. */
export function ownedFileName(name: string | undefined, format: string | undefined): string {
  const base = (name ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 80) || 'content';
  if (!format) return path.extname(base) ? base : `${base}.txt`;
  const ext = extensionFor(format);
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/** Writes content an agent sent into the viewer's folder; returns the file. */
export async function writeOwned(dir: string, fileName: string, content: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, fileName);
  await fs.promises.writeFile(`${file}.tmp`, content, { mode: 0o600 });
  await fs.promises.rename(`${file}.tmp`, file);
  return file;
}
