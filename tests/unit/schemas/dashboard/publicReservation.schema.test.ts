import { publicCreateReservationBodySchema } from '@/schemas/dashboard/reservation.schema'

describe('public reservation return URL wire contract', () => {
  const validAppointment = {
    startsAt: '2026-08-01T15:00:00.000Z',
    endsAt: '2026-08-01T16:00:00.000Z',
    duration: 60,
    guestName: 'Ana',
  }

  it('preserves bounded return URL candidates for the controller allowlist', () => {
    const parsed = publicCreateReservationBodySchema.parse({
      ...validAppointment,
      successUrl: 'javascript:alert(1)',
      cancelUrl: 'https://book.avoqado.io/return',
    })

    expect(parsed).toEqual(
      expect.objectContaining({
        successUrl: 'javascript:alert(1)',
        cancelUrl: 'https://book.avoqado.io/return',
      }),
    )
  })

  it('rejects unbounded return URL payloads before they reach URL parsing', () => {
    expect(
      publicCreateReservationBodySchema.safeParse({
        ...validAppointment,
        successUrl: `https://book.avoqado.io/${'a'.repeat(2049)}`,
      }).success,
    ).toBe(false)
  })
})
