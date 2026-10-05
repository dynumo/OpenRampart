import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import busboy from 'busboy';
import type { Request } from 'express';
import { config } from '../config.js';
import type { UploadedFile } from '../domain/attachments.js';
import { UPLOAD_TMP_DIR } from '../jobs/maintenance.js';
import { ValidationError } from '../lib/errors.js';

/**
 * Stream a single multipart file to a private temporary file, computing its
 * SHA-256 and enforcing the size limit as bytes arrive. The browser-declared
 * content type is ignored; the type is later verified from the bytes.
 */
export async function receiveUpload(
  req: Request,
): Promise<UploadedFile & { fields: Record<string, string> }> {
  const limit = config().maxUploadBytes;
  if (!req.is('multipart/form-data')) throw new ValidationError('Expected a file upload');
  await mkdir(UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(UPLOAD_TMP_DIR, randomUUID());
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      void rm(tmpPath, { force: true });
      reject(err);
    };
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: limit, fields: 20, fieldSize: 10_000 },
      });
    } catch {
      return fail(new ValidationError('Malformed upload'));
    }
    const fields: Record<string, string> = {};
    let fileInfo: { filename: string; size: number; sha256: string } | null = null;
    let fileDone: Promise<void> | null = null;
    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (_name, stream, info) => {
      const hash = createHash('sha256');
      let size = 0;
      const out = createWriteStream(tmpPath, { mode: 0o600 });
      fileDone = new Promise((res, rej) => {
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          hash.update(chunk);
        });
        stream.on('limit', () =>
          rej(new ValidationError(`Files must be no larger than ${config().MAX_UPLOAD_MB} MB`)),
        );
        out.on('finish', () => {
          fileInfo = { filename: info.filename || 'upload', size, sha256: hash.digest('hex') };
          res();
        });
        out.on('error', rej);
        stream.on('error', rej);
      });
      stream.pipe(out);
    });
    bb.on('error', (err) => fail(err as Error));
    bb.on('close', () => {
      if (!fileDone) return fail(new ValidationError('No file was received'));
      fileDone
        .then(() => {
          if (settled) return;
          settled = true;
          const f = fileInfo!;
          if (f.size === 0) {
            void rm(tmpPath, { force: true });
            return reject(new ValidationError('The file is empty'));
          }
          resolve({
            tmpPath,
            originalFilename: f.filename,
            sizeBytes: f.size,
            sha256: f.sha256,
            fields,
          });
        })
        .catch((err: Error) => fail(err));
    });
    req.on('aborted', () => fail(new ValidationError('Upload interrupted')));
    req.pipe(bb);
  });
}
