import { registerOrderTools } from '../../../src/mcp/tools/orders'
import type { McpScope } from '../../../src/mcp/scope'

const mockSerializedFind = jest.fn()
const mockOrderFind = jest.fn()
const mockOrderMatches = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => (v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }),
    requirePermission: jest.fn(),
  }),
}))
// find_order now restricts to venues where the caller holds orders:read (the daily_sales pattern);
// mock hasPermission true so the test exercises the tool logic, not the permission resolver.
jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => true,
  getUserAccess: jest.fn(),
  createAccessCache: jest.fn(() => ({})),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    serializedItem: { findFirst: (...a: unknown[]) => mockSerializedFind(...(a as [])) },
    order: {
      findFirst: (...a: unknown[]) => mockOrderFind(...(a as [])),
      findMany: (...a: unknown[]) => mockOrderMatches(...a),
      aggregate: jest.fn(),
    },
    venue: { findUnique: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
} as unknown as McpScope
const call = (args: Record<string, unknown>) => handlers.get('find_order')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerOrderTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.resetAllMocks())

describe('find_order by serial — case-insensitive (regression 2026-06-09)', () => {
  it('resolves the order even when the serial case differs from what is stored', async () => {
    // stored lower-cased; caller searches UPPERCASE
    mockOrderMatches.mockResolvedValueOnce([{ id: 'ord-1' }])
    mockOrderFind.mockResolvedValueOnce({
      id: 'ord-1',
      orderNumber: 'SN00003',
      status: 'COMPLETED',
      venue: { name: 'Wellness' },
      items: [],
      payments: [],
    })

    const out = parse(await call({ serialNumber: 'JHHHHHHHHHHHGGGGGGGG' }))

    const where = mockOrderMatches.mock.calls[0][0].where
    expect(where.items.some.serializedItem.serialNumber.in).toEqual(
      expect.arrayContaining(['JHHHHHHHHHHHGGGGGGGG', 'jhhhhhhhhhhhgggggggg']),
    )
    expect(out.found).toBe(true)
    expect(out.order.orderNumber).toBe('SN00003')
  })

  it('returns found:false for a serial that maps to no order', async () => {
    mockOrderMatches.mockResolvedValueOnce([])
    const out = parse(await call({ serialNumber: 'NOPE' }))
    expect(out.found).toBe(false)
    expect(mockOrderFind).not.toHaveBeenCalled()
  })
})

describe('find_order by orderNumber — the human identifier operators have (2026-06-26)', () => {
  it('resolves an order by its human number, case-insensitive AND scoped to your venues', async () => {
    // call 1: resolve number → id (within scope); call 2: fetch the full order
    mockOrderMatches.mockResolvedValueOnce([{ id: 'ord-9' }])
    mockOrderFind.mockResolvedValueOnce({
      id: 'ord-9',
      orderNumber: 'ORD-5454',
      status: 'COMPLETED',
      total: 358,
      venue: { name: 'Mobanq' },
      items: [],
      payments: [],
    })

    const out = parse(await call({ orderNumber: 'ord-5454' })) // lower-case input
    const lookupWhere = (mockOrderMatches.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(lookupWhere.orderNumber).toEqual({ equals: 'ord-5454', mode: 'insensitive' }) // case-insensitive
    expect(lookupWhere.venueId).toEqual({ in: ['v1'] }) // scoped — can't probe other venues' numbers
    expect(out.found).toBe(true)
    expect(out.order.orderNumber).toBe('ORD-5454')
    expect(out.order.total).toBe(358)
  })

  it('unknown order number → found:false, never fetches the full order', async () => {
    mockOrderMatches.mockResolvedValueOnce([]) // no order with that number in scope
    const out = parse(await call({ orderNumber: 'ORD-DOES-NOT-EXIST' }))
    expect(out.found).toBe(false)
    expect(out.reason).toMatch(/No order found with number/)
    expect(mockOrderMatches).toHaveBeenCalledTimes(1)
    expect(mockOrderFind).not.toHaveBeenCalled()
  })

  it('no identifier at all → asks for one (orderNumber listed first)', async () => {
    const out = parse(await call({}))
    expect(out.found).toBe(false)
    expect(out.reason).toBe('Pass orderNumber, orderId, or serialNumber')
  })
})

describe('find_order — identificación inequívoca por sucursal', () => {
  it('dos coincidencias: devuelve opciones sin cargar la orden más reciente', async () => {
    mockOrderMatches.mockResolvedValueOnce([
      { id: 'ord-1', venueId: 'v1', orderNumber: '100', venue: { name: 'Centro' } },
      { id: 'ord-2', venueId: 'v2', orderNumber: '100', venue: { name: 'Norte' } },
    ])
    const out = parse(await call({ orderNumber: '100' }))
    expect(out).toMatchObject({ found: false, needsInput: true, field: 'venueId' })
    expect(out.candidates).toHaveLength(2)
    expect(out.question).toMatch(/sucursal/)
    expect(mockOrderFind).not.toHaveBeenCalled()
    expect(mockOrderMatches.mock.calls[0][0]).toMatchObject({ take: 11 })
  })

  it('aplica el venue explícito antes de buscar coincidencias', async () => {
    mockOrderMatches.mockResolvedValueOnce([])
    await call({ venueId: 'v1', orderNumber: '100' })
    expect(mockOrderMatches.mock.calls[0][0].where.venueId).toEqual({ in: ['v1'] })
  })

  it('varios identificadores o sólo espacios requieren aclaración y no consultan la DB', async () => {
    for (const args of [{ orderId: 'a', orderNumber: '100' }, { orderNumber: '  ' }]) {
      const out = parse(await call(args))
      expect(out).toMatchObject({ found: false, needsInput: true })
    }
    expect(mockOrderMatches).not.toHaveBeenCalled()
    expect(mockOrderFind).not.toHaveBeenCalled()
    expect(mockSerializedFind).not.toHaveBeenCalled()
  })

  it('limita también la búsqueda por serial a órdenes legibles de esta conexión', async () => {
    mockOrderMatches.mockResolvedValueOnce([])
    await call({ serialNumber: 'ABC', venueId: 'v1' })
    expect(mockOrderMatches.mock.calls[0][0].where).toMatchObject({
      venueId: { in: ['v1'] },
      items: { some: { serializedItem: { serialNumber: { in: ['ABC', 'abc'] } } } },
    })
  })
})

/**
 * 🔴 Encargo 04edc5 (hz:8024bc1c:D41, founder «C»): la MISMA cortesía se guarda de dos formas según la pantalla. Mostrador /
 * «Cobrar»: renglón a precio lleno y la cabecera trae la cortesía (descuento $25.50); Mesas: renglón en $0 y la cabecera NO la
 * trae ($5.50). Quien lee la venta por el MCP veía dos descuentos distintos para lo mismo. `discountsAndComps` (aditivo) es la
 * cifra de los reportes («Descuentos y cortesías», como Square): igual en las dos. Cada renglón dice si fue cortesía.
 */
describe('find_order · la cortesía se lee igual en Mesas y en Mostrador (encargo 04edc5)', () => {
  const venta = (discountAmount: number, agua: { total: number }) => ({
    id: 'ord-1',
    orderNumber: 'ORD-1',
    status: 'COMPLETED',
    discountAmount,
    venue: { name: 'Café' },
    items: [
      { id: 'i1', productName: 'Coca', quantity: 1, unitPrice: 25, total: 25, discountAmount: 0, isCortesia: false },
      { id: 'i2', productName: 'Agua', quantity: 1, unitPrice: 20, total: agua.total, discountAmount: 20, isCortesia: true },
      { id: 'i3', productName: 'Café', quantity: 1, unitPrice: 30, total: 30, discountAmount: 0, isCortesia: false },
    ],
    payments: [],
  })

  it('🔴 descuentos y cortesías = $25.50 en las dos formas; el descuento guardado se devuelve tal cual', async () => {
    mockOrderFind.mockResolvedValueOnce(venta(25.5, { total: 20 }))
    const mostrador = parse(await call({ orderId: 'ord-1' }))
    mockOrderFind.mockResolvedValueOnce(venta(5.5, { total: 0 }))
    const mesas = parse(await call({ orderId: 'ord-1' }))

    expect([mostrador.order.discountsAndComps, mesas.order.discountsAndComps]).toEqual([25.5, 25.5])
    expect([mostrador.order.discountAmount, mesas.order.discountAmount]).toEqual([25.5, 5.5])
    expect(mesas.order.items.map((i: { isCortesia: boolean }) => i.isCortesia)).toEqual([false, true, false])
  })

  it('🔴 Codex p2 #4: también lleva el regalo de los combos (como los reportes)', async () => {
    // Combo de lista $200 vendido en $99 (su regalo, $101, vive en la promoción, no en la cabecera) + cortesía de Mesas de $20.
    mockOrderFind.mockResolvedValueOnce({
      ...venta(0, { total: 0 }),
      promotions: [
        {
          id: 'pr1',
          snapshotJson: { name: 'Combo' },
          grossCents: 20000,
          discountCents: 10100,
          netCents: 9900,
          needsReview: false,
          items: [],
        },
      ],
    })
    const out = parse(await call({ orderId: 'ord-1' }))
    expect(out.order.discountsAndComps).toBe(121)
  })

  it('la consulta pide si el renglón fue cortesía', async () => {
    mockOrderFind.mockResolvedValueOnce(venta(0, { total: 20 }))
    await call({ orderId: 'ord-1' })
    expect(mockOrderFind.mock.calls[0][0].select.items.select.isCortesia).toBe(true)
  })
})
