import { Prisma, type OrderStatus } from '@prisma/client'

/**
 * Estados con los que una cuenta ya NO está en la mesa. Es la lista con que la vista de mesas del POS
 * (`getTablesWithStatus`) decide qué cuentas siguen vivas sobre una mesa, y la misma de `clearTable`, `assignTable` y
 * `releaseTableIfSettled`. Vive una sola vez para que «¿la mesa tiene cuenta?» no conteste distinto en el plano.
 */
export const ESTADOS_FUERA_DE_LA_MESA = ['COMPLETED', 'CANCELLED', 'DELETED'] as const satisfies readonly OrderStatus[]

/**
 * Cuenta que OCUPA la mesa: viva (no está en `ESTADOS_FUERA_DE_LA_MESA`) y sin pagar. Es la que impide liberar la mesa
 * (`clearTable`) y la que `assignTable` reusa como hermana. Se busca por `Order.tableId`, no sólo por el puntero
 * `Table.currentOrderId`: una cuenta dividida o una orden dada de alta desde el POS se liga a la mesa sin apuntarla, y
 * cobrar la cuenta apuntada no mueve el puntero a la que sigue viva.
 */
export const CUENTA_VIVA_SIN_PAGAR = {
  status: { notIn: [...ESTADOS_FUERA_DE_LA_MESA] },
  paymentStatus: { not: 'PAID' },
} satisfies Prisma.OrderWhereInput

/** El mismo criterio sobre una cuenta ya leída. */
export function esCuentaVivaSinPagar(order: { status: string; paymentStatus: string }): boolean {
  return !(ESTADOS_FUERA_DE_LA_MESA as readonly string[]).includes(order.status) && order.paymentStatus !== 'PAID'
}

/** El mismo criterio en SQL, sobre el alias `o` de "Order" (para consultas crudas acotadas). */
export const CUENTA_VIVA_SIN_PAGAR_SQL = Prisma.sql`o.status NOT IN (${Prisma.join(
  ESTADOS_FUERA_DE_LA_MESA.map(s => Prisma.sql`CAST(${s} AS "OrderStatus")`),
)}) AND o."paymentStatus" <> CAST(${'PAID'} AS "PaymentStatus")`
