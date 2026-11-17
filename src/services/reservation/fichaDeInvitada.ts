import type { Prisma } from '@prisma/client'
import { canonicalPhoneE164, phoneLast10, phonesMatch } from '@/utils/phone'

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
  // Codex r3 #6: un número válido de menos de 10 dígitos (+298 …) no se puede volver a encontrar con la búsqueda compartida: no se crea.
  const ultimos10 = telefono ? phoneLast10(telefono) : null
  if (!telefono || !ultimos10) return null
  const nombre = (invitada.guestName ?? '').trim()

  // La búsqueda de la página pública (los dígitos sin formato + el número completo), con el nombre en la misma lectura.
  const candidatas = await tx.$queryRaw<Array<{ id: string; phone: string | null; firstName: string | null }>>`
    SELECT "id", "phone", "firstName" FROM "Customer"
    WHERE "venueId" = ${venueId} AND "phone" IS NOT NULL
      AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ${ultimos10}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${TOPE + 1}`
  // Codex r3 #6: con el tope lleno no se sabe si su ficha está más abajo: ni se liga ni se crea (no se duplica una que ya existe).
  if (candidatas.length > TOPE) return null
  const suya = candidatas.find(c => phonesMatch(c.phone, telefono))
  if (suya) {
    const suNombre = primerNombre(suya.firstName)
    return !suNombre || suNombre === primerNombre(nombre) ? { customerId: suya.id, creada: false } : null
  }
  if (!nombre) return null

  const [firstName, ...resto] = nombre.split(/\s+/)
  // Sin chocar con otra reserva que la crea al mismo tiempo: si ya existe, no se duplica y se usa ésa.
  const r = await tx.customer.createMany({
    data: [{ venueId, phone: telefono, firstName, lastName: resto.join(' ') || null }],
    skipDuplicates: true,
  })
  // Codex r3 #6: se recupera por el teléfono EXACTO que se guardó (no por la búsqueda topada).
  const creada = await tx.customer.findFirst({ where: { venueId, phone: telefono }, select: { id: true } })
  return creada ? { customerId: creada.id, creada: r.count === 1 } : null
}

const TOPE = 20
