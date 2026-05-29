import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { describeDbTarget, text } from './context'
import { registerVenueTools } from './tools/venues'
import { registerSalesTools } from './tools/sales'
import { registerTerminalTools } from './tools/terminals'
import { registerOrderTools } from './tools/orders'

async function main() {
  const server = new McpServer({ name: 'avoqado-admin', version: '0.1.0' })

  // Smoke tool — confirms the server is wired.
  server.tool('ping', 'Health check. Returns the DB target this MCP is pointed at.', {}, async () =>
    text({ ok: true, dbTarget: describeDbTarget() }),
  )

  registerVenueTools(server)
  registerSalesTools(server)
  registerTerminalTools(server)
  registerOrderTools(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Logs MUST go to stderr — stdout is the MCP protocol channel.
  console.error(`[avoqado-admin MCP] connected · DB target: ${describeDbTarget()}`)
}

main().catch(err => {
  console.error('[avoqado-admin MCP] fatal:', err)
  process.exit(1)
})
