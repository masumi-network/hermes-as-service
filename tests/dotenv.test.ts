import { describe, expect, it } from 'vitest';
import { buildHermesDotenv, mergeDotenv } from '../src/provision/dotenv.js';

describe('buildHermesDotenv', () => {
  const base = {
    apiServerKey: 'sk-test-1234',
    llmProxyToken: 'sprite-bearer-abc',
    orchestratorPublicUrl: 'https://orch.example.com',
    instanceId: 'inst-uuid-1',
  };

  it('emits required Hermes API server variables', () => {
    const dotenv = buildHermesDotenv(base);
    expect(dotenv).toContain('API_SERVER_ENABLED=true');
    expect(dotenv).toContain('API_SERVER_HOST=0.0.0.0');
    expect(dotenv).toContain('API_SERVER_PORT=8642');
    expect(dotenv).toContain('API_SERVER_KEY=sk-test-1234');
    expect(dotenv).toContain('HERMES_HOME=/opt/data');
    expect(dotenv).toContain('TERMINAL_ENV=local');
  });

  it('routes OpenRouter through the orchestrator proxy, not direct', () => {
    const dotenv = buildHermesDotenv(base);
    expect(dotenv).toContain('OPENROUTER_API_KEY=sprite-bearer-abc');
    expect(dotenv).toContain('OPENROUTER_BASE_URL=https://orch.example.com/v1/llm/inst-uuid-1');
    expect(dotenv).not.toContain('sk-or-v1-'); // no real OpenRouter key should appear
  });

  it('injects Exa key when present, omits when not', () => {
    const withExa = buildHermesDotenv({ ...base, exaApiKey: 'exa-real-key' });
    expect(withExa).toContain('EXA_API_KEY=exa-real-key');
    const without = buildHermesDotenv(base);
    expect(without).not.toContain('EXA_API_KEY=');
  });

  it('quotes values that contain whitespace', () => {
    const dotenv = buildHermesDotenv({ ...base, apiServerKey: 'has space' });
    expect(dotenv).toContain('API_SERVER_KEY="has space"');
  });
});

describe('mergeDotenv', () => {
  it('replaces existing keys in place', () => {
    const before = 'FOO=old\nBAR=keep\n';
    const after = mergeDotenv(before, { FOO: 'new' });
    expect(after).toContain('FOO=new');
    expect(after).toContain('BAR=keep');
  });

  it('appends new keys at end', () => {
    const before = 'FOO=v\n';
    const after = mergeDotenv(before, { NEW_KEY: 'val' });
    expect(after).toMatch(/FOO=v\nNEW_KEY=val\n$/);
  });

  it('preserves blank lines and comments', () => {
    const before = '# comment\n\nFOO=v\n';
    const after = mergeDotenv(before, { BAR: 'b' });
    expect(after).toContain('# comment');
    expect(after).toContain('FOO=v');
    expect(after).toContain('BAR=b');
  });
});
