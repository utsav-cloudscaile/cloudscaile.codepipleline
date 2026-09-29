export { loadAppConfig } from './config/index.js';
export type { AppConfig } from './config/types.js';
export {
  CURRENT_SCHEMA_VERSION,
  connectMongo,
  createRunRecorder,
  disconnectMongo,
  isMongoConnected,
  MessageModel,
  type Migration,
  type MigrationContext,
  migrationStatus,
  RunModel,
  type RunRecorder,
  type RunRecorderContext,
  runMigrations,
  SessionModel,
  ToolCallModel,
  UsageRecordModel,
} from './db/index.js';
export {
  DEFAULT_POLICY,
  evaluateTool,
  loadPolicy,
  type PermissionMode,
  type PolicyConfig,
  resolvePolicy,
  type ToolDecision,
} from './guardrails/index.js';
export { createLogger, type Logger, resolveLoggerOptions } from './logger/index.js';
export { buildMcpServers, type McpServerConfig, type McpServerRegistry } from './mcp/index.js';
export {
  type PipelineOptions,
  type PipelineResult,
  type PipelineStage,
  type PipelineStageResult,
  runPipeline,
} from './pipeline/index.js';
export { buildServer, DOCS_ROUTE_PREFIX, OPENAPI_JSON_ROUTE } from './server/index.js';

import { loadAppConfig } from './config/index.js';
import { connectMongo, runMigrations } from './db/index.js';
import { loadPolicy } from './guardrails/index.js';
import { createLogger } from './logger/index.js';
import { buildMcpServers } from './mcp/index.js';
import { buildServer } from './server/index.js';

/**
 * Process entry point: load config, load the guardrail policy, wire up the
 * MCP server registry, and start the Fastify trigger server. Only runs when
 * this file is executed directly (`pnpm dev` / `node dist/index.js`), not
 * when its exports are imported elsewhere (e.g. tests).
 */
async function main(): Promise<void> {
  const config = loadAppConfig();
  const logger = createLogger(config.logLevel);
  const policy = await loadPolicy(config.policyPath);
  const mcpServers = buildMcpServers(config);

  // Fail fast (5s server-selection timeout, see src/db/connection.ts) rather
  // than starting a server whose runs would silently go unpersisted.
  await connectMongo(config.mongo);
  logger.info({ uri: config.mongo.uri.replace(/\/\/[^@/]+@/, '//***@') }, 'mongodb connected');

  // Schema migrations run before the server listens, so no request ever sees
  // a half-migrated database. Deployments that migrate as a pipeline step
  // (`pnpm migrate`) set MONGODB_AUTO_MIGRATE=false to skip this.
  if (config.mongo.autoMigrate) {
    const { applied } = await runMigrations({ log: logger });
    if (applied.length > 0) {
      logger.info({ applied }, 'schema migrations applied');
    }
  } else {
    logger.info('MONGODB_AUTO_MIGRATE=false — expecting migrations to run as a deploy step');
  }

  const app = await buildServer({ config, mcpServers, policy });
  const address = await app.listen({ port: config.trigger.port, host: config.trigger.host });
  logger.info({ address }, 'trigger server listening');
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((error: unknown) => {
    console.error('Fatal error starting code-pipeline:', error);
    process.exitCode = 1;
  });
}
