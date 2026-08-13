import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { TodylConfig } from './config.js';
import { createClient } from './todyl/client.js';
import { createRepository, type TodylRepository } from './todyl/repository.js';
import { TODYL_TOOLS } from './tools/index.js';
import { toolError, type ToolResult } from './tools/result.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Re-express a `ToolResult` as a fresh `CallToolResult` object literal.
 *
 * `ToolResult` is structurally compatible with the SDK's `CallToolResult`
 * (its `content` items satisfy the "text" variant, `isError` lines up), but
 * the SDK's zod-derived type carries a `[x: string]: unknown` index
 * signature (from its `$loose` object schema) that a named interface like
 * `ToolResult` doesn't declare. Returning a `ToolResult` value through a
 * variable of that nominal type fails assignability for that reason alone;
 * rebuilding it as a fresh literal here — rather than casting — lets
 * TypeScript's normal literal-freshness check confirm the shape actually
 * matches instead of asserting it does.
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  return { content: result.content, isError: result.isError };
}

export function createServer(repo: TodylRepository): McpServer {
  const server = new McpServer({ name: 'todyl-mcp', version: '0.1.0' });

  for (const tool of TODYL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // readOnlyHint is read from the tool itself, not hardcoded, so this
        // annotation cannot lie if a non-read-only tool is ever added — the
        // MCP client's "should I confirm this with the user" decision relies
        // on it being accurate.
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: true },
      },
      async (args) => {
        try {
          return toCallToolResult(await tool.execute(args, repo));
        } catch (err) {
          // Todyl errors are already actionable; anything else is surfaced as-is
          // rather than swallowed into a generic failure.
          return toCallToolResult(toolError(err instanceof Error ? err.message : String(err)));
        }
      }
    );
  }

  return server;
}

export async function startServer(config: TodylConfig): Promise<void> {
  const repo = createRepository(createClient(config), config);
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  // Stateless: the MCP Gateway owns session lifecycle and pools connections,
  // so a fresh server+transport per request keeps this container simple.
  app.post('/mcp', async (req, res) => {
    const server = createServer(repo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      console.log(`todyl-mcp listening on :${config.port} at /mcp`);
      resolve();
    });
  });
}
