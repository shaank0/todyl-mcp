import { loadConfig } from './config.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    // Fail fast and loudly: starting without credentials would 401 every call
    // and look like a Todyl outage rather than a misconfiguration.
    console.error(`todyl-mcp cannot start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  await startServer(config);
}

void main();
