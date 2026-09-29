import Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError } from '@/errors/AppError'
import { stripe, STRIPE_DENTRO_DEL_CANDADO } from '@/services/stripe.service'
import { toStripeAmount } from '@/services/payments/providers/money'
import { hybridOfferDefinition } from './hybridOffer.schema'

/** One product per published offer, never one per customer's selection. Lookup keys recover lost create responses. */
export async function ensureHybridPublicationPrices(publicationId: string) {
  const publication = await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: publicationId } })
  const definition = hybridOfferDefinition.parse(publication.definition)
  const metadata = { kind: 'HYBRID_OFFER', publicationId, definitionHash: publication.definitionHash }
  async function ensure(phase: 'initial' | 'renewal', pesos: number, product?: string) {
    const lookupKey = `hybrid_${publicationId}_${phase}`
    const amount = toStripeAmount(new Prisma.Decimal(pesos))
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 2 }, STRIPE_DENTRO_DEL_CANDADO)
    if (found.has_more || found.data.length > 1) throw new ConflictError('No se pudo verificar el precio publicado.')
    const price: Stripe.Price =
      found.data[0] ??
      (await stripe.prices.create(
        {
          lookup_key: lookupKey,
          ...(product ? { product } : { product_data: { name: publication.name, metadata } }),
          currency: 'mxn',
          unit_amount: amount,
          recurring: { interval: 'month' },
          tax_behavior: 'inclusive',
          metadata,
        },
        { ...STRIPE_DENTRO_DEL_CANDADO, idempotencyKey: `hybrid-price:${publicationId}:${phase}` },
      ))
    const productId = typeof price.product === 'string' ? price.product : price.product.id
    if (
      !price.active ||
      price.unit_amount !== amount ||
      price.currency !== 'mxn' ||
      price.tax_behavior !== 'inclusive' ||
      price.recurring?.interval !== 'month' ||
      price.recurring.interval_count !== 1 ||
      price.metadata.publicationId !== publicationId ||
      price.metadata.definitionHash !== publication.definitionHash ||
      (product && product !== productId)
    )
      throw new ConflictError('El precio en Stripe no coincide con la oferta publicada.', 'HYBRID_PRICE_MISMATCH')
    return { priceId: price.id, productId }
  }
  const initial = await ensure('initial', definition.terms.price)
  const renewal =
    definition.terms.renewal.kind === 'REPRICE' ? await ensure('renewal', definition.terms.renewal.price, initial.productId) : null
  return prisma.hybridOfferPublication.update({
    where: { id: publicationId },
    data: {
      stripeProductId: initial.productId,
      stripePriceId: initial.priceId,
      stripeRenewalPriceId: renewal?.priceId ?? null,
    },
  })
}
