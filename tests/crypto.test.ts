import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

describe('crypto roundtrip', () => {
  beforeAll(() => {
    process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.ORCHESTRATOR_API_TOKEN ??= 'x'.repeat(32);
    process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test?sslmode=disable';
    process.env.SPRITES_API_TOKEN ??= 'sprt_test_token';
    process.env.OPENROUTER_API_KEY ??= 'sk-or-test-12345678';
  });

  it('encrypt → decrypt yields original', async () => {
    const { encryptSecret, decryptSecret, generateApiServerKey } = await import('../src/crypto.js');
    const original = await generateApiServerKey();
    const encrypted = await encryptSecret(original);
    expect(encrypted).not.toBe(original);
    const decrypted = await decryptSecret(encrypted);
    expect(decrypted).toBe(original);
  });

  it('different plaintexts produce different ciphertexts', async () => {
    const { encryptSecret } = await import('../src/crypto.js');
    const a = await encryptSecret('hello');
    const b = await encryptSecret('hello');
    // Nonces are random so even identical plaintext should not collide.
    expect(a).not.toBe(b);
  });
});
