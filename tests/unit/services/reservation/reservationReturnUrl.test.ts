import {
  buildReservationCheckoutReturnUrls,
  buildReservationReturnUrl,
  sanitizeReservationReturnUrl,
} from '@/services/reservation/reservationReturnUrl'

describe('reservation return URL policy', () => {
  const production = { nodeEnv: 'production', venueWebsite: 'https://wellness.example.com/about' }

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,pwned'],
    ['ftp://book.avoqado.io/return'],
    ['http://book.avoqado.io/return'],
    ['https://evilavoqado.io/return'],
    ['https://avoqado.io.attacker.test/return'],
    ['https://foreign.example/return'],
    ['not a URL'],
  ])('ignores an unsafe production URL: %s', candidate => {
    expect(sanitizeReservationReturnUrl(candidate, production)).toBeUndefined()
  })

  it.each([
    ['https://avoqado.io/return'],
    ['https://book.avoqado.io/return?source=widget'],
    ['https://wellness.example.com/checkout/return'],
  ])('accepts an allowlisted production URL: %s', candidate => {
    expect(sanitizeReservationReturnUrl(candidate, production)).toBe(candidate)
  })

  it('matches Venue.website by exact hostname, not by suffix or substring', () => {
    expect(sanitizeReservationReturnUrl('https://sub.wellness.example.com/return', production)).toBeUndefined()
    expect(sanitizeReservationReturnUrl('https://wellness.example.com.attacker.test/return', production)).toBeUndefined()
  })

  it.each(['http://localhost:5174/return', 'https://localhost/return', 'http://127.0.0.1:3000/return'])(
    'accepts localhost only in development: %s',
    candidate => {
      expect(sanitizeReservationReturnUrl(candidate, { ...production, nodeEnv: 'development' })).toBe(candidate)
      expect(sanitizeReservationReturnUrl(candidate, production)).toBeUndefined()
    },
  )

  it('rejects credential-bearing URLs even on an allowed hostname', () => {
    expect(sanitizeReservationReturnUrl('https://user:password@book.avoqado.io/return', production)).toBeUndefined()
  })

  it('sets payment parameters safely while preserving existing query and fragment', () => {
    expect(
      buildReservationReturnUrl('https://book.avoqado.io/venue?source=embed#confirmation', {
        payment: 'success',
        reservationId: 'reservation / ? 1',
        session_id: '{CHECKOUT_SESSION_ID}',
      }),
    ).toBe(
      'https://book.avoqado.io/venue?source=embed&payment=success&reservationId=reservation+%2F+%3F+1&session_id={CHECKOUT_SESSION_ID}#confirmation',
    )
  })

  it('falls back independently when widget return URL overrides are unsafe', () => {
    expect(
      buildReservationCheckoutReturnUrls({
        bookingPublicUrl: 'https://book.avoqado.io',
        venueSlug: 'wellness',
        venueWebsite: 'https://wellness.example.com',
        requestedSuccessUrl: 'javascript:alert(1)',
        requestedCancelUrl: 'https://wellness.example.com/cancel?from=widget',
        reservationId: 'reservation-1',
        nodeEnv: 'production',
      }),
    ).toEqual({
      successUrl: 'https://book.avoqado.io/wellness?payment=success&reservationId=reservation-1&session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://wellness.example.com/cancel?from=widget&payment=cancelled&reservationId=reservation-1',
    })
  })
})
