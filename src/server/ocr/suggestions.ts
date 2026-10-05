import type { DocumentSuggestionsDTO } from '../../shared/types.js';

/**
 * Deterministic, rule-based extraction of hints from OCR text: dates,
 * amounts, reference numbers, likely Actors and a possible title. No language
 * model is involved. Results are suggestions for the user to accept or ignore;
 * they never modify a record by themselves.
 */

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function validDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function extractDates(text: string): { value: string; text: string }[] {
  const found: { value: string; text: string; index: number; labelled: boolean }[] = [];
  const add = (value: string | null, raw: string, index: number) => {
    if (!value) return;
    const before = text.slice(Math.max(0, index - 20), index).toLowerCase();
    found.push({
      value,
      text: raw.trim(),
      index,
      labelled: /date[d:]?\s*$|dated\s*$/.test(before),
    });
  };
  const monthNames = Object.keys(MONTHS).join('|');
  // 12 September 2026, 12th Sept 2026, 12 Sep. 2026
  const re1 = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\.?,?\\s+(\\d{4})\\b`,
    'gi',
  );
  for (const m of text.matchAll(re1))
    add(validDate(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!), m[0], m.index!);
  // September 12, 2026
  const re2 = new RegExp(
    `\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
    'gi',
  );
  for (const m of text.matchAll(re2))
    add(validDate(+m[3]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!), m[0], m.index!);
  // 12/09/2026 or 12.09.2026 or 12-09-2026 (UK day-first)
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g))
    add(validDate(+m[3]!, +m[2]!, +m[1]!), m[0], m.index!);
  // 2026-09-12
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g))
    add(validDate(+m[1]!, +m[2]!, +m[3]!), m[0], m.index!);
  found.sort((a, b) => Number(b.labelled) - Number(a.labelled) || a.index - b.index);
  const seen = new Set<string>();
  return found
    .filter((f) => (seen.has(f.value) ? false : (seen.add(f.value), true)))
    .slice(0, 6)
    .map(({ value, text: t }) => ({ value, text: t }));
}

export function extractAmounts(text: string): { value: string; currency: string; text: string }[] {
  const out: { value: string; currency: string; text: string }[] = [];
  const symbols: Record<string, string> = { '£': 'GBP', '€': 'EUR', $: 'USD' };
  for (const m of text.matchAll(
    /([£€$])\s?(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)\b/g,
  )) {
    out.push({ value: m[2]!.replace(/,/g, ''), currency: symbols[m[1]!]!, text: m[0] });
  }
  for (const m of text.matchAll(/\b(GBP|EUR|USD)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/g)) {
    out.push({ value: m[2]!.replace(/,/g, ''), currency: m[1]!, text: m[0] });
  }
  const seen = new Set<string>();
  return out
    .filter((a) =>
      seen.has(a.currency + a.value) ? false : (seen.add(a.currency + a.value), true),
    )
    .slice(0, 8);
}

const REFERENCE_LABELS = [
  'our reference',
  'your reference',
  'our ref',
  'your ref',
  'reference number',
  'reference',
  'ref no',
  'ref',
  'account number',
  'account no',
  'customer number',
  'customer reference',
  'case number',
  'case reference',
  'claim number',
  'claim reference',
  'policy number',
  'invoice number',
  'tax reference',
  'utr',
  'national insurance number',
  'ni number',
  'company number',
  'membership number',
  'tenancy reference',
];

export function extractReferences(text: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const labels = REFERENCE_LABELS.map((l) => l.replace(/ /g, '\\s+')).join('|');
  const re = new RegExp(
    `\\b(${labels})\\b\\s*(?:no\\.?|number)?\\s*[:#.]?\\s*([A-Z0-9][A-Z0-9/\\- ]{3,30}[A-Z0-9])`,
    'gi',
  );
  for (const m of text.matchAll(re)) {
    const value = m[2]!
      .trim()
      .replace(/\s{2,}.*$/, '')
      .replace(/\s+(?:date|dated|tel|telephone|phone)\b.*$/i, '');
    if (!/\d/.test(value) || value.length < 4) continue;
    out.push({ label: m[1]!.replace(/\s+/g, ' ').trim(), value });
  }
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.value) ? false : (seen.add(r.value), true))).slice(0, 6);
}

const ORG_HINT =
  /\b(ltd|limited|plc|llp|council|bank|building society|hm revenue|hmrc|department|ministry|agency|service|services|trust|nhs|tribunal|court|insurance|energy|water|housing|association|university|college|police|ombudsman|commission|authority|office|solicitors|collections?)\b/i;

export function extractTitle(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3);
  for (const l of lines.slice(0, 60)) {
    const m = /^(?:re|subject|regarding)\s*[:-]\s*(.{4,140})$/i.exec(l);
    if (m) return m[1]!.trim();
  }
  for (const l of lines.slice(0, 40)) {
    if (
      /^(notice of|important|final notice|reminder|statement|decision|your [a-z]+ (?:claim|account|application))/i.test(
        l,
      ) &&
      l.length <= 120
    )
      return l;
  }
  return null;
}

export interface KnownActor {
  id: string;
  name: string;
  aliases: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractActors(
  text: string,
  known: KnownActor[],
): { actorId: string | null; name: string; reason: string }[] {
  const out: { actorId: string | null; name: string; reason: string }[] = [];
  const head = text.slice(0, 20_000);
  for (const a of known) {
    for (const candidate of [a.name, ...a.aliases]) {
      if (candidate.length < 3) continue;
      const re = new RegExp(
        `(^|[^\\p{L}\\p{N}])${escapeRegex(candidate)}($|[^\\p{L}\\p{N}])`,
        'iu',
      );
      if (re.test(head)) {
        out.push({
          actorId: a.id,
          name: a.name,
          reason:
            candidate === a.name
              ? 'Name appears in the document'
              : `"${candidate}" appears in the document`,
        });
        break;
      }
    }
    if (out.length >= 5) break;
  }
  if (out.length < 3) {
    const lines = head
      .split(/\r?\n/)
      .map((l) => l.trim())
      .slice(0, 25);
    for (const l of lines) {
      if (
        l.length >= 4 &&
        l.length <= 80 &&
        ORG_HINT.test(l) &&
        !/\d{3,}/.test(l) &&
        !out.some((o) => o.name.toLowerCase() === l.toLowerCase())
      ) {
        out.push({
          actorId: null,
          name: l.replace(/[,.;:]+$/, ''),
          reason: 'Looks like an organisation name near the top of the document',
        });
        if (out.length >= 5) break;
      }
    }
  }
  return out;
}

export function buildSuggestions(text: string, known: KnownActor[]): DocumentSuggestionsDTO {
  return {
    dates: extractDates(text),
    amounts: extractAmounts(text),
    references: extractReferences(text),
    actors: extractActors(text, known),
    title: extractTitle(text),
  };
}
