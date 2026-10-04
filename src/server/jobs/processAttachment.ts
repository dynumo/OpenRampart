import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { actors, attachments } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import {
  convertHeif,
  hasUsefulText,
  ocrImage,
  ocrPdf,
  pdfEmbeddedText,
  pdfPageCount,
  renderPdfFirstPage,
  toolVersion,
} from '../ocr/engine.js';
import { buildSuggestions } from '../ocr/suggestions.js';
import { categoryOf } from '../storage/fileTypes.js';
import { derivedKey, getObjectStream, putBuffer } from '../storage/s3.js';

/**
 * Asynchronous processing of a stored original:
 *   1. re-hash the stored object (integrity check)
 *   2. derive a thumbnail and preview (never replacing the original)
 *   3. extract text (OCR) and rule-based suggestions
 *
 * Each step records its own status. A failure in one step is recorded and does
 * not undo the others, and never affects the Event or the original file.
 */

export async function processAttachment(attachmentId: string): Promise<void> {
  const [att] = await db().select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1);
  if (!att || att.deletedAt) return;
  const category = categoryOf(att.mimeType);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'openrampart-proc-'));
  try {
    const originalPath = path.join(workDir, 'original');
    const hash = createHash('sha256');
    const { body } = await getObjectStream(att.storageKey);
    body.on('data', (chunk: Buffer) => hash.update(chunk));
    await pipeline(body, createWriteStream(originalPath));
    const integrityOk = hash.digest('hex') === att.sha256;
    await db()
      .update(attachments)
      .set({ integrityCheckedAt: new Date(), integrityOk })
      .where(eq(attachments.id, att.id));
    if (!integrityOk) {
      logger.error({ attachmentId }, 'stored original does not match recorded SHA-256; processing stopped');
      await db()
        .update(attachments)
        .set({
          derivativeStatus: att.derivativeStatus === 'not_applicable' ? 'not_applicable' : 'failed',
          derivativeError: 'The stored file does not match its recorded hash.',
          ocrStatus: att.ocrStatus === 'pending' ? 'failed' : att.ocrStatus,
          ocrError: att.ocrStatus === 'pending' ? 'The stored file does not match its recorded hash.' : att.ocrError,
        })
        .where(eq(attachments.id, att.id));
      return;
    }

    // An image the other steps can read: converted HEIC, or rendered first PDF page.
    let rasterPath: string | null = null;
    let pageCount: number | null = null;
    try {
      if (category === 'image') rasterPath = originalPath;
      if (category === 'heif') rasterPath = await heifToJpeg(originalPath, workDir);
      if (category === 'pdf') {
        pageCount = await pdfPageCount(originalPath);
        rasterPath = await renderPdfFirstPage(originalPath, path.join(workDir, 'page1'));
      }
    } catch (err) {
      logger.warn({ attachmentId, err: (err as Error).message.slice(0, 200) }, 'could not rasterise attachment');
    }

    if (att.derivativeStatus === 'pending') {
      await db().update(attachments).set({ derivativeStatus: 'processing' }).where(eq(attachments.id, att.id));
      try {
        if (!rasterPath) throw new Error('No renderable image');
        const base = sharp(rasterPath, { failOn: 'none', limitInputPixels: 268_402_689 }).rotate();
        const meta = await base.metadata();
        const thumb = await base.clone().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
        const preview = await base.clone().resize({ width: 1800, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        const thumbKey = derivedKey(att.ownerId, att.id, 'thumbnail.webp');
        const previewKey = derivedKey(att.ownerId, att.id, 'preview.webp');
        await putBuffer(thumbKey, thumb, 'image/webp');
        await putBuffer(previewKey, preview, 'image/webp');
        const rotated = (meta.orientation ?? 1) >= 5;
        await db()
          .update(attachments)
          .set({
            thumbnailKey: thumbKey,
            previewKey: previewKey,
            width: (rotated ? meta.height : meta.width) ?? null,
            height: (rotated ? meta.width : meta.height) ?? null,
            pageCount,
            derivativeStatus: 'done',
            derivativeError: null,
          })
          .where(eq(attachments.id, att.id));
      } catch (err) {
        logger.warn({ attachmentId, err: (err as Error).message.slice(0, 200) }, 'preview generation failed');
        await db()
          .update(attachments)
          .set({ derivativeStatus: 'failed', derivativeError: 'A preview could not be generated for this file.', pageCount })
          .where(eq(attachments.id, att.id));
      }
    }

    if (att.ocrStatus === 'pending') {
      await db().update(attachments).set({ ocrStatus: 'processing' }).where(eq(attachments.id, att.id));
      const c = config();
      const opts = { languages: c.OCR_LANGUAGES, timeoutSeconds: c.OCR_TIMEOUT_SECONDS, maxPdfPages: c.OCR_MAX_PDF_PAGES };
      try {
        let text = '';
        let engine = '';
        if (category === 'text') {
          text = (await readFile(originalPath)).toString('utf8').slice(0, 2_000_000);
          engine = 'plain text';
        } else if (category === 'pdf') {
          const embedded = await pdfEmbeddedText(originalPath, opts.maxPdfPages);
          if (hasUsefulText(embedded, pageCount ?? 1)) {
            text = embedded;
            engine = `pdftotext ${(await toolVersion('pdftotext')) ?? ''}`.trim();
          } else {
            const result = await ocrPdf(originalPath, workDir, opts, pageCount);
            text = result.text;
            engine = result.engine;
          }
        } else if (rasterPath) {
          // Normalise orientation from EXIF before recognition.
          const normalised = path.join(workDir, 'ocr.png');
          await sharp(rasterPath, { failOn: 'none' }).rotate().greyscale().png().toFile(normalised);
          const result = await ocrImage(normalised, opts);
          text = result.text;
          engine = result.engine;
        } else {
          throw new Error('Unsupported for OCR');
        }
        text = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
        const known = await db()
          .select({ id: actors.id, name: actors.name, aliases: actors.aliases })
          .from(actors)
          .where(and(eq(actors.ownerId, att.ownerId), isNull(actors.deletedAt), isNull(actors.mergedIntoId)));
        await db()
          .update(attachments)
          .set({
            ocrText: text,
            ocrStatus: 'done',
            ocrEngine: engine,
            ocrProcessedAt: new Date(),
            ocrError: null,
            suggestions: text ? buildSuggestions(text, known) : null,
          })
          .where(eq(attachments.id, att.id));
      } catch (err) {
        logger.warn({ attachmentId, err: (err as Error).message.slice(0, 200) }, 'text recognition failed');
        await db()
          .update(attachments)
          .set({
            ocrStatus: 'failed',
            ocrProcessedAt: new Date(),
            ocrError: 'Text could not be recognised in this file. The original is unaffected.',
          })
          .where(eq(attachments.id, att.id));
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function heifToJpeg(input: string, workDir: string): Promise<string> {
  const out = path.join(workDir, 'converted.jpg');
  await convertHeif(input, out);
  try {
    await access(out);
    return out;
  } catch {
    // Multi-image HEIF files are written as converted-1.jpg, converted-2.jpg …
    const files = (await readdir(workDir)).filter((f) => /^converted-\d+\.jpg$/.test(f)).sort();
    if (!files.length) throw new Error('HEIF conversion produced no image');
    return path.join(workDir, files[0]!);
  }
}

/** Requeue attachments stuck in "processing" after a crash. */
export async function resetStuckProcessing(): Promise<number> {
  const result = await db().execute(sql`
    UPDATE attachments SET
      ocr_status = CASE WHEN ocr_status = 'processing' THEN 'pending' ELSE ocr_status END,
      derivative_status = CASE WHEN derivative_status = 'processing' THEN 'pending' ELSE derivative_status END
    WHERE (ocr_status = 'processing' OR derivative_status = 'processing') AND uploaded_at < now() - interval '2 hours'
    RETURNING id`);
  return result.rowCount ?? 0;
}
