import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Local, self-hosted text recognition:
 *  - images:          Tesseract
 *  - PDFs with text:  pdftotext (Poppler) — exact embedded text, no OCR needed
 *  - scanned PDFs:    OCRmyPDF (which drives Tesseract page by page, handling
 *                     rotation and deskewing) producing a plain-text sidecar
 *
 * Commands are executed directly (no shell) with fixed arguments and internal
 * temporary paths, under a timeout. Recognised text is returned to the caller
 * and is never logged.
 */

export interface OcrOptions {
  languages: string;
  timeoutSeconds: number;
  maxPdfPages: number;
}

export interface OcrResult {
  text: string;
  engine: string;
}

const MAX_TEXT = 2_000_000;
const BUFFER = 64 * 1024 * 1024;

async function cmd(file: string, args: string[], timeoutSeconds: number, cwd?: string) {
  const { stdout } = await run(file, args, {
    timeout: timeoutSeconds * 1000,
    maxBuffer: BUFFER,
    cwd,
    env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    killSignal: 'SIGKILL',
  });
  return stdout.toString();
}

const versionCache = new Map<string, string | null>();

export async function toolVersion(tool: 'tesseract' | 'ocrmypdf' | 'pdftotext' | 'pdftoppm' | 'heif-convert'): Promise<string | null> {
  if (versionCache.has(tool)) return versionCache.get(tool)!;
  let version: string | null = null;
  try {
    if (tool === 'tesseract') {
      const { stdout, stderr } = await run('tesseract', ['--version'], { timeout: 10_000 });
      version = /tesseract\s+v?([\d.]+)/i.exec(String(stdout) + String(stderr))?.[1] ?? 'unknown';
    } else if (tool === 'ocrmypdf') {
      const { stdout } = await run('ocrmypdf', ['--version'], { timeout: 20_000 });
      version = String(stdout).trim().split(/\s/)[0] ?? 'unknown';
    } else if (tool === 'heif-convert') {
      const out = await run('heif-convert', ['--version'], { timeout: 10_000 }).catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
      version = /libheif version:\s*([\d.]+)/.exec(String(out.stdout) + String(out.stderr))?.[1] ?? 'unknown';
    } else {
      const { stdout, stderr } = await run(tool, ['-v'], { timeout: 10_000 });
      version = /version\s+([\d.]+)/.exec(String(stdout) + String(stderr))?.[1] ?? 'unknown';
    }
  } catch {
    version = null;
  }
  versionCache.set(tool, version);
  return version;
}

export async function ocrImage(imagePath: string, opts: OcrOptions): Promise<OcrResult> {
  const text = await cmd('tesseract', [imagePath, 'stdout', '-l', opts.languages, '--psm', '3'], opts.timeoutSeconds);
  return { text: text.slice(0, MAX_TEXT), engine: `tesseract ${(await toolVersion('tesseract')) ?? ''}`.trim() };
}

export async function pdfPageCount(pdfPath: string): Promise<number | null> {
  try {
    const out = await cmd('pdfinfo', [pdfPath], 30);
    const m = /^Pages:\s+(\d+)/m.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export async function pdfEmbeddedText(pdfPath: string, maxPages: number): Promise<string> {
  return (await cmd('pdftotext', ['-layout', '-l', String(maxPages), '-enc', 'UTF-8', pdfPath, '-'], 120)).slice(0, MAX_TEXT);
}

/** Whether embedded text looks like a real text layer rather than a scan. */
export function hasUsefulText(text: string, pages: number): boolean {
  const chars = text.replace(/\s+/g, '').length;
  return chars >= Math.max(40, 25 * Math.max(pages, 1));
}

export async function ocrPdf(pdfPath: string, workDir: string, opts: OcrOptions, pages: number | null): Promise<OcrResult> {
  const sidecar = path.join(workDir, 'sidecar.txt');
  const args = [
    '--force-ocr',
    '--output-type',
    'none',
    '--sidecar',
    sidecar,
    '-l',
    opts.languages,
    '--rotate-pages',
    '--deskew',
    '--jobs',
    '1',
    '--tesseract-timeout',
    String(Math.max(30, Math.floor(opts.timeoutSeconds / 2))),
    '--quiet',
  ];
  if (pages && pages > opts.maxPdfPages) args.push('--pages', `1-${opts.maxPdfPages}`);
  args.push(pdfPath, '-');
  await cmd('ocrmypdf', args, opts.timeoutSeconds, workDir);
  const text = (await readFile(sidecar, 'utf8')).replace(/\f/g, '\n\n').slice(0, MAX_TEXT);
  const v = await toolVersion('ocrmypdf');
  const t = await toolVersion('tesseract');
  return { text, engine: `ocrmypdf ${v ?? ''} + tesseract ${t ?? ''}`.replace(/\s+/g, ' ').trim() };
}

export async function renderPdfFirstPage(pdfPath: string, outPrefix: string): Promise<string> {
  await cmd('pdftoppm', ['-f', '1', '-l', '1', '-r', '110', '-png', '-singlefile', pdfPath, outPrefix], 120);
  return `${outPrefix}.png`;
}

export async function convertHeif(inputPath: string, outputPath: string): Promise<string> {
  await cmd('heif-convert', ['-q', '92', inputPath, outputPath], 120);
  return outputPath;
}
