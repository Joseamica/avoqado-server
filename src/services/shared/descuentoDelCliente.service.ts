import type { Discount, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'

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

const TOPE_POR_CLIENTE = 10

type Asignacion = { active: boolean; validFrom: Date | null; validUntil: Date | null; maxUses: number | null }

// Vigencia por instantes (validFrom <= ahora <= validUntil), igual que `getCustomerDiscounts`.
const vigente = (v: { validFrom: Date | null; validUntil: Date | null }, ahora: Date) =>
  (!v.validFrom || v.validFrom <= ahora) && (!v.validUntil || v.validUntil >= ahora)

export function cuentaComoDescuentoDelCliente(asignacion: Asignacion, d: Discount, venueId: string, ahora: Date): boolean {
  return (
    asignacion.active &&
    vigente(asignacion, ahora) &&
    asignacion.maxUses === null &&
    d.venueId === venueId &&
    d.active &&
    vigente(d, ahora) &&
    (d.type === 'PERCENTAGE' || d.type === 'FIXED_AMOUNT') &&
    d.scope === 'ORDER' &&
    d.minPurchaseAmount === null &&
    d.daysOfWeek.length === 0 &&
    d.timeFrom === null &&
    d.timeUntil === null &&
    d.maxTotalUses === null &&
    d.maxUsesPerCustomer === null &&
    !d.requiresApproval &&
    d.customerGroupId === null
  )
}

/** `priority` desc, luego `value` desc, luego el más viejo. */
export function elegirDescuentoDelCliente(candidatos: Discount[]): Discount | null {
  const orden = [...candidatos].sort(
    (a, b) => b.priority - a.priority || Number(b.value) - Number(a.value) || a.createdAt.getTime() - b.createdAt.getTime(),
  )
  return orden[0] ?? null
}

/** Una sola consulta para toda la lista de clientes; los que no tienen descuento válido no aparecen en el mapa. */
export async function descuentosDeLosClientes(
  venueId: string,
  customerIds: string[],
  db: Prisma.TransactionClient = prisma,
): Promise<Map<string, DescuentoDelCliente>> {
  const resultado = new Map<string, DescuentoDelCliente>()
  if (customerIds.length === 0) return resultado

  const ahora = new Date()
  const ventana = (ahora: Date) => [
    { OR: [{ validFrom: null }, { validFrom: { lte: ahora } }] },
    { OR: [{ validUntil: null }, { validUntil: { gte: ahora } }] },
  ]
  // La regla vive en el WHERE: sólo vuelven candidatos válidos. `cuentaComoDescuentoDelCliente` queda como doble revisión.
  // ponytail: tope de 10 asignaciones válidas por cliente en esta consulta; el orden es global (priority, value, más viejo),
  // así que lo mejor sale primero. Si algún cliente llega a tener más, subir el tope o consultar por cliente.
  const filas = await db.customerDiscount.findMany({
    where: {
      customerId: { in: customerIds },
      active: true,
      maxUses: null,
      AND: ventana(ahora),
      discount: {
        venueId,
        active: true,
        type: { in: ['PERCENTAGE', 'FIXED_AMOUNT'] },
        scope: 'ORDER',
        requiresApproval: false,
        minPurchaseAmount: null,
        daysOfWeek: { isEmpty: true },
        timeFrom: null,
        timeUntil: null,
        maxTotalUses: null,
        maxUsesPerCustomer: null,
        customerGroupId: null,
        AND: ventana(ahora),
      },
    },
    include: { discount: true },
    orderBy: [{ discount: { priority: 'desc' } }, { discount: { value: 'desc' } }, { discount: { createdAt: 'asc' } }],
    take: customerIds.length * TOPE_POR_CLIENTE,
  })

  const candidatos = new Map<string, Discount[]>()
  for (const f of filas) {
    if (!cuentaComoDescuentoDelCliente(f, f.discount, venueId, ahora)) continue
    candidatos.set(f.customerId, [...(candidatos.get(f.customerId) ?? []), f.discount])
  }
  for (const [customerId, lista] of candidatos) {
    const d = elegirDescuentoDelCliente(lista)!
    resultado.set(customerId, {
      discountId: d.id,
      name: d.name,
      type: d.type as 'PERCENTAGE' | 'FIXED_AMOUNT',
      value: Number(d.value),
      maxDiscountAmount: d.maxDiscountAmount != null ? Number(d.maxDiscountAmount) : null,
    })
  }
  return resultado
}

export const llaveDelDescuentoDelCliente = (customerId: string, discountId: string) => `descuento-cliente:${customerId}:${discountId}`
