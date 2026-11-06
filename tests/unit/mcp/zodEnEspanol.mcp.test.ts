/**
 * D24: el MCP valida la entrada de cada tool con el Zod del repo (el SDK no trae otro), así que el errorMap global en
 * español también le llega. El envoltorio («Input validation error: …») es del SDK y lo lee la IA, no el usuario.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import '@/utils/zodEnEspanol'

it('un tipo equivocado en la entrada de una tool sale en español', async () => {
  const server = new McpServer({ name: 'd24', version: '1' })
  server.registerTool('marcar', { inputSchema: { consentimiento: z.boolean() } }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  const client = new Client({ name: 'd24-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const r = await client.callTool({ name: 'marcar', arguments: { consentimiento: 'false' } })
    const texto = (r.content as Array<{ text: string }>)[0].text
    expect(r.isError).toBe(true)
    expect(texto).toContain('Se esperaba sí o no y llegó texto')
    expect(texto).not.toContain('Expected boolean')
  } finally {
    await client.close()
    await server.close()
  }
})
