// src/services/shared/cashDrawerPosting.ts

/**
 * 🔴 EL LADO QUE FALTABA DEL CAJÓN: la venta en efectivo.
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

import { Decimal } from '@prisma/client/runtime/library'

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { paymentCountsAsDrawerCash, TenderSemanticsPayment } from './tenderSemantics'

/**
 * Prefijo de la llave de idempotencia de los eventos que crea el SERVIDOR.
 * Se distingue a propósito de los UUID locales que mandan las apps por `/sync`.
 */
const SERVER_CASH_SALE_LOCAL_ID_PREFIX = 'srv-cash-sale:'

/** La llave del movimiento de caja de un pago. Determinista: mismo pago → misma llave. */
export function cashSaleDrawerLocalId(paymentId: string): string {
  return `${SERVER_CASH_SALE_LOCAL_ID_PREFIX}${paymentId}`
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

    const session = await prisma.cashDrawerSession.findFirst({
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
    const result = await prisma.cashDrawerEvent.createMany({
      data: [
        {
          sessionId: session.id,
          venueId: posting.venueId,
          type: 'CASH_SALE',
          amount: total,
          staffId: posting.staffId || 'SYSTEM',
          staffName,
          orderId: posting.orderId || null,
          note: null,
          localId: cashSaleDrawerLocalId(posting.paymentId),
        },
      ],
      skipDuplicates: true,
    })

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

/** Nombre legible del cajero para el listado de movimientos. Nunca lanza. */
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
