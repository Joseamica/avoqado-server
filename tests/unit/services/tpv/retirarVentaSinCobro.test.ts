/**
 * D36 (hz:e82938e1:D36, encargo da7275): «atrás» desde el cobro de «Cobrar» antes de cualquier intento de cobro retira la venta que se
 * creó al tocar «Cobrar». Se cancela con su bitácora; nunca se toca una venta con un intento de cobro, con mesa, vieja o de otro camino.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { MOTIVO_DE_RETIRO, retirarVentaSinCobro } from '@/services/tpv/retirarVentaSinCobro.service'

const { logAction } = require('@/services/dashboard/activity-log.service')

const VENUE = 'venue-1'
const ORDER = 'order-1'
const AHORA = new Date('2026-11-20T18:00:00Z')

function venta(
  datos: {
    source?: string
    type?: string
    tableId?: string | null
    createdAt?: Date
    status?: string
    paymentStatus?: string
    statusBajoCandado?: string
  } = {},
) {
  prismaMock.order.findFirst.mockResolvedValue({
    source: datos.source ?? 'TPV',
    type: datos.type ?? 'TAKEOUT',
    tableId: datos.tableId ?? null,
    createdAt: datos.createdAt ?? new Date('2026-11-20T17:58:00Z'),
    status: datos.status ?? 'PENDING',
    paymentStatus: datos.paymentStatus ?? 'PENDING',
  } as any)
  prismaMock.order.findUnique.mockResolvedValue({
    id: ORDER,
    source: datos.source ?? 'TPV',
    posRawData: null,
    paymentStatus: datos.paymentStatus ?? 'PENDING',
    status: datos.statusBajoCandado ?? datos.status ?? 'PENDING',
    version: 1,
    paidAmount: 0,
    tipAmount: 0,
    tableId: datos.tableId ?? null,
  } as any)
}

/** Los dos conteos de `Payment`: el del guardia (sólo COMPLETED) y el del retiro (CUALQUIER estado). */
function pagos(completados: number, deCualquierEstado: number) {
  prismaMock.payment.count.mockImplementation((async (args: any) =>
    args?.where?.status === 'COMPLETED' ? completados : deCualquierEstado) as any)
}

beforeEach(() => {
  jest.clearAllMocks()
  venta()
  pagos(0, 0)
  prismaMock.order.update.mockResolvedValue({ id: ORDER, status: 'CANCELLED', tableId: null } as any)
  prismaMock.order.findMany.mockResolvedValue([{ id: ORDER, tableId: null, createdAt: new Date('2026-11-20T17:58:00Z') }] as any)
  prismaMock.table.findMany.mockResolvedValue([])
  prismaMock.kdsOrder.findMany.mockResolvedValue([])
  prismaMock.kdsOrderItem.findMany.mockResolvedValue([])
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
  prismaMock.terminalPaymentRequest.count.mockResolvedValue(0)
  prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
    const sql = Array.isArray(query) ? query.join(' ') : ''
    if (sql.includes('"OrderDiscount"')) return []
    if (sql.includes('"KdsOrderItem"')) return []
    if (sql.includes('FROM "Venue"')) return [{ id: VENUE }]
    if (sql.includes('FROM "Order"')) return [{ id: ORDER }]
    if (sql.includes('pg_advisory_xact_lock')) return []
    throw new Error('SQL inesperado en el retiro')
  })
})

describe('retirarVentaSinCobro — nuevo: la venta de Cobrar sin ningún intento de cobro se cancela', () => {
  it('P1 cancela (no borra) la venta y deja la bitácora con el autor, el motivo y el origen', async () => {
    await expect(retirarVentaSinCobro(VENUE, ORDER, 'staff-1', AHORA)).resolves.toEqual({ estado: 'RETIRADA' })

    expect(prismaMock.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CANCELLED' } }))
    expect(prismaMock.order.delete).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORDER_CANCELLED',
        entity: 'Order',
        entityId: ORDER,
        staffId: 'staff-1',
        venueId: VENUE,
        data: { origen: 'COBRAR_ATRAS_SIN_COBRO', reason: MOTIVO_DE_RETIRO },
      }),
    )
  })

  it('P1 el conteo de cobros va bajo el candado y sin filtro de estado: un Payment FAILED o PENDING también frena', async () => {
    pagos(0, 1)

    await expect(retirarVentaSinCobro(VENUE, ORDER, 'staff-1', AHORA)).rejects.toMatchObject({
      statusCode: 409,
      code: 'VENTA_NO_RETIRABLE',
      details: { motivo: 'CON_INTENTO_DE_COBRO' },
    })
    expect(prismaMock.payment.count).toHaveBeenCalledWith({ where: { venueId: VENUE, orderId: ORDER } })
    // El rechazo corre DENTRO de la transacción, después del candado: la cancelación se deshace y no se audita nada.
    expect(logAction).not.toHaveBeenCalled()
  })

  it('P1 una solicitud de cobro del POS (no lápida) frena el retiro', async () => {
    prismaMock.terminalPaymentRequest.count.mockResolvedValue(1)

    await expect(retirarVentaSinCobro(VENUE, ORDER, 'staff-1', AHORA)).rejects.toMatchObject({
      code: 'VENTA_NO_RETIRABLE',
      details: { motivo: 'CON_SOLICITUD_DEL_POS' },
    })
    expect(prismaMock.terminalPaymentRequest.count).toHaveBeenCalledWith({
      where: { venueId: VENUE, orderId: ORDER, NOT: { status: 'FAILED', failureCode: { startsWith: 'REJECTED_' } } },
    })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('P1 una venta con dinero COMPLETED no se toca (el guardia de siempre)', async () => {
    pagos(1, 1)

    await expect(retirarVentaSinCobro(VENUE, ORDER, 'staff-1', AHORA)).rejects.toMatchObject({ statusCode: 400 })
    expect(logAction).not.toHaveBeenCalled()
  })

  it.each([
    ['una venta de mesa', { tableId: 'mesa-3' }, 'CON_MESA'],
    ['una venta de otro camino (POS)', { source: 'POS' }, 'NO_ES_DE_COBRAR'],
    ['una venta que no es de mostrador', { type: 'DINE_IN' }, 'NO_ES_DE_COBRAR'],
    ['una venta de hace más de 24 h', { createdAt: new Date('2026-11-19T17:00:00Z') }, 'VIEJA'],
    ['una venta ya pagada', { paymentStatus: 'PAID', status: 'COMPLETED' }, 'NO_PENDIENTE'],
  ])('P1 %s no se retira sola y no se escribe nada', async (_nombre, datos, motivo) => {
    venta(datos as any)

    await expect(retirarVentaSinCobro(VENUE, ORDER, 'staff-1', AHORA)).rejects.toMatchObject({
      statusCode: 409,
      code: 'VENTA_NO_RETIRABLE',
      details: { motivo },
    })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('el reintento de una venta ya cancelada contesta YA_RETIRADA sin volver a escribir ni a auditar', async () => {
    venta({ status: 'CANCELLED' })

    await expect(retirarVentaSinCobro(VENUE, ORDER, 'staff-1', AHORA)).resolves.toEqual({ estado: 'YA_RETIRADA' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('dos retiros a la vez: el segundo ve la cancelación bajo el candado y contesta YA_RETIRADA', async () => {
    venta({ statusBajoCandado: 'CANCELLED' })

    await expect(retirarVentaSinCobro(VENUE, ORDER, 'staff-1', AHORA)).resolves.toEqual({ estado: 'YA_RETIRADA' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('una venta de otro negocio no existe', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)

    await expect(retirarVentaSinCobro(VENUE, ORDER, 'staff-1', AHORA)).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORDER, venueId: VENUE } }))
  })
})
