import { formatOccurrence } from '../../shared/dates';

export function formatWhen(iso: string, precision: 'date' | 'datetime', tz: string): string {
  return formatOccurrence(iso, precision, tz);
}

export function formatDate(iso: string | null | undefined, tz?: string): string {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', ...(tz && iso.length > 10 ? { timeZone: tz } : { timeZone: 'UTC' }) }).format(d);
}

export function formatDateTime(iso: string | null | undefined, tz?: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));
}

export function monthHeading(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: tz }).format(new Date(iso));
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function money(amount: string | null, currency: string | null): string | null {
  if (!amount) return null;
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency ?? 'GBP' }).format(Number(amount));
  } catch {
    return `${amount} ${currency ?? ''}`.trim();
  }
}

export const RISK_LABEL: Record<string, string> = { none: 'No risk noted', low: 'Low risk', medium: 'Medium risk', high: 'High risk' };
export const STATUS_LABEL: Record<string, string> = { open: 'Open', monitoring: 'Monitoring', resolved: 'Resolved', closed: 'Closed' };
export const DIRECTION_LABEL: Record<string, string> = { inbound: 'Inbound', outbound: 'Outbound', internal: 'Observation / internal' };

/** Split highlighted search snippets (⟦…⟧) into safe React text segments. */
export function highlightSegments(snippet: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  const re = /⟦([\s\S]*?)⟧/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) {
    if (m.index > last) out.push({ text: snippet.slice(last, m.index), mark: false });
    out.push({ text: m[1]!, mark: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), mark: false });
  return out;
}

export function todayLocal(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
