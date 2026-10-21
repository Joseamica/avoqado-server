/**
 * C2 · T9 ronda 1: una herramienta MCP de dos pasos se prueba POR EL CATÁLOGO real (`configureToolCatalog`), como corre en producción
 * (`server.ts`): paso 1 (vista previa ⇒ `confirmationToken` atado a lo que firma el catálogo) y paso 2 con el token. Llamar al handler
 * directo no ve el token (así se escapó `confirm_order_price_contract`).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '../../src/mcp/catalog'
import type { McpScope } from '../../src/mcp/scope'

export async function conectarPorElCatalogo(registrar: (server: McpServer) => void, scope: McpScope) {
  const server = new McpServer({ name: 'por-el-catalogo', version: '1' })
  configureToolCatalog(server, { ...scope, scopes: ['mcp:read', 'mcp:write'] } as McpScope)
  registrar(server)
  const client = new Client({ name: 'prueba', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text),
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/**
 * El protocolo completo, como lo seguiría un agente obediente: paso 1 con `args`; el paso 2 con los `confirmationArgs` DE LA HERRAMIENTA,
 * tal cual, más el `confirmationToken` del catálogo. Devuelve la vista y el resultado. Exige que los `confirmationArgs` de la herramienta
 * sean EXACTAMENTE lo que firmó el catálogo (`confirmationArguments`) más `confirm: true`.
 */
export async function pasoUnoYDos(c: Awaited<ReturnType<typeof conectarPorElCatalogo>>, name: string, args: Record<string, unknown>) {
  const vista = await c.call(name, args)
  const resultado =
    vista.requiresConfirmation && vista.confirmationToken
      ? await c.call(name, { ...vista.confirmationArgs, confirmationToken: vista.confirmationToken })
      : null
  return { vista, resultado }
}
