import { Prisma } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'

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

type VinculosDeLaCuenta = { customerId: string | null; orderCustomers: { customerId: string; isPrimary: boolean }[] }

/**
 * Un fiado se divide o se junta sin perder a su cliente (hz:01185fe7:D2): los lectores de deuda piden un `OrderCustomer`, y
 * la parte separada o la cuenta que lo recibe nacían sin él. Antes de apartar la mesa se aparta al CLIENTE (`FOR KEY SHARE`),
 * y antes que a él, al NEGOCIO: Negocio → Cliente → Cuenta, el orden de la limpieza de datos de prueba (Negocio → Cliente,
 * Codex r1 de D2) y de las métricas del cobro (Cliente → Cuenta, Codex r3). Al revés, copiar el vínculo cerraba un interbloqueo.
 * Devuelve los clientes apartados; quien copia el vínculo comprueba, ya con la mesa apartada, que sigan siendo los mismos.
 */
export async function apartarClientesDelFiado(tx: Prisma.TransactionClient, venueId: string, orderIds: string[]): Promise<Set<string>> {
  const cuentas: { payLater: boolean | null; customerId: string | null; orderCustomers?: { customerId: string }[] }[] = []
  for (const id of orderIds) {
    const cuenta = await tx.order.findFirst({
      where: { id, venueId },
      select: { payLater: true, customerId: true, orderCustomers: { select: { customerId: true } } },
    })
    if (cuenta) cuentas.push(cuenta)
  }
  // Si alguna es fiado se apartan los clientes de TODAS: la cuenta que queda puede quedar a nombre del cliente de la otra.
  if (!cuentas.some(c => c.payLater === true)) return new Set()
  const ids = [
    ...new Set(cuentas.flatMap(c => [c.customerId, ...(c.orderCustomers ?? []).map(oc => oc.customerId)]).filter((id): id is string => !!id)),
  ].sort()
  if (ids.length) {
    await tx.$queryRaw`SELECT id FROM "Venue" WHERE id=${venueId} FOR KEY SHARE`
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR KEY SHARE`
  }
  return new Set(ids)
}

/** El dueño de una cuenta: su `OrderCustomer` primario; si no hay, `Order.customerId` (lo que escribe «Detalles de la cuenta»). */
export function duenoDeLaCuenta(o: VinculosDeLaCuenta): string | null {
  return o.orderCustomers.find(c => c.isPrimary)?.customerId ?? o.customerId ?? o.orderCustomers[0]?.customerId ?? null
}

/**
 * El cliente de un fiado, para copiarlo a la parte separada o a la cuenta que lo recibe: su dueño (que siempre lleva su
 * `OrderCustomer`, aunque el fiado sólo lo tuviera en «Detalles») y los demás vínculos. Si «Detalles» dice un cliente y el
 * vínculo primario otro, no se adivina de quién es la deuda (Codex r1 de D2): se pide corregirlo antes.
 */
export function clienteDelFiado(o: VinculosDeLaCuenta): { dueno: string; otros: string[] } | null {
  exigirUnSoloCliente(o)
  const dueno = duenoDeLaCuenta(o)
  return dueno ? { dueno, otros: [...new Set(o.orderCustomers.map(c => c.customerId))].filter(id => id !== dueno) } : null
}

/**
 * Una cuenta que entra en un fiado (dividirlo, o juntarlo con otra, sea cual sea el lado) no puede decir en «Detalles» un
 * cliente y en su vínculo primario otro: no se adivina de quién es la deuda (Codex r1 y r2 de D2).
 */
export function exigirUnSoloCliente(o: VinculosDeLaCuenta): void {
  const primario = o.orderCustomers.find(c => c.isPrimary)?.customerId
  if (primario && o.customerId && primario !== o.customerId) {
    throw new BadRequestError(
      'Esta cuenta tiene un cliente en «Detalles» distinto al de su «Pagar después». Corrige el cliente antes de dividirla o juntarla.',
      'FIADO_CON_DOS_CLIENTES',
    )
  }
}

/** Ya con la mesa apartada: si el fiado cambió de cliente en medio, no se copia un vínculo que no se apartó. */
export function exigirClientesApartados(apartados: Set<string>, o: VinculosDeLaCuenta, accion: string): void {
  const ids = [o.customerId, ...o.orderCustomers.map(c => c.customerId)].filter((id): id is string => !!id)
  if (ids.some(id => !apartados.has(id))) throw new BadRequestError(`La cuenta cambió de cliente mientras se ${accion} — vuelve a intentar`)
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

