export interface TodylConfig {
  baseUrl: string;
  clientId: string;
  accessToken: string;
  cacheTtlSeconds: number;
  maxPages: number;
  port: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = (env[key] ?? '').trim();
  if (!value) {
    throw new Error(
      `${key} is required. Create an External API token in the Todyl portal ` +
        `(Account → Developer APIs → External API Tokens) and set ${key}.`
    );
  }
  return value;
}

function numeric(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = (env[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): TodylConfig {
  return {
    baseUrl: (env.TODYL_API_BASE ?? 'https://api.todyl.com').trim().replace(/\/+$/, ''),
    clientId: required(env, 'TODYL_CLIENT_ID'),
    accessToken: required(env, 'TODYL_ACCESS_TOKEN'),
    cacheTtlSeconds: numeric(env, 'TODYL_CACHE_TTL_SECONDS', 300),
    maxPages: numeric(env, 'TODYL_MAX_PAGES', 20),
    port: numeric(env, 'PORT', 8080),
  };
}
