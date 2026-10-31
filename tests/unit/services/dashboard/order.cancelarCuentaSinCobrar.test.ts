/**
 * Cancelar desde el panel una cuenta sin cobrar (Amaena, 30-oct; promesa en
 * docs/audit/2026-10-30-cancelar-cuenta-sin-cobrar/promesa.md del workspace).
 *
 * La misma cancelación que usa el POS (`cancelOrderInTransaction`), con lo que el panel necesita además:
 *   · sólo cuentas que NO son de mesa ni pedidos en línea (Codex plan r1 #2, #3, #4, #7);
 *   · cualquier pago COMPLETED cuenta como dinero aunque `paymentStatus` diga PENDING (estados históricos);
 *   · una cuenta ya cancelada no se vuelve a escribir ni a auditar (r1 #6: el cliente HTTP reintenta solo);
 *   · el motivo va a la bitácora y no pisa las notas de la cuenta (r1 #5).
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { cancelarCuentaSinCobrar } from '@/services/dashboard/order.dashboard.service'

const { logAction } = require('@/services/dashboard/activity-log.service')

const VENUE = 'venue-1'
const ORDER = 'order-1'

function cuenta(datos: { tableId?: string | null; onlineOrder?: { id: string } | null; status?: string; paymentStatus?: string } = {}) {
  prismaMock.order.findFirst.mockResolvedValue({
    id: ORDER,
    tableId: datos.tableId ?? null,
    onlineOrder: datos.onlineOrder ?? null,
  } as any)
  prismaMock.order.findUnique.mockResolvedValue({
    id: ORDER,
    source: 'POS',
    posRawData: null,
    paymentStatus: datos.paymentStatus ?? 'PENDING',
    status: datos.status ?? 'CONFIRMED',
    version: 3,
    paidAmount: 0,
    tipAmount: 0,
  } as any)
}

beforeEach(() => {
  jest.clearAllMocks()
  cuenta()
  prismaMock.order.update.mockResolvedValue({ id: ORDER, status: 'CANCELLED', tableId: null } as any)
  prismaMock.order.findMany.mockResolvedValue([{ id: ORDER, tableId: null, createdAt: new Date('2026-10-01T00:00:00Z') }] as any)
  prismaMock.table.findMany.mockResolvedValue([])
  prismaMock.kdsOrder.findMany.mockResolvedValue([])
  prismaMock.kdsOrderItem.findMany.mockResolvedValue([])
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
  prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
    const sql = Array.isArray(query) ? query.join(' ') : ''
    if (sql.includes('FROM "Venue"')) return [{ id: VENUE }]
    if (sql.includes('FROM "Order"')) return [{ id: ORDER }]
    if (sql.includes('pg_advisory_xact_lock')) return []
    throw new Error('SQL inesperado en la cancelación')
  })
})

describe('cancelarCuentaSinCobrar — el panel cancela una cuenta sin cobrar', () => {
  it('cancela una cuenta de mostrador sin pagos: el motivo y el autor van a la bitácora y las notas no se tocan', async () => {
    await cancelarCuentaSinCobrar(VENUE, ORDER, 'La abrí por error', 'staff-1')

    expect(prismaMock.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CANCELLED' } }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORDER_CANCELLED',
        entity: 'Order',
        entityId: ORDER,
        staffId: 'staff-1',
        venueId: VENUE,
        data: { reason: 'La abrí por error' },
      }),
    )
  })

  it('🔴 una cuenta de MESA no se cancela desde el panel: se anula en el POS', async () => {
    cuenta({ tableId: 'mesa-7' })

    await expect(cancelarCuentaSinCobrar(VENUE, ORDER, 'error', 'staff-1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_IS_TABLE',
    })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 un pedido EN LÍNEA no se cancela por aquí: tiene su propio «Cancelar»', async () => {
    cuenta({ onlineOrder: { id: 'web-1' } })

    await expect(cancelarCuentaSinCobrar(VENUE, ORDER, 'error', 'staff-1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_IS_ONLINE',
    })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('🔴 PENDING con un pago COMPLETED registrado (estado histórico) cuenta como dinero: no se cancela', async () => {
    prismaMock.payment.count.mockResolvedValue(1)

    await expect(cancelarCuentaSinCobrar(VENUE, ORDER, 'error', 'staff-1')).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('🔴 una cuenta YA cancelada responde 409 sin volver a escribir ni a auditar (el reintento del navegador)', async () => {
    cuenta({ status: 'CANCELLED' })

    await expect(cancelarCuentaSinCobrar(VENUE, ORDER, 'otro motivo', 'staff-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ORDER_ALREADY_CANCELLED',
    })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('una cuenta que no es de este negocio no existe', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)

    await expect(cancelarCuentaSinCobrar(VENUE, ORDER, 'error', 'staff-1')).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORDER, venueId: VENUE } }))
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })
})

describe('CancelarCuentaSinCobrarSchema — el motivo es obligatorio', () => {
  const { CancelarCuentaSinCobrarSchema } = require('@/schemas/dashboard/order.schema')
  const params = { venueId: 'cmhabcdefghijklmnopqrstuv', orderId: 'cmhzyxwvutsrqponmlkjihgfe' }

  it('recorta el motivo y lo acepta', () => {
    const r = CancelarCuentaSinCobrarSchema.safeParse({ params, body: { reason: '  Cuenta duplicada  ' } })
    expect(r.success).toBe(true)
    expect(r.data.body.reason).toBe('Cuenta duplicada')
  })

  it.each([[{}], [{ reason: '' }], [{ reason: '  a  ' }], [{ reason: 'x'.repeat(301) }]])('rechaza %j', body => {
    expect(CancelarCuentaSinCobrarSchema.safeParse({ params, body }).success).toBe(false)
  })
})
