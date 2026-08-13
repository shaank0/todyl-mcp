import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';

const base = { TODYL_CLIENT_ID: 'cid', TODYL_ACCESS_TOKEN: 'tok' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.baseUrl).toBe('https://api.todyl.com');
    expect(c.cacheTtlSeconds).toBe(300);
    expect(c.maxPages).toBe(20);
    expect(c.port).toBe(8080);
  });

  it('reads overrides', () => {
    const c = loadConfig({
      ...base,
      TODYL_API_BASE: 'http://localhost:9999',
      TODYL_CACHE_TTL_SECONDS: '60',
      TODYL_MAX_PAGES: '3',
      PORT: '9000',
    } as NodeJS.ProcessEnv);
    expect(c.baseUrl).toBe('http://localhost:9999');
    expect(c.cacheTtlSeconds).toBe(60);
    expect(c.maxPages).toBe(3);
    expect(c.port).toBe(9000);
  });

  it('strips a trailing slash from the base URL', () => {
    const c = loadConfig({ ...base, TODYL_API_BASE: 'https://api.todyl.com/' } as NodeJS.ProcessEnv);
    expect(c.baseUrl).toBe('https://api.todyl.com');
  });

  it.each(['TODYL_CLIENT_ID', 'TODYL_ACCESS_TOKEN'])('throws when %s is missing', (key) => {
    const env = { ...base } as Record<string, string>;
    delete env[key];
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(new RegExp(key));
  });

  it('rejects a non-numeric TTL rather than silently defaulting', () => {
    expect(() => loadConfig({ ...base, TODYL_CACHE_TTL_SECONDS: 'soon' } as NodeJS.ProcessEnv))
      .toThrow(/TODYL_CACHE_TTL_SECONDS/);
  });
});
