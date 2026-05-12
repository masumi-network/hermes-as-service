import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function masterKey(): Buffer {
  const raw = loadConfig().MASTER_ENCRYPTION_KEY;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(`MASTER_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes`);
  }
  return buf;
}

/** Encrypts plaintext with the master key. Output: base64(iv || tag || ciphertext). */
export async function encryptSecret(plaintext: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export async function decryptSecret(blobB64: string): Promise<string> {
  const blob = Buffer.from(blobB64, 'base64');
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error('decryptSecret: ciphertext too short');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export async function generateApiServerKey(): Promise<string> {
  return randomBytes(32).toString('base64url');
}
