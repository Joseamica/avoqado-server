import { prismaMock as db } from '@tests/__helpers__/setup'
import { updateOrder } from '@/services/dashboard/order.dashboard.service'
import { lockTableOrderScope } from '@/services/shared/tableOrderLock'
import { assertOrderCancellableUnderLock } from '@/services/shared/orderCancelGuard'
import { retirarComandasDeVentaAnulada, tomarCandadoDeComandas } from '@/services/kds/kitchenTicketAuthoring.service'

jest.mock('@/services/shared/tableOrderLock', () => ({ lockTableOrderScope: jest.fn(async () => ({})) }))
jest.mock('@/services/shared/orderCancelGuard', () => ({
  ...jest.requireActual('@/services/shared/orderCancelGuard'),
  assertOrderCancellableUnderLock: jest.fn(async () => ({})),
  devolverCanjesDeVentaAnuladaEnTx: jest.fn(async () => ({})),
  avisarOrdenCancelada: jest.fn(),
}))
jest.mock('@/services/giftCards/cuentaDeTarjetas', () => ({ desactivarSobresPendientesDeCuentaEnTx: jest.fn() }))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  soltarValesAlCancelarLaVenta: jest.fn(),
  auditarValesSoltados: jest.fn(),
}))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderCancelled: jest.fn() }))
// hz:e82938e1:D40: el retiro de comandas y sus candados (los prueba su propia suite y la integración).
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  retirarComandasDeVentaAnulada: jest.fn(async () => ({ kdsOrderIds: [], kdsOrderItemIds: [] })),
  cuentasDeSusComandas: jest.fn(async () => ['order', 'cuenta-ligada']),
  tomarCandadoDeComandas: jest.fn(async () => undefined),
}))

let row: any
beforeEach(() => {
  jest.clearAllMocks()
  row = {
    id: 'order',
    venueId: 'venue',
    status: 'CANCELLED',
    paymentStatus: 'PENDING',
    customerId: null,
    customerName: null,
    tableId: null,
    servedById: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    orderNumber: 'S2',
    type: 'TAKEOUT',
    version: 1,
    items: [],
  }
  db.$transaction.mockImplementation(async (cb: any) => cb(db))
  db.$queryRaw.mockResolvedValue([{ id: 'order' }])
  db.order.count.mockImplementation(async () => (['CANCELLED', 'DELETED'].includes(row.status) ? 1 : 0))
  db.order.findFirst.mockImplementation(async () => ({ ...row }))
  db.order.update.mockImplementation(async ({ data }: any) => (row = { ...row, ...data }))
  db.customer.findFirst.mockResolvedValue({ id: 'customer' })
})
const cambios = [
  { customerId: 'customer' },
  { customerName: 'Otro nombre' },
  { createdAt: new Date('2026-11-01') },
  { orderNumber: 'OTRO' },
  { servedById: 'staff' },
  { type: 'DELIVERY' },
  { status: 'PENDING' },
]
describe('R9: panel protege todas las ramas de edición de una cuenta anulada', () => {
  it.each(['CANCELLED', 'DELETED'])('%s rechaza metadata y reactivación sin escritura', async status => {
    row.status = status
    const original = { ...row }
    for (const data of cambios) {
      await expect(updateOrder('venue', 'order', data as any)).rejects.toMatchObject({ code: 'ORDER_CANCELLED_NO_EDIT' })
      expect(row).toEqual(original)
      expect(db.order.update).not.toHaveBeenCalled()
    }
  })
  it.each(['CANCELLED', 'DELETED'])(
    '%s: reenviar anulación permite valores iguales normalizados y rechaza cambios efectivos',
    async status => {
      row.status = status
      const iguales = {
        status,
        customerId: '',
        customerName: null,
        tableId: '',
        servedById: '',
        createdAt: '2026-09-30T18:00:00-06:00',
        orderNumber: 'S2',
        type: 'TAKEOUT',
      }
      await expect(updateOrder('venue', 'order', iguales as any)).resolves.toMatchObject({ status })
      for (const data of cambios) {
        db.order.update.mockClear()
        await expect(updateOrder('venue', 'order', { status, ...data } as any)).rejects.toMatchObject({ code: 'ORDER_CANCELLED_NO_EDIT' })
        expect(db.order.update).not.toHaveBeenCalled()
      }
      expect(assertOrderCancellableUnderLock).not.toHaveBeenCalled()
    },
  )
  it.each(['CANCELLED', 'DELETED'])('anular una viva como %s y repetir sólo estado conserva el flujo', async status => {
    row.status = 'PENDING'
    await updateOrder('venue', 'order', { status } as any)
    expect(assertOrderCancellableUnderLock).toHaveBeenCalledTimes(1)
    await expect(updateOrder('venue', 'order', { status } as any)).resolves.toMatchObject({ status })
    expect(assertOrderCancellableUnderLock).toHaveBeenCalledTimes(1)
  })
  it('metadata viva toma FOR NO KEY UPDATE sin topología; ausencia conserva 404', async () => {
    row.status = 'PENDING'
    await updateOrder('venue', 'order', { customerName: 'Nombre' })
    expect(db.$queryRaw).toHaveBeenCalledTimes(1)
    const sql = db.$queryRaw.mock.calls[0][0].join('?')
    expect(sql).toContain('FOR NO KEY UPDATE')
    expect(lockTableOrderScope).not.toHaveBeenCalled()
    db.$queryRaw.mockResolvedValue([])
    await expect(updateOrder('venue', 'order', { customerName: 'Otro' })).rejects.toMatchObject({ statusCode: 404 })
  })
})

// hz:e82938e1:D39: como `cancelOrderInTransaction` (D38). Si anular por el PUT dejaba la marca de «por mandar a cocina» (la de una ronda)
// y el dinero ya capturado reabría la cuenta antes del barrido (cada minuto), el barrido armaba la comanda de una cancelada reabierta
// (regla S1: no vuelve a la cocina). Sólo la ANULACIÓN la limpia: cualquier otra edición deja la marca de la ronda como estaba.
describe('D39: anular por el PUT limpia la marca de «por mandar a cocina»', () => {
  it.each(['CANCELLED', 'DELETED'])('🔴 pasar una viva a %s limpia la marca en la misma escritura que la anula', async status => {
    row.status = 'PENDING'
    await updateOrder('venue', 'order', { status } as any)
    expect(db.order.update).toHaveBeenCalledTimes(1)
    expect(db.order.update.mock.calls[0][0].data).toMatchObject({ status, kitchenPendingAt: null })
  })
  it('editar una viva sin anularla no toca la marca (la ronda que espera a la cocina sigue esperando)', async () => {
    row.status = 'PENDING'
    await updateOrder('venue', 'order', { customerName: 'Nombre' })
    expect(db.order.update).toHaveBeenCalledTimes(1)
    expect(db.order.update.mock.calls[0][0].data).not.toHaveProperty('kitchenPendingAt')
  })
  it('reenviar la MISMA anulación no vuelve a escribir la marca', async () => {
    row.status = 'CANCELLED'
    await updateOrder('venue', 'order', { status: 'CANCELLED' } as any)
    expect(db.order.update.mock.calls[0][0].data).not.toHaveProperty('kitchenPendingAt')
  })
})

// hz:e82938e1:D40: anular por el PUT retiraba la cuenta pero NO sus comandas (el DELETE, `cancelOrderInTransaction` y «Regresar saldo y
// cancelar» sí): una comanda pendiente seguía en la pantalla de cocina y la cocina podía prepararla. Ahora, como el DELETE: los candados
// de sus comandas van ANTES que el de la venta (el orden del armado: comandas → venta) y el retiro corre antes de revisar el dinero.
describe('D40: anular por el PUT retira las comandas de la pantalla de cocina', () => {
  it.each(['CANCELLED', 'DELETED'])(
    '🔴 pasar una viva a %s retira sus comandas, con los candados de comandas antes que el de la venta',
    async status => {
      row.status = 'PENDING'
      await updateOrder('venue', 'order', { status } as any, { staffId: 'staff' } as any)
      expect(retirarComandasDeVentaAnulada).toHaveBeenCalledWith(db, 'venue', 'order', { staffId: 'staff' })
      // Codex d40-r2 #1: los candados de comandas (todos, en orden) van ANTES de la foto y los candados de la mesa.
      expect((tomarCandadoDeComandas as jest.Mock).mock.calls.map(c => c[1])).toEqual(['cuenta-ligada', 'order'])
      expect((tomarCandadoDeComandas as jest.Mock).mock.invocationCallOrder[1]).toBeLessThan(
        (lockTableOrderScope as jest.Mock).mock.invocationCallOrder[0],
      )
      expect((lockTableOrderScope as jest.Mock).mock.calls[0][1]).not.toHaveProperty('kdsOrderIds')
      // Primero el retiro (toma el candado de comandas) y luego la revisión del dinero (toma el de la venta), como el DELETE.
      expect((retirarComandasDeVentaAnulada as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        (assertOrderCancellableUnderLock as jest.Mock).mock.invocationCallOrder[0],
      )
    },
  )
  it('regresión: editar una viva sin anularla no retira comandas ni toma sus candados', async () => {
    row.status = 'PENDING'
    await updateOrder('venue', 'order', { status: 'CONFIRMED', customerName: 'Nombre' } as any)
    expect(retirarComandasDeVentaAnulada).not.toHaveBeenCalled()
    expect(tomarCandadoDeComandas).not.toHaveBeenCalled()
  })
  it('regresión: reenviar la anulación de una ya anulada no vuelve a retirar nada', async () => {
    row.status = 'CANCELLED'
    await updateOrder('venue', 'order', { status: 'CANCELLED' } as any)
    expect(retirarComandasDeVentaAnulada).not.toHaveBeenCalled()
  })
})
