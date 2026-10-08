/**
 * C1 · Tarea 12: el listado de las ventas que no entraron a la factura global también por el MCP (`global_invoice_excluded_sales`). Es una
 * LECTURA con el mismo permiso que el panel (`cfdi:view`) y la misma feature (CFDI): el periodo GUARDADO de una global que ya existe
 * (`principalCfdiId`), uno reciente (`desde`) o, sin nada, el último cerrado. Online a propósito (spec §10).
 */
import { registerCfdiTools } from '../../../src/mcp/tools/cfdi'
import type { McpScope } from '../../../src/mcp/scope'

const mockAudit = jest.fn()
const mockVenueFilter = jest.fn((v?: string) => ({ venueId: { in: [v ?? 'v1'] } }))
const mockRequirePermission = jest.fn()
const mockVenuesWithFeatureAccess = jest.fn()
const mockEmisorFindMany = jest.fn()
const mockListar = jest.fn()

jest.mock('@/services/fiscal/cfdiGlobal.service', () => ({
  listarExcluidasDeLaGlobal: (...a: unknown[]) => mockListar(...a),
  vistaPreviaComplementaria: jest.fn(),
  vistaPreviaPrincipal: jest.fn(),
  issueGlobalForEmisor: jest.fn(),
  emitirGlobalComplementaria: jest.fn(),
}))
// Viven en el mismo archivo: se mockean para que registrar las tools no cargue su cadena real (Storage, PAC…).
jest.mock('@/services/fiscal/cfdiEmail.service', () => ({ sendCfdiByEmail: jest.fn() }))
jest.mock('@/services/fiscal/cfdiCreditNote.service', () => ({ emitRefundCreditNote: jest.fn(), getRefundCreditNoteStatus: jest.fn() }))
jest.mock('@/services/fiscal/confirmarContratoDePrecio.service', () => ({
  vistaPreviaContrato: jest.fn(),
  confirmarContratoIvaIncluido: jest.fn(),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: jest.fn(() => true) }))
jest.mock('@/services/access/basePlan.service', () => ({
  venuesWithFeatureAccess: (...a: unknown[]) => mockVenuesWithFeatureAccess(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (...a: unknown[]) => mockVenueFilter(...(a as [string | undefined])),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    cfdi: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 }, _count: { _all: 0 } }),
    },
    fiscalEmisor: { findMany: (...a: unknown[]) => mockEmisorFindMany(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('global_invoice_excluded_sales')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  const reg = {
    tool: (...a: unknown[]) => {
      handlers.set(a[0] as string, a[a.length - 1] as never)
    },
  } as never
  registerCfdiTools(reg, scope)
})

const LISTADO = {
  periodo: { meses: '05', anio: 2026, desde: new Date('2026-05-01T06:00:00.000Z'), hasta: new Date('2026-06-01T06:00:00.000Z') },
  estadoDelPeriodo: 'TIMBRADA',
  totales: { porMotivo: { CORREGIDA_DESPUES: 1, EFECTIVO: 1 }, total: 2, completo: true, revisadas: 3 },
  corregidasPendientes: { n: 1, completo: true },
  ultimaCaptura: { al: new Date('2026-06-02T09:00:00.000Z'), excluidas: { PRODUCTO_POR_REVISAR: 1 } },
  excluidas: [
    { orderId: 'o1', folio: 'A-17', cobradoCents: 11650, motivo: 'EFECTIVO', texto: 'T-EFECTIVO', detalle: 'T-EFECTIVO' },
    {
      orderId: 'o2',
      folio: 'A-18',
      cobradoCents: 20000,
      motivo: 'CORREGIDA_DESPUES',
      texto: 'T-CORREGIDA',
      detalle: 'T-CORREGIDA',
    },
  ],
  siguiente: 'o2',
  revisadas: 3,
  globalApagada: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVenuesWithFeatureAccess.mockResolvedValue(new Set(['v1']))
  mockEmisorFindMany.mockResolvedValue([{ id: 'e1', rfc: 'AAA010101AAA', legalName: 'Café' }])
  mockListar.mockResolvedValue(LISTADO)
})

describe('global_invoice_excluded_sales — lectura, `cfdi:view`, feature CFDI', () => {
  it('🔴 con el permiso y la facturación: el listado del servicio con su periodo, totales, captura y las ventas en pesos', async () => {
    const r = parse(await call({ venueId: 'v1', principalCfdiId: 'g1', cursor: 'o0' }))
    expect(r).toEqual({
      ok: true,
      periodo: { meses: '05', anio: 2026, desde: '2026-05-01T06:00:00.000Z', hasta: '2026-06-01T06:00:00.000Z' },
      estadoDelPeriodo: 'TIMBRADA',
      totales: { porMotivo: { CORREGIDA_DESPUES: 1, EFECTIVO: 1 }, total: 2, completo: true, revisadas: 3 },
      corregidasPendientes: { n: 1, completo: true },
      ultimaCaptura: { al: '2026-06-02T09:00:00.000Z', excluidas: { PRODUCTO_POR_REVISAR: 1 } },
      ventas: [
        {
          orderId: 'o1',
          folio: 'A-17',
          cobradoCents: 11650,
          cobradoMxn: 116.5,
          motivo: 'EFECTIVO',
          texto: 'T-EFECTIVO',
          detalle: 'T-EFECTIVO',
        },
        {
          orderId: 'o2',
          folio: 'A-18',
          cobradoCents: 20000,
          cobradoMxn: 200,
          motivo: 'CORREGIDA_DESPUES',
          texto: 'T-CORREGIDA',
          detalle: 'T-CORREGIDA',
        },
      ],
      siguiente: 'o2',
      globalApagada: false,
    })
    // El mismo permiso que el panel (lectura) y el periodo por el id de la principal (C1-32): el servicio recibe el emisor resuelto.
    expect(mockRequirePermission).toHaveBeenCalledWith('cfdi:view', 'v1')
    expect(mockListar).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'v1', emisorId: 'e1', principalId: 'g1', cursor: 'o0', now: expect.any(Date) }),
    )
    // Es una lectura: no se audita como escritura.
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('🔴 ola final: con la global de Avoqado APAGADA para el RFC (0 comercios en la global, interruptor apagado) lo dice', async () => {
    mockListar.mockResolvedValue({ ...LISTADO, globalApagada: true })
    const r = parse(await call({ venueId: 'v1' }))
    expect(r).toMatchObject({ ok: true, globalApagada: true })
  })

  it('🔴 un periodo reciente por `desde` llega al servicio tal cual', async () => {
    await call({ venueId: 'v1', desde: '2026-05-01T06:00:00.000Z' })
    expect(mockListar).toHaveBeenCalledWith(expect.objectContaining({ emisorId: 'e1', desde: '2026-05-01T06:00:00.000Z' }))
  })

  it('🔴 sin la facturación ⇒ `planRequired` y no lee nada', async () => {
    mockVenuesWithFeatureAccess.mockResolvedValue(new Set())
    const r = parse(await call({ venueId: 'v1' }))
    expect(r).toMatchObject({ ok: false, planRequired: true, feature: 'CFDI' })
    expect(mockListar).not.toHaveBeenCalled()
    expect(mockEmisorFindMany).not.toHaveBeenCalled()
  })

  it('🔴 con varios RFC y sin `emisorId` ⇒ pregunta cuál (con sus opciones) y no lee', async () => {
    mockEmisorFindMany.mockResolvedValue([
      { id: 'e1', rfc: 'AAA010101AAA', legalName: 'Café' },
      { id: 'e2', rfc: 'BBB010101BBB', legalName: 'Panadería' },
    ])
    const r = parse(await call({ venueId: 'v1' }))
    expect(r).toMatchObject({
      ok: false,
      needsInput: true,
      field: 'emisorId',
      opciones: [
        { emisorId: 'e1', rfc: 'AAA010101AAA', nombre: 'Café' },
        { emisorId: 'e2', rfc: 'BBB010101BBB', nombre: 'Panadería' },
      ],
    })
    expect(mockListar).not.toHaveBeenCalled()
  })

  it('🔴 un RFC que no es del local ⇒ error claro, sin leer', async () => {
    mockEmisorFindMany.mockResolvedValue([])
    const r = parse(await call({ venueId: 'v1', emisorId: 'otro' }))
    expect(r).toEqual({ ok: false, error: 'No encontré ese RFC emisor en este local.' })
    expect(mockListar).not.toHaveBeenCalled()
  })

  it('🔴 un periodo viejo (o una global de antes del registro de sus ventas) ⇒ `ok: false` con el texto del servicio', async () => {
    mockListar.mockRejectedValue(new Error('Ese periodo ya no se emite desde aquí; pídelo a soporte.'))
    const r = parse(await call({ venueId: 'v1', desde: '2020-01-01T06:00:00.000Z' }))
    expect(r).toEqual({ ok: false, error: 'Ese periodo ya no se emite desde aquí; pídelo a soporte.' })
  })
})
