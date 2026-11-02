/**
 * `order_invoice_status` (28-oct-2026, «Nueva factura»): ¿esta venta ya está facturada? La regla es la del candado de emisión
 * (`facturaDeLaVenta.ts`), la misma con la que el buscador del dashboard marca «Ya facturada».
 *
 * 🔴 Lo que fija: sólo busca en locales con facturación activa y permiso de ver facturas; con varias coincidencias pregunta (nunca elige
 * la más reciente); VIGENTE / EN_CANCELACION / SIN_FACTURA según la regla; montos en pesos.
 */
import { registerCfdiTools } from '../../../src/mcp/tools/cfdi'
import type { McpScope } from '../../../src/mcp/scope'
import { Prisma } from '@prisma/client'
import { FACTURAS_QUE_CUENTAN_DE_LA_VENTA } from '../../../src/services/fiscal/facturaDeLaVenta'

const mockOrderFindMany = jest.fn()
const mockEntitled = jest.fn(async () => new Set(['v1', 'v2']))
const mockHasPermission = jest.fn((_access: unknown, _perm: string) => true)
const mockRequirePermission = jest.fn()

jest.mock('@/services/fiscal/facturaConDevolucion', () => ({
  facturasConNotasPendientes: jest.fn(async () => []),
  contarFacturasConNotasPendientes: jest.fn(async () => 0),
}))
jest.mock('@/services/fiscal/cfdiEmail.service', () => ({ sendCfdiByEmail: jest.fn() }))
jest.mock('@/services/fiscal/cfdiCreditNote.service', () => ({ emitRefundCreditNote: jest.fn(), getRefundCreditNoteStatus: jest.fn() }))
jest.mock('@/services/fiscal/confirmarContratoDePrecio.service', () => ({
  vistaPreviaContrato: jest.fn(),
  confirmarContratoIvaIncluido: jest.fn(),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: (a: unknown, p: string) => mockHasPermission(a, p) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: () => mockEntitled() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: jest.fn(), requirePermission: (...a: unknown[]) => mockRequirePermission(...a) }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { order: { findMany: (...a: unknown[]) => mockOrderFindMany(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1', 'v2', 'v3'],
  perVenueAccess: new Map([
    ['v1', {}],
    ['v2', {}],
    ['v3', {}],
  ]),
} as unknown as McpScope
beforeAll(() => {
  registerCfdiTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  mockOrderFindMany.mockReset()
  mockEntitled.mockImplementation(async () => new Set(['v1', 'v2']))
  mockHasPermission.mockImplementation(() => true)
  mockRequirePermission.mockReset()
})

async function llamar(args: Record<string, unknown>) {
  const res = await handlers.get('order_invoice_status')!(args, {})
  return JSON.parse(res.content[0].text)
}

const venta = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  venueId: 'v1',
  orderNumber: 'ORD-77',
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  total: new Prisma.Decimal('116.00'),
  createdAt: new Date('2026-10-20T18:00:00.000Z'),
  venue: { name: 'Testarudo', timezone: 'America/Mexico_City' },
  cfdis: [],
  ...over,
})
const factura = (over: Record<string, unknown> = {}) => ({
  id: 'cf1',
  replacesCfdiId: null,
  serie: 'A',
  folio: '12',
  uuid: 'UUID-1',
  status: 'STAMPED',
  cancelStatus: null,
  receptorNombre: 'Ana López',
  receptorRfc: 'LOAA800101AB1',
  totalCents: 11600,
  stampedAt: new Date('2026-10-20T18:10:00.000Z'),
  ...over,
})

describe('order_invoice_status', () => {
  it('pide sólo un dato: número o id', async () => {
    expect(await llamar({})).toMatchObject({ found: false, needsInput: true, field: 'orderNumber' })
    expect(await llamar({ orderNumber: 'ORD-1', orderId: 'x' })).toMatchObject({ found: false, needsInput: true })
    expect(mockOrderFindMany).not.toHaveBeenCalled()
  })

  it('busca sólo en locales con facturación activa y permiso de ver facturas, con las facturas que cuentan', async () => {
    mockHasPermission.mockImplementation((_a, _p) => _a !== scope.perVenueAccess.get('v2'))
    mockOrderFindMany.mockResolvedValue([venta()])
    await llamar({ orderNumber: ' ord-77 ' })

    const args = mockOrderFindMany.mock.calls[0][0]
    expect(args.where.venueId).toEqual({ in: ['v1'] }) // v3 sin CFDI; v2 sin permiso
    expect(args.where.orderNumber).toEqual({ equals: 'ord-77', mode: 'insensitive' })
    expect(args.select.cfdis.where).toEqual(FACTURAS_QUE_CUENTAN_DE_LA_VENTA)
    expect(args.take).toBe(11)
  })

  it('con un venueId sin facturación activa dice que falta el plan', async () => {
    const res = await llamar({ venueId: 'v3', orderNumber: 'ORD-77' })
    expect(res).toMatchObject({ ok: false, planRequired: true, feature: 'CFDI' })
    expect(mockRequirePermission).toHaveBeenCalledWith('cfdi:view', 'v3')
    expect(mockOrderFindMany).not.toHaveBeenCalled()
  })

  it('VIGENTE: devuelve la factura en pesos y la fecha del local', async () => {
    mockOrderFindMany.mockResolvedValue([venta({ cfdis: [factura()] })])
    const res = await llamar({ orderNumber: 'ORD-77' })
    expect(res).toMatchObject({
      found: true,
      orderNumber: 'ORD-77',
      estado: 'VIGENTE',
      totalMxn: 116,
      fecha: '2026-10-20 12:00',
      factura: { folio: 'A-12', uuid: 'UUID-1', totalMxn: 116, timbrada: '2026-10-20 12:10' },
    })
  })

  it('EN_CANCELACION no se presenta como facturada; sin facturas que cuenten es SIN_FACTURA', async () => {
    mockOrderFindMany.mockResolvedValue([venta({ cfdis: [factura({ cancelStatus: 'REQUESTED' })] })])
    expect(await llamar({ orderNumber: 'ORD-77' })).toMatchObject({ estado: 'EN_CANCELACION', factura: { uuid: 'UUID-1' } })

    mockOrderFindMany.mockResolvedValue([venta()])
    expect(await llamar({ orderNumber: 'ORD-77' })).toMatchObject({ estado: 'SIN_FACTURA', factura: null })
  })

  it('con sustitución manda la timbrada sin cancelación, no la que se está cancelando', async () => {
    mockOrderFindMany.mockResolvedValue([
      venta({
        cfdis: [
          factura({ id: 'A', uuid: 'ORIGINAL', cancelStatus: 'REQUESTED' }),
          factura({ id: 'B', replacesCfdiId: 'A', uuid: 'SUSTITUTA', folio: '13' }),
        ],
      }),
    ])
    expect(await llamar({ orderNumber: 'ORD-77' })).toMatchObject({ estado: 'VIGENTE', factura: { uuid: 'SUSTITUTA', folio: 'A-13' } })
  })

  it('🔴 Codex código r1 #1: el SAT rechazó cancelar la original y las dos siguen timbradas ⇒ informa la SUSTITUTA', async () => {
    mockOrderFindMany.mockResolvedValue([
      venta({
        cfdis: [
          factura({ id: 'A', uuid: 'ORIGINAL', cancelStatus: 'REJECTED' }),
          factura({ id: 'B', replacesCfdiId: 'A', uuid: 'SUSTITUTA', folio: '13' }),
        ],
      }),
    ])
    expect(await llamar({ orderNumber: 'ORD-77' })).toMatchObject({ estado: 'VIGENTE', factura: { uuid: 'SUSTITUTA' } })
  })

  it('varias coincidencias: pregunta la sucursal y no elige la más reciente', async () => {
    mockOrderFindMany.mockResolvedValue([
      venta(),
      venta({ id: 'o2', venueId: 'v2', venue: { name: 'Otro', timezone: 'America/Mexico_City' } }),
    ])
    const res = await llamar({ orderNumber: 'ORD-77' })
    expect(res).toMatchObject({ found: false, needsInput: true, field: 'venueId' })
    expect(res.candidates.map((c: { orderId: string }) => c.orderId)).toEqual(['o1', 'o2'])
  })

  it('sin coincidencias lo dice', async () => {
    mockOrderFindMany.mockResolvedValue([])
    expect(await llamar({ orderNumber: 'ORD-0' })).toMatchObject({ found: false })
  })
})
