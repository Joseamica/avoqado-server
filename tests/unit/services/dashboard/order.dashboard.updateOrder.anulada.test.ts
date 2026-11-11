import { prismaMock as db } from '@tests/__helpers__/setup'
import { updateOrder } from '@/services/dashboard/order.dashboard.service'
import { lockTableOrderScope } from '@/services/shared/tableOrderLock'
import { assertOrderCancellableUnderLock } from '@/services/shared/orderCancelGuard'

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
