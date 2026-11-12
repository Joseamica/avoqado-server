import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { utcTs } from '../../utils/sqlDates'

/**
 * El «descuento del cliente»: el que el negocio le asignó a UN cliente (`CustomerDiscount`) y la caja aplica sola al elegirlo.
 * Aquí vive la regla de cuál cuenta, en UN solo lugar. Sólo cuenta uno SIMPLE (porcentaje o monto, de toda la cuenta, sin
 * condiciones que dependan de la venta, la hora o los usos): lo demás sigue por el motor de descuentos de siempre.
 */
export type DescuentoDelCliente = {
  discountId: string
  name: string
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: number
  maxDiscountAmount: number | null
}

type Ganador = {
  customerId: string
  discountId: string
  name: string
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: Prisma.Decimal
  maxDiscountAmount: Prisma.Decimal | null
}

/**
 * El descuento de cada cliente de la lista, en UNA consulta que devuelve a lo más un renglón por cliente (`DISTINCT ON`): la
 * regla completa y el orden viven en la base. Gana `priority` mayor, luego `value` mayor, luego el más viejo y, en empate
 * total, el id menor. Sin tope que elija otro descuento ni una consulta por cliente (Codex r6–r8). `daysOfWeek` NULL (filas
 * por SQL, descuentos de referidos) cuenta como vacío, igual que lo lee Prisma. Los que no tienen uno válido no aparecen.
 */
export async function descuentosDeLosClientes(
  venueId: string,
  customerIds: string[],
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
): Promise<Map<string, DescuentoDelCliente>> {
  const resultado = new Map<string, DescuentoDelCliente>()
  const ids = [...new Set(customerIds)]
  if (ids.length === 0) return resultado

  const ahora = new Date()
  const ganadores = await db.$queryRaw<Ganador[]>`
    SELECT DISTINCT ON (cd."customerId")
      cd."customerId", d.id AS "discountId", d.name, d.type::text AS type, d.value, d."maxDiscountAmount"
    FROM "CustomerDiscount" cd
    JOIN "Discount" d ON d.id = cd."discountId"
    WHERE cd."customerId" IN (${Prisma.join(ids)})
      AND cd.active AND cd."maxUses" IS NULL
      AND (cd."validFrom" IS NULL OR cd."validFrom" <= ${utcTs(ahora)})
      AND (cd."validUntil" IS NULL OR cd."validUntil" >= ${utcTs(ahora)})
      AND d."venueId" = ${venueId} AND d.active
      AND d.type IN ('PERCENTAGE', 'FIXED_AMOUNT') AND d.scope = 'ORDER' AND NOT d."requiresApproval"
      AND d."minPurchaseAmount" IS NULL AND d."timeFrom" IS NULL AND d."timeUntil" IS NULL
      AND d."maxTotalUses" IS NULL AND d."maxUsesPerCustomer" IS NULL AND d."customerGroupId" IS NULL
      AND COALESCE(cardinality(d."daysOfWeek"), 0) = 0
      AND (d."validFrom" IS NULL OR d."validFrom" <= ${utcTs(ahora)})
      AND (d."validUntil" IS NULL OR d."validUntil" >= ${utcTs(ahora)})
    ORDER BY cd."customerId", d.priority DESC, d.value DESC, d."createdAt" ASC, d.id ASC
    LIMIT ${ids.length}
  `
  for (const g of ganadores) {
    resultado.set(g.customerId, {
      discountId: g.discountId,
      name: g.name,
      type: g.type,
      value: Number(g.value),
      maxDiscountAmount: g.maxDiscountAmount != null ? Number(g.maxDiscountAmount) : null,
    })
  }
  return resultado
}

export const llaveDelDescuentoDelCliente = (customerId: string, discountId: string) => `descuento-cliente:${customerId}:${discountId}`
