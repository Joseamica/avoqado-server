/**
 * Tenant guard for Mercado Pago endpoints.
 *
 * Mirrors `getStripeConnectMerchant` (src/services/dashboard/stripeConnect.service.ts:16-37):
 * every MP HTTP entry point (initiate / callback / disconnect) must go through
 * this helper before reading or mutating credentials. Without it, an authenticated
 * staff member from venue A could pass venue B's merchantId and overwrite
 * another tenant's MP connection.
 *
 * Returns the merchant row (with provider.code) so the caller doesn't have to
 * re-query.
 */
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

export async function getMercadoPagoMerchant(venueId: string, merchantId: string) {
  const merchant = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    include: { provider: { select: { code: true } } },
  })

  if (!merchant) {
    throw new NotFoundError('Afiliación de e-commerce no encontrada')
  }
  if (merchant.venueId !== venueId) {
    throw new UnauthorizedError('No tienes acceso a esta afiliación')
  }
  if (!merchant.provider || merchant.provider.code !== 'MERCADO_PAGO') {
    throw new BadRequestError('Esta afiliación no usa Mercado Pago')
  }

  return merchant
}
