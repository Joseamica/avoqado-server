import { prismaMock } from '@tests/__helpers__/setup'
import { cancelPassBookingFromVenue } from '@/services/aggregators/core/venueCancellation'

/**
 * Revisión final I3: si el estudio cancela (o quita de la clase) a un socio de pase desde Avoqado, el proveedor tiene
 * que enterarse — si no, el socio sigue viendo su reserva, llega, y su check-in se liga a una reserva cancelada.
 */
describe('cancelPassBookingFromVenue', () => {
  beforeEach(() => {
    prismaMock.aggregatorBooking.findUnique.mockReset()
    prismaMock.aggregatorBooking.updateMany.mockReset()
    prismaMock.aggregatorOutbox.create.mockReset()
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
  })

  // nuevo
  it('una reserva que no es de pase no escribe nada (cero costo para quien no usa pases)', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(null)
    await cancelPassBookingFromVenue(prismaMock as any, 'r1')
    expect(prismaMock.aggregatorBooking.findUnique.mock.calls[0][0].where).toEqual({ reservationId: 'r1' })
    expect(prismaMock.aggregatorBooking.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })

  // nuevo
  it('reserva de pase aceptada ⇒ la marca CANCELLED (sólo si seguía ACCEPTED) y encola CANCEL_BOOKING', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      connectionId: 'c1',
      venueId: 'v1',
      decision: 'ACCEPTED',
    } as any)
    prismaMock.aggregatorBooking.updateMany.mockResolvedValueOnce({ count: 1 })
    await cancelPassBookingFromVenue(prismaMock as any, 'r1')
    expect(prismaMock.aggregatorBooking.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'b1', decision: 'ACCEPTED' },
      data: { decision: 'CANCELLED' },
    })
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({
      operation: 'CANCEL_BOOKING',
      aggregatorBookingId: 'b1',
      coalesceKey: 'CANCEL_BOOKING:c1:b1',
    })
  })

  // nuevo
  it.each(['DENIED', 'CANCELLED'])('reserva de pase %s ⇒ nada que avisar', async decision => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({ id: 'b1', connectionId: 'c1', venueId: 'v1', decision } as any)
    await cancelPassBookingFromVenue(prismaMock as any, 'r1')
    expect(prismaMock.aggregatorBooking.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })

  // nuevo
  it('si el socio la canceló en ese mismo instante (count 0) no se encola nada', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      connectionId: 'c1',
      venueId: 'v1',
      decision: 'ACCEPTED',
    } as any)
    prismaMock.aggregatorBooking.updateMany.mockResolvedValueOnce({ count: 0 })
    await cancelPassBookingFromVenue(prismaMock as any, 'r1')
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
})
