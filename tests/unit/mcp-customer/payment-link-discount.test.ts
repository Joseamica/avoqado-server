import { registerPaymentLinkTools } from '../../../src/mcp/tools/paymentLinks'
import type { McpScope } from '../../../src/mcp/scope'

// Task 7 — las dos tools que crean ligas aceptan `discount`; exigen discounts:apply (+ discounts:read en catálogo)
// ANTES del preview y del confirm, porque llaman al servicio directo y se saltan las rutas.
const mockCreate = jest.fn()
const mockAudit = jest.fn()
const mockResolver = jest.fn()
const perms: string[] = []
const denied = new Set<string>()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (perm: string) => {
      perms.push(perm)
      if (denied.has(perm)) throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  createPaymentLink: (...a: unknown[]) => mockCreate(...(a as [])),
  updatePaymentLink: jest.fn(),
}))
jest.mock('@/services/dashboard/paymentLinkDiscount', () => ({
  ...jest.requireActual('@/services/dashboard/paymentLinkDiscount'),
  resolverDescuentoDeEntrada: (...a: unknown[]) => mockResolver(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Mexico_City' }) },
    discount: { findUnique: jest.fn().mockResolvedValue(null) },
    customer: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', firstName: 'Ana', lastName: null, email: null, phone: null }) },
  },
}))

const CUSTOMER = 'cm00000000000000000000001'
const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (tool: string, args: Record<string, unknown>) => handlers.get(tool)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const MANUAL = { mode: 'MANUAL', type: 'PERCENTAGE', value: 15, name: 'Buen Fin' }
const FOTO = { v: 1, origen: 'MANUAL', discountId: null, type: 'PERCENTAGE', value: 15, name: 'Buen Fin' }

beforeAll(() => {
  registerPaymentLinkTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  perms.length = 0
  denied.clear()
  mockResolver.mockResolvedValue({ foto: FOTO, discountId: null })
  mockCreate.mockResolvedValue({
    id: 'l1',
    shortCode: 'abc',
    title: 'Clase',
    amountType: 'FIXED',
    amount: 1000,
    status: 'ACTIVE',
    customer: null,
  })
})

describe.each([
  ['create_payment_link', { venueId: 'v1', title: 'Clase', amount: 1000, discount: MANUAL }],
  ['create_customer_payment_link', { venueId: 'v1', customerId: CUSTOMER, title: 'Clase', amount: 1000, discount: MANUAL }],
])('%s con descuento', (tool, base) => {
  it('sin discounts:apply no hay preview ni se llama al servicio', async () => {
    denied.add('discounts:apply')
    await expect(call(tool, base)).rejects.toThrow('discounts:apply')
    await expect(call(tool, { ...base, confirm: true })).rejects.toThrow('discounts:apply')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockResolver).not.toHaveBeenCalled()
  })

  it('descuento del catálogo también pide discounts:read', async () => {
    denied.add('discounts:read')
    const args = { ...base, discount: { mode: 'CATALOG', discountId: 'cdisc00000000000000000001' } }
    await expect(call(tool, { ...args, confirm: true })).rejects.toThrow('discounts:read')
    expect(perms).toContain('discounts:apply')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('vista previa: «$1,000 − $150 = $850» y no crea', async () => {
    const out = parse(await call(tool, base))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.message).toContain('$1,000 − $150 = $850')
    expect(out.preview.discount).toMatchObject({ name: 'Buen Fin', base: 1000, discount: 150, net: 850 })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('con confirm crea la liga pasando el descuento al servicio', async () => {
    const out = parse(await call(tool, { ...base, confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ discount: MANUAL })
  })

  it('donación con descuento: ni preview ni creación', async () => {
    const out = parse(await call(tool, { ...base, purpose: 'donation' }))
    expect(out).toMatchObject({ ok: false, error: 'Las donaciones no llevan descuento' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('la auditoría MCP registra el descuento', async () => {
    mockCreate.mockImplementation(async (_v: unknown, _d: unknown, _s: unknown, _k: unknown, onCreated?: (l: unknown) => Promise<void>) => {
      const link = {
        id: 'l1',
        shortCode: 'abc',
        title: 'Clase',
        amountType: 'FIXED',
        amount: 1000,
        status: 'ACTIVE',
        customer: null,
        discount: FOTO,
      }
      if (onCreated) await onCreated(link)
      return link
    })
    await call(tool, { ...base, confirm: true })
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({ discount: { type: 'PERCENTAGE', value: 15, origen: 'MANUAL', discountId: null } }),
      }),
    )
  })

  it('sin descuento no pide permisos de descuentos', async () => {
    const { discount: _d, ...sinDescuento } = base as Record<string, unknown>
    await call(tool, { ...sinDescuento, confirm: true })
    expect(perms.some(p => p.startsWith('discounts:'))).toBe(false)
    expect(mockCreate.mock.calls[0][1]).not.toHaveProperty('discount')
  })
})
