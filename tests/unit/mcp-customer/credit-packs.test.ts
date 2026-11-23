/**
 * Credit-pack read tools (coverage-gap sweep, 2026-06-29): prepaid packs ("paquete de 10
 * clases / masajes") shipped on the dashboard with no MCP coverage — core to the gyms/spas/
 * salons ICP.
 *
 *   - list_credit_packs        — the catalog (price, what's included, sold count)
 *   - customer_credit_balance  — one customer's remaining credits ("¿cuántas le quedan a Juan?")
 *
 * Reads, venue-scoped, gated by creditPacks:read (mirrors the dashboard route). Money in PESOS.
 */
import { registerCreditPackTools } from '../../../src/mcp/tools/creditPacks'
import type { McpScope } from '../../../src/mcp/scope'

const mockGetPacks = jest.fn()
const mockGetPurchases = jest.fn()
const mockCustomerFindMany = jest.fn()
const mockBalanceFindMany = jest.fn()
const mockStaffVenueFindFirst = jest.fn()
const mockRedeem = jest.fn()
const mockAudit = jest.fn()
const mockVenueFindUnique = jest.fn()
const mockPackFindMany = jest.fn()
const mockSell = jest.fn()

jest.mock('@/services/dashboard/creditPack.dashboard.service', () => ({
  getCreditPacks: (...a: unknown[]) => mockGetPacks(...(a as [])),
  getCustomerPurchases: (...a: unknown[]) => mockGetPurchases(...(a as [])),
  redeemItemManually: (...a: unknown[]) => mockRedeem(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/mobile/creditPack.mobile.service', () => ({ sellPackInPerson: (...a: unknown[]) => mockSell(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing creditPacks permission')
    },
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customer: { findMany: (...a: unknown[]) => mockCustomerFindMany(...(a as [])) },
    creditItemBalance: { findMany: (...a: unknown[]) => mockBalanceFindMany(...(a as [])) },
    staffVenue: { findFirst: (...a: unknown[]) => mockStaffVenueFindFirst(...(a as [])) },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
    creditPack: { findMany: (...a: unknown[]) => mockPackFindMany(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCreditPackTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('list_credit_packs (read, creditPacks:read)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call('list_credit_packs', { venueId: 'foreign' })).rejects.toThrow('out of scope')
    await expect(call('list_credit_packs', { venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockGetPacks).not.toHaveBeenCalled()
  })

  it('maps packs (price pesos, included items, sold count) and defaults to active only', async () => {
    mockGetPacks.mockResolvedValueOnce([
      {
        id: 'cp1',
        name: 'Paquete 10 clases',
        description: 'Yoga',
        price: 1500,
        currency: 'MXN',
        active: true,
        _count: { purchases: 7 },
        items: [{ product: { name: 'Clase Yoga' }, quantity: 10 }],
      },
      { id: 'cp2', name: 'Viejo', price: 100, currency: 'MXN', active: false, _count: { purchases: 0 }, items: [] },
    ])
    const out = parse(await call('list_credit_packs', { venueId: 'v1' }))
    expect(out.count).toBe(1) // inactive dropped by default
    expect(out.creditPacks[0]).toMatchObject({
      id: 'cp1',
      name: 'Paquete 10 clases',
      price: 1500,
      sold: 7,
      includes: [{ product: 'Clase Yoga', credits: 10 }],
    })
  })

  it('includeInactive keeps inactive packs', async () => {
    mockGetPacks.mockResolvedValueOnce([
      { id: 'cp2', name: 'Viejo', price: 100, currency: 'MXN', active: false, _count: { purchases: 0 }, items: [] },
    ])
    const out = parse(await call('list_credit_packs', { venueId: 'v1', includeInactive: true }))
    expect(out.count).toBe(1)
  })
})

describe('customer_credit_balance (read, creditPacks:read)', () => {
  it('resolves the customer and returns remaining credits per item', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'cust1', firstName: 'Juan', lastName: 'Pérez' }])
    mockGetPurchases.mockResolvedValueOnce({
      purchases: [
        {
          creditPack: { name: 'Paquete 10 clases' },
          status: 'ACTIVE',
          purchasedAt: new Date('2026-06-01T10:00:00Z'),
          expiresAt: new Date('2026-12-01T10:00:00Z'),
          amountPaid: 1500,
          itemBalances: [{ product: { name: 'Clase Yoga' }, remainingQuantity: 6, originalQuantity: 10 }],
        },
      ],
      total: 1,
    })
    const out = parse(await call('customer_credit_balance', { venueId: 'v1', search: 'juan' }))
    expect(out.found).toBe(true)
    expect(out.customer).toBe('Juan Pérez')
    // default → only ACTIVE purchases requested
    expect(mockGetPurchases).toHaveBeenCalledWith('v1', { customerId: 'cust1', status: 'ACTIVE', limit: 50 })
    expect(out.purchases[0]).toMatchObject({ pack: 'Paquete 10 clases', status: 'ACTIVE', amountPaid: 1500 })
    expect(out.purchases[0].items[0]).toEqual({ product: 'Clase Yoga', remaining: 6, original: 10 })
  })

  it('includeInactive asks for all statuses', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'cust1', firstName: 'Juan', lastName: 'Pérez' }])
    mockGetPurchases.mockResolvedValueOnce({ purchases: [], total: 0 })
    await call('customer_credit_balance', { venueId: 'v1', search: 'juan', includeInactive: true })
    expect(mockGetPurchases).toHaveBeenCalledWith('v1', { customerId: 'cust1', limit: 50 })
  })

  it('returns ambiguous when several customers match (no balance leaked)', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([
      { id: 'a', firstName: 'Juan', lastName: 'A' },
      { id: 'b', firstName: 'Juan', lastName: 'B' },
    ])
    const out = parse(await call('customer_credit_balance', { venueId: 'v1', search: 'juan' }))
    expect(out.ambiguous).toBe(true)
    expect(mockGetPurchases).not.toHaveBeenCalled()
  })

  it('returns found:false when no customer matches', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([])
    const out = parse(await call('customer_credit_balance', { venueId: 'v1', search: 'zzz' }))
    expect(out.found).toBe(false)
    expect(mockGetPurchases).not.toHaveBeenCalled()
  })
})

describe('redeem_credit (write, confirm-gated, creditPacks:redeem)', () => {
  const balance = (over: Record<string, unknown> = {}) => ({
    id: 'bal1',
    remainingQuantity: 6,
    product: { name: 'Clase Yoga' },
    creditPackPurchase: { expiresAt: new Date('2026-12-01T00:00:00Z'), creditPack: { name: 'Paquete 10 clases' } },
    ...over,
  })

  it('rejects out-of-scope / no-perm — no reads, no redeem', async () => {
    await expect(call('redeem_credit', { venueId: 'foreign', search: 'juan' })).rejects.toThrow('out of scope')
    await expect(call('redeem_credit', { venueId: 'no-perm', search: 'juan' })).rejects.toThrow('Forbidden')
    expect(mockBalanceFindMany).not.toHaveBeenCalled()
    expect(mockRedeem).not.toHaveBeenCalled()
  })

  it('errors when the customer has no available credits', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'P' }])
    mockBalanceFindMany.mockResolvedValueOnce([])
    const out = parse(await call('redeem_credit', { venueId: 'v1', search: 'juan' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/no tiene créditos/)
    expect(mockRedeem).not.toHaveBeenCalled()
  })

  it('asks which service when the customer has credits for several (no product given)', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'P' }])
    mockBalanceFindMany.mockResolvedValueOnce([balance(), balance({ id: 'bal2', product: { name: 'Masaje' } })])
    const out = parse(await call('redeem_credit', { venueId: 'v1', search: 'juan' }))
    expect(out.ambiguous).toBe(true)
    expect(out.available).toEqual(expect.arrayContaining(['Clase Yoga', 'Masaje']))
    expect(mockRedeem).not.toHaveBeenCalled()
  })

  it('without confirm: PREVIEWS remaining -> remaining-1 and does NOT redeem', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'P' }])
    mockBalanceFindMany.mockResolvedValueOnce([balance()])
    const out = parse(await call('redeem_credit', { venueId: 'v1', search: 'juan' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toMatchObject({ customer: 'Juan P', product: 'Clase Yoga', pack: 'Paquete 10 clases', remaining: 6, after: 5 })
    expect(mockRedeem).not.toHaveBeenCalled()
  })

  it('picks the soonest-expiring balance among same-service credits', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'P' }])
    mockBalanceFindMany.mockResolvedValueOnce([
      balance({ id: 'late', creditPackPurchase: { expiresAt: new Date('2026-12-31T00:00:00Z'), creditPack: { name: 'Pack B' } } }),
      balance({ id: 'soon', creditPackPurchase: { expiresAt: new Date('2026-07-15T00:00:00Z'), creditPack: { name: 'Pack A' } } }),
    ])
    const out = parse(await call('redeem_credit', { venueId: 'v1', search: 'juan', product: 'yoga' }))
    expect(out.preview.pack).toBe('Pack A') // soonest-expiring
  })

  it('with confirm:true: redeems against the resolved balance + the caller StaffVenue id, and audits', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'P' }])
    mockBalanceFindMany.mockResolvedValueOnce([balance()])
    mockStaffVenueFindFirst.mockResolvedValueOnce({ id: 'sv-1' }) // CreditTransaction.createdById FKs to StaffVenue.id
    mockRedeem.mockResolvedValueOnce({ id: 'txn1' })
    const out = parse(await call('redeem_credit', { venueId: 'v1', search: 'juan', reason: 'asistió 7pm', confirm: true }))
    expect(mockRedeem).toHaveBeenCalledWith('v1', 'bal1', 'sv-1', 'asistió 7pm') // StaffVenue.id, NOT scope.staffId
    expect(out).toMatchObject({ ok: true, redeemed: { customer: 'Juan P', product: 'Clase Yoga', remaining: 5, transactionId: 'txn1' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'CREDIT_REDEEMED', entityId: 'bal1', venueId: 'v1' })
  })

  it('errors (does not redeem) if the caller has no StaffVenue row for the venue', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'P' }])
    mockBalanceFindMany.mockResolvedValueOnce([balance()])
    mockStaffVenueFindFirst.mockResolvedValueOnce(null)
    const out = parse(await call('redeem_credit', { venueId: 'v1', search: 'juan', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockRedeem).not.toHaveBeenCalled()
  })

  it('surfaces a service rejection (e.g. expired) as ok:false', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'P' }])
    mockBalanceFindMany.mockResolvedValueOnce([balance()])
    mockStaffVenueFindFirst.mockResolvedValueOnce({ id: 'sv-1' })
    mockRedeem.mockRejectedValueOnce(new Error('Los creditos han expirado'))
    const out = parse(await call('redeem_credit', { venueId: 'v1', search: 'juan', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/expirado/)
  })
})

// D679 · paquete Ilimitado. Tanda certificada «lecturas» (Codex código r1 #8): ningún campo que ya existía cambia de tipo —
// `credits`, `remaining`, `original` y `after` siguen siendo números, también en un renglón Ilimitado—; lo nuevo va en campos que
// se agregan (`unlimited`, `display`, `used`, `faltas`) y le dicen al modelo que ese número no es un saldo. Paquetes normales, igual.
describe('D679 · Ilimitado en las herramientas de créditos', () => {
  const VENCE = new Date('2026-12-22T18:00:00Z') // 22 de diciembre en México
  const ili = (over: Record<string, unknown> = {}) => ({
    id: 'bal-ili',
    remainingQuantity: 99996,
    unlimited: true,
    product: { name: 'Lagree' },
    creditPackPurchase: { expiresAt: VENCE, creditPack: { name: 'Ilimitado' } },
    ...over,
  })
  beforeEach(() => mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' }))

  const salidas = async () => {
    const out: unknown[] = []
    mockGetPacks.mockResolvedValueOnce([
      {
        id: 'cp-ili',
        name: 'Ilimitado',
        price: 2500,
        currency: 'MXN',
        active: true,
        _count: { purchases: 1 },
        items: [
          { product: { name: 'Lagree' }, quantity: 99999, unlimited: true },
          { product: { name: 'Shake' }, quantity: 2, unlimited: false },
        ],
      },
    ])
    out.push(parse(await call('list_credit_packs', { venueId: 'v1' })))

    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Ana', lastName: 'T' }])
    mockGetPurchases.mockResolvedValueOnce({
      purchases: [
        {
          creditPack: { name: 'Ilimitado' },
          status: 'ACTIVE',
          purchasedAt: new Date('2026-11-22T10:00:00Z'),
          expiresAt: VENCE,
          amountPaid: 2500,
          faltas: { noLlego: 1, cancelTarde: 2 },
          itemBalances: [
            { product: { name: 'Lagree' }, remainingQuantity: 99996, originalQuantity: 99999, unlimited: true },
            { product: { name: 'Shake' }, remainingQuantity: 1, originalQuantity: 2, unlimited: false },
          ],
        },
        {
          creditPack: { name: 'Ilimitado viejo' },
          status: 'REFUNDED',
          purchasedAt: new Date('2026-10-01T10:00:00Z'),
          expiresAt: new Date('2026-10-31T10:00:00Z'),
          amountPaid: 2500,
          itemBalances: [{ product: { name: 'Lagree' }, remainingQuantity: 0, originalQuantity: 99999, unlimited: true }],
        },
      ],
      total: 2,
    })
    out.push(parse(await call('customer_credit_balance', { venueId: 'v1', search: 'ana', includeInactive: true })))

    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Ana', lastName: 'T' }])
    mockBalanceFindMany.mockResolvedValueOnce([ili()])
    out.push(parse(await call('redeem_credit', { venueId: 'v1', search: 'ana' })))

    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Ana', lastName: 'T' }])
    mockBalanceFindMany.mockResolvedValueOnce([ili()])
    mockStaffVenueFindFirst.mockResolvedValueOnce({ id: 'sv-1' })
    mockRedeem.mockResolvedValueOnce({ id: 'txn-ili' })
    out.push(parse(await call('redeem_credit', { venueId: 'v1', search: 'ana', confirm: true })))

    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Ana', lastName: 'T' }])
    mockPackFindMany.mockResolvedValueOnce([
      { id: 'cp-ili', name: 'Ilimitado', price: 2500, items: [{ quantity: 99999, unlimited: true, product: { name: 'Lagree' } }] },
    ])
    out.push(parse(await call('sell_credit_pack', { venueId: 'v1', customerSearch: 'ana', packSearch: 'ilimitado' })))
    return out
  }

  it('ningún campo que ya existía cambia de tipo: credits, remaining, original y after siguen siendo números', async () => {
    const [lista, saldo, previa, hecho, venta] = (await salidas()) as any[]
    for (const it of [...lista.creditPacks[0].includes, ...venta.preview.includes]) expect(typeof it.credits).toBe('number')
    for (const p of saldo.purchases)
      for (const it of p.items) expect([typeof it.remaining, typeof it.original]).toEqual(['number', 'number'])
    expect([typeof previa.preview.remaining, typeof previa.preview.after, typeof hecho.redeemed.remaining]).toEqual([
      'number',
      'number',
      'number',
    ])
  })

  it('list_credit_packs y sell_credit_pack: el renglón Ilimitado agrega unlimited y display; el normal igual que hoy', async () => {
    const [lista, , , , venta] = (await salidas()) as any[]
    expect(lista.creditPacks[0].includes).toEqual([
      { product: 'Lagree', credits: 99999, unlimited: true, display: 'Ilimitado' },
      { product: 'Shake', credits: 2 },
    ])
    expect(venta.preview.includes).toEqual([{ product: 'Lagree', credits: 99999, unlimited: true, display: 'Ilimitado' }])
  })

  it('customer_credit_balance de un Ilimitado: agrega unlimited, used, display y faltas; compra REFUNDED sin used y «reembolsado»', async () => {
    const [, saldo] = (await salidas()) as any[]
    expect(saldo.purchases[0].items).toEqual([
      {
        product: 'Lagree',
        remaining: 99996,
        original: 99999,
        unlimited: true,
        used: 3,
        display: 'Ilimitado · vence el 22 de diciembre de 2026',
      },
      { product: 'Shake', remaining: 1, original: 2 },
    ])
    expect(saldo.purchases[0].faltas).toEqual({ noLlego: 1, cancelTarde: 2 })
    expect(saldo.purchases[1].items).toEqual([
      { product: 'Lagree', remaining: 0, original: 99999, unlimited: true, display: 'Ilimitado · reembolsado' },
    ])
    expect(saldo.purchases[1]).not.toHaveProperty('faltas')
  })

  it('redeem_credit previsualiza «REGISTRARÁ 1 uso» y marca unlimited', async () => {
    const [, , previa, hecho] = (await salidas()) as any[]
    expect(previa.message).toBe(
      'Esto REGISTRARÁ 1 uso de "Lagree" (Ilimitado, vence el 22 de diciembre de 2026) de Ana T. Vuelve a llamar con confirm:true para aplicar.',
    )
    expect(previa.preview).toMatchObject({ remaining: 99996, after: 99995, unlimited: true })
    expect(hecho).toMatchObject({ ok: true, redeemed: { remaining: 99995, unlimited: true, transactionId: 'txn-ili' } })
  })

  it('paquete normal idéntico a hoy: sin unlimited ni display, y sin consultar la zona', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'P' }])
    mockBalanceFindMany.mockResolvedValueOnce([ili({ unlimited: false, remainingQuantity: 6 })])
    const out = parse(await call('redeem_credit', { venueId: 'v1', search: 'juan' }))
    expect(out.preview).toEqual({
      customer: 'Juan P',
      product: 'Lagree',
      pack: 'Ilimitado',
      expiresAt: VENCE.toISOString(),
      remaining: 6,
      after: 5,
    })
    expect(out.message).toContain('CANJEARÁ 1 crédito')
    expect(mockVenueFindUnique).not.toHaveBeenCalled()
  })
})
