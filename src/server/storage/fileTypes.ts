import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { ValidationError } from '../lib/errors.js';

/**
 * Upload content verification. The type is determined from the file's own
 * bytes (magic numbers), never trusted from the browser. Only an allow-list of
 * passive document, image and audio formats is accepted; active content such
 * as HTML, SVG, JavaScript or executables is always rejected.
 */

export type FileCategory = 'image' | 'heif' | 'pdf' | 'text' | 'audio' | 'office';

interface Allowed {
  category: FileCategory;
  /** Safe to display inline in the browser (still sandboxed by CSP). */
  inline: boolean;
}

const BINARY_TYPES: Record<string, Allowed> = {
  'image/jpeg': { category: 'image', inline: true },
  'image/png': { category: 'image', inline: true },
  'image/webp': { category: 'image', inline: true },
  'image/gif': { category: 'image', inline: true },
  'image/tiff': { category: 'image', inline: false },
  'image/avif': { category: 'image', inline: true },
  'image/heic': { category: 'heif', inline: false },
  'image/heif': { category: 'heif', inline: false },
  'image/heic-sequence': { category: 'heif', inline: false },
  'image/heif-sequence': { category: 'heif', inline: false },
  'application/pdf': { category: 'pdf', inline: true },
  'audio/mpeg': { category: 'audio', inline: true },
  'audio/mp4': { category: 'audio', inline: true },
  'audio/x-m4a': { category: 'audio', inline: true },
  'audio/aac': { category: 'audio', inline: true },
  'audio/wav': { category: 'audio', inline: true },
  'audio/x-wav': { category: 'audio', inline: true },
  'audio/ogg': { category: 'audio', inline: true },
  'audio/opus': { category: 'audio', inline: true },
  'audio/amr': { category: 'audio', inline: false },
  'audio/webm': { category: 'audio', inline: true },
  'video/webm': { category: 'audio', inline: false },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    category: 'office',
    inline: false,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    category: 'office',
    inline: false,
  },
  'application/vnd.oasis.opendocument.text': { category: 'office', inline: false },
  'application/vnd.oasis.opendocument.spreadsheet': { category: 'office', inline: false },
  'application/msword': { category: 'office', inline: false },
  'application/x-cfb': { category: 'office', inline: false },
};

/** Text formats have no magic number; they are accepted by extension after a content check. */
const TEXT_EXTENSIONS: Record<string, string> = {
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/csv',
  '.eml': 'message/rfc822',
  '.log': 'text/plain',
};

export interface DetectedType {
  mimeType: string;
  category: FileCategory;
  inline: boolean;
}

export class UnsupportedFileError extends ValidationError {
  constructor(message: string) {
    super(message, { file: message });
    this.name = 'UnsupportedFileError';
  }
}

function looksLikeText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  const text = buf.toString('utf8');
  // Reject markup that a browser might render as active content.
  if (/<\s*(html|script|svg|iframe|object|embed|!doctype)/i.test(text.slice(0, 4096))) return false;
  const replacement = (text.match(/�/g) ?? []).length;
  return replacement < Math.max(4, text.length / 200);
}

export async function detectFileType(
  filePath: string,
  originalFilename: string,
): Promise<DetectedType> {
  const handle = await open(filePath, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (head.length === 0) throw new UnsupportedFileError('The file is empty.');
  const detected = await fileTypeFromBuffer(head);
  if (detected) {
    let mime = detected.mime as string;
    // Old Office documents are detected as generic CFB containers.
    if (mime === 'application/x-cfb') {
      const ext = path.extname(originalFilename).toLowerCase();
      if (ext !== '.doc' && ext !== '.xls')
        throw new UnsupportedFileError('This file type is not supported.');
      mime = ext === '.doc' ? 'application/msword' : 'application/vnd.ms-excel';
      return { mimeType: mime, category: 'office', inline: false };
    }
    if (mime === 'application/zip') {
      throw new UnsupportedFileError(
        'ZIP archives are not accepted. Please upload the individual files.',
      );
    }
    const allowed = BINARY_TYPES[mime];
    if (!allowed) throw new UnsupportedFileError(`Files of type ${mime} are not accepted.`);
    return { mimeType: mime, ...allowed };
  }
  const ext = path.extname(originalFilename).toLowerCase();
  const textMime = TEXT_EXTENSIONS[ext];
  if (textMime && looksLikeText(head))
    return { mimeType: textMime, category: 'text', inline: textMime === 'text/plain' };
  throw new UnsupportedFileError(
    'This file type is not accepted. Supported: photos (JPEG, PNG, HEIC, WebP), PDF, plain text, email (.eml), audio and office documents.',
  );
}

export function isInlineSafe(mimeType: string): boolean {
  if (mimeType === 'text/plain') return true;
  return BINARY_TYPES[mimeType]?.inline ?? false;
}

export function categoryOf(mimeType: string): FileCategory | null {
  if (BINARY_TYPES[mimeType]) return BINARY_TYPES[mimeType]!.category;
  if (Object.values(TEXT_EXTENSIONS).includes(mimeType)) return 'text';
  if (mimeType === 'application/vnd.ms-excel') return 'office';
  return null;
}

/**
 * Make an uploaded filename safe to store and to place in headers or archive
 * paths: no directory components, control characters or reserved names.
 */
export function sanitiseFilename(name: string): string {
  let base = name.split(/[\\/]/).pop() ?? '';
  // Strip control characters and characters that are unsafe in filenames on common platforms.
  // eslint-disable-next-line no-control-regex
  const unsafe = /[\u0000-\u001f\u007f<>:"|?*]/g;
  base = base.normalize('NFC').replace(unsafe, '').trim();
  base = base.replace(/^\.+/, '');
  if (!base) base = 'upload';
  if (base.length > 200) {
    const ext = path.extname(base).slice(0, 20);
    base = base.slice(0, 200 - ext.length) + ext;
  }
  return base;
}
