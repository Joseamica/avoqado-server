/**
 * IVA por producto, plan 2, tarea 6: `confirm_order_price_contract` — calcado del arnés de
 * `write-confirm-gating.test.ts` (mocks de guard/audit/servicio). Cubre los 4 casos del brief:
 * (a) sin confirm ⇒ vista previa, el servicio de confirmar NO se llama, sin auditoría;
 * (b) confirm:true sin version ⇒ pide la versión, no confirma;
 * (c) confirm:true completo ⇒ llama al servicio con versionVista/motivo, y audita;
 * (d) sin la feature CFDI ⇒ no llama a nada (ni siquiera la vista previa).
 */
import { registerCfdiTools } from '../../../src/mcp/tools/cfdi'
import type { McpScope } from '../../../src/mcp/scope'

const mockVistaPreviaContrato = jest.fn()
const mockConfirmarContratoIvaIncluido = jest.fn()
const mockAudit = jest.fn()
const mockRequirePermission = jest.fn()
const mockVenuesWithFeatureAccess = jest.fn()
const mockVenueFindUnique = jest.fn()

jest.mock('@/services/fiscal/confirmarContratoDePrecio.service', () => ({
  vistaPreviaContrato: (...a: unknown[]) => mockVistaPreviaContrato(...(a as [])),
  confirmarContratoIvaIncluido: (...a: unknown[]) => mockConfirmarContratoIvaIncluido(...(a as [])),
}))
// El tool de nota de crédito vive en el mismo archivo — se mockea para que registrarlo no cargue
// su cadena real (Storage, PAC, etc.), aunque esta suite no llama a ese tool.
jest.mock('@/services/fiscal/cfdiCreditNote.service', () => ({
  emitRefundCreditNote: jest.fn(),
  getRefundCreditNoteStatus: jest.fn(),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: jest.fn(() => true) }))
jest.mock('@/services/access/basePlan.service', () => ({
  venuesWithFeatureAccess: (...a: unknown[]) => mockVenuesWithFeatureAccess(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => ({ venueId: { in: [v ?? 'v1'] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  const reg = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never
  registerCfdiTools(reg, scope)
})

beforeEach(() => {
  jest.clearAllMocks()
  mockVenuesWithFeatureAccess.mockResolvedValue(new Set(['v1']))
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

const PREVIEW_CONFIRMABLE = {
  orderId: 'o1',
  orderNumber: 'ORD-1',
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  totalMxn: 150.5,
  taxAmountMxn: 0,
  source: 'TPV',
  contratoActual: 'DESCONOCIDO',
  version: 3,
  confirmable: true,
}

describe('confirm_order_price_contract — confirm-gated (IVA por producto, plan 2)', () => {
  it('(a) sin confirm ⇒ devuelve la vista previa, NO llama al servicio de confirmar, sin auditoría', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce(PREVIEW_CONFIRMABLE)

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' }))

    expect(out.requiresConfirmation).toBe(true)
    // El transporte JSON serializa `createdAt` a ISO string; el resto viaja igual.
    expect(out.preview).toEqual({ ...PREVIEW_CONFIRMABLE, createdAt: PREVIEW_CONFIRMABLE.createdAt.toISOString() })
    expect(out.message).toMatch(/ORD-1/)
    expect(out.message).toMatch(/version: 3/)
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('sin confirm, no confirmable ⇒ devuelve el motivo y tampoco llama a nada más', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce({
      ...PREVIEW_CONFIRMABLE,
      confirmable: false,
      motivo: 'Esta venta ya tiene un contrato de precio definido.',
    })

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' }))

    expect(out.ok).toBe(false)
    expect(out.error).toBe('Esta venta ya tiene un contrato de precio definido.')
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('(b) confirm:true sin version ⇒ pide la versión, no confirma', async () => {
    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, motivo: 'x' }))

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/version/)
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('confirm:true sin motivo ⇒ pide el motivo, no confirma', async () => {
    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, version: 3 }))

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/motivo/)
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('(c) confirm:true completo ⇒ llama al servicio con versionVista/motivo y audita', async () => {
    mockConfirmarContratoIvaIncluido.mockResolvedValueOnce({ ok: true })

    const out = parse(
      await call('confirm_order_price_contract', {
        venueId: 'v1',
        orderId: 'o1',
        confirm: true,
        version: 3,
        motivo: 'El cliente lo confirmó por WhatsApp.',
      }),
    )

    expect(mockConfirmarContratoIvaIncluido).toHaveBeenCalledWith({
      venueId: 'v1',
      orderId: 'o1',
      versionVista: 3,
      staffId: 's1',
      motivo: 'El cliente lo confirmó por WhatsApp.',
    })
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ORDER_PRICE_CONTRACT_CONFIRMED_MCP',
        entity: 'Order',
        entityId: 'o1',
        venueId: 'v1',
        data: { motivo: 'El cliente lo confirmó por WhatsApp.', version: 3 },
      }),
    )
    expect(out.ok).toBe(true)
  })

  it('confirm:true pero el servicio rechaza (p. ej. CAMBIO_DESDE_LA_VISTA) ⇒ no audita', async () => {
    mockConfirmarContratoIvaIncluido.mockResolvedValueOnce({
      ok: false,
      code: 'CAMBIO_DESDE_LA_VISTA',
      message: 'La venta cambió desde que la revisaste. Vuelve a pedir la vista previa.',
    })

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, version: 3, motivo: 'x' }))

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/cambió/)
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('(d) sin la feature CFDI ⇒ no llama a nada (ni la vista previa ni el servicio de confirmar)', async () => {
    mockVenuesWithFeatureAccess.mockResolvedValueOnce(new Set())

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' }))

    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(out.feature).toBe('CFDI')
    expect(mockVistaPreviaContrato).not.toHaveBeenCalled()
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('sin la feature CFDI y con confirm:true ⇒ tampoco confirma', async () => {
    mockVenuesWithFeatureAccess.mockResolvedValueOnce(new Set())

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, version: 3, motivo: 'x' }))

    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
  })

  it('guardas en orden: venueFilter → requirePermission(cfdi:issue) → feature CFDI', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce(PREVIEW_CONFIRMABLE)

    await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' })

    expect(mockRequirePermission).toHaveBeenCalledWith('cfdi:issue', 'v1')
    expect(mockVenuesWithFeatureAccess).toHaveBeenCalledWith(['v1'], 'CFDI')
  })
})
