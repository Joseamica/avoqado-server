-- Additive: existing connections keep the manual MCP audience.
ALTER TABLE "mcp_refresh_tokens" ADD COLUMN "resource" TEXT;
