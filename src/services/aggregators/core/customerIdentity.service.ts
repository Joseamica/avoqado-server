import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { findCustomerIdByPhone } from '@/services/public/customerPhoneLookup'
import { normalizePhoneE164 } from '@/utils/phone'
import { PassUser, Provider } from './types'

/** Separa el nombre del socio en nombre y apellidos. */
function splitName(full: string): { firstName: string; lastName: string | null } {
  const parts = (full ?? '').trim().split(/\s+/)
  return { firstName: parts[0] || 'Socio', lastName: parts.slice(1).join(' ') || null }
}

const isUniqueViolation = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'P2002'

/**
 * Liga al socio del pase con la ficha de cliente del negocio, en este orden: identidad externa ya conocida → teléfono →
 * correo → ficha nueva. Siempre deja guardada la identidad externa, así el siguiente evento del mismo socio entra directo.
 *
 * Ligar no mueve dinero ni créditos (spec §7): por eso no reabre el riesgo del auto-link del widget.
 *
 * - El teléfono se busca con el buscador canónico (`findCustomerIdByPhone`): los teléfonos de las fichas viejas están
 *   guardados como los escribió quien las dio de alta, y comparar exacto contra E.164 no los encontraría. Un teléfono que
 *   no se entiende se ignora (nunca se busca ni se guarda) y se intenta por correo.
 * - El correo se compara sin importar mayúsculas y se guarda en minúsculas.
 * - Concurrencia: dos primeros eventos del mismo socio a la vez. El alta (ficha + identidad) va en un savepoint; si choca
 *   con la del otro (P2002), se deshace —sin dejar una ficha duplicada— y se usa la identidad que ganó. Bajo una
 *   transacción SERIALIZABLE, Postgres suele reportar ese choque como 40001 y lo reintenta `withSerializableRetry`.
 *
 * Debe llamarse dentro de una transacción (usa SAVEPOINT). Nunca registra nombre, correo ni teléfono: sólo ids.
 */
export async function resolvePassCustomer(
  tx: Prisma.TransactionClient,
  p: { venueId: string; provider: Provider; externalUserId: string; user: PassUser },
): Promise<{ customerId: string; created: boolean }> {
  const identityKey = { venueId: p.venueId, provider: p.provider, externalUserId: p.externalUserId }
  const findIdentity = () =>
    tx.customerExternalIdentity.findUnique({
      where: { venueId_provider_externalUserId: identityKey },
      select: { customerId: true },
    })

  const known = await findIdentity()
  if (known) return { customerId: known.customerId, created: false }

  const phone = p.user.phone ? normalizePhoneE164(p.user.phone) : null
  const email = p.user.email?.trim().toLowerCase() || null

  let customerId: string | null = null
  let matchedBy: 'phone' | 'email' | 'created' = 'created'
  if (phone) {
    customerId = await findCustomerIdByPhone(tx, p.venueId, phone)
    if (customerId) matchedBy = 'phone'
  }
  if (!customerId && email) {
    const byEmail = await tx.customer.findFirst({
      where: { venueId: p.venueId, email: { equals: email, mode: 'insensitive' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (byEmail) {
      customerId = byEmail.id
      matchedBy = 'email'
    }
  }

  await tx.$executeRawUnsafe('SAVEPOINT pase_identidad_socio')
  try {
    if (!customerId) {
      const { firstName, lastName } = splitName(p.user.name)
      const created = await tx.customer.create({
        data: { venueId: p.venueId, firstName, lastName, email, phone, provider: 'EMAIL' },
        select: { id: true },
      })
      customerId = created.id
    }
    await tx.customerExternalIdentity.create({ data: { ...identityKey, customerId } })
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT pase_identidad_socio')
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT pase_identidad_socio')
    const winner = await findIdentity()
    if (!winner) throw error
    logger.info('[PASES] Socio ya ligado por un evento simultáneo', {
      venueId: p.venueId,
      provider: p.provider,
      customerId: winner.customerId,
    })
    return { customerId: winner.customerId, created: false }
  }

  logger.info('[PASES] Socio ligado a su ficha de cliente', { venueId: p.venueId, provider: p.provider, customerId, matchedBy })
  return { customerId, created: matchedBy === 'created' }
}
