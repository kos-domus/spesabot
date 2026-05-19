/**
 * Application-level encryption for PII fields stored in user_profiles.
 *
 * Uses AES-256-GCM with a per-field random IV. The encrypted value is stored
 * as "iv:ciphertext:tag" (hex-encoded) so it can live in a TEXT column.
 *
 * The encryption key is read from SPESABOT_PII_KEY env var (64 hex chars = 32 bytes).
 * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // recommended for GCM

function getKey(): Buffer {
  const hex = process.env.SPESABOT_PII_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'SPESABOT_PII_KEY must be set to a 64-char hex string (32 bytes). ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(hex, 'hex');
}

/** PII fields that get encrypted/decrypted transparently.
 *
 * `email` is deliberately NOT in this list: the API enforces uniqueness via
 * a partial unique index on `email`, and AES-GCM is non-deterministic (each
 * encryption yields a different ciphertext), which breaks that index. We keep
 * email as plaintext-lowercased for lookup. Every other user-identifying
 * field is encrypted.
 */
export const PII_FIELDS = [
  'nome', 'cognome', 'telefono', 'indirizzo',
  'numero_civico', 'citta', 'cap', 'codice_fiscale',
] as const;

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

export function decrypt(stored: string): string {
  const key = getKey();
  const [ivHex, ciphertextHex, tagHex] = stored.split(':');
  if (!ivHex || !ciphertextHex || !tagHex) {
    // Not encrypted (legacy plaintext) — return as-is
    return stored;
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    // Decryption failed — likely legacy plaintext, return as-is
    return stored;
  }
}

/** Encrypt a single sensitive value (e.g. loyalty card number). */
export function encryptValue(plaintext: string): string {
  return encrypt(plaintext);
}

/** Decrypt a single sensitive value. */
export function decryptValue(stored: string): string {
  return decrypt(stored);
}

/** Check if PII encryption is properly configured. */
export function isPiiKeyConfigured(): boolean {
  const hex = process.env.SPESABOT_PII_KEY;
  return !!hex && hex.length === 64;
}

/** Encrypt PII fields in a record before DB insert/update. */
export function encryptProfile(fields: Record<string, string | null>): Record<string, string | null> {
  if (!process.env.SPESABOT_PII_KEY) throw new Error('SPESABOT_PII_KEY not configured — cannot store PII');
  const result = { ...fields };
  for (const f of PII_FIELDS) {
    if (result[f]) result[f] = encrypt(result[f]!);
  }
  return result;
}

/** Decrypt PII fields in a record after DB read. */
export function decryptProfile(row: Record<string, unknown>): Record<string, unknown> {
  if (!process.env.SPESABOT_PII_KEY) return row; // return raw if key not configured (read-only is safe)
  const result = { ...row };
  for (const f of PII_FIELDS) {
    if (typeof result[f] === 'string' && result[f]) {
      result[f] = decrypt(result[f] as string);
    }
  }
  return result;
}
