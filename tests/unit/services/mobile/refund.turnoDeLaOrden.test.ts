/**
 * La orden testigo de un reembolso móvil cae en el MISMO turno que su `Payment`.
 *
 * 🔴 Por qué importa que sea el mismo y no «el turno abierto»: el `shiftId` de aquí no se
 * consulta, se RECLAMA — `createRefund` hace un `updateMany` condicional sobre el turno OPEN
 * (que es a la vez el decremento de `totalSales`), y si el turno cerró entre la lectura y el
 * claim el reembolso entra SIN turno a propósito, nunca en uno cerrado. Reusar ese valor ya
 * reclamado es lo que garantiza que orden y cobro no puedan divergir: una orden en un turno y su
 * reembolso en otro descuadra el corte que una persona firma.
 */
import { createRefund } from '@/services/mobile/refund.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

const VENUE = 'venue-1'
const STAFF = 'staff-1'

const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0]?.[0]?.data
const datosDelCobro = () => (prismaMock.payment.create as jest.Mock).mock.calls[0]?.[0]?.data

describe('createRefund (móvil) — la orden testigo comparte turno con su cobro', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    }
    ;(prismaMock as any).cashDrawerEvent = { create: jest.fn(), createMany: jest.fn().mockResolvedValue({ count: 1 }) }
    prismaMock.order.create.mockResolvedValue({ id: 'order-ref-1', orderNumber: 'REF-1' } as any)
    prismaMock.payment.create.mockImplementation(async (args: any) => ({
      id: 'payment-ref-1',
      createdAt: new Date('2026-09-03T12:00:00.000Z'),
      ...args.data,
    }))
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' } as any)
    prismaMock.staff = { findUnique: jest.fn().mockResolvedValue(null) } as any
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as any)
  })

  const reembolso = () => createRefund({ venueId: VENUE, amount: 5000, reason: 'Producto defectuoso', method: 'CASH', staffId: STAFF })

  it('con el turno RECLAMADO, la orden y el cobro llevan el MISMO turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-negocio' } as any)

    await reembolso()

    expect(datosDeLaOrden().shiftId).toBe('turno-negocio')
    expect(datosDelCobro().shiftId).toBe('turno-negocio')
  })

  it('si el turno cerró entre la lectura y el claim, NINGUNO de los dos lleva turno', async () => {
    // El claim (`updateMany` con `status: OPEN`) devuelve 0: el turno se cerró en medio. Lo que
    // no puede pasar es que la orden quede en un turno cerrado mientras el cobro queda fuera.
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-que-ya-cerro' } as any)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 0 } as any)

    await reembolso()

    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
    expect(datosDelCobro().shiftId ?? null).toBeNull()
  })

  it('sin turno abierto el reembolso SIGUE ocurriendo, sin turno en ninguno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(null)

    await reembolso()

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
    expect(datosDelCobro().shiftId ?? null).toBeNull()
  })
})
