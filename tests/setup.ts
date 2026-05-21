// Minimal env shim so importing modules that pull `loadConfig()` at
// module-load time (via the logger) doesn't blow up during unit tests.
process.env.ORCHESTRATOR_API_TOKEN ??= 'test-token-1234567890abcdef';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.FLY_API_TOKEN ??= 'test-fly-token-1234567890abcdef';
process.env.FLY_ORG_SLUG ??= 'test-org';
process.env.FLY_MACHINE_IMAGE ??= 'registry.fly.io/hermes-user-image:test';
process.env.MASTER_ENCRYPTION_KEY ??= 'A'.repeat(48);
process.env.ADMIN_PASSWORD ??= 'test-password';
process.env.ORCHESTRATOR_PUBLIC_URL ??= 'https://orch.test';
process.env.OPENROUTER_API_KEY ??= 'test-or-key';
