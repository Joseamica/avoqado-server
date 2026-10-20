-- Qué app OAuth (ChatGPT, Claude…) hizo cada llamada al MCP: evidencia si un cliente dice «yo no fui» (founder, 15-oct).
-- Nullable y sin default: en Postgres no reescribe la tabla.
ALTER TABLE "mcp_tool_calls" ADD COLUMN "clientId" TEXT;
