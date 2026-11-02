/**
 * BORRADOR: promover a tests/unit/mcp-customer/courtesy-review.adapters.test.ts tras registrar seam503 y effect write.
 * Catálogo/confirmación/guard REALES por SDK; servicio financiero aislado (PG8 ya cubre su conducta real).
 * registerOrderTools es el grupo ya montado por registerAllTools; no requiere export/módulo nuevo para el seam.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { registerOrderTools } from '@/mcp/tools/orders'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import { ConflictError } from '@/errors/AppError'
import {
  clone,
  ids,
  original,
  publicSnapshot,
  internalOriginal,
  internalSnapshot,
  previewReply,
  appliedReply,
} from '../../__helpers__/courtesyReview.adapter.fixture'

const mockReview = jest.fn(),
  mockAudit = jest.fn()
jest.mock('@/services/mobile/cortesia-pendiente.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/cortesia-pendiente.mobile.service'),
  revisarCortesiaPendiente: (...args: unknown[]) => mockReview(...args),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...args: unknown[]) => mockAudit(...args) }))

const TOOL = 'review_pending_courtesy'
let server: McpServer | undefined, client: Client | undefined
let permissions: string[]
const args = () => ({ venueId: ids.venue, ...clone(original) })
async function connect(profile: 'manual' | 'directory' = 'manual', scopes = ['mcp:read', 'mcp:write']) {
  const scope = {
    staffId: ids.actor,
    activeOrg: 'synthetic-organization',
    allowedVenueIds: [ids.venue],
    scopes,
    perVenueAccess: new Map([[ids.venue, { role: 'CASHIER', corePermissions: permissions, isSuperAdmin: false }]]),
  } as unknown as McpScope
  server = new McpServer({ name: 'courtesy-adapter-test', version: '1' })
  configureToolCatalog(server, scope, profile)
  registerOrderTools(server, scope)
  client = new Client({ name: 'courtesy-client', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return scope
}
async function call(body: Record<string, unknown>) {
  const r = await client!.callTool({ name: TOOL, arguments: body })
  const text = (r.content as Array<{ text: string }>)[0].text
  try {
    return JSON.parse(text)
  } catch {
    return { isError: r.isError, error: text }
  }
}
beforeEach(() => {
  jest.clearAllMocks()
  permissions = ['orders:read', 'orders:comp']
  mockReview.mockImplementation(async (_venue, _actor, body) => (body.confirm ? appliedReply() : previewReply()))
  mockAudit.mockResolvedValue(undefined)
})
afterEach(async () => {
  await client?.close()
  await server?.close()
  client = undefined
  server = undefined
})

it('la tool nueva vive en MCP libre con efecto write y no se agrega al directorio certificado', async () => {
  expect(TOOL_EFFECTS[TOOL]).toBe('write')
  expect(DIRECTORY_TOOLS.has(TOOL)).toBe(false)
  await connect()
  expect((await client!.listTools()).tools.map(t => t.name)).toContain(TOOL)
  await client!.close()
  await server!.close()
  client = undefined
  server = undefined
  await connect('directory')
  expect((await client!.listTools()).tools.map(t => t.name)).not.toContain(TOOL)
})

it('preview por orders:read muestra110 PESOS, liga tupla completa al token existente y no confirma/audita', async () => {
  permissions = ['orders:read']
  await connect()
  const p = await call(args())
  expect(p).toMatchObject({ requiresConfirmation: true, confirmationToken: expect.any(String), expectedCourtesySnapshot: publicSnapshot })
  expect(p.confirmationArguments).toMatchObject({
    venueId: ids.venue,
    originalPaymentKey: ids.key,
    expectedCourtesySnapshot: publicSnapshot,
  })
  expect(p.expectedCourtesySnapshot.total).toBe(110)
  expect(JSON.stringify(p)).not.toMatch(/"[^"]*Cents"/)
  expect(mockReview).toHaveBeenCalledWith(
    ids.venue,
    { actorId: ids.actor, isImpersonating: false },
    expect.objectContaining({ ...internalOriginal, confirm: false }),
  )
  expect(mockReview.mock.calls.every(([, , body]) => body.confirm === false)).toBe(true)
  expect(mockAudit).not.toHaveBeenCalled()
})

it('confirm sin token o con snapshot alterado no llega al dominio financiero', async () => {
  await connect()
  const p = await call(args())
  mockReview.mockClear()
  expect(await call({ ...args(), confirm: true })).toMatchObject({ needsInput: true, field: 'confirmationToken' })
  const changed = clone(p.confirmationArguments)
  changed.expectedCourtesySnapshot.total = 109
  expect(await call({ ...changed, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({ needsInput: true })
  expect(mockReview).not.toHaveBeenCalled()
  expect(mockAudit).not.toHaveBeenCalled()
})

it('confirm autorizado convierte toda la tupla de pesos al DTO interno y audita con identidad MCP actual', async () => {
  const scope = await connect()
  const p = await call(args())
  mockReview.mockClear()
  const result = await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
  expect(result).toMatchObject({
    ok: true,
    outcome: 'APPLIED',
    originalPaymentKey: ids.key,
    snapshot: { total: 0, paymentStatus: 'PENDING' },
  })
  expect(mockReview).toHaveBeenCalledWith(
    ids.venue,
    { actorId: ids.actor, isImpersonating: false },
    { ...internalOriginal, confirm: true, expected: internalSnapshot },
  )
  expect(mockAudit).toHaveBeenCalledWith(
    scope,
    expect.objectContaining({
      action: 'ORDER_COURTESY_REVIEW_APPLIED',
      venueId: ids.venue,
      entity: 'Order',
      entityId: ids.order,
      data: expect.objectContaining({ originalPaymentKey: ids.key }),
    }),
  )
  expect(JSON.stringify(result)).not.toMatch(/"[^"]*Cents"/)
  expect(JSON.stringify(mockReview.mock.calls[0])).not.toContain('confirmationToken')
})

it('orders:read/orders:update permiten consultar pero no reemplazan orders:comp al confirmar', async () => {
  permissions = ['orders:read', 'orders:update']
  await connect()
  const p = await call(args())
  mockReview.mockClear()
  const r = await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
  expect(r.error ?? r.message).toMatch(/orders:comp|permiso/i)
  expect(mockReview).not.toHaveBeenCalled()
  expect(mockAudit).not.toHaveBeenCalled()
})

it('venueFilter rechaza otro venue antes de preview y no sustituye por el de la conexión', async () => {
  await connect()
  const r = await call({ ...args(), venueId: ids.otherVenue })
  expect(r.error ?? r.message).toMatch(/scope|organizaci|venue/i)
  expect(mockReview).not.toHaveBeenCalled()
  expect(mockAudit).not.toHaveBeenCalled()
})

it('scope OAuth de lectura no anuncia ni ejecuta la tool financiera', async () => {
  await connect('manual', ['mcp:read'])
  expect((await client!.listTools()).tools.map(t => t.name)).not.toContain(TOOL)
  expect(mockReview).not.toHaveBeenCalled()
})

it('error canónico español no se interpreta como éxito ni produce audit MCP', async () => {
  await connect()
  const p = await call(args())
  mockReview.mockRejectedValue(new ConflictError('La cuenta cambió. Vuelve a revisarla.', 'COURTESY_REVIEW_CHANGED'))
  const r = await call({ ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
  expect(r).toMatchObject({ ok: false, error: 'La cuenta cambió. Vuelve a revisarla.', code: 'COURTESY_REVIEW_CHANGED' })
  expect(mockAudit).not.toHaveBeenCalled()
})

it('el codec compartido rechaza una fracción de centavo del snapshot público antes de invocar el dominio', async () => {
  await connect()
  const expectedCourtesySnapshot = clone(publicSnapshot)
  expectedCourtesySnapshot.lines[0].modifiers[0].price = 10.001
  const r = await call({ ...args(), expectedCourtesySnapshot })
  expect(r.error ?? r.message).toMatch(/importe|centavo|inválid|cantidad/i)
  expect(mockReview).not.toHaveBeenCalled()
  expect(mockAudit).not.toHaveBeenCalled()
})

it('repetición exacta ya aplicada conserva resultado y no duplica la auditoría de una escritura MCP', async () => {
  await connect()
  const p = await call(args())
  const body = { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken }
  expect(await call(body)).toMatchObject({ ok: true, outcome: 'APPLIED' })
  mockReview.mockResolvedValue({ ...appliedReply(), outcome: 'ALREADY_APPLIED' })
  expect(await call(body)).toMatchObject({ ok: true, outcome: 'ALREADY_APPLIED' })
  expect(mockAudit).toHaveBeenCalledTimes(1)
})

it.each(['productId', 'confirm', 'externalId'])('validación SDK de %s explica el problema en español sin invocar dominio', async field => {
  await connect()
  const input: Record<string, any> = args()
  if (field === 'productId') input.lines[0].productId = 'identificador-invalido'
  if (field === 'confirm') input.confirm = 'true'
  if (field === 'externalId') delete input.externalId
  const result = await call(input)
  const message = result.error ?? result.message
  expect(message).toEqual(expect.stringMatching(/inválid|válid|requerid|booleano|identificador|datos/i))
  expect(message).not.toMatch(/Invalid cuid|Expected boolean, received string|["']Required["']/i)
  expect(mockReview).not.toHaveBeenCalled()
  expect(mockAudit).not.toHaveBeenCalled()
})
