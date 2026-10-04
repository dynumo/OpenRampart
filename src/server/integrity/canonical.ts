import canonicalizeImport from 'canonicalize';
import { sha256Hex } from '../lib/crypto.js';

/**
 * Deterministic serialisation using the JSON Canonicalization Scheme
 * (RFC 8785): sorted keys, no insignificant whitespace, ECMAScript number
 * formatting. The same logical value always yields the same bytes and
 * therefore the same SHA-256 hash, so anyone can re-verify an exported
 * revision with standard tools.
 */
const canonicalizeFn = canonicalizeImport as unknown as (value: unknown) => string | undefined;

export function canonicalJson(value: unknown): string {
  const out = canonicalizeFn(value);
  if (out === undefined) throw new Error('Value cannot be canonicalised');
  return out;
}

export function canonicalHash(value: unknown): { canonical: string; sha256: string } {
  const canonical = canonicalJson(value);
  return { canonical, sha256: sha256Hex(Buffer.from(canonical, 'utf8')) };
}
