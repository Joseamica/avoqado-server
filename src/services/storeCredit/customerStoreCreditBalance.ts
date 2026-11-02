/**
 * El saldo a favor en la ficha del cliente (spec 2026-10-30-saldo-a-favor, tarea S8c). Sólo lectura, sin candado: es para mostrar.
 *  - `balanceCents` = suma de los sobres ACTIVE de la sucursal (una tarjeta regalada guardada no es sobre: `esSobreDeSaldoAFavorSql`).
 *  - `giftCardId` / `phoneLast4` = los del ACTIVE más viejo (createdAt, id); si no hay ACTIVE, los del BLOCKED más viejo.
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
  // Los ACTIVE mandan: tienen el dinero y su teléfono es el que gasta. Sólo si no hay ninguno, el BLOCKED más viejo (saldo 0).
  for (const r of rows) {
    const actual = out.get(r.customerId)
    const activo = r.status === 'ACTIVE'
    const centavos = activo ? Math.round(Number(r.balance) * 100) : 0
    const ficha = { phoneLast4: (r.recipientPhone ?? '').slice(-4), giftCardId: r.id }
    if (!actual) {
      out.set(r.customerId, { balanceCents: centavos, ...ficha, ...(activo ? {} : { blocked: true as const }) })
    } else if (activo) {
      actual.balanceCents += centavos
      if (actual.blocked) {
        // El primer ACTIVE (el más viejo, por el orden) reemplaza al congelado que se vio antes.
        delete actual.blocked
        Object.assign(actual, ficha)
      }
    }
  }
  return out
}
