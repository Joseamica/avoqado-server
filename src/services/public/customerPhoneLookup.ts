import type { Prisma, PrismaClient } from '@prisma/client'
import { phoneLast10, phonesMatch } from '@/utils/phone'

/**
 * El cliente de ESTE negocio con ese teléfono, aunque esté guardado con otro formato.
 *
 * Los clientes que ya existen guardan el teléfono como lo escribió quien los dio de alta («5512345678», «55 1234 5678»,
 * «(55) 1234-5678»): medido en la base local el 2026-08-27, 681 de 682 SIN normalizar. Comparar exacto no los reconoce y se
 * les crea una ficha NUEVA: pierden sellos, créditos e historial, y el negocio acaba con dos fichas de la misma persona.
 *
 * Filtro barato en SQL por los últimos 10 dígitos y `phonesMatch` como verificación canónica, porque dos países pueden
 * compartir esos 10 dígitos y no son la misma persona. Si coinciden varias fichas, gana la más antigua.
 */
export async function findCustomerIdByPhone(
  db: PrismaClient | Prisma.TransactionClient,
  venueId: string,
  phone: string,
): Promise<string | null> {
  const last10 = phoneLast10(phone)
  if (!last10) return null
  const candidatos = await db.$queryRaw<{ id: string; phone: string | null }[]>`
    SELECT "id", "phone"
    FROM "Customer"
    WHERE "venueId" = ${venueId}
      AND "phone" IS NOT NULL
      AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ${last10}
    ORDER BY "createdAt" ASC
    LIMIT 20
  `
  return candidatos.find(c => phonesMatch(c.phone, phone))?.id ?? null
}
