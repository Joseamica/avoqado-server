import { Prisma } from '@prisma/client'
import {
  computeOrderBalance,
  isRefundPayment,
  FULL_PAYMENT_TOLERANCE,
  type CompletedPaymentForBalance,
  type OrderAmountsForBalance,
} from './orderBalance'

/**
 * Un toque repetido en «Efectivo» sobre una orden que YA quedó cubierta.
 *
 * Nació de SN00396 (BAE MEZQUITAL, 2026-09-04): 5 cobros COMPLETED de $0 en 1.7 s desde la
 * misma PAX, referencias distintas y sin llave de idempotencia. La defensa por
 * `referenceNumber` no lo ve (la referencia se acuña por toque) y la de `idempotencyKey`
 * tampoco (llegó vacía). Esta regla mira el ESTADO de la orden, no las credenciales del cobro.
 *
 * ── Qué se deduplica: la FIRMA de una ráfaga, no «la orden ya está saldada» ────────────
 * 🔴 La versión inicial deduplicaba con sólo dos condiciones —efectivo y saldo cubierto— y
 * eso confunde DOS entregas físicas de dinero distintas (auditoría de Codex, 2026-09-07):
 * el cajero recibe $100, el POST muere y la fila queda en la cola; la orden se sigue viendo
 * sin pagar, así que otra terminal —u otro turno— cobra otros $100 legítimos; horas después
 * la cola reproduce la primera fila, el servidor ve la orden saldada y la responde con el
 * cobro ajeno. Resultado: **$200 en el cajón y $100 en la base**, sin un solo rastro.
 *
 * Por eso hacen falta las tres condiciones juntas, que son las que sólo se dan a la vez en
 * una ráfaga de toques del mismo intento:
 *
 *   1. **Mismo dinero** — importe y propina iguales (con la tolerancia de un centavo). Dos
 *      entregas legítimas casi nunca coinciden al centavo, y una propina distinta es dinero
 *      distinto.
 *   2. **Misma terminal** — la ráfaga sale de un solo aparato. Si el cobro previo vino de
 *      otra terminal, es otra persona cobrando: se registra. (Si a alguno de los dos le falta
 *      el serial —APK viejo— la terminal no descalifica: sería el lado inseguro exigirla.)
 *   3. **Dentro de la ventana** — `VENTANA_DE_RAFAGA_MS`. Un cobro previo de hace media hora
 *      no es un toque repetido; es otro cobro.
 *
 * 🔑 **Fuera de la firma, se REGISTRA y el sobrepago lo vigila el watchdog de integridad de
 * dinero** (`money-integrity-watchdog.job.ts`), que es una anomalía VISIBLE y reparable.
 * Deduplicar de más produce dinero desaparecido, que es invisible. Entre las dos, esta regla
 * elige siempre equivocarse hacia el lado del que se entera alguien.
 *
 * ── Las otras tres condiciones, de la primera versión ──────────────────────────────────
 * 🔴 Sólo EFECTIVO. Una tarjeta que llega a registrarse YA se cobró en el banco: rechazarla o
 * deduplicarla deja «dinero movido sin registro», que es el peor desenlace.
 * 🔴 Sólo si ya existe un cobro previo. Una orden de $0 (cortesía, línea gratis de
 * PlayTelecom) está «saldada» desde antes del primer cobro; sin esta condición el PRIMER cobro
 * de cada línea gratis se perdería, y de ese cobro nace la SaleVerification que Walmart paga.
 * 🔴 Los reembolsos REABREN la puerta: tras devolver, volver a cobrar es legítimo.
 *
 * ── El saldo de ESTA regla no es `isFullyPaid` ─────────────────────────────────────────
 * `computeOrderBalance` implementa la decisión del founder (2026-08-18) de que **un reembolso
 * NO reabre saldo**: una venta de $100 cobrada y devuelta entera sigue diciendo `isFullyPaid`.
 * Para el corte y el CFDI eso es lo correcto; para este candado sería lo contrario de lo que
 * hace falta, porque convertiría un cobro legítimo posterior a la devolución en un «toque
 * repetido» y lo tiraría en silencio. Así que aquí se usa la fórmula del diagnóstico —
 * `total − cobrado + reembolsado ≤ 0.01`— reusando las piezas ya calculadas de
 * `computeOrderBalance` (nada de reimplementar la aritmética). Un reembolso PARCIAL también
 * abre la puerta: el lado seguro del dinero es no deduplicar de más.
 *
 * 🔑 Quien lea los pagos de la base DEBE seleccionar `type`: sin él un reembolso es
 * indistinguible de un cobro negativo. Y `terminalId` y `createdAt`: sin ellos ningún cobro
 * previo puede demostrar la firma, y la regla se vuelve inerte (que es el lado seguro).
 */

/**
 * Cuánto puede durar una ráfaga de toques del MISMO intento.
 *
 * La evidencia son 1.7 segundos, pero un intento que se estaciona esperando el turno por red
 * puede tardar bastante más (la TPV abandona la petición a los 10 s y la cola la reproduce
 * después). Quince minutos cubre con holgura la reproducción inmediata de la cola sin abarcar
 * «el cajero cobró otra vez media hora más tarde», que es un cobro real.
 */
export const VENTANA_DE_RAFAGA_MS = 15 * 60_000

export interface CobroCandidato {
  method: string | null | undefined
  status: string | null | undefined
  hasAreaTicketLines: boolean
  /** Importe entrante en PESOS (ya convertido desde centavos). */
  amount: number
  /** Propina entrante en PESOS. */
  tip: number
  /** Terminal que manda el cobro; `null` cuando el aparato no envió serial. */
  terminalId: string | null
}

export interface PagoPrevio extends CompletedPaymentForBalance {
  id: string
  method?: string | null
  createdAt?: Date
  terminalId?: string | null
}

/**
 * ¿Este cobro entrante puede llegar a ser un toque repetido? Es la MISMA condición que
 * `cobroEnEfectivoSobreOrdenSaldada` aplica primero, expuesta aparte para que quien la llama
 * pueda ahorrarse la consulta de los pagos previos cuando la respuesta ya es «no» — en un
 * camino de dinero que la TPV abandona a los 10 s, una consulta de más dentro de la
 * transacción es exactamente lo que produce el reintento que estamos evitando.
 *
 * 🔑 Vive AQUÍ y no en el llamador para que no existan dos definiciones del candado.
 */
export function aplicaCandadoDeEfectivo(candidato: CobroCandidato): boolean {
  if (candidato.method !== 'CASH') return false
  if (candidato.status !== 'COMPLETED') return false
  if (candidato.hasAreaTicketLines) return false
  return true
}

const decimal = (value: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal =>
  value == null ? new Prisma.Decimal(0) : new Prisma.Decimal(value.toString())

export function cobroEnEfectivoSobreOrdenSaldada(
  candidato: CobroCandidato,
  order: OrderAmountsForBalance,
  pagosCompletados: readonly PagoPrevio[],
  ahora: Date = new Date(),
): PagoPrevio | null {
  if (!aplicaCandadoDeEfectivo(candidato)) return null

  const cobros = pagosCompletados.filter(p => !isRefundPayment(p))
  if (cobros.length === 0) return null

  const saldo = computeOrderBalance(order, pagosCompletados)
  // `remainingBalance` viene clampado a 0 (un sobrepago no deja saldo negativo), así que el
  // faltante se recalcula desde `total` y `paidAmount` y se le SUMA lo devuelto.
  const restante = saldo.total.minus(saldo.paidAmount).plus(saldo.refundedAmount)
  if (restante.greaterThan(FULL_PAYMENT_TOLERANCE)) return null

  const mismoDinero = (p: PagoPrevio) =>
    decimal(p.amount).minus(candidato.amount).abs().lessThanOrEqualTo(FULL_PAYMENT_TOLERANCE) &&
    decimal(p.tipAmount).minus(candidato.tip).abs().lessThanOrEqualTo(FULL_PAYMENT_TOLERANCE)

  // Sin fecha no se puede demostrar la ventana ⇒ no se deduplica.
  const dentroDeLaVentana = (p: PagoPrevio) => p.createdAt != null && ahora.getTime() - p.createdAt.getTime() <= VENTANA_DE_RAFAGA_MS

  // Un serial ausente en cualquiera de los dos lados NO descalifica: exigirlo dejaría fuera a
  // los APKs que no mandan `deviceSerialNumber` y el candado no protegería a nadie ahí.
  const mismaTerminal = (p: PagoPrevio) => p.terminalId == null || candidato.terminalId == null || p.terminalId === candidato.terminalId

  const masReciente = (a: PagoPrevio, b: PagoPrevio) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)

  // 🔴 Sin fallback a «el cobro más reciente aunque no sea efectivo»: la versión anterior podía
  // responder con un cobro de TARJETA cuando no había efectivo que casara, y eso ata un cobro
  // en efectivo a un movimiento que no lo es.
  const enEfectivo = cobros.filter(p => p.method === 'CASH' && mismoDinero(p) && dentroDeLaVentana(p) && mismaTerminal(p)).sort(masReciente)
  return enEfectivo[0] ?? null
}
