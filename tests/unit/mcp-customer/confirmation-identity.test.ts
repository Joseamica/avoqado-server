import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { registerMenuTools } from '@/mcp/tools/menu'
import { registerStaffTools } from '@/mcp/tools/staff'
import { registerGiftCardTools } from '@/mcp/tools/giftCards'
import type { McpScope } from '@/mcp/scope'

const mockProducts = jest.fn()
const mockMembers = jest.fn()
const mockProductWrite = jest.fn()
const mockMemberWrite = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: (...a: unknown[]) => mockProducts(...a) },
    staffVenue: { findMany: (...a: unknown[]) => mockMembers(...a) },
  },
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({ updateProduct: (...a: unknown[]) => mockProductWrite(...a) }))
jest.mock('@/services/dashboard/team.dashboard.service', () => ({ updateTeamMember: (...a: unknown[]) => mockMemberWrite(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
const mockGiftCards = jest.fn()
const mockGiftCardDetail = jest.fn()
const mockGiftCardWrite = jest.fn()
const mockCancelStart = jest.fn()
jest.mock('@/services/giftCards/giftCardReports.service', () => ({
  listGiftCards: (...a: unknown[]) => mockGiftCards(...a),
  getGiftCardDetail: (...a: unknown[]) => mockGiftCardDetail(...a),
  getGiftCardSummary: jest.fn(),
  getGiftCardLiabilityAging: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardSurface.service', () => ({ operarSobreDeGerente: (...a: unknown[]) => mockGiftCardWrite(...a) }))
jest.mock('@/services/giftCards/giftCardCancel.service', () => ({
  iniciarCancelacionDeVenta: (...a: unknown[]) => mockCancelStart(...a),
  liberarCancelacionDeVenta: jest.fn(),
}))

let server: McpServer
let client: Client
const product = { id: 'product-A', name: 'Cafe', price: 30, active: true }
const member = {
  id: 'member-A',
  staffId: 'person-A',
  role: 'WAITER',
  active: true,
  staff: { firstName: 'Juan', lastName: 'Perez', active: true },
}
const giftCard = { id: 'gc1', last4: '4821', status: 'ACTIVE', balance: 400, order: { id: 'o1', orderNumber: 'ORD-1' } }
beforeEach(async () => {
  jest.clearAllMocks()
  mockProducts.mockResolvedValue([product])
  mockMembers.mockResolvedValue([member])
  mockProductWrite.mockResolvedValue({ ...product, price: 45 })
  mockMemberWrite.mockResolvedValue({})
  mockGiftCards.mockResolvedValue({ items: [giftCard], page: 1, pageSize: 10, total: 1, totalBalance: 400 })
  mockGiftCardDetail.mockImplementation(async (_v: string, id: string) => {
    if (id !== giftCard.id) throw new Error(`detalle inesperado de ${id}`)
    return { ...giftCard, cancel: { allowed: true, reason: null, message: null }, sale: { cards: 1, amount: 400 } }
  })
  mockGiftCardWrite.mockResolvedValue({ activityIds: ['act-1'], replayed: false })
  mockCancelStart.mockResolvedValue({ giftCardIds: ['gc1'], bloqueadas: ['gc1'] })
  server = new McpServer({ name: 'identity', version: '1' })
  const scope = {
    staffId: 'owner',
    activeOrg: 'org',
    allowedVenueIds: ['centro'],
    scopes: ['mcp:read', 'mcp:write'],
    perVenueAccess: new Map([['centro', { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }]]),
  } as unknown as McpScope
  configureToolCatalog(server, scope)
  registerMenuTools(server, scope)
  registerStaffTools(server, scope)
  registerGiftCardTools(server, scope)
  client = new Client({ name: 'identity-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
})
afterEach(async () => {
  await client.close()
  await server.close()
})
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args })
  return JSON.parse((r.content as Array<{ text: string }>)[0].text)
}

it.each(['set_menu_item_price', 'set_menu_item_active'])('%s liga identidad y estado, sin volver a elegir por nombre', async name => {
  const args = { venueId: 'centro', name: 'Cafe', ...(name.endsWith('price') ? { price: 45 } : { active: false }) }
  const p = await call(name, args)
  mockProducts.mockResolvedValue([{ ...product, id: 'product-B', price: 80 }])
  expect(await call(name, { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({
    needsInput: true,
  })
  expect(mockProductWrite).not.toHaveBeenCalled()
  mockProducts.mockResolvedValue([{ ...product, price: 35 }])
  expect(await call(name, { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({
    needsInput: true,
  })
  mockProducts.mockResolvedValue([product])
  expect(await call(name, { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })).toMatchObject({
    ok: true,
  })
  expect(mockProducts.mock.calls.at(-1)[0].where).toMatchObject({ id: product.id })
  expect(mockProductWrite.mock.calls[0][1]).toBe(product.id)
  expect(mockProductWrite.mock.calls[0][4]).toEqual({ name: 'Cafe', price: 30, active: true })
})

it('el cambio de acceso liga StaffVenue y estado del local, no el estado global de Staff', async () => {
  const p = await call('update_staff_member', { venueId: 'centro', name: 'Juan', role: 'manager' })
  for (const changed of [
    { ...member, id: 'member-B' },
    { ...member, role: 'CASHIER' },
    { ...member, active: false },
  ]) {
    mockMembers.mockResolvedValue([changed])
    expect(
      await call('update_staff_member', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken }),
    ).toMatchObject({ needsInput: true })
    expect(mockMemberWrite).not.toHaveBeenCalled()
  }
  mockMembers.mockResolvedValue([member])
  expect(
    await call('update_staff_member', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken }),
  ).toMatchObject({ ok: true })
  expect(mockMembers.mock.calls.at(-1)[0].where).toMatchObject({ id: member.id })
  expect(mockMemberWrite.mock.calls[0][2]).toMatchObject({ expectedState: { role: 'WAITER', active: true }, callerRole: 'OWNER' })
  mockMembers.mockResolvedValue([{ ...member, active: false }])
  expect(await call('update_staff_member', { venueId: 'centro', name: 'Juan', active: true })).toMatchObject({
    preview: { changes: { active: { from: false, to: true } } },
  })
})

it('🔴 manage_gift_card: la confirmación con otro monto u otra tarjeta que la vista previa se rechaza sin escribir', async () => {
  const args = {
    venueId: 'centro',
    last4: '4821',
    action: 'adjust',
    direction: 'add',
    amount: 50,
    reason: 'CASHIER_ERROR',
    note: 'Se cobró doble',
    idempotencyKey: 'mcp-tarjeta-0001',
  }
  const p = await call('manage_gift_card', args)
  expect(p).toMatchObject({ requiresConfirmation: true, confirmationArguments: args })
  for (const cambio of [{ amount: 60 }, { direction: 'remove' }, { last4: '9999' }, { cardRef: 'gc-otra' }, { saleFolio: 'ORD-2' }]) {
    expect(
      await call('manage_gift_card', { ...p.confirmationArguments, ...cambio, confirm: true, confirmationToken: p.confirmationToken }),
    ).toMatchObject({ needsInput: true, field: 'confirmationToken' })
  }
  expect(mockGiftCardWrite).not.toHaveBeenCalled()
  expect(
    await call('manage_gift_card', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken }),
  ).toMatchObject({ ok: true })
  expect(mockGiftCardWrite).toHaveBeenCalledTimes(1)
  expect(mockGiftCardWrite.mock.calls[0].slice(0, 3)).toEqual(['centro', 'gc1', 'owner'])
})

describe('🔴 tarjetas: la confirmación opera la tarjeta que se VIO en la vista previa, nunca otra con los mismos 4', () => {
  // Entre la vista previa y la confirmación reponen el código de A (gc1) y B (gc2, de otra venta) queda terminando en 4821.
  const B = { id: 'gc2', last4: '4821', status: 'ACTIVE', balance: 900, order: { id: 'o2', orderNumber: 'ORD-2' } }
  const elLectorDevuelveB = (aReponida: boolean) => {
    mockGiftCards.mockResolvedValue({ items: [B], page: 1, pageSize: 10, total: 1, totalBalance: 900 })
    mockGiftCardDetail.mockImplementation(async (_v: string, id: string) => {
      const t = id === 'gc1' ? { ...giftCard, ...(aReponida ? { last4: '7777' } : {}) } : B
      return { ...t, cancel: { allowed: true, reason: null, message: null }, sale: { cards: 1, amount: t.balance } }
    })
  }
  const AJUSTE = {
    venueId: 'centro',
    last4: '4821',
    action: 'adjust',
    direction: 'add',
    amount: 50,
    reason: 'CASHIER_ERROR',
    note: 'Se cobró doble',
    idempotencyKey: 'mcp-tarjeta-0002',
  }

  it.each([
    ['A ya no termina en 4821 ⇒ se rechaza', true],
    ['A sigue terminando en 4821 ⇒ opera A', false],
  ])('manage_gift_card: %s', async (_caso, aReponida) => {
    const p = await call('manage_gift_card', AJUSTE)
    expect(p.confirmationArguments).toMatchObject({ cardRef: 'gc1' })
    elLectorDevuelveB(aReponida)
    const r = await call('manage_gift_card', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
    expect(mockGiftCardWrite.mock.calls.map(c => c[1])).not.toContain('gc2')
    if (aReponida) {
      expect(r).toMatchObject({ ok: false, code: 'GIFT_CARD_NOT_FOUND' })
      expect(mockGiftCardWrite).not.toHaveBeenCalled()
    } else {
      expect(r).toMatchObject({ ok: true })
      expect(mockGiftCardWrite.mock.calls[0].slice(0, 3)).toEqual(['centro', 'gc1', 'owner'])
    }
  })

  it.each([
    ['A ya no termina en 4821 ⇒ se rechaza', true],
    ['A sigue terminando en 4821 ⇒ cancela la venta de A', false],
  ])('cancel_gift_card_sale: %s', async (_caso, aReponida) => {
    const args = { venueId: 'centro', last4: '4821', action: 'start', idempotencyKey: 'mcp-cancelar-0001' }
    const p = await call('cancel_gift_card_sale', args)
    expect(p).toMatchObject({ requiresConfirmation: true, confirmationArguments: { cardRef: 'gc1' } })
    elLectorDevuelveB(aReponida)
    const r = await call('cancel_gift_card_sale', { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
    expect(mockCancelStart.mock.calls.map(c => c[1])).not.toContain('o2')
    if (aReponida) {
      expect(r).toMatchObject({ ok: false, code: 'GIFT_CARD_NOT_FOUND' })
      expect(mockCancelStart).not.toHaveBeenCalled()
    } else {
      expect(r).toMatchObject({ ok: true })
      expect(mockCancelStart.mock.calls[0].slice(0, 2)).toEqual(['centro', 'o1'])
    }
  })
})
