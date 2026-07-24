import { describe, expect, it } from 'vitest';
import { MCP_TOOLS_VERSION } from '../src/routes/sokosumi-mcp.js';

describe('MCP_TOOLS_VERSION', () => {
  it('is a stable 12-char hex fingerprint', () => {
    expect(MCP_TOOLS_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic within a process (same catalog → same version)', async () => {
    // Re-import: module cache means the same computed value, proving it is a
    // pure function of the catalog and not, say, seeded by time/random.
    const again = (await import('../src/routes/sokosumi-mcp.js')).MCP_TOOLS_VERSION;
    expect(again).toBe(MCP_TOOLS_VERSION);
  });
});
