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
          : mode === 'fiscal'
            ? { total: 125, fiscalUuid: 'UUID-CFDI' }
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

// Lo que las políticas de los directorios de Claude y OpenAI no aceptan: no entra en NINGUNA tanda.
const NUNCA_EN_DIRECTORIO = [
  // mover dinero
  'create_payment_link',
  'issue_refund',
  'record_manual_payment',
  'record_serialized_sale',
  'refund_card_on_terminal',
  'release_terminal_payment',
  'sell_credit_pack',
  'set_merchant_routing_rule',
  'set_terminal_payment_strict_mode',
  // identificadores oficiales, CFDI y nómina
  'accounting_iva_cashflow',
  'accounts_payable',
  'add_employee',
  'cash_out_org_withdrawals',
  'cash_out_withdrawals',
  'cfdi_status',
  'confirm_order_price_contract',
  'diot',
  'electronic_accounting_balance',
  'electronic_accounting_catalog',
  'electronic_accounting_polizas',
  'emit_refund_credit_note',
  'employees',
  'expenses',
  'fiscal_readiness',
  'generate_expense_policies',
  'import_expense_xml',
  'isr_provisional',
  'mark_expense_paid',
  'payroll_run',
  'register_expense',
  'send_cfdi_email',
  'set_fiscal_loss',
  'set_sales_retention',
  'staff_documents',
  'stamp_payroll_receipts',
  'supplier_invoices',
  // mostrar o vender planes de Avoqado
  'get_venue_plan_status',
  'get_venue_seat_status',
  'subscription_status',
  'venue_entitlements',
  'accept_hybrid_purchase',
  'avoqado_help',
  'cancel_hybrid_contract',
  'cancel_hybrid_purchase',
  'downgrade_venue_to_free',
  'feature_catalog',
  'get_announcement',
  'get_venue_downgrade_preview',
  'hybrid_contracts',
  'hybrid_current_purchase',
  'hybrid_offers',
  'hybrid_purchase_status',
  'hybrid_replacement_options',
  'list_announcements',
  'preview_hybrid_offer',
  'quote_hybrid_purchase',
  'resume_hybrid_purchase',
  'schedule_hybrid_selection',
  'venue_feature_grid',
  'venue_features',
  // administración interna de Avoqado
  'avoqado_internal_docs',
  'create_launch_campaign',
  'get_hybrid_campaign',
  'get_launch_campaign',
  'hybrid_campaign_redemptions',
  'landing_leads',
  'list_hybrid_campaigns',
  'list_launch_campaigns',
  'publish_hybrid_campaign',
  'save_hybrid_campaign',
  'set_hybrid_campaign_status',
  'set_launch_campaign_featured',
  'set_launch_campaign_status',
]

it('ninguna tanda del directorio incluye herramientas prohibidas, y todas están declaradas', () => {
  const { DIRECTORY_TIERS } = require('@/mcp/directory/catalog')
  const all: string[] = DIRECTORY_TIERS.flatMap((t: { tools: string[] }) => t.tools)
  expect(all.length).toBeGreaterThan(0)
  for (const name of all) expect(TOOL_EFFECTS[name]).toBeDefined()
  for (const name of NUNCA_EN_DIRECTORIO) expect({ name, publicada: all.includes(name) }).toEqual({ name, publicada: false })
  // Las tandas que no son la base se publican por tipo de efecto: la de lecturas sólo puede leer.
  const lecturas = DIRECTORY_TIERS.find((t: { name: string }) => t.name === 'lecturas')
  for (const name of lecturas.tools) expect({ name, effect: TOOL_EFFECTS[name] }).toEqual({ name, effect: 'read' })
  // La tanda de escrituras sólo lleva cambios internos: nada que avise a terceros, otorgue accesos o toque el dinero
  // de una cuenta abierta. Esas van en una tanda posterior, con sus propios candados.
  const escrituras = DIRECTORY_TIERS.find((t: { name: string }) => t.name === 'escrituras')
  const conEfectosExternos = [
    'reschedule_reservation',
    'cancel_reservation',
    'set_reservation_status',
    'create_reservation',
    'update_reservation',
    'add_to_waitlist',
    'configure_reservations',
    'invite_staff',
    'update_staff_member',
    'approve_overtime',
    'respond_to_review',
    'set_birthday_automation',
    'adjust_loyalty_points',
    'redeem_loyalty_on_check',
    'redeem_stamp_reward',
    'configure_wallet_card',
    'configure_referral',
    'decide_customer_approval',
    'apply_service_charge',
    'comp_table_check',
    'redeem_credit',
    'configure_auto_reorder',
    'configure_receipt_layout',
    // Auditoría 3-oct: el alta puede mandar un correo de referidos; los comensales pueden activar un cargo automático.
    'create_customer',
    'set_table_check_details',
  ]
  expect(escrituras.tools.length).toBe(27)
  for (const name of escrituras.tools) {
    expect({ name, effect: TOOL_EFFECTS[name] }).toEqual({ name, effect: 'write' })
    expect({ name, externo: conEfectosExternos.includes(name) }).toEqual({ name, externo: false })
  }
})

it('el directorio publica descripciones propias, sin nombrar herramientas ni dar órdenes al asistente', () => {
  const { DIRECTORY_TIERS } = require('@/mcp/directory/catalog')
  const { DIRECTORY_DESCRIPTIONS } = require('@/mcp/directory/descriptions')
  const all: string[] = DIRECTORY_TIERS.flatMap((t: { tools: string[] }) => t.tools)
  expect(Object.keys(DIRECTORY_DESCRIPTIONS).sort()).toEqual([...all].sort())
  // Sólo nombres con forma de identificador: palabras sueltas como «reservations» son vocabulario, no una referencia.
  const toolNames = Object.keys(TOOL_EFFECTS).filter(n => n.includes('_'))
  for (const [name, description] of Object.entries(DIRECTORY_DESCRIPTIONS) as Array<[string, string]>) {
    expect(description.length).toBeGreaterThan(40)
    for (const other of toolNames)
      expect({ name, mentions: description.includes(other) && other !== name ? other : null }).toEqual({ name, mentions: null })
    expect({
      name,
      order:
        description.match(/\b(never|do not|don't|always|first use|use the|(?<!no-)show|ask|instead of|nunca|usa|muestra)\b/i)?.[0] ?? null,
    }).toEqual({
      name,
      order: null,
    })
  }
})

it('el perfil de directorio usa su descripción y el manual conserva la original', async () => {
  const { DIRECTORY_DESCRIPTIONS } = require('@/mcp/directory/descriptions')
  const directory = await connected(['mcp:read'], 'directory')
  const manual = await connected(['mcp:read'])
  try {
    expect((await directory.client.listTools()).tools.find(t => t.name === 'daily_sales')?.description).toBe(
      DIRECTORY_DESCRIPTIONS.daily_sales,
    )
    expect((await manual.client.listTools()).tools.find(t => t.name === 'daily_sales')?.description).toBe('Ventas')
  } finally {
    await directory.close()
    await manual.close()
  }
})

it('el directorio filtra identificadores fiscales de la respuesta y el manual la devuelve completa', async () => {
  const directory = await connected(['mcp:read'], 'directory')
  const manual = await connected(['mcp:read'])
  try {
    const d = await directory.client.callTool({ name: 'daily_sales', arguments: { mode: 'fiscal' } })
    expect(d.structuredContent).toEqual({ status: 'success', data: { total: 125 } })
    const m = await manual.client.callTool({ name: 'daily_sales', arguments: { mode: 'fiscal' } })
    expect(m.structuredContent).toEqual({ status: 'success', data: { total: 125, fiscalUuid: 'UUID-CFDI' } })
  } finally {
    await directory.close()
    await manual.close()
  }
})
