/**
 * Los servicios de una reserva que ya se pagaron con créditos de paquete, para que la cuenta del check-in no los vuelva a cobrar
 * (hz:fefa11b6:D20, bloque 0a).
 *
 * Antes, `createOrderFromReservation` abría la cuenta a precio de lista aunque la clienta hubiera pagado la clase con créditos: salía
 * en «Sin cobrar» y la caja podía cobrarla dos veces. Ahora un servicio cuyos lugares están TODOS pagados con créditos entra en $0
 * con la nota «Pagada con paquete», en el MISMO renglón de siempre (misma cantidad y mismos extras: inventario, ingresos y factura
 * leen los extras igual que antes, Codex 0-r2 #8). Los extras se siguen cobrando. La cuenta sigue ABIERTA aunque quede en $0: se le
 * puede agregar un consumo, deshacer la llegada no deja una venta, y el turno y el cobro corren como siempre (Codex 0-r1 #4-#6, #9).
 *
 * Si los créditos no alcanzan para todos los lugares de un servicio, el servicio se cobra completo, como hoy. No se alcanza en la
 * práctica: un canje gasta un crédito por lugar (o falla) y un Ilimitado sólo aparta un lugar.
 *
 * Créditos = el NETO por producto de los movimientos de ESTA reserva: canjes (`REDEEM`, cantidad negativa) menos devoluciones
 * positivas (`REFUND` > 0; un `REFUND` de 0 es sólo la marca de una cancelación tardía). Un pase Ilimitado deja el mismo `REDEEM −1`
 * y se trata igual. 🔴 Nunca se leen los saldos (`remainingQuantity`, `originalQuantity`): en un Ilimitado valen 99,999 por dentro.
 * No se depende de `creditPackItemId` (puede ser null). Un canje ya hecho cubre aunque después marquen la compra «reembolsada»: esa
 * marca sólo anula lo que quedaba (`refundPurchase`).
 *
 * El depósito en línea NO se aplica aquí: aplicarlo bien pide registrarlo como pago de la cuenta (forma «aplicación de anticipos»),
 * no como precio rebajado (perdería extras y comisiones a precio de lista; Codex 0-r1 #1, #7, #14). Va a la deuda.
 */
import { Prisma } from '@prisma/client'

export const NOTA_PAGADA_CON_PAQUETE = 'Pagada con paquete'

/** Una reserva tiene pocos movimientos (uno por servicio y lugar, más su devolución); el tope sólo cuida la consulta. */
const TOPE_DE_MOVIMIENTOS = 200

export async function creditosDeLaReserva(
  tx: Prisma.TransactionClient,
  args: { venueId: string; reservationId: string },
): Promise<Map<string, number>> {
  const movimientos = await tx.creditTransaction.findMany({
    where: { venueId: args.venueId, reservationId: args.reservationId, type: { in: ['REDEEM', 'REFUND'] } },
    select: { type: true, quantity: true, creditItemBalance: { select: { productId: true } } },
    take: TOPE_DE_MOVIMIENTOS,
  })
  const porProducto = new Map<string, number>()
  for (const m of movimientos) {
    const gastados = m.type === 'REDEEM' ? Math.abs(m.quantity) : m.quantity > 0 ? -m.quantity : 0
    const pid = m.creditItemBalance.productId
    porProducto.set(pid, (porProducto.get(pid) ?? 0) + gastados)
  }
  for (const [pid, n] of porProducto) if (n <= 0) porProducto.delete(pid)
  return porProducto
}

/**
 * Qué servicios (por posición en la reserva) quedan pagados enteros con créditos: los que tienen créditos para TODOS sus lugares.
 * Los créditos de un producto se gastan una vez aunque el producto se repita en la reserva.
 */
export function serviciosPagadosConCreditos(productIds: string[], lugares: number, creditos: Map<string, number>): Set<number> {
  const quedan = new Map(creditos)
  const pagados = new Set<number>()
  productIds.forEach((pid, i) => {
    if ((quedan.get(pid) ?? 0) >= lugares) {
      quedan.set(pid, (quedan.get(pid) ?? 0) - lugares)
      pagados.add(i)
    }
  })
  return pagados
}
