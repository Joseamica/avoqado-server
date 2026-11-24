/**
 * Los lugares de una reserva que ya se pagaron con créditos de paquete, para que la cuenta del check-in no los vuelva a cobrar
 * (hz:fefa11b6:D20, bloque 0a).
 *
 * Antes, `createOrderFromReservation` abría la cuenta a precio de lista aunque la clienta hubiera pagado la clase con un crédito:
 * salía en «Sin cobrar» y la caja podía cobrarla dos veces. Ahora cada lugar pagado con un crédito va en $0 con la nota «Pagada con
 * paquete»; los lugares sin crédito y los extras se siguen cobrando. La cuenta sigue ABIERTA (aunque quede en $0): así se le puede
 * agregar un consumo, deshacer la llegada no deja una venta, y el turno y el cobro corren como siempre (Codex 0-r1 #4-#6, #9).
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

export type Tramo = {
  /** Índice del servicio de la reserva del que sale este tramo. */
  renglon: number
  quantity: number
  unitPrice: Prisma.Decimal
  notes: string | null
  /**
   * Los extras del servicio van UNA vez: en el tramo que se cobra si lo hay (son lo que queda por cobrar), si no en el de $0.
   */
  conModificadores: boolean
}

/**
 * Parte cada servicio en tramos: primero los lugares pagados con crédito ($0), luego los demás a su precio. La suma de `quantity`
 * de los tramos de un servicio es siempre `lugares`; los créditos de un producto se gastan una vez aunque el producto se repita.
 */
export function partirPorCreditos(
  servicios: Array<{ productId: string; unitPrice: Prisma.Decimal }>,
  lugares: number,
  creditos: Map<string, number>,
): { tramos: Tramo[]; creditosAplicados: number } {
  const quedan = new Map(creditos)
  let creditosAplicados = 0
  const tramos: Tramo[] = []
  servicios.forEach((s, renglon) => {
    const conCredito = Math.min(lugares, quedan.get(s.productId) ?? 0)
    if (conCredito > 0) {
      quedan.set(s.productId, (quedan.get(s.productId) ?? 0) - conCredito)
      creditosAplicados += conCredito
      const todos = conCredito === lugares
      tramos.push({
        renglon,
        quantity: conCredito,
        unitPrice: new Prisma.Decimal(0),
        notes: NOTA_PAGADA_CON_PAQUETE,
        conModificadores: todos,
      })
    }
    if (lugares - conCredito > 0) {
      tramos.push({ renglon, quantity: lugares - conCredito, unitPrice: s.unitPrice, notes: null, conModificadores: true })
    }
  })
  return { tramos, creditosAplicados }
}
