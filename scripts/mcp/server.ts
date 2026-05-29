import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { describeDbTarget, text } from './context'

async function main() {
  const server = new McpServer({ name: 'avoqado-admin', version: '0.1.0' })

  // Smoke tool — confirms the server is wired before real tools are added.
  server.tool(
    'ping',
    'Health check. Returns the DB target this MCP is pointed at.',
    {},
    async () => text({ ok: true, dbTarget: describeDbTarget() }),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Logs MUST go to stderr — stdout is the MCP protocol channel.
  console.error(`[avoqado-admin MCP] connected · DB target: ${describeDbTarget()}`)
}

main().catch((err) => {
  console.error('[avoqado-admin MCP] fatal:', err)
  process.exit(1)
})
