// src/services/shared/cashDrawerPosting.ts

/**
 * 🔴 LOS DOS LADOS DEL CAJÓN, EN UN SOLO ARCHIVO: la venta suma, el reembolso resta.
 *
 * `postCashSaleToDrawer` (2026-08-16) cerró el lado de la VENTA. El mismo día, con la
 * app y con `curl`, se midió el defecto espejo: el reembolso que la app usa de verdad
 * (`refund.dashboard.service`) tampoco restaba, así que el cajón inventaba un SOBRANTE
 * del tamaño de lo devuelto. Ver `postCashRefundToDrawer`, abajo.
 *
 * ── El lado de la VENTA ───────────────────────────────────────────────────────
 *
 * Un reembolso en efectivo crea automáticamente un `CashDrawerEvent` PAY_OUT
 * (`refund.mobile.service.ts`), pero NINGÚN servicio del servidor creaba el evento
 * simétrico al COBRAR. El tipo `CASH_SALE` existía en el enum y en `calculateExpectedAmount`,
 * pero la única forma de que naciera era el push del cliente a `/cash-drawer/sync`
 * —fire-and-forget, sin cola de reintento, y que la TPV ni siquiera tiene—.
 *
 * Medido en PRODUCCIÓN el 2026-08-16: PAY_OUT = 5 eventos por $1,496.00 ·
 * CASH_SALE = 1 evento por $13.50. O sea que el cajón sólo bajaba: cualquier negocio
 * que prendiera la caja veía un FALTANTE del tamaño de sus ventas del día, y el
 * cierre se lo cobraba al cajero.
 *
 * ── Por qué UN helper compartido y no un `create` en cada servicio ─────────────
 *
 * NO existe un único escritor de `Payment` en este repo (hay ~14 `payment.create`).
 * Lo que sí existe es un único juego de servicios por los que pasa TODO cobro de un
 * punto de venta, y son los que llaman aquí:
 *
 *   · `order.mobile.service.payCashOrder`   → POS móvil en línea **y** la reproducción
 *                                              del outbox offline (intent `PAY_CASH`)
 *   · `payment.tpv.service.recordOrderPayment` → cobro de una cuenta desde la TPV
 *   · `payment.tpv.service.recordFastPayment`  → venta rápida; la usan la TPV **y** el
 *                                              POS móvil (`POST /mobile/venues/:id/fast`)
 *
 * Concentrar la decisión aquí es lo que evita que cada punto de entrada vuelva a
 * decidir por su cuenta "¿esto es efectivo?" y las respuestas se separen — que es
 * exactamente cómo nacieron las tres definiciones distintas de "efectivo esperado"
 * que documenta `tenderSemantics.ts`.
 *
 * ── Reglas duras que este archivo respeta ─────────────────────────────────────
 *
 * 1. **NUNCA lanza.** El cajón no autoriza ventas: si no hay caja abierta, si la
 *    escritura falla o si la base no responde, el cobro sigue su curso. En este
 *    dominio el "fail-safe" no puede ser impedir un cobro.
 * 2. **"¿Está en el cajón?" la contesta `tenderSemantics`**, nunca un `method === 'CASH'`
 *    local (regla del CLAUDE.md del repo). Así un vale que cuenta como efectivo físico
 *    (`tenderCountsAsCash`) entra igual que el efectivo.
 * 3. **Idempotente por construcción.** El `localId` se DERIVA del `paymentId`, y el
 *    índice `@@unique([venueId, localId])` es el candado. Reproducir el mismo pago del
 *    outbox —o un reintento del cliente— es un no-op, no un segundo movimiento de caja.
 */

import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { logAction } from '../dashboard/activity-log.service'
import { paymentCountsAsDrawerCash, TenderSemanticsPayment } from './tenderSemantics'

/**
 * Prefijo de la llave de idempotencia de los eventos que crea el SERVIDOR.
 * Se distingue a propósito de los UUID locales que mandan las apps por `/sync`.
 */
const SERVER_CASH_SALE_LOCAL_ID_PREFIX = 'srv-cash-sale:'

/**
 * Prefijo de la llave del movimiento de un REEMBOLSO creado por el SERVIDOR.
 * Distinto del de la venta a propósito: un mismo id jamás debe colisionar entre
 * las dos direcciones del dinero.
 */
const SERVER_REFUND_LOCAL_ID_PREFIX = 'srv-refund:'

/** `Shift.cashDifference` is Decimal(10,2); the drawer itself has the wider Decimal(12,2). */
const SHIFT_CASH_DIFFERENCE_MAX = new Decimal('99999999.99')

type LateShiftPendingReason =
  | 'MISSING_SHIFT_RELATION'
  | 'SHIFT_NOT_FOUND_OR_CROSS_VENUE'
  | 'SHIFT_NOT_CLOSED'
  | 'SHIFT_MISSING_CASH_DECLARED'
  | 'SHIFT_COUNT_MISMATCH'
  | 'SHIFT_DIFFERENCE_OVERFLOW'
  | 'SHIFT_CONCURRENT_WRITE_LOST'

interface LateClosedDrawerAudit {
  staffId?: string
  venueId: string
  sessionId: string
  linkedShiftId: string | null
  cause: string
  localId: string | null
  amountPesos: string
  expectedAfterPesos: string
  overShortBeforePesos: string | null
  overShortAfterPesos: string
  shiftReconciliationStatus: 'APPLIED' | 'PENDING'
  pendingReason?: LateShiftPendingReason
  shiftDifferenceBeforePesos?: string | null
}

interface LateEventTransactionResult {
  result: { count: number }
  audit?: LateClosedDrawerAudit
}

/**
 * 🔴 CONTRATO CON EL POS, NO COSMÉTICA. El corte de caja del POS separa los
 * reembolsos del resto de los retiros por el PREFIJO de la nota
 * (`CorteTicketBuilder.PREFIJO_REEMBOLSO` en Android, misma cadena en iOS:
 * `note.startsWith("Reembolso:")`). Si el servidor escribe otra cosa, el dinero
 * sí baja del cajón pero el ticket del corte lo cuenta como un retiro a mano y el
 * dueño no puede explicar el hueco. Por eso la nota la arma ESTE archivo y no cada
 * llamador: un solo lugar puede romper —o mantener— el contrato.
 */
export const DRAWER_REFUND_NOTE_PREFIX = 'Reembolso:'

/** La llave del movimiento de caja de un pago. Determinista: mismo pago → misma llave. */
export function cashSaleDrawerLocalId(paymentId: string): string {
  return `${SERVER_CASH_SALE_LOCAL_ID_PREFIX}${paymentId}`
}

/** La llave del movimiento de caja de un reembolso. Determinista: mismo reembolso → misma llave. */
export function cashRefundDrawerLocalId(refundPaymentId: string): string {
  return `${SERVER_REFUND_LOCAL_ID_PREFIX}${refundPaymentId}`
}

export interface CashSaleDrawerPosting extends TenderSemanticsPayment {
  venueId: string
  paymentId: string
  /** `Payment.status` — sólo un cobro COMPLETED movió dinero. */
  status: string
  /** `Payment.type` — REGULAR / FAST / REFUND / TEST. */
  type?: string | null
  /** Importe de la venta, en unidades mayores (pesos), sin propina. */
  amount: Decimal | number | string
  /** Propina, en unidades mayores (pesos). */
  tipAmount?: Decimal | number | string | null
  staffId?: string | null
  staffName?: string | null
  orderId?: string | null
  /**
   * Fase 3 (barrido de reconciliación): la sesión EXACTA en la que ocurrió el movimiento. Sin
   * esto el helper toma la caja OPEN de AHORA — correcto para el cobro inline, pero un barrido
   * que repone una venta del martes la metería en la caja abierta del jueves. El barrido
   * resuelve la sesión por ventana [openedAt, closedAt] y la pasa aquí.
   */
  targetSessionId?: string | null
}

export type CashSaleDrawerOutcome =
  /** Se creó el movimiento. */
  | 'POSTED'
  /** Ya existía (reintento / replay del outbox): el índice único lo saltó. */
  | 'ALREADY_POSTED'
  /** El dinero no entró al cajón (tarjeta, transferencia, reembolso, $0, prueba). */
  | 'NOT_DRAWER_CASH'
  /** El pago todavía no está cobrado. */
  | 'NOT_COMPLETED'
  /** El negocio no trae caja abierta — normal, no todos usan el cajón. */
  | 'NO_OPEN_DRAWER'
  /** La caja se cerró entre encontrarla y escribir: el movimiento NO entra a una caja cerrada (fail-open). */
  | 'DRAWER_CLOSED'
  /** Falló la escritura. Se loguea y el cobro sigue: NUNCA se propaga. */
  | 'FAILED'

/**
 * Registra la venta en efectivo como movimiento de caja. Devuelve SIEMPRE, nunca lanza.
 *
 * 🔴 LA PROPINA ENTRA AL CAJÓN. El dinero físico que queda en la caja incluye la
 * propina en efectivo hasta que se le entrega al mesero — y cuando se le entrega, esa
 * salida ya se registra como PAY_OUT. Sumar sólo la venta dejaría el arqueo corto por
 * el total de las propinas del turno y volvería a acusar un faltante inventado.
 * No es una decisión nueva: es la convención que ya siguen los otros dos caminos de
 * arqueo del repo —`cashCloseout.dashboard.service.ts` suma `amount + tipAmount`, y
 * `calculateCashReconciliation` lo documenta como "ventas en efectivo **+ propina
 * cobrada en efectivo**"—. Que el cajón sumara distinto sería la cuarta definición de
 * "efectivo esperado" y no cuadraría con el corte del dashboard.
 */
export async function postCashSaleToDrawer(posting: CashSaleDrawerPosting): Promise<CashSaleDrawerOutcome> {
  try {
    if (posting.status !== 'COMPLETED') return 'NOT_COMPLETED'

    // Un REEMBOLSO no pasa por aquí: `refund.*.service` ya crea su propio PAY_OUT, y
    // el Payment del reembolso viaja con monto NEGATIVO + status COMPLETED. Tomarlo
    // aquí restaría el reembolso DOS veces. Un pago de prueba (demo en vivo) no es
    // dinero real.
    if (posting.type === 'REFUND' || posting.type === 'TEST') return 'NOT_DRAWER_CASH'

    // 🔴 La ÚNICA respuesta válida a "¿este dinero está en el cajón?".
    if (!paymentCountsAsDrawerCash(posting)) return 'NOT_DRAWER_CASH'

    const total = new Decimal(String(posting.amount ?? 0)).plus(new Decimal(String(posting.tipAmount ?? 0)))
    // Un cobro en $0 (cuenta cortesiada al 100%) es una venta legítima que NO movió
    // efectivo: un movimiento de caja en cero sólo ensucia el listado del corte.
    if (total.lessThanOrEqualTo(0)) return 'NOT_DRAWER_CASH'

    const session = posting.targetSessionId
      ? await prisma.cashDrawerSession.findFirst({
          where: { id: posting.targetSessionId, venueId: posting.venueId },
          select: { id: true },
        })
      : await prisma.cashDrawerSession.findFirst({
          where: { venueId: posting.venueId, status: 'OPEN' },
          select: { id: true },
        })
    // 🔴 FAIL-OPEN: sin caja abierta no pasa nada y el cobro sigue. La caja PREVIENE
    // descuadres, no autoriza ventas.
    if (!session) return 'NO_OPEN_DRAWER'

    // El nombre del cajero se ve en el listado de movimientos del corte. Los servicios
    // de cobro sólo tienen el id a la mano, así que se resuelve aquí — y sólo aquí,
    // cuando ya sabemos que hay caja abierta y que el dinero sí entró: es la rama menos
    // frecuente, no una consulta extra en cada venta.
    const staffName = posting.staffName || (await resolveStaffName(posting.staffId))

    // `createMany` + `skipDuplicates` en vez de `create`: con `create`, el replay de un
    // intent del outbox chocaría con el índice único y lanzaría P2002 DESPUÉS de que el
    // cobro ya está commiteado — un error en la respuesta de una venta que sí ocurrió.
    const result = await createEventUnderSessionLock(session.id, !posting.targetSessionId, {
      sessionId: session.id,
      venueId: posting.venueId,
      type: 'CASH_SALE',
      amount: total,
      staffId: posting.staffId || 'SYSTEM',
      staffName,
      orderId: posting.orderId || null,
      note: null,
      localId: cashSaleDrawerLocalId(posting.paymentId),
    })
    if (!result) {
      logger.info('💵 [CASH-DRAWER] La caja se cerró mientras se registraba el movimiento — no entra a una caja cerrada', {
        venueId: posting.venueId,
        sessionId: session.id,
      })
      return 'DRAWER_CLOSED'
    }

    if (result.count === 0) {
      logger.info('💵 [CASH-DRAWER] Venta en efectivo ya registrada en el cajón (replay) — no se duplica', {
        venueId: posting.venueId,
        paymentId: posting.paymentId,
      })
      return 'ALREADY_POSTED'
    }

    logger.info('💵 [CASH-DRAWER] Venta en efectivo sumada al cajón', {
      venueId: posting.venueId,
      paymentId: posting.paymentId,
      sessionId: session.id,
      amount: total.toFixed(2),
    })
    return 'POSTED'
  } catch (error) {
    // 🔴 El cobro YA está commiteado cuando se llega aquí. Propagar convertiría una
    // venta exitosa en una pantalla de Error y el cajero volvería a cobrar.
    logger.error('❌ [CASH-DRAWER] No se pudo sumar la venta en efectivo al cajón (el cobro NO se ve afectado)', {
      venueId: posting.venueId,
      paymentId: posting.paymentId,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'FAILED'
  }
}

// ============================================================================
// EL OTRO LADO: EL REEMBOLSO EN EFECTIVO
// ============================================================================

/**
 * 🔴 EL CAJÓN SUMABA LA VENTA PERO NO RESTABA EL REEMBOLSO QUE LA APP USA DE VERDAD.
 *
 * Medido con la app y con `curl` contra el backend el 2026-08-16: el cajón marcaba
 * $50,380 con $50,230 físicos. El SOBRANTE inventado era exactamente lo reembolsado
 * ($150) — el espejo del faltante que arregló `postCashSaleToDrawer`, y con el mismo
 * costo: el arqueo acusa al cajero por dinero que no está.
 *
 * Había DOS rutas de reembolso y sólo la que nadie llama movía la caja:
 *   · `POST /mobile/venues/:venueId/refunds` → `refund.mobile.service` → SÍ creaba el
 *     PAY_OUT… pero NINGÚN cliente consume esa ruta.
 *   · `POST /mobile/venues/:venueId/payments/:paymentId/refund` → `refund.dashboard.service`
 *     → NO tocaba el cajón. ES LA QUE USA LA APP.
 *
 * El arreglo NO fue mandar la app a la ruta gemela —sería un retroceso: el servicio del
 * dashboard trae candado contra doble reembolso, límite de lo que queda por devolver,
 * reembolso por artículo, reposición de inventario, reversa de comisión, recibo digital,
 * manejo de propina y el costo negativo para que liquidación cuadre—. Fue darle el cajón.
 * Y para que no vuelva a haber dos definiciones de "salió efectivo", el gemelo de mobile
 * también entra por aquí: UN solo lugar sabe restar.
 */

export interface CashRefundDrawerPosting extends TenderSemanticsPayment {
  venueId: string
  /** Id del `Payment` de tipo REFUND. De él se DERIVA la llave de idempotencia. */
  refundPaymentId: string
  /**
   * Efectivo devuelto, en unidades mayores (pesos). Se normaliza a POSITIVO: el
   * `Payment` del reembolso viaja en negativo y `calculateExpectedAmount` resta los
   * PAY_OUT, así que un monto negativo SUMARÍA al cajón — el mismo signo invertido
   * que originó este bug. Incluye la propina devuelta: salió del mismo cajón.
   */
  amount: Decimal | number | string
  staffId?: string | null
  staffName?: string | null
  orderId?: string | null
  /** Motivo, ya legible. La nota final la arma este archivo con el prefijo del contrato. */
  reason?: string | null
  /**
   * Fase 3 (barrido de reconciliación): la sesión EXACTA en la que ocurrió el movimiento. Sin
   * esto el helper toma la caja OPEN de AHORA — correcto para el cobro inline, pero un barrido
   * que repone una venta del martes la metería en la caja abierta del jueves. El barrido
   * resuelve la sesión por ventana [openedAt, closedAt] y la pasa aquí.
   */
  targetSessionId?: string | null
}

export type CashRefundDrawerOutcome = CashSaleDrawerOutcome

/**
 * Registra el reembolso en efectivo como salida de caja. Devuelve SIEMPRE, nunca lanza.
 *
 * 🔴 DECISIÓN — SÍ RESTA AUNQUE LA ORDEN VENGA DEL DASHBOARD WEB O DEL MCP, donde no hay
 * un cajón físico enfrente. Razón: el `CashDrawerEvent` mide DINERO FÍSICO DEL LOCAL, y la
 * pregunta que contesta es "¿salió efectivo de esa caja?", no "¿desde qué pantalla se
 * tecleó?". Si un cobro en efectivo se devuelve en efectivo, el dinero salió del cajón del
 * local — lo haya capturado el cajero en la tablet o el dueño desde su casa.
 *
 * La alternativa (restar sólo cuando el actor está en el POS) exige saber dónde está
 * parado quien opera, cosa que el servidor no puede saber; y su modo de fallar es
 * justamente el defecto que este archivo arregla: el caso más común —el dueño devolviendo
 * desde la laptop del mostrador, con la caja de ese mismo local abierta— volvería a
 * inventar un SOBRANTE mudo.
 *
 * CONSECUENCIA que se acepta a cambio, acotada por dos guardas que ya existen:
 * (a) sólo se registra si el dinero ORIGINAL estaba en el cajón —una devolución de tarjeta
 * nunca lo toca— y (b) sólo si hay una caja ABIERTA, así que un reembolso capturado a la
 * 1 AM con el local cerrado no mueve nada. Queda el caso raro del dueño que registra a
 * distancia un reembolso en efectivo que NO salió de esa caja: ahí el arqueo mostrará un
 * faltante… pero con un movimiento fechado, con nombre y con motivo que lo explica. Un
 * faltante explicado es infinitamente más barato que el sobrante mudo de hoy.
 *
 * ⚠️ LÍMITE CONOCIDO (defecto separado, NO se arregla aquí): el sistema asume que el dinero
 * se devolvió POR DONDE ENTRÓ. La semántica se resuelve sobre el pago ORIGINAL porque es lo
 * único que el servidor recibe —la app no manda cómo se entregó el dinero—. Si se cobró con
 * tarjeta y se devolvió en efectivo (o al revés), el corte descuadra en ambas direcciones.
 */
export async function postCashRefundToDrawer(posting: CashRefundDrawerPosting): Promise<CashRefundDrawerOutcome> {
  try {
    // 🔴 La ÚNICA respuesta válida a "¿este dinero salió del cajón?" — evaluada sobre la
    // semántica del pago REAL (fundsFlow → snapshot del tender → legacy), nunca sobre un
    // `method === 'CASH'` que venga del cuerpo del cliente. Ese check frágil es lo que
    // tenía el gemelo de mobile: un cliente que omitiera `method` saltaba el movimiento
    // EN SILENCIO (comprobado con curl), y un vale que cuenta como efectivo físico
    // (`tenderCountsAsCash`) se quedaba fuera del arqueo.
    if (!paymentCountsAsDrawerCash(posting)) return 'NOT_DRAWER_CASH'

    // El Payment del reembolso es negativo; el PAY_OUT siempre es positivo.
    const total = new Decimal(String(posting.amount ?? 0)).abs()
    if (total.lessThanOrEqualTo(0)) return 'NOT_DRAWER_CASH'

    const session = posting.targetSessionId
      ? await prisma.cashDrawerSession.findFirst({
          where: { id: posting.targetSessionId, venueId: posting.venueId },
          select: { id: true },
        })
      : await prisma.cashDrawerSession.findFirst({
          where: { venueId: posting.venueId, status: 'OPEN' },
          select: { id: true },
        })
    // 🔴 FAIL-OPEN: sin caja abierta no pasa nada y el reembolso sigue su curso. La caja
    // jamás puede impedir devolverle su dinero a un cliente.
    if (!session) return 'NO_OPEN_DRAWER'

    const staffName = posting.staffName || (await resolveStaffName(posting.staffId))
    const note = posting.reason ? `${DRAWER_REFUND_NOTE_PREFIX} ${posting.reason}` : DRAWER_REFUND_NOTE_PREFIX

    // `createMany` + `skipDuplicates`: el reembolso YA está commiteado cuando se llega
    // aquí, así que un P2002 de un reintento sería un error en la respuesta de una
    // devolución que sí ocurrió. El índice `@@unique([venueId, localId])` es el candado.
    const result = await createEventUnderSessionLock(session.id, !posting.targetSessionId, {
      sessionId: session.id,
      venueId: posting.venueId,
      type: 'PAY_OUT',
      amount: total,
      staffId: posting.staffId || 'SYSTEM',
      staffName,
      orderId: posting.orderId || null,
      note,
      localId: cashRefundDrawerLocalId(posting.refundPaymentId),
    })
    if (!result) {
      logger.info('💵 [CASH-DRAWER] La caja se cerró mientras se registraba el movimiento — no entra a una caja cerrada', {
        venueId: posting.venueId,
        sessionId: session.id,
      })
      return 'DRAWER_CLOSED'
    }

    if (result.count === 0) {
      logger.info('💸 [CASH-DRAWER] Reembolso en efectivo ya registrado en el cajón (reintento) — no se resta dos veces', {
        venueId: posting.venueId,
        refundPaymentId: posting.refundPaymentId,
      })
      return 'ALREADY_POSTED'
    }

    logger.info('💸 [CASH-DRAWER] Reembolso en efectivo restado del cajón', {
      venueId: posting.venueId,
      refundPaymentId: posting.refundPaymentId,
      sessionId: session.id,
      amount: total.toFixed(2),
    })
    return 'POSTED'
  } catch (error) {
    // 🔴 El reembolso YA está commiteado. Propagar convertiría una devolución exitosa en
    // una pantalla de Error y el cajero devolvería el dinero otra vez.
    logger.error('❌ [CASH-DRAWER] No se pudo restar el reembolso del cajón (el reembolso NO se ve afectado)', {
      venueId: posting.venueId,
      refundPaymentId: posting.refundPaymentId,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'FAILED'
  }
}

/** Nombre legible del cajero para el listado de movimientos. Nunca lanza. */
/**
 * P1 de la auditoría de Codex (27-ago): la venta tardía entraba a una caja YA CERRADA.
 *
 * El cierre (`closeSession`) toma su CAS a CLOSED y luego lee los eventos. Un movimiento que hubiera
 * encontrado la sesión OPEN un instante antes seguía insertándose después — el `overShort` firmado
 * no lo incluía. Aquí el insert va en una transacción que PRIMERO toca la fila de la sesión con
 * `status='OPEN'`: el UPDATE toma el candado de fila; si el cierre ya la marcó CLOSED (commiteado o
 * no), esperamos y al re-evaluar el WHERE no hay fila → `null`, y el helper responde DRAWER_CLOSED.
 * Con `targetSessionId` (el barrido de la fase 3 reparando una ventana cerrada) el candado NO exige
 * OPEN: ahí reparar una sesión cerrada es justo el propósito.
 */
async function createEventUnderSessionLock(
  sessionId: string,
  requireOpen: boolean,
  data: Prisma.CashDrawerEventCreateManyInput,
): Promise<{ count: number } | null> {
  const transactionResult = await prisma.$transaction(async (tx): Promise<LateEventTransactionResult | null> => {
    const lock = await tx.cashDrawerSession.updateMany({
      where: requireOpen ? { id: sessionId, venueId: data.venueId, status: 'OPEN' } : { id: sessionId, venueId: data.venueId },
      data: { updatedAt: new Date() },
    })
    if (!lock || lock.count === 0) return null
    const result = await tx.cashDrawerEvent.createMany({ data: [data], skipDuplicates: true })
    // 🔴 P1 (Codex, 2ª auditoría): el barrido (fase 3) repone dentro de una caja YA CERRADA y contada.
    // Sin esto el esperado subía y el `overShort` firmado se quedaba viejo: "esperado 1,100 / contado
    // 1,000 / diferencia 0". Se recalcula con la MISMA fórmula del cierre, bajo el mismo candado.
    if (!requireOpen && result.count > 0) {
      const session = await tx.cashDrawerSession.findFirst({
        where: { id: sessionId, venueId: data.venueId },
        select: {
          venueId: true,
          status: true,
          shiftId: true,
          actualAmount: true,
          overShort: true,
          startingAmount: true,
          events: { select: { type: true, amount: true } },
        },
      })
      if (session && session.status === 'CLOSED' && session.actualAmount !== null) {
        const { calculateExpectedAmount } = await import('../mobile/cash-drawer.mobile.service')
        const expected = calculateExpectedAmount({ startingAmount: session.startingAmount, events: session.events })
        // `calculateExpectedAmount` is the drawer's existing authority and returns a number. The
        // signed difference itself is calculated and rounded with Decimal, then the SAME Decimal is
        // offered to both records; no provider centavos or JS subtraction can split their values.
        const expectedDecimal = new Decimal(expected.toString())
        const overShort = new Decimal(session.actualAmount.toString()).minus(expectedDecimal).toDecimalPlaces(2)
        await tx.cashDrawerSession.updateMany({ where: { id: sessionId, venueId: session.venueId }, data: { overShort } })

        let pendingReason: LateShiftPendingReason | undefined
        let shiftDifferenceBeforePesos: string | null | undefined

        if (!session.shiftId) {
          pendingReason = 'MISSING_SHIFT_RELATION'
        } else {
          // The explicit 1:1 relation is the only authority. A clock/window inference could attach
          // yesterday's physical count to another person's shift, so a missing same-tenant row is
          // deliberately one visible pending state.
          const shift = await tx.shift.findFirst({
            where: { id: session.shiftId, venueId: session.venueId },
            select: { id: true, venueId: true, status: true, cashDeclared: true, cashDifference: true },
          })

          if (!shift) {
            pendingReason = 'SHIFT_NOT_FOUND_OR_CROSS_VENUE'
          } else if (shift.status !== 'CLOSED') {
            pendingReason = 'SHIFT_NOT_CLOSED'
          } else if (shift.cashDeclared === null) {
            pendingReason = 'SHIFT_MISSING_CASH_DECLARED'
          } else if (!new Decimal(shift.cashDeclared.toString()).equals(new Decimal(session.actualAmount.toString()))) {
            pendingReason = 'SHIFT_COUNT_MISMATCH'
          } else if (overShort.absoluteValue().greaterThan(SHIFT_CASH_DIFFERENCE_MAX)) {
            pendingReason = 'SHIFT_DIFFERENCE_OVERFLOW'
          } else {
            shiftDifferenceBeforePesos = shift.cashDifference?.toFixed(2) ?? null
            // Tenant + state + physical count + prior signed value form the CAS. If an owner edits
            // the counted shift after our read, the stale late-posting repair cannot overwrite it.
            const shifted = await tx.shift.updateMany({
              where: {
                id: shift.id,
                venueId: session.venueId,
                status: 'CLOSED',
                cashDeclared: shift.cashDeclared,
                cashDifference: shift.cashDifference,
              },
              data: { cashDifference: overShort },
            })
            if (shifted.count !== 1) pendingReason = 'SHIFT_CONCURRENT_WRITE_LOST'
          }
        }

        const audit: LateClosedDrawerAudit = {
          staffId: data.staffId && data.staffId !== 'SYSTEM' ? data.staffId : undefined,
          venueId: session.venueId,
          sessionId,
          linkedShiftId: session.shiftId,
          cause: data.type,
          localId: data.localId ?? null,
          amountPesos: new Decimal(data.amount.toString()).toFixed(2),
          expectedAfterPesos: expectedDecimal.toFixed(2),
          overShortBeforePesos: session.overShort?.toFixed(2) ?? null,
          overShortAfterPesos: overShort.toFixed(2),
          shiftReconciliationStatus: pendingReason ? 'PENDING' : 'APPLIED',
          ...(pendingReason ? { pendingReason } : {}),
          ...(shiftDifferenceBeforePesos !== undefined ? { shiftDifferenceBeforePesos } : {}),
        }

        return { result, audit }
      }
    }
    return { result }
  })

  if (!transactionResult) return null
  if (!transactionResult.audit) return transactionResult.result

  const audit = transactionResult.audit
  logger.info('💵 [CASH-DRAWER] Movimiento repuesto en una caja cerrada: overShort recalculado', {
    sessionId,
    expected: audit.expectedAfterPesos,
    overShort: audit.overShortAfterPesos,
  })

  if (audit.pendingReason) {
    // Stable token for alerts/searches; the structured reason says why no Shift value was invented.
    logger.error('❌ [CASH-DRAWER] LATE_SHIFT_RECONCILIATION_PENDING', {
      venueId: audit.venueId,
      sessionId: audit.sessionId,
      linkedShiftId: audit.linkedShiftId,
      reason: audit.pendingReason,
    })
  }

  // Audit attempts happen only after the money transaction commits. `logAction` is best-effort and
  // never throws, so an audit outage cannot undo a valid late event or its signed drawer repair.
  await logAction({
    staffId: audit.staffId,
    venueId: audit.venueId,
    action: 'CASH_DRAWER_ADJUSTED_AFTER_CLOSE',
    entity: 'CashDrawerSession',
    entityId: audit.sessionId,
    data: {
      cause: audit.cause,
      localId: audit.localId,
      source: 'RECONCILER',
      // Preserve the original numeric audit contract while adding explicit Decimal-safe peso
      // strings for the linked correction. Existing audit consumers keep working unchanged.
      amount: Number(audit.amountPesos),
      overShortBefore: audit.overShortBeforePesos === null ? null : Number(audit.overShortBeforePesos),
      overShortAfter: Number(audit.overShortAfterPesos),
      expectedAfter: Number(audit.expectedAfterPesos),
      amountPesos: audit.amountPesos,
      expectedAfterPesos: audit.expectedAfterPesos,
      overShortBeforePesos: audit.overShortBeforePesos,
      overShortAfterPesos: audit.overShortAfterPesos,
      linkedShiftId: audit.linkedShiftId,
      shiftReconciliationStatus: audit.shiftReconciliationStatus,
      ...(audit.pendingReason ? { shiftReconciliationPendingReason: audit.pendingReason } : {}),
    },
  })

  if (audit.shiftReconciliationStatus === 'APPLIED' && audit.linkedShiftId) {
    await logAction({
      staffId: audit.staffId,
      venueId: audit.venueId,
      action: 'SHIFT_UPDATED',
      entity: 'Shift',
      entityId: audit.linkedShiftId,
      data: {
        cause: audit.cause,
        localId: audit.localId,
        source: 'RECONCILER',
        amountPesos: audit.amountPesos,
        cashDifferenceBeforePesos: audit.shiftDifferenceBeforePesos ?? null,
        cashDifferenceAfterPesos: audit.overShortAfterPesos,
        cashDrawerSessionId: audit.sessionId,
      },
    })
  }

  return transactionResult.result
}

async function resolveStaffName(staffId?: string | null): Promise<string> {
  if (!staffId) return 'Sistema'
  try {
    const staff = await prisma.staff.findUnique({
      where: { id: staffId },
      select: { firstName: true, lastName: true },
    })
    const name = [staff?.firstName, staff?.lastName].filter(Boolean).join(' ').trim()
    return name || 'Sistema'
  } catch {
    return 'Sistema'
  }
}
