/**
 * «Marcar revisado» (review_exchange) atravesando el catálogo REAL (rC1, 26-oct): la confirmación es la firmada del
 * catálogo. Una huella que el cliente pueda calcular solo (sha256 de los argumentos) no sirve como vista previa.
 */
import { createHash, randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerExchangeTools } from '@/mcp/tools/exchanges'

const mockDetail = jest.fn()
const mockReview = jest.fn()
const mockSettingsUpdate = jest.fn()
jest.mock('@/services/dashboard/venueSettings.dashboard.service', () => ({
  updateVenueSettings: (...a: unknown[]) => mockSettingsUpdate(...a),
}))
jest.mock('@/services/dashboard/exchange.dashboard.service', () => ({ markExchangeReviewed: (...a: unknown[]) => mockReview(...a) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    exchange: { findFirst: (...a: unknown[]) => mockDetail(...a), findMany: jest.fn(), count: jest.fn() },
    venue: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ timezone: 'America/Mexico_City', type: 'RESTAURANT', settings: { exchangesEnabled: null } }),
    },
  },
}))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (access: { corePermissions: string[] }, permission: string) => access.corePermissions.includes(permission),
}))

const venueId = 'cm12345678901234567890123'
const exchangeId = 'cm52345678901234567890123'
const note = 'Revisado con la gerente'
const scope: McpScope = {
  staffId: 'cm32345678901234567890123',
  activeOrg: 'cm42345678901234567890123',
  scopes: ['mcp:read', 'mcp:write'],
  allowedVenueIds: [venueId],
  perVenueAccess: new Map([[venueId, { corePermissions: ['payments:read', 'payments:refund', 'venues:update'] } as never]]),
}
const args = { venueId, exchangeId, note }

let server: McpServer
let client: Client
const call = async (a: Record<string, unknown>) => {
  const r = await client.callTool({ name: 'review_exchange', arguments: a })
  return JSON.parse((r.content as Array<{ text: string }>)[0].text)
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockDetail.mockResolvedValue({ id: exchangeId, status: 'NEEDS_REVIEW', reviewReason: 'CHARGE_AMOUNT_MISMATCH', reviewedAt: null })
  mockReview.mockResolvedValue({
    id: exchangeId,
    reviewedAt: new Date('2026-10-26T18:00:00Z'),
    reviewedById: scope.staffId,
    reviewNote: note,
  })
  server = new McpServer({ name: 'cambios', version: '1' })
  configureToolCatalog(server, scope)
  registerExchangeTools(server, scope)
  client = new Client({ name: 'review-two-step', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
})
afterEach(async () => {
  await client.close()
  await server.close()
})

it('una huella fabricada sin vista previa NO marca revisado', async () => {
  const key = randomUUID()
  const forged = createHash('sha256')
    .update(JSON.stringify(['review_exchange', venueId, scope.staffId, exchangeId, note, key]))
    .digest('hex')
    .slice(0, 32)
  await call({ ...args, idempotencyKey: key, previewDigest: forged, confirm: true }).catch(() => null)
  expect(mockReview).not.toHaveBeenCalled()
})

it('confirm:true sin token NO escribe', async () => {
  expect(await call({ ...args, confirm: true })).toMatchObject({ needsInput: true, field: 'confirmationToken' })
  expect(mockReview).not.toHaveBeenCalled()
})

it('la vista previa da un token firmado; con otra nota u otro cambio NO escribe', async () => {
  const preview = await call(args)
  expect(preview).toMatchObject({ requiresConfirmation: true, confirmationToken: expect.any(String), preview: { nota: note } })
  for (const cambio of [{ note: 'Otra nota distinta' }, { exchangeId: 'cm62345678901234567890123' }])
    expect(await call({ ...args, ...cambio, confirm: true, confirmationToken: preview.confirmationToken })).toMatchObject({
      needsInput: true,
    })
  expect(mockReview).not.toHaveBeenCalled()
})

it('los mismos argumentos + confirm:true + el token sí marcan revisado, por el servicio compartido', async () => {
  const preview = await call(args)
  const r = await call({ ...preview.confirmationArguments, confirm: true, confirmationToken: preview.confirmationToken })
  expect(r).toMatchObject({ ok: true, cambio: exchangeId })
  expect(mockReview).toHaveBeenCalledTimes(1)
  expect(mockReview).toHaveBeenCalledWith({ venueId, exchangeId, staffId: scope.staffId, note, source: 'MCP' })
})

it('setting write requires a signed preview bound to venue and requested value', async () => {
  const settingCall = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'set_exchanges_setting', arguments: args })
    return JSON.parse((result.content as Array<{ text: string }>)[0].text)
  }
  const args = { venueId, exchangesEnabled: true }
  expect(await settingCall({ ...args, confirm: true })).toMatchObject({ needsInput: true, field: 'confirmationToken' })
  expect(mockSettingsUpdate).not.toHaveBeenCalled()
  const preview = await settingCall(args)
  expect(preview).toMatchObject({
    requiresConfirmation: true,
    confirmationToken: expect.any(String),
    preview: { actual: false, nuevo: true },
  })
  expect(mockSettingsUpdate).not.toHaveBeenCalled()
  for (const changed of [{ exchangesEnabled: false }, { venueId: 'cm62345678901234567890123' }]) {
    expect(
      await settingCall({ ...preview.confirmationArguments, ...changed, confirm: true, confirmationToken: preview.confirmationToken }),
    ).toMatchObject({ needsInput: true })
  }
  expect(mockSettingsUpdate).not.toHaveBeenCalled()
  mockSettingsUpdate.mockImplementation(async () => {
    jest
      .mocked(prisma.venue.findUnique)
      .mockResolvedValue({ timezone: 'America/Mexico_City', type: 'RESTAURANT', settings: { exchangesEnabled: true } } as never)
    return { exchangesEnabled: true }
  })
  expect(
    await settingCall({ ...preview.confirmationArguments, confirm: true, confirmationToken: preview.confirmationToken }),
  ).toMatchObject({ ok: true, prendido: true, guardado: true })
  expect(mockSettingsUpdate).toHaveBeenCalledTimes(1)
  expect(mockSettingsUpdate).toHaveBeenCalledWith(venueId, { exchangesEnabled: true }, scope.staffId)
})
