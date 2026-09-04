import { Prisma } from '@prisma/client'

/**
 * Los cargos por servicio de una orden: UNA sola definición de cómo se recalculan.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * `OrderServiceCharge.type` puede ser `PERCENTAGE`, y el schema lo define como «13 = 13%
 * sobre la base (subtotal − descuentos)». Cuando un descuento, una cortesía o una anulación
 * mueven esa base, el cargo tiene que moverse con ella. Pasarle a `computeStoredOrderTotal`
 * el SNAPSHOT congelado `Order.serviceChargeAmount` deja el total equivocado en la dirección
 * que le toque: alto cuando la base baja (el cliente paga de más) y bajo cuando la base sube
 * al quitar un descuento (el negocio cobra de menos).
 *
 * La regla estaba escrita a mano en cuatro sitios y FALTABA en otros cinco. Vive aquí para
 * que no pueda volver a divergir.
 *
 * ── Las reglas, y por qué son éstas ─────────────────────────────────────────
 * 🔴 **Las FILAS son la verdad; `Order.serviceChargeAmount` es una copia derivada de ellas.**
 * Sin filas el importe es 0 — el snapshot huérfano NO se conserva. Lo contrario fue la
 * primera versión de esta función y lo tumbó una auditoría de Codex (2026-09-03) con dos
 * argumentos mejores: la misma orden cobraría distinto según qué mutador corra, y un
 * snapshot > 0 sin filas no es un estado defensivo sino ROTO con causa conocida —
 * `removeServiceCharge` (`service-charge.mobile.service.ts`) borra la fila y recalcula
 * DESPUÉS, fuera de transacción; si ese recálculo falla, conservar el snapshot cobra para
 * siempre un cargo que ya se borró. Calcular 0 sana el estado en la siguiente operación.
 *
 * 🔴 **Quien llama tiene que PERSISTIR el resultado en `Order.serviceChargeAmount`**, no sólo
 * en `total`. `computeOrderBalance` —lo que de verdad se cobra— lee el snapshot y no las
 * filas: guardar sólo el total deja el arreglo en cosmético.
 *
 * 🔴 **La aritmética va en `Prisma.Decimal`, incluida la BASE.** Con `Number`,
 * `100 - 89.95` da `10.049999999999997` y el 10% de eso redondea a 1.00 cuando corresponde
 * 1.01. Un centavo por cobro, en el camino del dinero.
 */

/**
 * La base de los cargos por servicio: `max(0, subtotal − descuentos)`, en `Prisma.Decimal`.
 *
 * El clamp existe porque un `discountAmount` mayor que el subtotal es un estado que sí ocurre
 * (una cortesía de cuenta completa encima de un descuento previo), y una base negativa
 * produciría un cargo negativo que RESTA del corte del día.
 */
export function baseDeCargos(subtotal: Prisma.Decimal | number, descuento: Prisma.Decimal | number): Prisma.Decimal {
  const base = new Prisma.Decimal(subtotal).minus(descuento)
  return base.isNegative() ? new Prisma.Decimal(0) : base
}

/** Lo mínimo que necesita esta función de un cliente de Prisma: las filas de cargo. */
export type ClienteDeCargos = Pick<Prisma.TransactionClient, 'orderServiceCharge'>

/**
 * Recalcula los cargos de una orden contra una base NUEVA, persiste las filas porcentuales
 * que cambiaron, y devuelve el importe total en pesos.
 *
 * @param db la transacción de quien llama: el recálculo y el `order.update` que lo consume
 *           tienen que caer o persistir JUNTOS, o queda la fila nueva con el total viejo.
 * @param base `max(0, subtotal − descuentos)`, normalmente vía `baseDeCargos`.
 */
export async function recalcularCargosPorServicio(db: ClienteDeCargos, orderId: string, base: Prisma.Decimal | number): Promise<number> {
  const charges = await db.orderServiceCharge.findMany({ where: { orderId } })
  const baseDec = new Prisma.Decimal(base)

  let total = new Prisma.Decimal(0)
  for (const charge of charges) {
    // Un % se re-calcula cuando cambia la cuenta; un MONTO FIJO (descorche, entrega) se
    // respeta tal cual — no depende de cuánto se consumió.
    const amount =
      charge.type === 'PERCENTAGE'
        ? baseDec.mul(charge.value).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        : new Prisma.Decimal(charge.amount)
    if (charge.type === 'PERCENTAGE' && !amount.equals(charge.amount)) {
      await db.orderServiceCharge.update({ where: { id: charge.id }, data: { amount } })
    }
    total = total.plus(amount)
  }
  return total.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()
}
