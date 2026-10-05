# Attachments, storage and OCR

Attachments are the evidence behind Events: photographed letters, PDFs, screenshots, emails
and voicemails. OpenRampart keeps the **original exactly as uploaded**. Everything else
(previews, recognised text, suggestions) is derived from it, stored separately and never
replaces it.

## Accepted files

The type is detected from the file's content, not its name:

| Category  | Types                                  | Shown in the browser | Text extracted with                                             |
| --------- | -------------------------------------- | -------------------- | --------------------------------------------------------------- |
| Images    | JPEG, PNG, WebP, GIF, AVIF, TIFF       | Yes (TIFF: download) | Tesseract                                                       |
| HEIC/HEIF | iPhone photos                          | Preview only         | libheif → Tesseract                                             |
| PDF       | Any                                    | Yes                  | `pdftotext` if it contains text, otherwise OCRmyPDF + Tesseract |
| Text      | `.txt`, `.md`, `.csv`, `.log`, `.eml`  | Plain text only      | Read directly                                                   |
| Audio     | MP3, M4A/AAC, WAV, Ogg/Opus, WebM, AMR | Yes (AMR: download)  | — (add notes yourself)                                          |
| Office    | Word, Excel, OpenDocument              | Download             | —                                                               |

Anything else is refused with a clear message. Maximum size: `MAX_UPLOAD_MB` (50 MB by
default).

## Lifecycle

```
upload ─► temp file ─► SHA-256 + size + type check ─► object storage ─► database row ─► Event revision
                                                                                 │
                                       background worker ◄───────────────────────┘
                                       1. re-hash stored object (integrity)
                                       2. thumbnail + preview (WebP)
                                       3. text: pdftotext / OCRmyPDF / Tesseract
                                       4. rule-based suggestions
                                       5. queue for timestamping (if enabled)
```

1. **Receive.** The browser streams the file. The server writes it to a private temporary
   file, computing SHA-256 and enforcing the size limit as it goes. Nothing is buffered in
   memory.
2. **Check.** The type is detected from magic bytes and checked against the allow-list. The
   filename is sanitised.
3. **Store.** The file is uploaded to `originals/<owner>/<attachment id>`. Only then is the
   database row created, with filename, type, size, SHA-256, uploader and page position. A new
   Event revision records the addition.
4. **Process (asynchronously).** Each step records its own status. The Event is usable
   immediately; text and previews appear when ready.
   - **Integrity:** the stored object is read back and hashed. A mismatch is flagged
     prominently.
   - **Previews:** HEIC is converted, and the first page of a PDF is rendered. A thumbnail and a
     page-sized preview are made, EXIF-rotated, as WebP.
   - **Text:**
     - text PDFs use their embedded text (`pdftotext`, exact, no OCR);
     - scanned PDFs use OCRmyPDF (`--force-ocr`, text sidecar only; the PDF itself is not
       changed);
     - images use Tesseract.

     Languages are set by `OCR_LANGUAGES`. Long PDFs are limited to `OCR_MAX_PDF_PAGES`.

   - **Suggestions:** simple, deterministic rules find likely dates, amounts, reference
     numbers, a subject line and known Actors in the text. **No AI is involved, and nothing is
     applied automatically.** Suggestions appear beside the Event for you to accept or ignore.
     For a Helper, Actor suggestions only include Actors that Helper can see.
5. **Timestamp.** When enabled, the SHA-256 is queued for OpenTimestamps (see
   [timestamping.md](timestamping.md)).

Failures are retried a few times. A permanent failure shows a calm message ("The text could not be
read") with **Try again**. It never affects the Event or the original.

## Phone letter capture

**Capture a letter** is designed for one-handed use on a phone:

1. Take a photo of each page. The phone's camera opens directly (`capture="environment"`).
2. Reorder or remove pages.
3. Check the date, who it is from, and an optional title. Everything else can wait.
4. Save.

The Event is saved first. Pages then upload one by one with progress shown. If some fail (for
example, the signal drops), the Event is kept and only the failed pages are retried. Each page
is its own attachment, in order, with its own hash and text.

## Viewing

The attachment page shows:

- the document: an image, a PDF in the browser's viewer, or a player for audio;
- the recognised text, labelled with the engine and version, which you can correct;
- the file's details: name, type, size, SHA-256, uploader, upload time, integrity status and
  timestamp status;
- **Verify now**, **Download original**, and the `.ots` proof when available.

Originals are served with `Content-Security-Policy: sandbox` and `nosniff`, so a file can never
run code in OpenRampart. Downloading an original is recorded in the Audit Log.

## Correcting recognised text

OCR makes mistakes. **Correct the text** saves your version alongside the machine's. Both are kept,
and **Revert to automatic text** goes back. Search and exports use your corrected text when there is one. Only the
owner, or the person who uploaded the file, can correct it, and each correction is audited.

## Deleting

Deleting an attachment (owner only) moves it to the **Trash**. It disappears from the Event,
search and exports, and the Event gains a revision noting the removal. It can be restored for
`DELETION_RETENTION_DAYS` (30 by default). After that, the maintenance job permanently removes
the database row, the original and all derived files from storage. A purge is recorded in the
Audit Log.

Deleting an Event takes its attachments into the Trash with it. They are restored or purged
together.

## Limits and known gaps

- **HEIC conversion** uses `heif-convert` from libheif, which is in the container image. Whether
  a particular HEIC variant converts depends on the libheif build. If conversion fails, the
  original is still stored and downloadable, and the failure is shown.
- Office documents and audio are stored and downloadable, but their text is not extracted.
- Handwriting recognition is limited to what Tesseract supports. Typed letters work best.
