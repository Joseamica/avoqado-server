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
 *   0. **A alguno de los dos lados le falta la llave de idempotencia.** Dos cobros que traen
 *      `idempotencyKey` son dos intentos LÓGICOS distintos y su identidad ya es exacta: la
 *      resuelve `@@unique([venueId, idempotencyKey])`, y deduplicarlos por parecido borraría
 *      una entrega física reproducida horas después desde la misma PAX. Pero apagar la
 *      heurística mirando SÓLO el cobro entrante —como hacía la ronda 3— deja abierta la
 *      *ráfaga mixta*: una sola entrega de $100 que produce dos peticiones, A sin llave y B
 *      con llave, deja DOS cobros, porque la llave de B no existe todavía en la base y B se
 *      salta la heurística (3ª auditoría de Codex, P2). Con la llave puesta en la FIRMA, el
 *      par (A sin llave, B con llave) sí se reconoce.
 *   1. **Mismo dinero** — importe y propina **exactamente** iguales. Aquí no vale la
 *      tolerancia de un centavo con la que se decide «la cuenta quedó cubierta»: como
 *      identidad del dinero convertiría $100.00 y $100.01 en el mismo cobro.
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
 * previo puede demostrar la firma, y la regla se vuelve inerte (que es el lado seguro). Y
 * `idempotencyKey`, que es la excepción peligrosa: olvidarla NO vuelve la regla inerte sino
 * más agresiva — todos los previos parecerían «sin llave» y dos intentos lógicos distintos se
 * deduplicarían entre sí.
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
  /**
   * Llave de idempotencia del cobro entrante. NO apaga la heurística por sí sola: entra en la
   * FIRMA, junto al dinero, la terminal y la ventana (`alMenosUnoSinLlave`). Obligatoria en el
   * tipo (aunque su valor pueda ser nulo) para que ningún llamador nuevo la olvide y deje la
   * comparación creyendo que los dos lados vienen sin llave.
   */
  idempotencyKey: string | null | undefined
}

export interface PagoPrevio extends CompletedPaymentForBalance {
  id: string
  method?: string | null
  createdAt?: Date
  terminalId?: string | null
  /**
   * Llave del cobro YA registrado. Ausente ⇒ APK viejo (o llave vaciada), que es justo el lado
   * en el que la heurística tiene algo que hacer. Quien lea los pagos de la base DEBE
   * seleccionarla: sin ella todos los previos parecen «sin llave» y dos intentos lógicos
   * distintos se deduplicarían entre sí.
   */
  idempotencyKey?: string | null
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
  // 🔴 La llave NO se mira aquí, a propósito. La ronda 3 apagaba el candado entero cuando el
  // cobro entrante la traía, y eso dejaba pasar la ráfaga MIXTA (A sin llave crea el cobro; B
  // con llave no la encuentra en la base, se salta la heurística y crea otro: $100 en el cajón
  // y $200 en la base — 3ª auditoría de Codex, P2). La condición correcta compara los DOS
  // lados y por eso vive en la firma (`alMenosUnoSinLlave`), no en este atajo.
  //
  // 🔴 El precio, declarado: un cobro en EFECTIVO con llave paga ahora la consulta de los
  // cobros previos y la relectura de la orden dentro de la transacción. Se acepta porque el
  // efectivo es una fracción del tráfico; lo que este atajo sigue evitando —y es lo que de
  // verdad costaba— es ese viaje en cada cobro con TARJETA.
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

  // 🔴 Identidad EXACTA, no la tolerancia del saldo. `FULL_PAYMENT_TOLERANCE` ($0.01) existe
  // para decidir «la cuenta quedó cubierta» pese al redondeo de un reparto; usarla como
  // identidad del dinero convierte $100.00 y $100.01 en el mismo cobro, y entonces una
  // entrega física de $100.01 no genera ni Payment ni movimiento de turno (2ª auditoría de
  // Codex, P2). Los importes viven en la base con dos decimales: aquí se comparan iguales.
  const mismoDinero = (p: PagoPrevio) =>
    decimal(p.amount).equals(decimal(candidato.amount)) && decimal(p.tipAmount).equals(decimal(candidato.tip))

  // Sin fecha no se puede demostrar la ventana ⇒ no se deduplica. Y la edad tiene que ser
  // NO NEGATIVA: un `createdAt` en el futuro (backfill, importación, reloj corrido) dejaría
  // «dentro de la ventana» a cualquier efectivo compatible de hoy, para siempre — un cobro
  // real se descartaría sin dejar rastro (2ª auditoría de Codex, P3). Fecha futura ⇒ se
  // registra, que es el lado del que alguien se entera.
  const dentroDeLaVentana = (p: PagoPrevio) => {
    if (p.createdAt == null) return false
    const edad = ahora.getTime() - p.createdAt.getTime()
    return edad >= 0 && edad <= VENTANA_DE_RAFAGA_MS
  }

  // Un serial ausente en cualquiera de los dos lados NO descalifica: exigirlo dejaría fuera a
  // los APKs que no mandan `deviceSerialNumber` y el candado no protegería a nadie ahí.
  const mismaTerminal = (p: PagoPrevio) => p.terminalId == null || candidato.terminalId == null || p.terminalId === candidato.terminalId

  // 🔴 Dos llaves presentes ⇒ dos intentos LÓGICOS distintos: su identidad ya es exacta y la
  // resuelve el índice único, así que deduplicarlos por parecido es la única forma de borrar
  // dinero real (una fila encolada a las 10:00 que se reproduce a las 14:01 casaría la firma
  // de un cobro AJENO de la misma PAX — 2ª auditoría, P1 residual). En cuanto a UNO de los dos
  // le falta la llave, esa identidad exacta no existe y la firma vuelve a ser la única defensa
  // — que es el caso de la ráfaga mixta (3ª auditoría, P2).
  const alMenosUnoSinLlave = (p: PagoPrevio) => !candidato.idempotencyKey || !p.idempotencyKey

  const masReciente = (a: PagoPrevio, b: PagoPrevio) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)

  // 🔴 Sin fallback a «el cobro más reciente aunque no sea efectivo»: la versión anterior podía
  // responder con un cobro de TARJETA cuando no había efectivo que casara, y eso ata un cobro
  // en efectivo a un movimiento que no lo es.
  const enEfectivo = cobros
    .filter(p => p.method === 'CASH' && mismoDinero(p) && dentroDeLaVentana(p) && mismaTerminal(p) && alMenosUnoSinLlave(p))
    .sort(masReciente)
  return enEfectivo[0] ?? null
}
