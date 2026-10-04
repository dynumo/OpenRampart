/**
 * Timezone-aware date helpers shared by the server and the browser.
 *
 * Events store `occurred_at` as an instant (timestamptz). Date-only Events are
 * stored at local midnight in the record owner's time zone, with
 * occurred_precision = 'date', so they sort and filter correctly and are always
 * displayed as the date the user entered.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function partsInZone(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` to a UTC instant. */
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let offset = zoneOffsetMs(new Date(guess), timeZone);
  let result = guess - offset;
  // Second pass corrects for DST transitions between guess and result.
  const offset2 = zoneOffsetMs(new Date(result), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    result = guess - offset;
  }
  return new Date(result);
}

export function isValidDateString(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export interface ParsedOccurrence {
  instant: Date;
  precision: 'date' | 'datetime';
}

/**
 * Parse user input for "when did this happen":
 *  - "2026-09-12"            → date precision, local midnight in timeZone
 *  - "2026-09-12T14:30"      → wall-clock time in timeZone
 *  - "2026-09-12T13:30:00Z" / with offset → that exact instant
 */
export function parseOccurrence(input: string, timeZone: string): ParsedOccurrence | null {
  const s = input.trim();
  if (DATE_RE.test(s)) {
    if (!isValidDateString(s)) return null;
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return { instant: zonedToUtc(y, m, d, 0, 0, 0, timeZone), precision: 'date' };
  }
  const naive = NAIVE_DT_RE.exec(s);
  if (naive) {
    const [y, m, d, hh, mm, ss] = naive.slice(1).map((v) => Number(v ?? 0)) as number[];
    if (!isValidDateString(s.slice(0, 10)) || hh! > 23 || mm! > 59 || ss! > 59) return null;
    return { instant: zonedToUtc(y!, m!, d!, hh!, mm!, ss!, timeZone), precision: 'datetime' };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return { instant: d, precision: 'datetime' };
  }
  return null;
}

/** YYYY-MM-DD of an instant in a time zone. */
export function localDateString(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** YYYY-MM-DDTHH:mm of an instant in a time zone (for datetime-local inputs). */
export function localDateTimeString(instant: Date, timeZone: string): string {
  const p = partsInZone(instant, timeZone);
  return `${localDateString(instant, timeZone)}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Start of a local date in a time zone, as an instant. */
export function startOfLocalDate(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return zonedToUtc(y, m, d, 0, 0, 0, timeZone);
}

/** Human date for display, e.g. "12 September 2026" or "12 September 2026, 14:30". */
export function formatOccurrence(
  iso: string | Date,
  precision: 'date' | 'datetime',
  timeZone: string,
  locale = 'en-GB',
): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const opts: Intl.DateTimeFormatOptions =
    precision === 'date'
      ? { timeZone, day: 'numeric', month: 'long', year: 'numeric' }
      : { timeZone, day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}
