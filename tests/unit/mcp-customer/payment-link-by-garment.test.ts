import { registerPaymentLinkTools } from '../../../src/mcp/tools/paymentLinks'
import type { McpScope } from '../../../src/mcp/scope'

const mockCreate = jest.fn()
const mockAudit = jest.fn()
const mockGroupFindMany = jest.fn()
const mockGroupFindFirst = jest.fn()
const mockLinkFind = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/services/dashboard/paymentLink.service', () => ({ createPaymentLink: (...a: unknown[]) => mockCreate(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    paymentLink: { count: jest.fn().mockResolvedValue(1), findMany: (...a: unknown[]) => mockLinkFind(...(a as [])) },
    productGroup: {
      findMany: (...a: unknown[]) => mockGroupFindMany(...(a as [])),
      findFirst: (...a: unknown[]) => mockGroupFindFirst(...(a as [])),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const create = (args: Record<string, unknown>) => handlers.get('create_payment_link')!(args, {})
const list = (args: Record<string, unknown>) => handlers.get('list_payment_links')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerPaymentLinkTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('create_payment_link por prenda', () => {
  it('vista previa con productGroupId: no crea', async () => {
    mockGroupFindFirst.mockResolvedValueOnce({ id: 'g1', name: 'Vestido lino' })
    const out = parse(await create({ venueId: 'v1', title: 'Vestido', productGroupId: 'g1' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toMatchObject({ purpose: 'ITEM', garment: 'Vestido lino', productGroupId: 'g1' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('confirm crea con purpose ITEM + productGroupId, sin importe, y audita', async () => {
    mockGroupFindFirst.mockResolvedValueOnce({ id: 'g1', name: 'Vestido lino' })
    mockCreate.mockResolvedValueOnce({ id: 'pl-9', shortCode: 'XY', title: 'Vestido', amountType: 'OPEN', amount: null, status: 'ACTIVE' })
    const out = parse(await create({ venueId: 'v1', title: 'Vestido', productGroupId: 'g1', confirm: true }))
    expect(mockCreate).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({ purpose: 'ITEM', productGroupId: 'g1', amountType: 'OPEN' }),
      's1',
    )
    expect(mockCreate.mock.calls[0][1].amount).toBeUndefined()
    expect(out.ok).toBe(true)
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ entityId: 'pl-9', data: expect.objectContaining({ productGroupId: 'g1' }) })
  })

  it('garment por nombre: una coincidencia se resuelve', async () => {
    mockGroupFindMany.mockResolvedValueOnce([{ id: 'g1', name: 'Vestido lino' }])
    const out = parse(await create({ venueId: 'v1', title: 'Vestido', garment: 'lino' }))
    expect(out.preview).toMatchObject({ productGroupId: 'g1' })
  })

  it('garment ambiguo: devuelve candidatos y no crea ni elige', async () => {
    mockGroupFindMany.mockResolvedValueOnce([
      { id: 'g1', name: 'Vestido lino' },
      { id: 'g2', name: 'Vestido seda' },
    ])
    const out = parse(await create({ venueId: 'v1', title: 'V', garment: 'vestido', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.candidates).toEqual([
      { id: 'g1', name: 'Vestido lino' },
      { id: 'g2', name: 'Vestido seda' },
    ])
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('garment sin coincidencias: error', async () => {
    mockGroupFindMany.mockResolvedValueOnce([])
    const out = parse(await create({ venueId: 'v1', title: 'V', garment: 'zzz', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['amount', { amount: 100 }],
    ['discount', { discount: { mode: 'CATALOG', discountId: 'd1' } }],
    ['donation', { purpose: 'donation' }],
  ])('incompatible con %s', async (_n, extra) => {
    const out = parse(await create({ venueId: 'v1', title: 'V', productGroupId: 'g1', confirm: true, ...extra }))
    expect(out.ok).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('el rechazo del servicio (sin plan / no Stripe) llega como error', async () => {
    mockGroupFindFirst.mockResolvedValueOnce({ id: 'g1', name: 'V' })
    mockCreate.mockRejectedValueOnce(new Error('Las ligas por prenda son del plan Pro'))
    const out = parse(await create({ venueId: 'v1', title: 'V', productGroupId: 'g1', confirm: true }))
    expect(out).toMatchObject({ ok: false, error: 'Las ligas por prenda son del plan Pro' })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('regresión: importe y donación siguen igual', async () => {
    mockCreate.mockResolvedValue({ id: 'p', shortCode: 'S', title: 'T', amountType: 'FIXED', amount: 5, status: 'ACTIVE' })
    await create({ venueId: 'v1', title: 'T', amount: 5, confirm: true })
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ purpose: 'PAYMENT', amountType: 'FIXED', amount: 5 })
    expect(mockCreate.mock.calls[0][1].productGroupId).toBeUndefined()
    await create({ venueId: 'v1', title: 'T', purpose: 'donation', confirm: true })
    expect(mockCreate.mock.calls[1][1]).toMatchObject({ purpose: 'DONATION', amountType: 'OPEN' })
    expect(mockGroupFindFirst).not.toHaveBeenCalled()
  })
})

describe('list_payment_links con garment', () => {
  it('trae el nombre de la prenda (o null)', async () => {
    const base = {
      description: null,
      purpose: 'ITEM',
      amountType: 'OPEN',
      amount: null,
      currency: 'MXN',
      status: 'ACTIVE',
      expiresAt: null,
      createdAt: new Date(),
    }
    mockLinkFind.mockResolvedValueOnce([
      { ...base, shortCode: 'A', title: 'a', productGroup: { id: 'g1', name: 'Vestido lino' } },
      { ...base, shortCode: 'B', title: 'b', purpose: 'PAYMENT', productGroup: null },
    ])
    const out = parse(await list({ venueId: 'v1' }))
    expect(out.links.map((l: { garment: string | null }) => l.garment)).toEqual(['Vestido lino', null])
  })
})
