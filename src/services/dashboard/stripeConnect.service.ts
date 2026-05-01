import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { getProvider } from '@/services/payments/provider-registry'

type StripeBusinessType = 'company' | 'individual'

function toJsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

async function getStripeConnectMerchant(venueId: string, merchantId: string) {
  const merchant = await prisma.ecommerceMerchant.findUnique({
    where: { id: merchantId },
    include: {
      provider: { select: { code: true } },
    },
  })

  if (!merchant) {
    throw new NotFoundError('Afiliación de e-commerce no encontrada')
  }

  if (merchant.venueId !== venueId) {
    throw new UnauthorizedError('No tienes acceso a esta afiliación')
  }

  if (merchant.provider.code !== 'STRIPE_CONNECT') {
    throw new BadRequestError('Esta afiliación no usa Stripe Connect')
  }

  return merchant
}

export async function createStripeOnboardingLink(venueId: string, merchantId: string, businessType: StripeBusinessType) {
  const merchant = await getStripeConnectMerchant(venueId, merchantId)
  const providerCredentials = {
    ...toJsonObject(merchant.providerCredentials),
    businessType,
  } as Prisma.InputJsonObject

  const merchantWithBusinessType = await prisma.ecommerceMerchant.update({
    where: { id: merchant.id },
    data: { providerCredentials },
    include: {
      provider: { select: { code: true } },
    },
  })

  const provider = getProvider(merchantWithBusinessType)
  return provider.createOnboardingLink(merchantWithBusinessType)
}

export async function getStripeOnboardingStatus(venueId: string, merchantId: string) {
  const merchant = await getStripeConnectMerchant(venueId, merchantId)
  const provider = getProvider(merchant)
  return provider.getOnboardingStatus(merchant)
}
