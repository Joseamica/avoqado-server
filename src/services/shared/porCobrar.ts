import { Prisma } from '@prisma/client'

/**
 * «Por cobrar» (fiado) como Toast (founder 26-oct): sólo es deuda del cliente lo que el cajero mandó a «Pagar después».
 * Antes bastaba con que una cuenta abierta tuviera cliente, y un cobro con tarjeta que fallaba (rechazo, terminal ocupada,
 * sin respuesta) quedaba como deuda en el reporte, en el saldo del cliente y en su «Liquidar todo» (Amaena, 28-sep y 20-oct).
 *
 * `Order.payLater`: true = «Pagar después»; false = se creó para cobrarse en el momento; null = no se sabe (filas viejas y
 * caminos que no lo declaran, como la TPV) → la regla de antes. Cada lector suma ESTA condición a la que ya tenía.
 * 🔴 Nunca `{ payLater: { not: false } }` ni `NOT`: en SQL `NULL <> false` no es verdadero y se comerían las filas viejas.
 */
export const NO_ES_COBRO_DEL_MOMENTO = { OR: [{ payLater: true }, { payLater: null }] } satisfies Prisma.OrderWhereInput

/** La misma condición en SQL crudo, para una consulta con el alias `o` sobre "Order". */
export const SQL_NO_ES_COBRO_DEL_MOMENTO = Prisma.sql`o."payLater" IS DISTINCT FROM false`

/** Lo que manda el POS de ANDROID/iOS al crear la cuenta: `PAY_LATER` → true; otro método → false; nada → null. */
export function payLaterDesdeMetodoDePago(paymentMethod: unknown): boolean | null {
  if (typeof paymentMethod !== 'string' || paymentMethod.trim() === '') return null
  return paymentMethod.trim().toUpperCase() === 'PAY_LATER'
}

/**
 * Al juntar dos cuentas, la que queda: fiado si alguna lo era (no se esconde una deuda); «no se sabe» si alguna no se sabe;
 * cobro del momento sólo si las dos lo eran.
 */
export function combinarPayLater(a: boolean | null, b: boolean | null): boolean | null {
  if (a === true || b === true) return true
  if (a === null || b === null) return null
  return false
}

