/**
 * La orden que nace del CHECK-IN de una reserva cae en el turno de caja del negocio.
 *
 * 🔴 Por qué esto NO es «una orden de reserva que nació días antes»: `createOrderFromReservation`
 * se llama SÓLO al hacer check-in — `reservation/checkIn.service.ts` (el cliente llega al
 * mostrador) y `dashboard/classSession.dashboard.service.ts` con `checkInImmediately` (walk-in).
 * Nunca al reservar. La orden nace con el cliente enfrente, igual que abrir una mesa.
 *
 * Y pesa más que en otros caminos: el ICP son citas y clases, así que en un spa o un gym el día
 * ENTERO pasa por aquí. Dejarla sin turno les dejaría «0 órdenes» — el defecto que se arregla.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import { createOrderFromReservation } from '@/services/reservation/createOrderFromReservation'
import { prismaMock } from '@tests/__helpers__/setup'

const VENUE = 'venue-1'

function reserva() {
  return {
    id: 'reservation-1',
    productId: 'product-1',
    productIds: [],
    partySize: 1,
    tableId: null,
    customerId: null,
    guestName: 'Ana',
    guestPhone: null,
    guestEmail: null,
    specialRequests: null,
    assignedStaffId: null,
    modifiers: [],
  }
}

/** Lo que de verdad se persistió en la orden. */
const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0]?.[0]?.data

describe('createOrderFromReservation — la orden del check-in cae en el turno del NEGOCIO', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    prismaMock.order.findFirst.mockResolvedValue(null)
    prismaMock.reservation.findFirst.mockResolvedValue(reserva() as any)
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Corte',
        sku: 'CUT-1',
        price: new Prisma.Decimal(100),
        taxRate: new Prisma.Decimal(0),
        category: { name: 'Servicios' },
      },
    ] as any)
    prismaMock.order.create.mockResolvedValue({ id: 'order-1' } as any)
    prismaMock.orderItem.create.mockResolvedValue({ id: 'item-1' } as any)
  })

  it('con turno abierto, la orden nace atada a ese turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-negocio' } as any)

    await createOrderFromReservation(prismaMock as any, { reservationId: 'reservation-1', venueId: VENUE, createdByStaffId: 'staff-1' })

    expect(datosDeLaOrden().shiftId).toBe('turno-negocio')
    // Y se resolvió por NEGOCIO, no por quien atiende: el turno es del venue desde la fase 1.
    expect(prismaMock.shift.findFirst).toHaveBeenCalledTimes(1)
    expect((prismaMock.shift.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
    })
  })

  it('sin turno abierto el check-in SIGUE ocurriendo, con la orden sin turno', async () => {
    // Un negocio que no abrió caja tiene que poder recibir a su cliente igual.
    prismaMock.shift.findFirst.mockResolvedValue(null)

    const resultado = await createOrderFromReservation(prismaMock as any, {
      reservationId: 'reservation-1',
      venueId: VENUE,
      createdByStaffId: 'staff-1',
    })

    expect(resultado).toEqual({ orderId: 'order-1', created: true })
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })

  it('el turno se lee con el MISMO cliente que crea la orden (dentro de la transacción)', () => {
    // La función recibe un `tx`: resolver el turno con el `prisma` global se saldría de la
    // transacción y podría leer un turno que la propia transacción aún no ve.
    const fuente = require('fs').readFileSync(
      require('path').join(__dirname, '../../../../src/services/reservation/createOrderFromReservation.ts'),
      'utf8',
    )
    expect(fuente).toMatch(/turnoAbiertoDelNegocio\(tx,\s*venueId\)/)
  })
})
