import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError } from '@/errors/AppError'

export function hybridHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, child) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map(key => [key, child[key]]),
        )
      : child,
  )
  return createHash('sha256').update(canonical).digest('hex')
}

const unknownResult = () =>
  new ConflictError(
    'Aún no pudimos confirmar el resultado en Stripe. Conservamos el mismo intento; no vuelvas a comprar.',
    'HYBRID_PROVIDER_UNKNOWN',
  )

/** Callers certify customer, metadata and amounts in perform/recover before returning a provider object. */
export async function recordedStripeWrite<P extends object, T extends { id: string }>(
  purchaseId: string,
  step: string,
  request: P,
  perform: (saved: P, idempotencyKey: string) => Promise<T>,
  recover: (providerId: string | null) => Promise<T | null>,
): Promise<T> {
  const requestHash = hybridHash(request)
  const operation = await prisma.hybridBillingOperation.upsert({
    where: { purchaseId_step: { purchaseId, step } },
    create: { purchaseId, step, request: JSON.parse(JSON.stringify(request)) as Prisma.InputJsonValue, requestHash },
    update: {},
  })
  if (operation.requestHash !== requestHash)
    throw new ConflictError('La solicitud cambió respecto del intento guardado.', 'HYBRID_REQUEST_CHANGED')
  try {
    const recovered = await recover(operation.providerId)
    if (recovered) {
      await prisma.hybridBillingOperation.update({
        where: { id: operation.id },
        data: { status: 'OBSERVED', providerId: recovered.id, lastIssue: null },
      })
      return recovered
    }
    // Stripe retains keys for at least 24 hours. A one-hour margin also covers slow calls and clock skew.
    if (operation.providerId || Date.now() - operation.createdAt.getTime() >= 23 * 3600000) throw unknownResult()
    const observed = await perform(operation.request as P, `hybrid:${operation.id}`)
    await prisma.hybridBillingOperation.update({
      where: { id: operation.id },
      data: { status: 'OBSERVED', providerId: observed.id, lastIssue: null },
    })
    return observed
  } catch (error) {
    // Never store bearer links, provider response bodies or credentials in the journal.
    await prisma.hybridBillingOperation.update({
      where: { id: operation.id },
      data: { status: 'UNKNOWN', lastIssue: 'STRIPE_RESULT_UNCONFIRMED' },
    })
    throw Object.assign(unknownResult(), { cause: error })
  }
}
