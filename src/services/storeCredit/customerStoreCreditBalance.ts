/**
 * El saldo a favor en la ficha del cliente (spec 2026-10-30-saldo-a-favor, tarea S8c). Sólo lectura, sin candado: es para mostrar.
 *  - `balanceCents` = suma de los sobres ACTIVE de la sucursal (una tarjeta regalada guardada no es sobre: `esSobreDeSaldoAFavorSql`).
 *  - `giftCardId` / `phoneLast4` = los del sobre que recibiría el siguiente abono: el vivo más viejo, el mismo orden que
 *    `prepararSobreDeSaldoAFavorEnTx`.
 *  - Sólo hay sobres congelados (BLOCKED): saldo 0 y `blocked: true`. Sin sobres: `null`.
 */
import { Prisma } from '@prisma/client'
import { esSobreDeSaldoAFavorSql } from '../giftCards/giftCardLedger'

export interface StoreCreditDeCliente {
  balanceCents: number
  phoneLast4: string
  giftCardId: string
  blocked?: true
}

/** Un cliente tiene pocos sobres vivos (uno, por el candado de primer sobre); el tope cubre el peor caso de una página de 100 clientes. */
const TOPE_DE_SOBRES = 1000

/** UNA consulta para el lote de clientes de la página (o uno solo). El mapa trae todos los ids pedidos, con `null` si no tienen sobre. */
export async function storeCreditDeClientes(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  venueId: string,
  customerIds: string[],
): Promise<Map<string, StoreCreditDeCliente | null>> {
  const out = new Map<string, StoreCreditDeCliente | null>(customerIds.map(id => [id, null]))
  if (customerIds.length === 0) return out
  const rows = await db.$queryRaw<
    Array<{ id: string; customerId: string; status: string; balance: Prisma.Decimal | number | string; recipientPhone: string | null }>
  >(Prisma.sql`
    SELECT g.id, g."customerId", g.status, g.balance, g."recipientPhone" FROM "GiftCard" g
    WHERE g."venueId" = ${venueId} AND g."customerId" = ANY(${customerIds}::text[]) AND g.status IN ('ACTIVE', 'BLOCKED')
      AND ${esSobreDeSaldoAFavorSql('g')}
    ORDER BY g."createdAt" ASC, g.id ASC
    LIMIT ${TOPE_DE_SOBRES}`)
  for (const r of rows) {
    const actual = out.get(r.customerId)
    const centavos = r.status === 'ACTIVE' ? Math.round(Number(r.balance) * 100) : 0
    if (!actual) {
      out.set(r.customerId, {
        balanceCents: centavos,
        phoneLast4: (r.recipientPhone ?? '').slice(-4),
        giftCardId: r.id,
        ...(r.status === 'BLOCKED' ? { blocked: true as const } : {}),
      })
    } else {
      actual.balanceCents += centavos
      // Si el primero estaba congelado y hay otro ACTIVE, el cliente ya tiene saldo usable: no se marca congelado.
      if (centavos > 0) delete actual.blocked
    }
  }
  return out
}
