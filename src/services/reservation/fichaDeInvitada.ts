import type { Prisma } from '@prisma/client'
import { findCustomerIdByPhone } from '@/services/public/customerPhoneLookup'
import { canonicalPhoneE164 } from '@/utils/phone'

/** «Ána  Ruiz» → «ana»: el primer nombre, sin acentos ni mayúsculas. */
const primerNombre = (s: string | null | undefined) =>
  (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase().split(/\s+/)[0] ?? ''

/**
 * D7 (founder 16-nov, «A · crearla siempre»): recepción reserva a una «invitada nueva» con nombre y teléfono y la reserva quedaba
 * sin ficha, así que esa alumna no podía llegar con el QR del kiosco. Se busca su ficha por el teléfono COMPLETO (la misma
 * búsqueda que la página pública) y, si no hay, se crea, como los «Instant Profiles» de Square.
 *
 * 🔴 Teléfono compartido (Codex r8–r11): si la ficha de ese número tiene OTRO nombre (mamá que agenda a su hija), no se liga: la
 * reserva queda como hoy y la hija llega tecleando su teléfono. `@@unique([venueId, phone])` no deja crearle otra con ese número.
 *
 * Corre dentro de la transacción de quien crea la reserva. `creada` es para su `ActivityLog` (fuera de la transacción).
 */
export async function fichaDeLaInvitada(
  tx: Prisma.TransactionClient,
  venueId: string,
  invitada: { guestName: string | null | undefined; guestPhone: string | null | undefined },
): Promise<{ customerId: string; creada: boolean } | null> {
  const telefono = invitada.guestPhone ? canonicalPhoneE164(invitada.guestPhone) : null
  if (!telefono) return null
  const nombre = (invitada.guestName ?? '').trim()

  const existente = await findCustomerIdByPhone(tx, venueId, telefono)
  if (existente) {
    const ficha = await tx.customer.findFirst({ where: { id: existente, venueId }, select: { firstName: true } })
    const suNombre = primerNombre(ficha?.firstName)
    return !suNombre || suNombre === primerNombre(nombre) ? { customerId: existente, creada: false } : null
  }
  if (!nombre) return null

  const [firstName, ...resto] = nombre.split(/\s+/)
  // Sin chocar con otra reserva que la crea al mismo tiempo: si ya existe, no se duplica y se usa ésa.
  const r = await tx.customer.createMany({
    data: [{ venueId, phone: telefono, firstName, lastName: resto.join(' ') || null }],
    skipDuplicates: true,
  })
  const id = await findCustomerIdByPhone(tx, venueId, telefono)
  return id ? { customerId: id, creada: r.count === 1 } : null
}
