/**
 * Reads AGENTCHAT_PORT: unset means 4317, otherwise a decimal port 1-65535 (the same rule the MCP
 * server applies). `Number()` alone would turn '' into 0 (a random port) and '0x10' into 16.
 */
export function parsePort(portEnv: string | undefined): number {
  if (portEnv === undefined) return 4317;
  if (!/^\d{1,5}$/.test(portEnv) || Number(portEnv) < 1 || Number(portEnv) > 65535) {
    throw new Error(`AGENTCHAT_PORT must be a port number between 1 and 65535 (got ${JSON.stringify(portEnv)})`);
  }
  return Number(portEnv);
}
