import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { validateRequest } from '@/middlewares/validation'
import { publicCreateReservationBodySchema } from '@/schemas/dashboard/reservation.schema'
import { publicCheckoutSchema } from '@/schemas/dashboard/creditPack.schema'

/**
 * Fase 0.B — "el body nunca confiere identidad", por HTTP de verdad.
 *
 * Zod elimina las claves desconocidas en silencio y `validateRequest` reemplaza `req.body`
 * con el objeto filtrado, así que `resolveBookingIdentity` nunca veía el `customerId` que
 * alguien mandó. Ahora, `customerId` en el body de reserva o checkout público ⇒
 * `400 CUSTOMER_ID_NOT_ALLOWED` desde el middleware de validación.
 */
function run(schema: z.ZodTypeAny, body: Record<string, unknown>, params: Record<string, string> = {}) {
  const req = { body, params, query: {} } as unknown as Request
  const res = {} as Response
  const next = jest.fn() as NextFunction
  return validateRequest(schema)(req, res, next).then(() => ({ req, next }))
}

describe('validateRequest — customerId en el body público', () => {
  it('reserva pública con customerId → next(BadRequestError code CUSTOMER_ID_NOT_ALLOWED)', async () => {
    const schema = z.object({ params: z.object({ venueSlug: z.string() }), body: publicCreateReservationBodySchema })
    const { next } = await run(
      schema,
      {
        guestName: 'Ana',
        guestPhone: '+525511111111',
        customerId: 'c_inventado',
        productId: 'p1',
        startsAt: new Date(Date.now() + 3600000).toISOString(),
        endsAt: new Date(Date.now() + 7200000).toISOString(),
        duration: 60,
      },
      { venueSlug: 'x' },
    )
    const err = (next as jest.Mock).mock.calls[0][0]
    expect(err).toBeDefined()
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('CUSTOMER_ID_NOT_ALLOWED')
  })

  it('checkout público con customerId → 400 CUSTOMER_ID_NOT_ALLOWED', async () => {
    const { next } = await run(
      publicCheckoutSchema,
      { email: 'a@b.com', successUrl: 'https://x/ok', cancelUrl: 'https://x/no', customerId: 'c_inventado' },
      { venueSlug: 'x', packId: 'p' },
    )
    const err = (next as jest.Mock).mock.calls[0][0]
    expect(err?.code).toBe('CUSTOMER_ID_NOT_ALLOWED')
  })

  it('regresión: reserva pública SIN customerId pasa y req.body queda sin la clave', async () => {
    const schema = z.object({ params: z.object({ venueSlug: z.string() }), body: publicCreateReservationBodySchema })
    const { req, next } = await run(
      schema,
      {
        guestName: 'Ana',
        guestPhone: '+525511111111',
        productId: 'p1',
        startsAt: new Date(Date.now() + 3600000).toISOString(),
        endsAt: new Date(Date.now() + 7200000).toISOString(),
        duration: 60,
      },
      { venueSlug: 'x' },
    )
    expect((next as jest.Mock).mock.calls[0]).toEqual([])
    expect((req.body as any).customerId).toBeUndefined()
  })

  it('regresión: otro campo desconocido inofensivo sigue siendo ignorado en silencio (no .strict() global)', async () => {
    const schema = z.object({ params: z.object({ venueSlug: z.string() }), body: publicCreateReservationBodySchema })
    const { next } = await run(
      schema,
      {
        guestName: 'Ana',
        guestPhone: '+525511111111',
        productId: 'p1',
        startsAt: new Date(Date.now() + 3600000).toISOString(),
        endsAt: new Date(Date.now() + 7200000).toISOString(),
        duration: 60,
        utm_source: 'ig',
      },
      { venueSlug: 'x' },
    )
    expect((next as jest.Mock).mock.calls[0]).toEqual([])
  })
})
