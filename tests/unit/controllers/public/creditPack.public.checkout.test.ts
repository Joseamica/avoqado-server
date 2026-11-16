import { Request, Response, NextFunction } from 'express'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findFirst: jest.fn().mockResolvedValue({ id: 'v1', name: 'Estudio', slug: 'estudio' }) } },
}))
jest.mock('@/services/dashboard/creditPack.public.service', () => ({
  createCheckoutSession: jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.com/cs_1', sessionId: 'cs_1', expiresAt: null }),
}))

import { createCheckout } from '@/controllers/public/creditPack.public.controller'
import { createCheckoutSession } from '@/services/dashboard/creditPack.public.service'

/**
 * D655: «Comprar» en «Mi cuenta» no hacía nada a quien entró con Google: no tiene teléfono, la tienda manda
 * `phone: ''` y el esquema lo rechazaba («El teléfono es requerido»). Con sesión, la compra va por su id.
 */
async function comprar(body: Record<string, unknown>, customerId?: string) {
  const req = {
    params: { venueSlug: 'estudio', packId: 'p1' },
    body: { successUrl: 'https://x/ok', cancelUrl: 'https://x/no', ...body },
    ...(customerId ? { customerAuth: { customerId } } : {}),
  } as unknown as Request
  const res = { json: jest.fn() } as unknown as Response
  const next = jest.fn() as NextFunction
  await createCheckout(req, res, next)
  return { res, next }
}

describe('createCheckout — teléfono (D655)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('con sesión y sin teléfono: crea el pago a nombre de la clienta de la sesión', async () => {
    const { res, next } = await comprar({ email: 'jose@x.com', phone: '' }, 'c_sesion')
    expect(next).not.toHaveBeenCalled()
    expect(createCheckoutSession).toHaveBeenCalledWith('v1', 'p1', 'jose@x.com', '', 'https://x/ok', 'https://x/no', {
      customerId: 'c_sesion',
    })
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ checkoutUrl: 'https://checkout.stripe.com/cs_1' }))
  })

  it('invitada sin teléfono: «El teléfono es requerido» y no se toca Stripe', async () => {
    for (const phone of [undefined, '']) {
      const { next } = await comprar({ email: 'maria@x.com', ...(phone === undefined ? {} : { phone }) })
      expect((next as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({ message: 'El teléfono es requerido', statusCode: 400 }))
    }
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })

  it('invitada con teléfono: sigue como siempre', async () => {
    const { next } = await comprar({ phone: '+525511111111' })
    expect(next).not.toHaveBeenCalled()
    expect(createCheckoutSession).toHaveBeenCalledWith('v1', 'p1', undefined, '+525511111111', 'https://x/ok', 'https://x/no', {
      customerId: null,
    })
  })
})
