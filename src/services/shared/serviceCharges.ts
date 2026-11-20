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
  // A centavos ANTES del %: la suma de renglones llega en `Number` (25.02 + 25.33 = 50.349999999999994) y su 10 % redondeaba a
  // 5.03 en vez de 5.04 (Codex r1 #11 de «Anular producto»; también lo sumaban así `addItemsToOrder` y `voidItems`).
  const centavos = (v: Prisma.Decimal | number) => new Prisma.Decimal(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  const base = centavos(subtotal).minus(centavos(descuento))
  return base.isNegative() ? new Prisma.Decimal(0) : base
}

/**
 * El importe de UN cargo sobre una base: el % sobre la base a centavos (ROUND_HALF_UP), o el monto fijo tal cual. Es la ÚNICA
 * fórmula: la vista previa del MCP, el alta del cargo, los cargos automáticos y los dos recalculadores la usan, para que lo que
 * se aprueba, lo que queda en la bitácora y lo que se cobra sea el mismo número (Codex r4 #2 de «Anular producto»: con `Number`,
 * el 10 % de 100 − 89.95 daba 1.00 en la vista previa y 1.01 en el cobro).
 */
export function importeDeCargo(
  type: 'PERCENTAGE' | 'FIXED_AMOUNT' | string,
  value: Prisma.Decimal | number,
  base: Prisma.Decimal | number,
): Prisma.Decimal {
  if (type !== 'PERCENTAGE') return new Prisma.Decimal(value)
  const baseDec = new Prisma.Decimal(base).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  return baseDec.mul(value).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
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
  // A centavos aquí también: hay llamadores que arman la base a mano con `Number` (p. ej. `recalculateOrderTotals` al quitar un
  // cargo). Sin esto, la misma cuenta daba 5.04 por un camino y 5.03 por otro (Codex r2 #6 de «Anular producto»).
  const baseDec = new Prisma.Decimal(base).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

  let total = new Prisma.Decimal(0)
  for (const charge of charges) {
    // Un % se re-calcula cuando cambia la cuenta; un MONTO FIJO (descorche, entrega) se
    // respeta tal cual — no depende de cuánto se consumió.
    const amount = charge.type === 'PERCENTAGE' ? importeDeCargo(charge.type, charge.value, baseDec) : new Prisma.Decimal(charge.amount)
    if (charge.type === 'PERCENTAGE' && !amount.equals(charge.amount)) {
      await db.orderServiceCharge.update({ where: { id: charge.id }, data: { amount } })
    }
    total = total.plus(amount)
  }
  return total.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()
}
