import { z } from 'zod'

export const consumerOAuthSchema = z.object({
  body: z.object({
    provider: z.enum(['GOOGLE', 'APPLE']),
    idToken: z.string().min(20, 'idToken invalido'),
    firstName: z.string().max(80).optional(),
    lastName: z.string().max(80).optional(),
  }),
})

export const searchConsumerVenuesSchema = z.object({
  query: z.object({
    q: z.string().trim().max(120).optional(),
    city: z.string().trim().max(80).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
})

export const consumerVenueParamsSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
  }),
})

export const consumerCreateReservationSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
  }),
  body: z
    .object({
      startsAt: z.coerce.date().optional(),
      endsAt: z.coerce.date().optional(),
      duration: z.number().int().min(5).max(480).optional(),
      guestName: z.string().min(1).max(200).optional(),
      guestPhone: z.string().min(1).max(20).optional(),
      guestEmail: z.string().email().max(200).optional(),
      partySize: z.number().int().min(1).max(100).optional(),
      productId: z.string().optional(),
      classSessionId: z.string().optional(),
      spotIds: z.array(z.string().min(1)).max(100).optional(),
      specialRequests: z.string().max(2000).optional(),
      creditItemBalanceId: z.string().optional(),
    })
    .refine(
      data => {
        if (data.classSessionId) return true
        return data.startsAt != null && data.endsAt != null && data.duration != null
      },
      {
        message: 'startsAt, endsAt y duration son requeridos para reservaciones sin classSessionId',
        path: ['startsAt'],
      },
    )
    .refine(
      data => {
        if (data.classSessionId) return true
        if (!data.startsAt || !data.endsAt) return true
        return data.endsAt > data.startsAt
      },
      {
        message: 'La fecha de fin debe ser posterior a la fecha de inicio',
        path: ['endsAt'],
      },
    ),
})

export const consumerFinalizeCreditCheckoutSchema = z.object({
  body: z.object({
    sessionId: z.string().min(8, 'sessionId invalido').regex(/^cs_/, 'sessionId invalido'),
  }),
})

export const consumerCreateCreditCheckoutSchema = z.object({
  params: z.object({
    venueSlug: z.string().min(1),
    packId: z.string().min(1),
  }),
})
