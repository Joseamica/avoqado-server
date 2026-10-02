import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { text } from '@/mcp/respond'
import { instrumentTools } from '@/mcp/instrument'
import type { McpScope } from '@/mcp/scope'

async function connected(scopes: string[], profile: 'manual' | 'directory' = 'manual') {
  const server = new McpServer({ name: 'catalog-test', version: '1' })
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  instrumentTools(server, { staffId: 's', org: 'o' })
  configureToolCatalog(server, { staffId: 's', activeOrg: 'o', scopes } as McpScope, profile)
  const read = jest.fn(async ({ mode }: { mode?: string }) =>
    text(
      mode === 'error'
        ? { ok: false, error: 'Invalid `prisma.venue.findMany()` invocation' }
        : mode === 'question'
          ? { found: false, needsInput: true, question: '¿Qué sucursal?' }
          : { total: 125 },
    ),
  )
  const write = jest.fn(async () => text({ ok: true }))
  server.tool('daily_sales', 'Ventas', { mode: z.string().optional() }, read)
  server.tool('record_manual_payment', 'Registrar pago', {}, write)
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    client,
    read,
    write,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

it('expone anotaciones y salida estructurada compatible en el protocolo real', async () => {
  const c = await connected(['mcp:read', 'mcp:write'])
  try {
    const { tools } = await c.client.listTools()
    expect(tools.find(t => t.name === 'daily_sales')).toMatchObject({
      title: 'Daily sales',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      outputSchema: { type: 'object' },
    })
    expect(tools.find(t => t.name === 'record_manual_payment')?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false })
    const result = await c.client.callTool({ name: 'daily_sales', arguments: {} })
    expect(result.structuredContent).toEqual({ status: 'success', data: { total: 125 } })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ total: 125 }, null, 2) }])
  } finally {
    await c.close()
  }
})

it('solo lectura no anuncia escrituras ni permite invocarlas directamente', async () => {
  const c = await connected(['mcp:read'])
  try {
    expect((await c.client.listTools()).tools.map(t => t.name)).toEqual(['daily_sales'])
    const result = await c.client.callTool({ name: 'record_manual_payment', arguments: {} })
    expect(result.isError).toBe(true)
    expect(c.write).not.toHaveBeenCalled()
  } finally {
    await c.close()
  }
})

it('grant explícitamente vacío no anuncia ni ejecuta lecturas', async () => {
  const c = await connected([])
  try {
    expect((await c.client.listTools()).tools).toEqual([])
    expect((await c.client.callTool({ name: 'daily_sales', arguments: {} })).isError).toBe(true)
    expect(c.read).not.toHaveBeenCalled()
  } finally {
    await c.close()
  }
})

it('una aclaración no es error y ningún error interno se filtra en structuredContent', async () => {
  const c = await connected(['mcp:read'])
  try {
    const question = await c.client.callTool({ name: 'daily_sales', arguments: { mode: 'question' } })
    expect(question.structuredContent).toMatchObject({ status: 'needs_input', data: { question: '¿Qué sucursal?' } })
    expect(question.isError).not.toBe(true)
    const error = await c.client.callTool({ name: 'daily_sales', arguments: { mode: 'error' } })
    expect(error.isError).toBe(true)
    expect(JSON.stringify(error)).not.toMatch(/prisma|findMany/)
  } finally {
    await c.close()
  }
})

it('los previews que persisten lotes se clasifican como escritura', () => {
  expect(TOOL_EFFECTS.preview_catalog_import).toBe('write')
  expect(TOOL_EFFECTS.preview_catalog_publication).toBe('write')
  expect(TOOL_EFFECTS.print_routing_preview).toBe('read')
})

it('cada herramienta del código tiene exactamente una declaración de efectos', () => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const ts = require('typescript') as typeof import('typescript')
  const directory = path.resolve(__dirname, '../../../src/mcp/tools')
  const names: string[] = []
  for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.ts'))) {
    const ast = ts.createSourceFile(file, fs.readFileSync(path.join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: import('typescript').Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['tool', 'registerTool'].includes(node.expression.name.text) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        names.push(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  expect(names.length).toBe(new Set(names).size)
  expect(names.sort()).toEqual(Object.keys(TOOL_EFFECTS).sort())
})

it('directorio bloquea herramientas excluidas también por invocación directa, sin recortar el MCP manual', async () => {
  const c = await connected(['mcp:read', 'mcp:write'], 'directory')
  try {
    expect((await c.client.listTools()).tools.map(t => t.name)).toEqual(['daily_sales'])
    expect((await c.client.callTool({ name: 'record_manual_payment', arguments: {} })).isError).toBe(true)
    expect(c.write).not.toHaveBeenCalled()
    expect((await c.client.callTool({ name: 'daily_sales', arguments: {} })).isError).not.toBe(true)
  } finally {
    await c.close()
  }
})

it('el catálogo de publicación contiene sólo herramientas declaradas y ninguna administración interna', () => {
  const { DIRECTORY_TOOLS } = require('@/mcp/directory/catalog')
  expect(DIRECTORY_TOOLS.size).toBeGreaterThan(0)
  for (const name of DIRECTORY_TOOLS) expect(TOOL_EFFECTS[name]).toBeDefined()
  for (const name of [
    'avoqado_internal_docs',
    'register_expense',
    'import_expense_xml',
    'expenses',
    'employees',
    'add_employee',
    'staff_documents',
    'issue_refund',
    'record_manual_payment',
    'create_payment_link',
    'accept_hybrid_purchase',
    'venue_feature_grid',
    'create_launch_campaign',
  ]) {
    expect(DIRECTORY_TOOLS.has(name)).toBe(false)
  }
})
