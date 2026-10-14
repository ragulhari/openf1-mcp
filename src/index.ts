#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenF1Client } from "./client.js";
import { DEFAULT_CONFIG, registerTools } from "./tools.js";

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function createServer(client = new OpenF1Client({
  baseUrl: process.env.OPENF1_BASE_URL,
  token: process.env.OPENF1_TOKEN,
  minIntervalMs: intEnv("OPENF1_MIN_INTERVAL_MS", 350),
})) {
  const server = new McpServer(
    { name: "openf1", version: "1.0.0" },
    {
      instructions:
        "Formula 1 data from the OpenF1 API (2023 onwards). Workflow: 1) get_meetings or get_sessions to find a session_key; " +
        "2) get_drivers to map driver numbers to names; 3) use the other tools. Use session_key \"latest\" for the most recent session. " +
        "For telemetry (get_car_data, get_location) give one driver and a lap_number. Times are UTC.",
    },
  );
  registerTools(server, client, {
    ...DEFAULT_CONFIG,
    defaultLimit: intEnv("OPENF1_DEFAULT_LIMIT", DEFAULT_CONFIG.defaultLimit),
  });
  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel: log only to stderr.
  console.error("openf1-mcp running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
