import { registerPaymentLinkTools } from '../../../src/mcp/tools/paymentLinks'
import type { McpScope } from '../../../src/mcp/scope'
import { DIRECTORY_TOOLS } from '../../../src/mcp/directory/catalog'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'

const mockCreate = jest.fn()
const mockAudit = jest.fn()
const mockGroupFindMany = jest.fn()
const mockGroupFindFirst = jest.fn()
const mockLinkFind = jest.fn()
const mockPermiso = jest.fn()
const mockLinkCount = jest.fn().mockResolvedValue(1)

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockPermiso(...(a as [])),
  }),
}))
jest.mock('@/services/dashboard/paymentLink.service', () => ({ createPaymentLink: (...a: unknown[]) => mockCreate(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    paymentLink: { count: (...a: unknown[]) => mockLinkCount(...(a as [])), findMany: (...a: unknown[]) => mockLinkFind(...(a as [])) },
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
const listPrendas = (args: Record<string, unknown>) => handlers.get('list_garment_payment_links')!(args, {})
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
    // El servicio guarda la liga por prenda como FIXED (precio de la talla) con importe vacío.
    mockCreate.mockResolvedValueOnce({ id: 'pl-9', shortCode: 'XY', title: 'Vestido', amountType: 'FIXED', amount: null, status: 'ACTIVE' })
    const out = parse(await create({ venueId: 'v1', title: 'Vestido', productGroupId: 'g1', confirm: true }))
    expect(mockCreate).toHaveBeenCalledWith('v1', expect.objectContaining({ purpose: 'ITEM', productGroupId: 'g1' }), 's1')
    expect(mockCreate.mock.calls[0][1].amount).toBeUndefined()
    expect(out.ok).toBe(true)
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ entityId: 'pl-9', data: expect.objectContaining({ productGroupId: 'g1' }) })
  })

  it('G2: la respuesta y la auditoría dicen lo GUARDADO (FIXED), nunca «OPEN»', async () => {
    mockGroupFindFirst.mockResolvedValueOnce({ id: 'g1', name: 'Vestido lino' })
    mockCreate.mockResolvedValueOnce({ id: 'pl-9', shortCode: 'XY', title: 'Vestido', amountType: 'FIXED', amount: null, status: 'ACTIVE' })
    const out = parse(await create({ venueId: 'v1', title: 'Vestido', productGroupId: 'g1', confirm: true }))
    expect(out.paymentLink.amountType).toBe('FIXED')
    expect(mockAudit.mock.calls[0][1].data.amountType).toBe('FIXED')
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

/**
 * H: `list_payment_links` está en el catálogo certificado (directorio): cambiar su respuesta cambia lo que se revisó. La
 * prenda se ve con una tool NUEVA de sólo lectura, sólo en el modo libre (`/mcp`), con las mismas guardas.
 */
describe('list_payment_links queda como la certificada', () => {
  it('no trae «garment» ni consulta la familia', async () => {
    mockLinkFind.mockResolvedValueOnce([
      {
        shortCode: 'A',
        title: 'a',
        description: null,
        purpose: 'ITEM',
        amountType: 'FIXED',
        amount: null,
        currency: 'MXN',
        status: 'ACTIVE',
        expiresAt: null,
        createdAt: new Date(),
      },
    ])
    const out = parse(await list({ venueId: 'v1' }))
    expect(out.links[0]).not.toHaveProperty('garment')
    expect(mockLinkFind.mock.calls[0][0].select).not.toHaveProperty('productGroup')
  })
})

describe('list_garment_payment_links (modo libre)', () => {
  const base = {
    shortCode: 'A',
    title: 'Vestido',
    status: 'ACTIVE',
    currency: 'MXN',
    expiresAt: null,
    createdAt: new Date('2026-11-12T00:00:00Z'),
    productGroup: { id: 'g1', name: 'Vestido lino' },
  }

  it('lista sólo ligas por prenda del negocio, con el nombre de la prenda, paginada y con tope', async () => {
    mockLinkCount.mockResolvedValueOnce(3)
    mockLinkFind.mockResolvedValueOnce([base])
    const out = parse(await listPrendas({ venueId: 'v1', limit: 1 }))
    expect(mockPermiso).toHaveBeenCalledWith('payment-link:read', 'v1')
    const args = mockLinkFind.mock.calls[0][0]
    expect(args.where).toMatchObject({ venueId: { in: ['v1'] }, productGroupId: { not: null }, status: 'ACTIVE' })
    expect(args.take).toBe(1)
    expect(out).toMatchObject({ venueId: 'v1', count: 1, total: 3, hasMore: true, nextOffset: 1 })
    expect(out.links[0]).toMatchObject({
      shortCode: 'A',
      title: 'Vestido',
      garment: 'Vestido lino',
      productGroupId: 'g1',
      status: 'ACTIVE',
    })
  })

  it('sin permiso de lectura no consulta', async () => {
    mockPermiso.mockImplementationOnce(() => {
      throw new Error('sin permiso')
    })
    await expect(listPrendas({ venueId: 'v1' })).rejects.toThrow('sin permiso')
    expect(mockLinkFind).not.toHaveBeenCalled()
  })

  it('es lectura, y NO entra al catálogo certificado', () => {
    expect(TOOL_EFFECTS.list_garment_payment_links).toBe('read')
    expect(DIRECTORY_TOOLS.has('list_garment_payment_links')).toBe(false)
  })
})
