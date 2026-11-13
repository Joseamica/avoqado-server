/**
 * Dónde se imprime el delivery por MCP: lectura (guardada + efectiva, una consulta por lote) y
 * `set_delivery_channel_printing` en dos pasos.
 */
import { registerDeliveryChannelTools } from '../../../src/mcp/tools/deliveryChannels'
import type { McpScope } from '../../../src/mcp/scope'

const mockLinksFind = jest.fn()
const mockLinkFirst = jest.fn()
const mockStationsFind = jest.fn()
const mockUpdate = jest.fn()
const mockAudit = jest.fn()
const mockWriteScope = jest.fn()
const mockGate = jest.fn()
const mockPermission = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    deliveryChannelLink: { findMany: (...a: unknown[]) => mockLinksFind(...a), findFirst: (...a: unknown[]) => mockLinkFirst(...a) },
    printStation: { findMany: (...a: unknown[]) => mockStationsFind(...a) },
    deliveryConnectIntent: { findMany: jest.fn().mockResolvedValue([]) },
  },
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: v }),
    requirePermission: (...a: unknown[]) => mockPermission(...a),
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: (...a: unknown[]) => mockWriteScope(...a) }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockGate(...a) }))
jest.mock('@/services/delivery-channels/core/deliveryChannelLink.service', () => ({
  updateChannelLink: (...a: unknown[]) => mockUpdate(...a),
}))
jest.mock('@/services/delivery-channels/core/deliverySummary.service', () => ({
  getDeliveryDailySummary: jest.fn().mockResolvedValue({ channels: [] }),
}))
jest.mock('@/services/delivery-channels/core/deliveryHours.service', () => ({
  resolveDeliveryHours: jest.fn().mockResolvedValue({ horario: null, fuente: null }),
}))
jest.mock('@/services/delivery-channels/core/injectionRate.service', () => ({
  calcularTasaInyeccion: jest.fn().mockResolvedValue({}),
}))
jest.mock('@/services/delivery-channels/core/menuSync.service', () => ({
  menuSyncStatusOf: jest.fn(),
  revisionDeMenuOf: jest.fn(),
}))
jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({ hasAdapter: () => true }))
jest.mock('@/services/delivery-channels/core/deliveryCashPending.service', () => ({ listDeliveryCashPending: jest.fn() }))
jest.mock('@/services/delivery-channels/core/productosDelCanal', () => ({ resumenDeProductos: () => ({ cuantos: null }) }))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const handlers = new Map<string, Handler>()
registerDeliveryChannelTools(
  { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never,
  { staffId: 'staff1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map(), isSuperAdmin: false } as McpScope,
)
const call = (tool: string, args: Record<string, unknown>) => handlers.get(tool)!(args, {})

const link = (id: string, provider: string, impresion?: unknown) => ({
  id,
  provider,
  status: 'ACTIVE',
  lastMenuSyncAt: null,
  snoozedUntil: null,
  lastMenuHash: null,
  webhookSecret: 'x',
  config: impresion ? { impresion } : {},
})

beforeEach(() => {
  ;[mockLinksFind, mockLinkFirst, mockStationsFind, mockUpdate, mockAudit, mockWriteScope, mockGate, mockPermission].forEach(m =>
    m.mockReset(),
  )
  mockGate.mockResolvedValue(null)
  mockStationsFind.mockResolvedValue([{ id: 'st1', active: true, sendsComanda: true }])
})

describe('delivery_channels: impresion', () => {
  it('trae guardada y efectiva por canal con UNA sola consulta de estaciones', async () => {
    mockLinksFind.mockResolvedValue([
      link('l1', 'RAPPI', { comanda: 'UNA_ESTACION', estacionId: 'st1', empaque: 'NO' }),
      link('l2', 'UBER_EATS'),
    ])
    const r = parse(await call('delivery_channels', { venueId: 'v1' }))
    expect(mockStationsFind).toHaveBeenCalledTimes(1)
    expect(mockStationsFind.mock.calls[0][0].take).toBeGreaterThan(0)
    expect(r.channels[0].impresion.guardada).toEqual({ comanda: 'UNA_ESTACION', estacionId: 'st1', empaque: 'NO' })
    expect(r.channels[0].impresion.efectiva).toEqual({
      proveedor: 'RAPPI',
      estacionUnicaId: 'st1',
      empaque: false,
      empaqueEstacionId: null,
    })
    expect(r.channels[0].impresion.motivo).toBeUndefined()
    expect(r.channels[1].impresion.guardada).toEqual({ comanda: 'SALON', empaque: 'NEGOCIO' })
  })

  it('estación borrada: efectiva a null y motivo claro', async () => {
    mockStationsFind.mockResolvedValue([])
    mockLinksFind.mockResolvedValue([link('l1', 'RAPPI', { comanda: 'UNA_ESTACION', estacionId: 'gone', empaque: 'NEGOCIO' })])
    const r = parse(await call('delivery_channels', { venueId: 'v1' }))
    expect(r.channels[0].impresion.efectiva.estacionUnicaId).toBeNull()
    expect(r.channels[0].impresion.motivo).toBe('La estación elegida ya no existe o está apagada: se imprime como en el salón')
  })

  it('sin estaciones elegidas no consulta estaciones', async () => {
    mockLinksFind.mockResolvedValue([link('l2', 'UBER_EATS')])
    await call('delivery_channels', { venueId: 'v1' })
    expect(mockStationsFind).not.toHaveBeenCalled()
  })
})

describe('set_delivery_channel_printing', () => {
  const args = { venueId: 'v1', linkId: 'l1', comanda: 'UNA_ESTACION', estacionId: 'st1', empaque: 'NO' }
  beforeEach(() => mockLinkFirst.mockResolvedValue(link('l1', 'RAPPI')))

  it('sin confirm: vista previa antes/después, no escribe ni audita', async () => {
    const r = parse(await call('set_delivery_channel_printing', args))
    expect(r.requiresConfirmation).toBe(true)
    expect(r.antes.guardada).toEqual({ comanda: 'SALON', empaque: 'NEGOCIO' })
    expect(r.despues.efectiva.estacionUnicaId).toBe('st1')
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('con confirm: escribe por updateChannelLink y audita', async () => {
    mockUpdate.mockResolvedValue({})
    const r = parse(await call('set_delivery_channel_printing', { ...args, confirm: true }))
    expect(r.ok).toBe(true)
    expect(mockUpdate).toHaveBeenCalledWith('v1', 'l1', { config: { impresion: { comanda: 'UNA_ESTACION', estacionId: 'st1', empaque: 'NO' } } }, 'staff1')
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'DELIVERY_CHANNEL_PRINTING_SET' }))
    expect(mockWriteScope).toHaveBeenCalled()
  })

  it('sin permiso: el error sube y no escribe', async () => {
    mockPermission.mockImplementation(() => {
      throw new Error('PermissionError')
    })
    await expect(call('set_delivery_channel_printing', { ...args, confirm: true })).rejects.toThrow('PermissionError')
    expect(mockPermission).toHaveBeenCalledWith('delivery-channels:manage', 'v1')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('sin plan: planRequired y no escribe', async () => {
    mockGate.mockResolvedValue('Mejora tu plan')
    const r = parse(await call('set_delivery_channel_printing', { ...args, confirm: true }))
    expect(r.planRequired).toBe(true)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('forma inválida (UNA_ESTACION sin estación): ok:false sin escribir', async () => {
    const r = parse(await call('set_delivery_channel_printing', { venueId: 'v1', linkId: 'l1', comanda: 'UNA_ESTACION', empaque: 'NO', confirm: true }))
    expect(r.ok).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
