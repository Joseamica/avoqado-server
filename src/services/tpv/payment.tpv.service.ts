import { Payment, PaymentMethod, SplitType, OrderSource, PaymentSource, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { generateDigitalReceipt } from './digitalReceipt.tpv.service'
import { publishCommand } from '../../communication/rabbitmq/publisher'
import { trackRecentPaymentCommand } from '../pos-sync/posSyncOrder.service'
import { socketManager } from '../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../communication/sockets/types'
import { createTransactionCost } from '../payments/transactionCost.service'
import { deductInventoryForProduct, getProductInventoryStatus } from '../dashboard/productInventoryIntegration.service'
import type { OrderModifierForInventory } from '../dashboard/rawMaterial.service'
import { parseDateRange } from '@/utils/datetime'
import { PhaseTimer } from '@/utils/phaseTimer'
import { awardLoyaltyForPaidOrder } from '../shared/loyaltyOnPaidOrder'
import { createCommissionForPayment } from '../dashboard/commission/commission-calculation.service'
import { runAutoReorderForVenue } from '../dashboard/autoReorder.service'
import { serializedInventoryService } from '../serialized-inventory/serializedInventory.service'
import { getEffectivePaymentConfig } from '../organization-payment-config.service'
import { logAction } from '../dashboard/activity-log.service'
import { paymentIsAvoqadoSettled } from '../shared/tenderSemantics'
// La ÚNICA definición de "qué cuenta como pagado" — la comparten los cuatro
// caminos de cobro, para que un reembolso no reabra saldo en ninguno.
import { summarizeRefunds } from '../shared/orderBalance'
import { resolveTenderForCharge, computeTenderCommission, type ResolvedTenderCharge } from '../dashboard/tenderType.dashboard.service'
import { validateStaffVenue as validateStaffVenueShared } from '../../utils/staff-venue.util'
import { isRetryableDbError } from '../../utils/serializableRetry'
import { loadOrderForCfdiFromDb } from '../fiscal/cfdi.service'
import { terminalPaymentService } from '../terminal-payment.service'
// Sin ciclo: table.tpv.service NO importa este archivo (verificado 2026-08-03).
import * as tableService from './table.tpv.service'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import { postCashSaleToDrawer } from '../shared/cashDrawerPosting'
import {
  classifyCardInternationality,
  type CardInternationalityDecision,
  type ClientCountryEvidenceSource,
} from '../payments/cardInternationality.service'
import { getAreaTicketLineIdsCoveredByInventoryReservations } from './order.tpv.service'
import { resolveFastPaymentTarget } from './fastPaymentTarget'
import { linkCustomerToExistingOrder, normalizeRequestedCustomerId, resolveFastOrderCustomer } from './fastPaymentCustomer'

/**
 * Build the slim digitalReceipt response shape with a constructed `receiptUrl`.
 *
 * The TPV client (`FastPaymentRecorder`) requires `digitalReceipt.receiptUrl` (non-null). The
 * fresh-record path constructs it inline, but the idempotent / existing-payment branches used to
 * return the raw Prisma receipt (which has NO `receiptUrl` field) → the TPV crashed parsing the
 * response and the offline queue never cleared (stuck "pago pendiente" + blank QR). Use this
 * everywhere a digitalReceipt is returned so every response shape is consistent.
 *
 * `autofacturaAvailable` is ALWAYS present (defaults to `false`) so the TPV can pick a "…y
 * factura" QR caption only when the venue+merchant can actually self-invoice this ticket.
 */
export function mapDigitalReceiptResponse<T extends { accessKey: string }>(
  receipt: T | null | undefined,
  autofacturaAvailable = false,
): (T & { receiptUrl: string; autofacturaAvailable: boolean }) | null {
  if (!receipt) return null
  // Purely ADDITIVE: keep every field the idempotent branches already returned (id, accessKey,
  // dataSnapshot, status, …) and just ADD the constructed `receiptUrl` the TPV client needs.
  // Removes nothing → cannot break any consumer that relied on the previous shape.
  return {
    ...receipt,
    receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${receipt.accessKey}`,
    autofacturaAvailable,
  }
}

/**
 * Igual que {@link mapDigitalReceiptResponse}, pero si el pago existente NO tiene fila en
 * `DigitalReceipt`, la GENERA en vez de devolver `null`.
 *
 * 🔴 Por qué existe (incidente Testarudo Café, 2026-08-05). `mapDigitalReceiptResponse` corta con
 * `if (!receipt) return null` — correcto como mapeo, pero en las ramas idempotentes significaba
 * responder 200 con `digitalReceipt: null` a un TPV que lo leía sin protección
 * (`FastPaymentRecorder.kt` → `body.data.digitalReceipt.receiptUrl`). Gson no respeta la
 * no-nulabilidad de Kotlin, así que el null entraba y reventaba con NPE; la NPE se clasificaba
 * como error TRANSITORIO y el pago —ya cobrado y ya registrado— se reintentaba sin tope:
 * 2,781 reintentos del mismo cobro del 23-jun en 6.3 h. Cero doble cargo (la idempotencia
 * respondió bien las 2,781 veces), pero la terminal nunca cerró su pendiente.
 *
 * El TPV ya quedó blindado (`digitalReceipt` nullable + lectura null-safe), PERO un APK tarda
 * 3-5 días en llegar a las terminales y hay pagos en prod hoy en esa condición. Esto lo corta
 * desde el server, que despliega en minutos y cubre también a las terminales viejas.
 *
 * Nunca lanza: si la generación falla se cae a `null` (el comportamiento anterior) — un recibo
 * faltante jamás puede tumbar la respuesta de un cobro que ya ocurrió.
 */
export async function ensureDigitalReceiptResponse(
  paymentId: string,
  receipt: { accessKey: string } | null | undefined,
  autofacturaAvailable = false,
): Promise<{ accessKey: string; receiptUrl: string; autofacturaAvailable: boolean } | null> {
  if (receipt) return mapDigitalReceiptResponse(receipt, autofacturaAvailable)

  try {
    const generated = await generateDigitalReceipt(paymentId)
    logger.info('🧾 [idempotent] Recibo digital faltante generado al vuelo', { paymentId, receiptId: generated.id })
    return mapDigitalReceiptResponse(generated, autofacturaAvailable)
  } catch (error) {
    logger.error('🧾 [idempotent] No se pudo generar el recibo faltante — se responde sin recibo', {
      paymentId,
      error: error instanceof Error ? error.message : error,
    })
    return null
  }
}

/**
 * Resolve whether this order's ticket may self-invoice (autofactura), for the TPV's
 * "…y factura" QR caption. Mirrors `getAutofacturaStatusController`
 * (`src/controllers/public/cfdi.public.controller.ts`) — reuses the SAME canonical resolver
 * (`loadOrderForCfdiFromDb`) so the definition of "available" never drifts between the customer
 * receipt portal and the TPV printout.
 *
 * 🛡️ Hot payment path: this is a read-only fiscal-config lookup layered on top of a successful
 * charge. It must NEVER break the payment/receipt response — any error (including a rejected
 * promise) degrades to `false`, same as "not invoiceable".
 */
export async function resolveAutofacturaAvailable(orderId: string | null | undefined): Promise<boolean> {
  if (!orderId) return false
  try {
    const bundle = await loadOrderForCfdiFromDb(orderId)
    return !!bundle && bundle.facturacionEnabled && bundle.autofacturaEnabled
  } catch (error) {
    logger.error('[payment.tpv.service] resolveAutofacturaAvailable lookup failed — defaulting to false', {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Convert TPV rating strings to numeric values for database storage
 *
 * **Supports:**
 * - Numeric strings: "1", "2", "3", "4", "5" (new Android format - 2025-01-30)
 * - Categorical strings: "EXCELLENT", "GOOD", "POOR" (legacy format - backward compatibility)
 *
 * @param tpvRating The rating string from TPV
 * @returns Numeric rating (1-5) or null if invalid
 */
function mapTpvRatingToNumeric(tpvRating: string): number | null {
  // ✅ NEW: First try to parse as numeric string (Android app sends "1"-"5")
  const numericRating = parseInt(tpvRating, 10)
  if (!isNaN(numericRating) && numericRating >= 1 && numericRating <= 5) {
    return numericRating
  }

  // ⚠️ LEGACY: Fallback to categorical format for backward compatibility
  const ratingMap: Record<string, number> = {
    EXCELLENT: 5,
    GOOD: 3,
    POOR: 1,
  }

  return ratingMap[tpvRating.toUpperCase()] || null
}

/**
 * 🔴 DINERO — Aviso de inventario que viaja PEGADO a un cobro que YA se registró.
 *
 * Existe porque el inventario se revisa DESPUÉS de que el Payment quedó
 * comiteado (desde la paridad con Square, 2026-08-12, nada rechaza un cobro por
 * stock; el pre-flight previo a la transacción se quitó el 2026-08-25 porque
 * sólo duplicaba la consulta). Ahí ya no hay nada que prevenir: rechazar no
 * des-cobra la tarjeta, sólo le miente al cajero, que entonces vuelve a
 * pasarla. Ese fue el doble cobro real.
 *
 * Mismo criterio que el bloque 🚨 [Sobrepago] de este archivo: el pago se
 * registra SIEMPRE y lo que se elimina es la invisibilidad del problema.
 *
 * Se sirve como campo OPCIONAL de la respuesta de `recordOrderPayment` — con
 * spread condicional, igual que `areaTicketCheckoutState`, así que la llave
 * está AUSENTE (no `null`) cuando no hay nada que avisar y ningún cliente viejo
 * cambia de comportamiento.
 */
export interface OrderInventoryWarning {
  /**
   * `INSUFFICIENT_INVENTORY` — se detectó faltante pero el descuento SÍ corrió.
   * `INVENTORY_NOT_DEDUCTED` — el descuento falló y se revirtió; la causa puede ser
   * falta de stock, concurrencia o una receta mal configurada, y va en `issues[].reason`.
   */
  code: 'INSUFFICIENT_INVENTORY' | 'INVENTORY_NOT_DEDUCTED'
  /** El cobro SIEMPRE quedó registrado. Esto dice si el stock alcanzó a moverse. */
  inventoryDeducted: boolean
  /** Español, listo para pintarse al cajero. NO puede sugerir que el cobro falló. */
  message: string
  /** Los mismos 4 datos que antes se aplastaban en el string del error, ya estructurados. */
  issues: Array<{
    productId: string
    productName: string
    requested: number | null
    available: number | string | null
    reason: string
  }>
}

/**
 * Arma el aviso que ve el cajero. La PRIMERA frase siempre confirma el cobro:
 * si el POS sólo alcanza a pintar una línea, esa línea no puede ser la que lo
 * mande a pasar la tarjeta otra vez.
 */
export function buildInventoryWarning(rawIssues: OrderInventoryWarning['issues'], inventoryDeducted: boolean): OrderInventoryWarning {
  // En un TOCTOU real las DOS puertas reportan el MISMO producto: el pre-flight
  // con el `available` numérico, y la deducción con `available: null` y su error.
  // Sin esto el cajero ve la hamburguesa dos veces y no sabe si son dos problemas.
  // Gana la primera (el pre-flight, que trae el número), y si a ella le faltaba el
  // dato disponible, lo rellena la segunda. Un producto = una línea.
  const porProducto = new Map<string, OrderInventoryWarning['issues'][number]>()
  for (const issue of rawIssues) {
    const previo = porProducto.get(issue.productId)
    if (!previo) {
      porProducto.set(issue.productId, { ...issue })
      continue
    }
    if (previo.available == null && issue.available != null) previo.available = issue.available
    if (previo.requested == null && issue.requested != null) previo.requested = issue.requested
  }
  const issues = [...porProducto.values()]

  const detalle = issues
    .map(issue => {
      const disponible = issue.available == null ? 'sin disponibilidad confirmada' : `disponibles ${issue.available}`
      const pedido = issue.requested == null ? 'cantidad no determinada' : `se pidieron ${issue.requested}`
      return `${issue.productName} (${pedido}, ${disponible} — ${issue.reason})`
    })
    .join('; ')

  const cierre = inventoryDeducted
    ? 'El inventario sí se descontó; revisa el stock de estos productos.'
    : 'El inventario NO se descontó y la cuenta quedó marcada para revisión.'

  return {
    // El motivo real (falta de stock, concurrencia, receta mal configurada) viaja
    // verbatim en `issues[].reason`; el código sólo resume qué pasó con el stock.
    code: inventoryDeducted ? 'INSUFFICIENT_INVENTORY' : 'INVENTORY_NOT_DEDUCTED',
    inventoryDeducted,
    message: `El cobro se registró correctamente. Hubo un problema de inventario: ${detalle || 'sin detalle disponible'}. ${cierre}`,
    issues,
  }
}

/**
 * ✅ WORLD-CLASS PATTERN: Pre-flight validation (Stripe, Shopify, Toast POS)
 * Validate inventory availability BEFORE capturing payment
 * Also validates modifier inventory (Toast/Square pattern)
 *
 * @param venueId Venue ID
 * @param orderItems Order items to validate (including modifiers)
 * @returns Validation result with issues if any
 */
async function validateOrderInventoryAvailability(
  venueId: string,
  orderItems: Array<{
    productId: string
    product: { name: string }
    quantity: number
    weightQuantity?: any
    modifiers?: Array<{
      quantity: number
      modifier: {
        id: string
        name: string
        rawMaterialId: string | null
        quantityPerUnit: any // Decimal
        unit: string | null
        inventoryMode: string
      }
    }>
  }>,
): Promise<{
  available: boolean
  issues?: Array<{ productId: string; productName: string; requested: number; available: number | string; reason: string }>
}> {
  const issues: Array<{ productId: string; productName: string; requested: number; available: number | string; reason: string }> = []

  // Validate each product
  for (const item of orderItems) {
    const effectiveQuantity = item.weightQuantity != null ? Number(item.weightQuantity) : item.quantity
    try {
      const inventoryStatus = await getProductInventoryStatus(venueId, item.productId)

      // QUANTITY method → check current stock
      if (inventoryStatus.inventoryMethod === 'QUANTITY') {
        const currentStock = inventoryStatus.currentStock || 0

        if (currentStock < effectiveQuantity) {
          issues.push({
            productId: item.productId,
            productName: item.product.name,
            requested: effectiveQuantity,
            available: currentStock,
            reason: 'Insufficient stock for product',
          })
        }
      }

      // RECIPE method → check max portions
      if (inventoryStatus.inventoryMethod === 'RECIPE') {
        const maxPortions = inventoryStatus.maxPortions || 0

        if (maxPortions < effectiveQuantity) {
          // Gather missing ingredient details
          const missingIngredients =
            inventoryStatus.insufficientIngredients
              ?.map(ing => `${ing.name} (need ${ing.required} ${ing.unit}, have ${ing.available} ${ing.unit})`)
              .join(', ') || 'Unknown ingredients'

          issues.push({
            productId: item.productId,
            productName: item.product.name,
            requested: effectiveQuantity,
            available: `${maxPortions} portions (missing: ${missingIngredients})`,
            reason: 'Insufficient ingredients for recipe',
          })
        }
      }
    } catch (error: any) {
      logger.error('⚠️ Failed to validate inventory for product', {
        productId: item.productId,
        productName: item.product.name,
        error: error.message,
      })

      // If validation fails for any reason, mark as unavailable
      issues.push({
        productId: item.productId,
        productName: item.product.name,
        requested: item.quantity,
        available: 'Unknown',
        reason: `Validation error: ${error.message}`,
      })
    }

    // ✅ WORLD-CLASS: Validate modifier inventory (Toast/Square pattern)
    if (item.modifiers?.length) {
      for (const orderModifier of item.modifiers) {
        const modifier = orderModifier.modifier

        // Skip modifiers without inventory tracking
        if (!modifier.rawMaterialId || !modifier.quantityPerUnit) continue

        try {
          // Check raw material stock for this modifier
          const rawMaterial = await prisma.rawMaterial.findUnique({
            where: { id: modifier.rawMaterialId },
            select: {
              id: true,
              name: true,
              currentStock: true,
              unit: true,
            },
          })

          if (!rawMaterial) {
            issues.push({
              productId: item.productId,
              productName: `${item.product.name} + ${modifier.name}`,
              requested: orderModifier.quantity,
              available: 'Unknown',
              reason: `Raw material not found for modifier ${modifier.name}`,
            })
            continue
          }

          // Calculate total quantity needed: quantityPerUnit × orderItem.quantity × modifier.quantity
          const quantityPerUnit = parseFloat(modifier.quantityPerUnit.toString())
          const totalNeeded = quantityPerUnit * effectiveQuantity * orderModifier.quantity
          const currentStock = parseFloat(rawMaterial.currentStock.toString())

          if (currentStock < totalNeeded) {
            issues.push({
              productId: item.productId,
              productName: `${item.product.name} + ${modifier.name}`,
              requested: totalNeeded,
              available: `${currentStock} ${rawMaterial.unit}`,
              reason: `Insufficient ${rawMaterial.name} for modifier`,
            })
          }
        } catch (modifierError: any) {
          logger.error('⚠️ Failed to validate inventory for modifier', {
            productId: item.productId,
            modifierId: modifier.id,
            modifierName: modifier.name,
            error: modifierError.message,
          })
        }
      }
    }
  }

  return {
    available: issues.length === 0,
    issues: issues.length > 0 ? issues : undefined,
  }
}

/**
 * Map payment source from Android app format to PaymentSource enum
 * @param source The source string from the app (e.g., "AVOQADO_TPV")
 * @returns Valid PaymentSource enum value
 */
function mapPaymentSource(source?: string): PaymentSource {
  if (!source) return 'OTHER'

  // Map "AVOQADO_TPV" from Android app to "TPV" enum value
  if (source === 'AVOQADO_TPV') return 'TPV'

  // Check if it's a valid PaymentSource enum value
  const validSources: PaymentSource[] = ['TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER']
  return validSources.includes(source as PaymentSource) ? (source as PaymentSource) : 'OTHER'
}

/**
 * Update order totals directly in backend for standalone mode
 * @param orderId Order ID to update
 * @param paymentAmount Total payment amount (including tip)
 * @param tipAmount Tip amount from this payment (to calculate cumulative order.tipAmount)
 * @param currentPaymentId Current payment ID to exclude from calculation
 * @param staffId Optional staff ID who processed the payment (for loyalty points)
 * @returns Aviso de inventario cuando hubo faltante, o `null`. NUNCA lanza por
 *          inventario: cuando esta función corre el Payment ya está comiteado.
 */
async function updateOrderTotalsForStandalonePayment(
  orderId: string,
  paymentAmount: number,
  tipAmount: number, // ✅ FIX: Pass tip separately to update order.tipAmount
  currentPaymentId?: string,
  staffId?: string,
  options?: { areaTicketAlreadyFinalized?: boolean },
): Promise<OrderInventoryWarning | null> {
  // Get current order with payment information
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      payments: {
        where: {
          status: 'COMPLETED',
          // ✅ FIX: Exclude the current payment to avoid double-counting
          ...(currentPaymentId && { id: { not: currentPaymentId } }),
        },
        // 🔴 `type` NO es decorativo: un reembolso vive como un `Payment` NEGATIVO
        // `type: REFUND` colgado de la MISMA orden, y sin ese campo restaba de lo
        // pagado. Se leen TODOS los COMPLETED sin filtrar por `type` en la
        // consulta —igual que los otros tres canales— porque el resumen
        // compartido necesita los REFUND para reportar `refundState`.
        select: { amount: true, tipAmount: true, type: true },
      },
      items: {
        include: {
          product: true,
          // ✅ Include paymentAllocations to filter out paid items in validation
          paymentAllocations: true,
          modifiers: {
            include: {
              modifier: {
                select: {
                  id: true,
                  name: true,
                  groupId: true,
                  rawMaterialId: true,
                  quantityPerUnit: true,
                  unit: true,
                  inventoryMode: true,
                },
              },
            },
          },
        },
      },
      customer: true, // ⭐ LOYALTY: Need customer for points earning
    },
  })

  if (!order) {
    throw new Error(`Order ${orderId} not found for total update`)
  }
  const isAreaTicketOrder = order.items.some(item => item.areaTicketLineId != null)

  // 🔴 UN REEMBOLSO NO REABRE SALDO (founder, 2026-08-18).
  //
  // `summarizeRefunds` es la ÚNICA definición de "qué cuenta como pagado" del
  // backend (`src/services/shared/orderBalance.ts`), la misma que usan efectivo,
  // vales por área y cripto. Antes esta suma incluía el `Payment` NEGATIVO
  // `type: REFUND`, así que un cobro nuevo sobre una cuenta ya devuelta
  // recalculaba el saldo restando lo reembolsado y la venta volvía a pedir
  // dinero que el cliente ya había recuperado. El reembolso ahora lleva su
  // propio carril (`refundedAmount`/`refundState`), como `refunded_money` de
  // Square o `refundStatus` de Toast — y en México lo cierra el SAT: la
  // devolución se ampara con un CFDI de Egreso y el de ingreso no se toca.
  const refundSummary = summarizeRefunds(order.payments)

  // No se BLOQUEA nada: cuando esta función corre la tarjeta YA se cobró en el
  // proveedor, y rechazar aquí dejaría dinero cobrado SIN registro en Avoqado.
  // Queda un rastro greppable — MISMO token en los cuatro canales de cobro.
  if (refundSummary.refundState !== 'NONE') {
    logger.warn('⚠️ [Reembolso] cobro sobre una cuenta con reembolsos — el saldo NO los cuenta, revisar', {
      orderId,
      venueId: order.venueId,
      channel: 'recordOrderPayment',
      paymentId: currentPaymentId ?? null,
      refundState: refundSummary.refundState,
      refundedAmount: refundSummary.refundedAmount.toFixed(2),
    })
  }

  // Calculate total payments made (including this new one)
  const previousPayments = refundSummary.netPaidAmount.toNumber()
  const totalPaid = previousPayments + paymentAmount

  // ✅ FIX: Use subtotal as base (doesn't include tips), not order.total (which may already include tips from previous payments)
  const orderSubtotal = parseFloat(order.subtotal.toString())

  // Subtract order-level discount (e.g., 100% cortesía applied via applyManualDiscount).
  // Without this, discounted orders never reach isFullyPaid and stay in PENDING.
  const orderDiscount = order.discountAmount ? parseFloat(order.discountAmount.toString()) : 0

  // ✅ FIX: Calculate cumulative tip from all completed payments + current tip
  // 🔴 Sin los REFUND: la propina DEVUELTA (negativa) borraba del total la
  // propina que el mesero sí había cobrado.
  const previousTips = refundSummary.netTipAmount.toNumber()
  const totalTip = previousTips + tipAmount

  // ✅ FIX: Calculate new total including tips (consistent with fast payments)
  //
  // 🔴 MONEY: la MERCANCÍA se clampa a 0 ANTES de sumar la propina.
  //
  // Un `discountAmount` mayor que el subtotal es un estado que sí existe en la
  // base —lo dejan las cortesías de cuenta completa, y `recalculateOrderTotals`
  // guarda la suma cruda de descuentos aunque clampe su propio total— y aquí se
  // convertía en un `Order.total` NEGATIVO al cobrar: la cuenta pasaba a deber
  // dinero al cliente, el corte lo restaba de la venta del día y el POS pintaba
  // un botón "Pagar $-25.30". Visto en M13 (`cmsetvfft0001c9jxv33p26gl`):
  // subtotal 253.00 − descuento 278.30 = −25.30.
  //
  // El clamp va sobre `subtotal − descuento` y NO sobre el total completo: la
  // propina es dinero que el cliente decidió dar, no mercancía, y un descuento
  // excedente no debe comérsela. Mismo criterio que
  // `recalculateOrderTotals` (base clampada, luego se suman los cargos) y que
  // `applyManualDiscount` en discount.tpv.service.ts.
  const newTotal = Math.max(0, orderSubtotal - orderDiscount) + totalTip

  // Calculate remaining amount (based on new total)
  // 🔴 El clamp a 0 se CONSERVA a propósito: clientes viejos (TPV/Android/iOS) esperan
  // remainingBalance >= 0 y quitarlo rompería su UI. El problema nunca fue el clamp en sí,
  // sino que era la ÚNICA representación del saldo: un sobrepago quedaba idéntico a una
  // cuenta bien saldada y nadie se enteraba (Mindform: $734 cobrados sobre una cuenta de
  // $380, invisible 2 meses hasta que el watchdog lo pescó). La detección de abajo rompe
  // esa invisibilidad sin cambiar el contrato de la API.
  const remainingAmount = Math.max(0, newTotal - totalPaid)
  const isFullyPaid = remainingAmount <= 0.01 // Account for floating point precision

  // 🔴 ¿La cuenta YA estaba saldada ANTES de este pago? (audit Codex 2026-08-12, P1)
  //
  // Re-cobrar una orden ya COMPLETED —el gesto exacto del doble cobro del
  // cajero, con idempotencyKey NUEVA que la dedup no atrapa— volvía a disparar
  // `isFullyPaid` y con él TODO el loop de deducción: la mercancía se
  // descontaba DOS veces (y sin el piso del decremento condicional, a
  // negativo). El dinero sigue el criterio del bloque 🚨 [Sobrepago] de
  // arriba: se registra SIEMPRE; lo que no se repite es el efecto de
  // inventario, que ya ocurrió cuando la orden se saldó la primera vez.
  // Se compara contra el total SIN la propina de este pago (previousTips, no
  // totalTip): la propina nueva no convierte una cuenta saldada en pendiente.
  // Y exige pagos PREVIOS: una orden 100% cortesía (total clampado a 0) sin
  // pagos aún NO está saldada — su primer cobro de $0 sí debe deducir.
  const settledBeforeThisPayment =
    order.payments.length > 0 && previousPayments >= Math.max(0, orderSubtotal - orderDiscount) + previousTips - 0.01
  const coveredAreaTicketLines = isFullyPaid
    ? await getAreaTicketLineIdsCoveredByInventoryReservations(order.venueId, order.items)
    : new Set<string>()

  // 🚨 SOBREPAGO — detectar y gritar, NUNCA rechazar ni lanzar.
  //
  // Cuando este código corre, la tarjeta YA se cobró (Blumon primero, backend después): un
  // rechazo aquí dejaría dinero cobrado al cliente SIN registro en Avoqado — un cobro
  // fantasma, peor que el sobrepago. Por eso el pago SIEMPRE se registra; lo que se elimina
  // es la invisibilidad. `wasAlreadyPaid` distingue el caso Mindform exacto: un cobro nuevo
  // aterrizando sobre una cuenta que YA estaba saldada.
  const overpaidBy = Math.round((totalPaid - newTotal) * 100) / 100
  if (overpaidBy > 0.01) {
    const wasAlreadyPaid = order.paymentStatus === 'PAID'
    // BetterStack debe alertar sobre '🚨 [Sobrepago]'.
    logger.error('🚨 [Sobrepago] Se cobró MÁS de lo que vale la cuenta — el pago se registra, pero requiere revisión', {
      orderId,
      venueId: order.venueId,
      totalPaid,
      orderTotal: newTotal,
      overpaidBy,
      wasAlreadyPaid,
      paymentId: currentPaymentId ?? null,
      staffId: staffId ?? null,
    })
    // Fire-and-forget FUERA de toda transacción: una falla del audit jamás puede tocar el cobro.
    void prisma.activityLog
      .create({
        data: {
          action: 'SOBREPAGO_DETECTADO',
          entity: 'Order',
          entityId: orderId,
          staffId: staffId ?? null,
          venueId: order.venueId,
          data: {
            totalPaid,
            orderTotal: newTotal,
            overpaidBy,
            wasAlreadyPaid,
            paymentId: currentPaymentId ?? null,
          },
        },
      })
      .catch(err => {
        logger.error('🚨 [Sobrepago] No se pudo escribir el ActivityLog del sobrepago', {
          orderId,
          error: err instanceof Error ? err.message : err,
        })
      })
  }

  // 🚨 INVENTARIO INSUFICIENTE — detectar y gritar, NUNCA rechazar ni lanzar.
  //
  // Cuando este bloque corre, `prisma.$transaction` de `recordOrderPayment` YA
  // retornó: el Payment está comiteado y la tarjeta ya se cobró en el proveedor.
  // Un `throw` aquí NO des-cobra nada — sólo hace que el POS pinte "error de
  // inventario" sobre un cobro que sí pasó. El cajero concluye que no se cobró y
  // vuelve a pasar la tarjeta; ese segundo intento lleva `idempotencyKey` y
  // `referenceNumber` NUEVOS, así que la deduplicación no lo atrapa. Doble cobro
  // irrecuperable, medido en producción.
  //
  // Éste es el ÚNICO chequeo de inventario del camino de cobro. Desde la paridad con
  // Square (2026-08-12) nada rechaza un cobro por stock, así que el pre-flight que
  // corría ANTES de la transacción sólo duplicaba esta consulta y se quitó
  // (2026-08-25). Cuando dispara, el dinero ya entró: se avisa, no se revierte.
  //
  // Mismo razonamiento, línea por línea, que el bloque 🚨 [Sobrepago] de arriba.
  const inventoryIssues: OrderInventoryWarning['issues'] = []
  // true cuando la deducción REAL falló (no el pre-flight): decide el
  // `inventoryDeducted` del aviso final. Vive aquí porque el return está fuera
  // del bloque de deducción.
  let deductionFailed = false

  // ✅ WORLD-CLASS: Pre-flight validation BEFORE capturing payment (Stripe pattern)
  // Validate inventory availability before marking order as complete
  // (skip si la orden ya estaba saldada: su inventario ya se validó y dedujo)
  if (isFullyPaid && !settledBeforeThisPayment && !options?.areaTicketAlreadyFinalized) {
    // ✅ FIX: Only validate items that haven't been paid yet (no paymentAllocations)
    // Items with paymentAllocations have already been "claimed" by a previous split payment
    // Also skip items with deleted products (productId is null - Toast/Square pattern)
    const unpaidItems = order.items.filter(
      (item: any) =>
        item.productId &&
        (!item.paymentAllocations || item.paymentAllocations.length === 0) &&
        (!item.areaTicketLineId || !coveredAreaTicketLines.has(item.areaTicketLineId)),
    )

    logger.info('🔍 Pre-flight validation: Checking inventory availability before completing order', {
      orderId,
      venueId: order.venueId,
      totalItems: order.items.length,
      unpaidItems: unpaidItems.length,
      paidItems: order.items.length - unpaidItems.length,
    })

    const validation = await validateOrderInventoryAvailability(
      order.venueId,
      unpaidItems as { productId: string; product: { name: string }; quantity: number; modifiers?: any[] }[],
    )

    if (!validation.available) {
      // Se conserva el mismo detalle que antes viajaba en el mensaje del error
      // (producto, cuánto se pidió, cuánto había, motivo) — ahora estructurado.
      const issuesDescription = validation.issues
        ?.map(issue => `${issue.productName}: requested ${issue.requested}, available ${issue.available} (${issue.reason})`)
        .join('; ')

      // 🚨 token estable que machea la regla de Better Stack — NO renombrar.
      logger.error('🚨 [Inventario] Stock insuficiente detectado DESPUÉS de registrar el cobro — el pago se conserva, requiere revisión', {
        orderId,
        venueId: order.venueId,
        paymentId: currentPaymentId ?? null,
        staffId: staffId ?? null,
        stage: 'PRE_DEDUCTION',
        issues: validation.issues,
        issuesDescription,
      })

      // Fire-and-forget FUERA de toda transacción: una falla del audit jamás puede tocar el cobro.
      void prisma.activityLog
        .create({
          data: {
            action: 'INVENTARIO_INSUFICIENTE_AL_COBRAR',
            entity: 'Order',
            entityId: orderId,
            staffId: staffId ?? null,
            venueId: order.venueId,
            data: {
              stage: 'PRE_DEDUCTION',
              paymentId: currentPaymentId ?? null,
              issues: (validation.issues ?? []) as unknown as Prisma.InputJsonValue,
            },
          },
        })
        .catch(err => {
          logger.error('🚨 [Inventario] No se pudo escribir el ActivityLog del faltante de inventario', {
            orderId,
            error: err instanceof Error ? err.message : err,
          })
        })

      for (const issue of validation.issues ?? []) {
        inventoryIssues.push({
          productId: issue.productId,
          productName: issue.productName,
          requested: issue.requested,
          available: issue.available,
          reason: issue.reason,
        })
      }
      // Sin `throw`: el cobro ya existe. Se sigue adelante para dejar la cuenta
      // consistente con el dinero que SÍ entró, y el faltante viaja como aviso.
    } else {
      // En `else` a propósito: al quitar el `throw`, este log quedaba cayendo por
      // gravedad y cantaba "All inventory available" JUSTO debajo de la alerta de
      // faltante. Un log que se contradice a sí mismo cuesta una hora en un incidente.
      logger.info('✅ Pre-flight validation passed: All inventory available', {
        orderId,
        venueId: order.venueId,
      })
    }
  }

  // Determine new payment status
  let newPaymentStatus = order.paymentStatus
  if (isFullyPaid) {
    newPaymentStatus = 'PAID'
  } else if (totalPaid > 0) {
    newPaymentStatus = 'PARTIAL'
  }

  // Update order totals and status (including partial payment tracking)
  // ⭐ KIOSK MODE FIX: If servedById is null, assign the staff who processed the payment
  const shouldAssignServer = !order.servedById && staffId

  // 🔴 ATOMICIDAD del vale (audit Codex xhigh 2026-08-14): la transición a PAID y
  // el posting van en la MISMA transacción, para que valga el invariante
  //
  //     orden PAID  ⟺  posting existe
  //
  // Antes eran dos commits: si el proceso moría entre ellos, la orden quedaba
  // pagada SIN vale, y el sweeper no puede rescatar un posting que nunca nació
  // (sólo reintenta los existentes) — la deducción se perdía invisible.
  //
  // Trade-off aceptado: si el insert del vale falla, la transición a PAID se
  // revierte. NO es una regresión de "el inventario nunca bloquea un cobro":
  // el Payment YA está commiteado y el dinero registrado; lo que queda es una
  // orden sin marcar como pagada, estado que el watchdog de integridad ya
  // vigila (pago sin orden pagada) — visible y recuperable, a diferencia de la
  // deducción perdida en silencio. Los dos modos de falla realistas del vale ya
  // están cerrados aguas arriba: el UNIQUE con pre-check y la clasificación en
  // lote (nada de N+1 dentro de la transacción del dinero).
  const { createSalePostingInTx } = await import('@/services/inventory/inventoryPosting.service')
  let tpvPostingId: string | null = null
  const debeRegistrarPosting = isFullyPaid && !settledBeforeThisPayment && !options?.areaTicketAlreadyFinalized

  const updatedOrder = options?.areaTicketAlreadyFinalized
    ? order
    : await prisma.$transaction(async tx => {
        const updated = await tx.order.update({
          where: { id: orderId },
          data: {
            paymentStatus: newPaymentStatus,
            // ⭐ Partial payment tracking: Persist paidAmount and remainingBalance
            paidAmount: totalPaid,
            remainingBalance: remainingAmount,
            // ✅ FIX: Update order.tipAmount with cumulative tip from all payments
            tipAmount: totalTip,
            // ✅ FIX: Update order.total to include cumulative tips (consistent with fast payments)
            total: newTotal,
            // ⭐ KIOSK MODE: Assign payment processor as server if no server was assigned
            ...(shouldAssignServer && {
              servedById: staffId,
              createdById: order.createdById || staffId, // Also set createdById if null
            }),
            ...(isFullyPaid && {
              status: 'COMPLETED',
              completedAt: new Date(),
            }),
          },
          include: {
            items: {
              include: {
                product: true,
                // ✅ Include modifiers with inventory-related fields for stock deduction
                modifiers: {
                  include: {
                    modifier: {
                      select: {
                        id: true,
                        name: true,
                        groupId: true,
                        rawMaterialId: true,
                        quantityPerUnit: true,
                        unit: true,
                        inventoryMode: true,
                      },
                    },
                  },
                },
              },
            },
          },
        })

        // El vale nace aquí dentro: mismo commit que la transición a PAID.
        if (debeRegistrarPosting) {
          const posting = await createSalePostingInTx(tx, {
            venueId: updated.venueId,
            orderId,
            items: updated.items as any,
            staffId,
          })
          tpvPostingId = posting?.id ?? null
        }

        return updated
      })

  logger.info('Order totals updated for standalone payment', {
    orderId,
    orderSubtotal,
    newTotal, // ✅ Subtotal + cumulative tips
    paymentAmount,
    tipAmount,
    totalTip, // ✅ Cumulative tip from all payments
    totalPaid,
    remainingAmount,
    isFullyPaid,
    newPaymentStatus,
    // ⭐ KIOSK MODE: Log if we assigned the server from payment processor
    kioskModeServerAssigned: shouldAssignServer,
    assignedServerId: shouldAssignServer ? staffId : null,
  })

  // 🔥 INVENTORY DEDUCTION: Automatically deduct stock when order is completed
  // Non-blocking (payments.md): la venta cobrada nunca se revierte por
  // inventario — el fallo viaja como aviso + 🚨 log, y QUANTITY llega a negativo
  // en la fuente. (El comentario anterior decía "Fail payment if inventory
  // deduction fails (Shopify, Square, Toast)" — falso: Square hace lo opuesto.)
  // 🔴 `!settledBeforeThisPayment`: la mercancía de una orden ya saldada salió
  // con el PRIMER cobro — repetir el loop la descontaba dos veces (audit Codex).
  if (isFullyPaid && !settledBeforeThisPayment && !options?.areaTicketAlreadyFinalized) {
    const deductionErrors: Array<{ productId: string; productName: string; requested: number; error: string }> = []
    // Items cuya deducción SÍ se aplicó — se QUEDAN deducidos aunque otro item
    // falle (se vendieron); van al log/ActivityLog como contexto del drift.
    const deductedItems: Array<{ productId: string; quantity: number }> = []

    // 🔴 Posting durable (fase 2, atomizado en la 3.5): el vale YA nació en la
    // transacción que marcó la orden PAID (arriba) — aquí sólo se RECLAMA para
    // deducir: se leen sus líneas y se marca APPLYING. Cada línea se marca
    // APPLIED/FAILED conforme el loop avanza, así el sweeper sólo reintenta lo
    // que quedó pendiente y nunca re-deduce lo ya aplicado. El loop de abajo NO
    // se toca: lo comparten 8 features del cobro y está probado en producción.
    let tpvPostingLines = new Map<string, string>()
    try {
      if (tpvPostingId) {
        const lines = await prisma.inventoryPostingLine.findMany({ where: { postingId: tpvPostingId } })
        tpvPostingLines = new Map(lines.map(l => [l.effectKey, l.id]))
        await prisma.inventoryPosting.updateMany({
          where: { id: tpvPostingId, status: 'PENDING' },
          data: { status: 'APPLYING', attempts: { increment: 1 } },
        })
      }
    } catch (postingError: any) {
      // El posting es OBSERVABILIDAD durable: si falla, la deducción sigue igual
      // que antes de la fase 2 — jamás puede impedir que la mercancía se descuente.
      logger.error('[InventoryPosting] No se pudo registrar el posting del cobro TPV (la deducción continúa)', {
        orderId,
        error: postingError?.message,
      })
    }

    logger.info('🎯 Starting inventory deduction for completed order', {
      orderId,
      venueId: updatedOrder.venueId,
      itemCount: updatedOrder.items.length,
    })

    // Deduct stock for each product in the order
    for (const item of updatedOrder.items) {
      if (item.areaTicketLineId && coveredAreaTicketLines.has(item.areaTicketLineId)) {
        logger.info('⏭️ Skipping generic deduction for area-ticket line covered by reservation', {
          orderId,
          orderItemId: item.id,
          areaTicketLineId: item.areaTicketLineId,
        })
        continue
      }

      // Skip items where product was deleted (Toast/Square pattern)
      if (!item.productId) {
        // ⚠️ SERIALIZED INVENTORY: Check if this is a serialized item before skipping
        // Serialized items have productId=null but productSku contains the serial number
        if (item.productSku) {
          try {
            logger.info('📦 Marking serialized item as SOLD', {
              orderId,
              orderItemId: item.id,
              serialNumber: item.productSku,
              productName: item.productName,
            })
            // Plan §1.5 — pass staffId so the custody precheck logs WARN-mode
            // violations even at payment-post-hook. The order createdById is
            // the promoter who rang the sale. We intentionally wrap in
            // try/catch (already here) so ENFORCE mode does not break payment
            // completion — the scan/sell precheck is the primary gate.
            await serializedInventoryService.markAsSold(updatedOrder.venueId, item.productSku, item.id, undefined, {
              staffId: updatedOrder.createdById ?? staffId,
            })
            logger.info('✅ Serialized item marked as SOLD', {
              orderId,
              serialNumber: item.productSku,
            })
          } catch (markAsSoldError: any) {
            logger.error('❌ Failed to mark serialized item as SOLD', {
              orderId,
              orderItemId: item.id,
              serialNumber: item.productSku,
              error: markAsSoldError.message,
            })
            // Don't fail the payment if marking as sold fails
            // Item will remain in AVAILABLE status and can be manually corrected
          }
        } else {
          logger.info('⏭️ Skipping inventory deduction for deleted product', {
            orderId,
            productName: item.productName,
          })
        }
        continue
      }

      try {
        // ✅ Transform order item modifiers to inventory format
        // Skip modifiers where the modifier was deleted (Toast/Square pattern)
        const orderModifiers: OrderModifierForInventory[] =
          item.modifiers
            ?.filter(m => m.modifier)
            .map(m => ({
              quantity: m.quantity,
              modifier: {
                id: m.modifier!.id,
                name: m.modifier!.name,
                groupId: m.modifier!.groupId,
                rawMaterialId: m.modifier!.rawMaterialId,
                quantityPerUnit: m.modifier!.quantityPerUnit,
                unit: m.modifier!.unit,
                inventoryMode: m.modifier!.inventoryMode,
              },
            })) || []

        // Venta por peso: weighted lines deduct the weighed kilos (quantity is
        // always 1 on them); the same effective quantity feeds the compensation
        // restock below so a rollback returns exactly what was deducted.
        const effectiveQuantity = item.weightQuantity != null ? Number(item.weightQuantity) : item.quantity
        const tpvLineId = tpvPostingLines.get(item.id)
        await deductInventoryForProduct(
          updatedOrder.venueId,
          item.productId,
          effectiveQuantity,
          orderId,
          staffId, // staffId for tracking who processed the order
          orderModifiers,
          tpvLineId ? { postingLineId: tpvLineId } : undefined,
        )

        // Línea aplicada: el sweeper ya no la reintenta. Fire-and-forget — el
        // estado del posting nunca puede tumbar un cobro ya registrado.
        if (tpvLineId) {
          void prisma.inventoryPostingLine
            .update({
              where: { id: tpvLineId },
              data: { status: 'APPLIED', appliedQuantityBase: new Prisma.Decimal(effectiveQuantity) },
            })
            .catch(() => undefined)
        }

        deductedItems.push({ productId: item.productId, quantity: effectiveQuantity })

        logger.info('✅ Stock deducted successfully for product', {
          orderId,
          productId: item.productId,
          productName: item.product?.name || item.productName,
          quantity: item.quantity,
          modifiersCount: orderModifiers.length,
        })
      } catch (deductionError: any) {
        // Collect errors instead of swallowing them
        //
        // La rama CONCURRENT_TRANSACTION antes buscaba SOLO el texto
        // 'could not obtain lock', que Prisma nunca emite: en un deadlock manda
        // 'Transaction failed due to a write conflict or a deadlock' con code
        // P2034. Los 9 eventos del 17-18 jul 2026 (Mindform) cayeron por eso en
        // 'UNKNOWN' y nos dejaron sin diagnóstico — parecían recetas mal
        // configuradas cuando eran colisiones de concurrencia.
        //
        // Ahora se detectan por CÓDIGO (isRetryableDbError), no por texto, más
        // el ConflictError que deductStockFIFO lanza cuando agota sus reintentos.
        // ⚠️ Esto solo corrige la ETIQUETA para poder diagnosticar: el
        // comportamiento no cambia — abajo, todo lo que no sea NO_RECIPE sigue
        // tumbando la orden, a propósito.
        const errorReason = deductionError.message.includes('does not have a recipe')
          ? 'NO_RECIPE'
          : deductionError.message.includes('Insufficient stock')
            ? 'INSUFFICIENT_STOCK'
            : isRetryableDbError(deductionError) ||
                deductionError.message.includes('could not obtain lock') ||
                deductionError.message.includes('Conflicto de concurrencia persistente')
              ? 'CONCURRENT_TRANSACTION'
              : 'UNKNOWN'

        // Línea fallida: queda FAILED para que el sweeper la reintente sola.
        const failedLineId = tpvPostingLines.get(item.id)
        if (failedLineId) {
          void prisma.inventoryPostingLine
            .update({ where: { id: failedLineId }, data: { status: 'FAILED', reason: deductionError.message } })
            .catch(() => undefined)
        }

        logger.error('❌ Failed to deduct stock for product', {
          orderId,
          productId: item.productId,
          productName: item.product?.name || item.productName,
          quantity: item.quantity,
          error: deductionError.message,
          reason: errorReason,
        })

        // Solo NO_RECIPE es benigno (producto sin receta/tracking de inventario).
        // Cualquier otro error — incluido UNKNOWN (p.ej. unidades incompatibles
        // por una receta mal configurada) — debe fallar la orden: tragarlo en
        // silencio dejaba ventas completadas SIN deducción de stock.
        if (errorReason !== 'NO_RECIPE') {
          deductionErrors.push({
            productId: item.productId!,
            productName: item.product?.name || item.productName || 'Unknown',
            requested: item.weightQuantity != null ? Number(item.weightQuantity) : item.quantity,
            error: deductionError.message,
          })

          logAction({
            staffId,
            venueId: updatedOrder.venueId,
            action: 'INVENTORY_DEDUCTION_FAILED',
            entity: 'Order',
            entityId: orderId,
            data: {
              source: 'TPV',
              productId: item.productId,
              productName: item.product?.name || item.productName || 'Unknown',
              quantity: item.quantity,
              reason: errorReason,
              error: deductionError.message,
            },
          })
        }
      }
    }

    // Estado final del posting: APPLIED si todo aplicó, PARTIAL_FAILED si algo
    // quedó pendiente (el sweeper lo recoge). Cercado por el claim APPLYING para
    // no pisar a otro worker.
    if (tpvPostingId) {
      void prisma.inventoryPosting
        .updateMany({
          where: { id: tpvPostingId, status: 'APPLYING' },
          data:
            deductionErrors.length > 0
              ? { status: 'PARTIAL_FAILED', lastError: deductionErrors[0]?.error ?? 'línea fallida' }
              : { status: 'APPLIED', appliedAt: new Date(), lastError: null },
        })
        .catch(() => undefined)
    }

    // ✅ FIX: Rollback order if ANY critical inventory deduction failed
    if (deductionErrors.length > 0) {
      deductionFailed = true
      // 🔴 La venta cobrada SE QUEDA CERRADA (decisión founder+Claude 2026-08-12,
      // espejo de Square y de la regla escrita en payments.md: "Non-blocking:
      // payment succeeds even if deduction fails"). Antes este bloque restauraba
      // lo ya deducido, regresaba los seriales a AVAILABLE y revertía la orden a
      // PENDING/PARTIAL — con el cliente ya pagado y en la puerta: cuenta abierta,
      // sin lealtad/cupones, y CERO señal en inventario. Revertir la orden no
      // des-vende nada; sólo hace que el registro mienta.
      //
      // Con QUANTITY yendo a negativo en la fuente, lo que cae aquí son fallos de
      // receta (FIFO/unidades), deadlocks agotados y errores de configuración: el
      // faltante queda como drift para conciliación — igual que ya lo hace el
      // flujo de carrito libre en order.tpv.service.ts ("We do NOT throw — the
      // order is closed, customer is happy").
      const errorDetails = deductionErrors.map(e => `${e.productName}: ${e.error}`).join('; ')

      // Resumen a nivel orden. El detalle POR ITEM ya se auditó arriba con
      // INVENTORY_DEDUCTION_FAILED en cada catch — nombre distinto a propósito
      // para no duplicar entradas en la bitácora.
      logAction({
        staffId,
        venueId: updatedOrder.venueId,
        action: 'INVENTORY_DEDUCTION_INCOMPLETE',
        entity: 'Order',
        entityId: orderId,
        data: {
          source: 'TPV',
          failedProducts: deductionErrors,
          // Lo ya deducido se QUEDA deducido: esos items sí se vendieron.
          keptDeducted: deductedItems,
          orderStatus: 'COMPLETED',
        },
      })

      // 🚨 Segunda puerta del MISMO doble cobro: este bloque corre con el Payment
      // ya comiteado, así que no puede lanzar. 🚨 token estable de Better Stack —
      // NO renombrar.
      logger.error('🚨 [Inventario] La deducción de stock falló DESPUÉS de registrar el cobro — el pago se conserva, requiere revisión', {
        orderId,
        venueId: updatedOrder.venueId,
        paymentId: currentPaymentId ?? null,
        staffId: staffId ?? null,
        stage: 'DEDUCTION',
        failedProducts: deductionErrors,
        keptDeducted: deductedItems,
        errorDetails,
      })

      for (const failed of deductionErrors) {
        inventoryIssues.push({
          productId: failed.productId,
          productName: failed.productName,
          requested: failed.requested,
          available: null,
          reason: failed.error,
        })
      }

      // SIN `return`: la venta quedó completa, así que cupones, referidos,
      // lealtad y la liberación de la mesa corren igual que en cualquier otro
      // cobro. El aviso viaja en el retorno final de la función.
    } else {
      logger.info('🎯 Inventory deduction completed successfully for order', {
        orderId,
        totalItems: updatedOrder.items.length,
      })
    }

    // 🎟️ COUPON FINALIZATION: Mark coupons as redeemed when order is fully paid
    // ✅ WORLD-CLASS PATTERN: Coupons are "applied" at checkout but only "redeemed" on payment (Toast, Square)
    try {
      await finalizeCouponsForOrder(updatedOrder.venueId, orderId)
    } catch (couponError: any) {
      // ⚠️ Don't fail the payment if coupon finalization fails - just log the error
      logger.error('⚠️ Failed to finalize coupons (payment still succeeded)', {
        orderId,
        error: couponError.message,
      })
      // Continue execution - payment is still successful
    }

    // REFERRAL HOOK: trigger referral qualification if this order has a pending referral
    try {
      const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
      await onOrderPaid({ orderId: updatedOrder.id, venueId: updatedOrder.venueId })
    } catch (err) {
      console.error('[referral hook] onOrderPaid failed for order', updatedOrder.id, err)
    }

    // 🎁 CUSTOMER METRICS & LOYALTY POINTS: Update for ALL customers, points for PRIMARY only
    // ✅ WORLD-CLASS PATTERN: Multiple customers per order (visit tracking + loyalty)
    const orderTotal = parseFloat(updatedOrder.total.toString())

    // La regla vive en `awardLoyaltyForPaidOrder`, COMPARTIDA con el cobro en
    // efectivo de Android/iOS (`payCashOrder`). Antes estaba copiada aquí y ese
    // otro camino no la tenía: el mismo café daba sello con tarjeta y no en
    // efectivo (Testarudo, 2026-09-01). Nunca lanza.
    await awardLoyaltyForPaidOrder({
      venueId: updatedOrder.venueId,
      orderId,
      orderTotal,
      staffId,
      legacyCustomer: order.customer
        ? { id: order.customer.id, firstName: order.customer.firstName, lastName: order.customer.lastName }
        : null,
    })
  }

  // 🪑 Liberar la mesa si ésta era su última cuenta viva.
  //
  // Va en try/catch porque el estado del plano es bookkeeping — jamás puede
  // tumbar un cobro que el banco ya aprobó. (Antes también dependía de que la
  // deducción no hubiera revertido la orden; desde 2026-08-12 la venta cobrada
  // nunca se revierte por inventario, así que la mesa se libera siempre.)
  //
  // Antes esto lo hacía SOLO el cliente (`finishTableAfterPayment` → HTTP
  // directo). Sin red, con la app matada, o cobrando desde otro dispositivo, la
  // mesa se quedaba OCCUPIED sin cuenta: imposible de abrir, anular o liberar.
  if (isFullyPaid && !isAreaTicketOrder && updatedOrder.tableId) {
    try {
      await tableService.releaseTableIfSettled(updatedOrder.venueId, updatedOrder.tableId)
    } catch (error) {
      logger.error('⚠️ No se pudo liberar la mesa tras el cobro (el pago NO se ve afectado)', {
        orderId,
        tableId: updatedOrder.tableId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Todo faltante —del pre-flight o de la deducción misma— viaja como aviso.
  // `inventoryDeducted: false` sólo cuando la deducción real falló: el cajero
  // ve el problema, pero la venta cobrada nunca se revierte por inventario.
  return inventoryIssues.length > 0 ? buildInventoryWarning(inventoryIssues, !deductionFailed) : null
}

interface PaymentFilters {
  fromDate?: string
  toDate?: string
  staffId?: string
}

interface PaginationResponse<T> {
  data: T[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
    diagnostics?: any
  }
}

interface PaymentHistoryItem extends Payment {
  refundedAmount?: string | null
  isFullyRefunded?: boolean
}

/**
 * Validate staff and venue relationship using staffId
 * @param staffId Staff ID to validate
 * @param venueId Venue ID to validate against
 * @param userId Fallback user ID if staffId is not provided
 * @returns Validated staff ID
 */
export async function validateStaffVenue(staffId: string | undefined, venueId: string, userId?: string): Promise<string | undefined> {
  return validateStaffVenueShared(staffId, venueId, userId)
}

/**
 * Get payments for a venue with pagination and filtering
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param pageSize Number of items per page
 * @param pageNumber Page number
 * @param filters Filter options
 * @returns Paginated payment results
 */
export async function getPayments(
  venueId: string,
  pageSize: number,
  pageNumber: number,
  filters: PaymentFilters = {},
  _orgId?: string,
): Promise<PaginationResponse<PaymentHistoryItem>> {
  const { fromDate, toDate, staffId } = filters

  // Build the query filters
  const whereClause: any = {
    venueId: venueId,
  }

  // Add date range filters if provided using standardized datetime utility
  if (fromDate || toDate) {
    try {
      // Use parseDateRange with no default (throws error if dates are invalid)
      const dateRange = parseDateRange(fromDate, toDate, 0)
      whereClause.createdAt = {
        gte: dateRange.from,
        lte: dateRange.to,
      }
    } catch (error) {
      throw new BadRequestError(`Invalid date range: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Handle staff filter (staffId maps to processedById in new schema)
  if (staffId) {
    // Check if the staff member exists in the venue
    const staffMember = await prisma.staff.findFirst({
      where: {
        id: staffId,
        venues: {
          some: {
            venueId: venueId,
          },
        },
      },
    })

    if (!staffMember) {
      logger.warn(`Staff member with ID ${staffId} not found for venue ${venueId}`)
      throw new NotFoundError(`Staff member with ID ${staffId} not found for this venue`)
    }

    whereClause.processedById = staffId
  }

  // Calculate pagination values
  const skip = (pageNumber - 1) * pageSize

  // Check total payments for venue for diagnostics
  const totalVenuePayments = await prisma.payment.count({
    where: { venueId },
  })

  // Execute the query with pagination
  const [payments, totalCount] = await prisma.$transaction([
    prisma.payment.findMany({
      where: whereClause,
      include: {
        processedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            total: true,
            table: true,
          },
        },
        // Include allocations for tip information
        allocations: {
          select: {
            id: true,
            amount: true,
            orderItem: {
              select: {
                id: true,
                product: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: pageSize,
    }),
    prisma.payment.count({
      where: whereClause,
    }),
  ])

  // Calculate pagination metadata
  const totalPages = Math.ceil(totalCount / pageSize)

  const paymentsWithRefundMeta: PaymentHistoryItem[] = payments.map(payment => {
    const processorData = (payment.processorData as Record<string, unknown>) || {}
    const refundedRaw = processorData.refundedAmount

    let refundedAmount: number | null = null
    if (typeof refundedRaw === 'number') {
      refundedAmount = refundedRaw
    } else if (typeof refundedRaw === 'string' && refundedRaw.trim() !== '') {
      const parsed = parseFloat(refundedRaw)
      refundedAmount = Number.isNaN(parsed) ? null : parsed
    }

    const amountValue = parseFloat(payment.amount.toString())
    const tipValue = parseFloat(payment.tipAmount?.toString() || '0')
    const totalOriginalAmount = amountValue + tipValue
    const isFullyRefunded = refundedAmount != null && totalOriginalAmount > 0 ? refundedAmount >= totalOriginalAmount : false

    return {
      ...payment,
      refundedAmount: refundedAmount != null ? refundedAmount.toString() : null,
      isFullyRefunded,
    }
  })

  const response: PaginationResponse<PaymentHistoryItem> = {
    data: paymentsWithRefundMeta,
    meta: {
      totalCount,
      pageSize,
      currentPage: pageNumber,
      totalPages,
      hasNextPage: pageNumber < totalPages,
      hasPrevPage: pageNumber > 1,
    },
  }

  // Add diagnostic information if no results
  if (totalCount === 0) {
    const diagnosticInfo: any = {
      venueExists: (await prisma.venue.findUnique({ where: { id: venueId } })) !== null,
      totalVenuePayments,
      filters: {
        dateRange: fromDate || toDate ? true : false,
        staffId: staffId ? true : false,
      },
    }

    // Try to get the most recent payment for this venue
    const latestPayment = await prisma.payment.findFirst({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, processedById: true },
    })

    if (latestPayment) {
      diagnosticInfo.latestPaymentDate = latestPayment.createdAt
    }

    response.meta.diagnostics = diagnosticInfo
  }

  return response
}

/**
 * Interface for payment creation data
 */
interface PaymentCreationData {
  venueId: string
  amount: number // Amount in cents
  tip: number // Tip in cents
  status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'PROCESSING' | 'REFUNDED'
  // Ausente SÓLO cuando viaja `tenderTypeId`: ahí el método fiscal lo resuelve el
  // server desde la revisión congelada del catálogo. El schema exige exactamente uno
  // de los dos, así que un payload sin ninguno nunca llega hasta aquí.
  method?: 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'DIGITAL_WALLET' | 'BANK_TRANSFER' | 'OTHER'
  // Referencia al tipo de pago del negocio. Sólo la referencia: la semántica de dinero
  // (comisión, cajón, forma SAT) la congela el server desde `VenueTenderTypeRevision`.
  tenderTypeId?: string
  tenderRevision?: number
  // Sólo la cola de reintentos del POS. Honra la revisión que el cajero vio al cobrar:
  // una venta ya ocurrida no se rechaza porque el catálogo cambió después.
  isOfflineReplay?: boolean
  // Detalle del cobro declarado a mano ("Tarjeta (terminal externa)"). Sólo aplica a
  // métodos que NO pasaron por Avoqado; en efectivo va null. iOS manda null explícito.
  externalSource?: string | null
  source: string
  splitType: 'PERPRODUCT' | 'EQUALPARTS' | 'CUSTOMAMOUNT' | 'FULLPAYMENT'
  tpvId: string
  staffId: string
  paidProductsId: string[]

  // 🔴 El CLIENTE de la venta rápida. Opcional/aditivo: los POS que no lo mandan se
  // comportan exactamente igual que antes. Un id inválido NUNCA rechaza el cobro — ver
  // `fastPaymentCustomer.ts` para el porqué completo.
  customerId?: string | null

  // Snapshot de MERCHANT_ROUTING_RULES evaluado por la TPV para este cobro
  // (auditoría). Opcional — APKs viejos no lo envían.
  routingEvaluation?: Prisma.InputJsonValue

  // Card payment fields
  cardBrand?: string
  last4?: string
  typeOfCard?: 'CREDIT' | 'DEBIT'
  currency: string
  bank?: string

  // Menta integration fields
  mentaAuthorizationReference?: string
  mentaOperationId?: string
  mentaTicketId?: string
  token?: string
  isInternational: boolean
  issuerCountryCode?: string
  issuerCountrySource?: ClientCountryEvidenceSource

  // Additional fields
  reviewRating?: string

  // Enhanced payment tracking fields (from new database migration)
  authorizationNumber?: string
  referenceNumber?: string
  maskedPan?: string
  entryMode?: string

  // ⭐ Provider-agnostic merchant account tracking (2025-01-10)
  merchantAccountId?: string // Primary: Structured merchant account ID
  blumonSerialNumber?: string // Legacy: Blumon-specific serial number (deprecated)

  // Split payment specific fields
  equalPartsPartySize?: number
  equalPartsPayedFor?: number

  // 🔧 PRE-payment verification fields (generated ONCE when entering verification screen)
  // orderReference ensures photos match order number (FAST-{timestamp} or ORD-{number})
  orderReference?: string

  // Firebase Storage URLs of verification photos (uploaded before payment)
  verificationPhotos?: string[]

  // Scanned barcodes from verification screen
  verificationBarcodes?: string[]

  // 💸 Blumon Operation Number (2025-12-16)
  // Small integer from SDK response (response.operation) needed for CancelIcc refunds
  // This allows refunds to work WITHOUT waiting for Blumon webhook
  // Example: 12945658 (fits in number, unlike the 12-digit referenceNumber string)
  blumonOperationNumber?: number

  // ⭐ Device Serial Number for Terminal attribution (2026-01-08)
  // Links payment to the Terminal that processed it (for device-based reporting)
  // This is the Terminal.serialNumber (e.g., "AVQD-2841548417"), NOT blumonSerialNumber
  deviceSerialNumber?: string

  // 🛡️ Idempotency key (2026-04-08) - Stripe/Square/Toast pattern
  // Client-generated UUID v4 sent ONCE per logical payment attempt and reused
  // on every retry. Backend deduplicates atomically via the unique index
  // (venueId, idempotencyKey) in the Payment table.
  //
  // Backwards compatible: optional. TPV versions < v1.10.10 do not send it,
  // and those requests fall back to the legacy referenceNumber-based check.
  idempotencyKey?: string
  // POS→TPV arbitration link (the POS-generated requestId). When present, this
  // Payment's creation closes the TerminalPaymentRequest row + frees the
  // terminal slot atomically. Optional/additive; old TPVs omit it.
  terminalPaymentRequestId?: string
}

/**
 * Shadow-only issuer-country decision. Cash/manual/external methods have no card
 * issuer to classify and therefore keep the new Payment fields null.
 */
function classifyPaymentInternationalityShadow(paymentData: PaymentCreationData): CardInternationalityDecision | null {
  if (paymentData.method !== 'CREDIT_CARD' && paymentData.method !== 'DEBIT_CARD') return null

  return classifyCardInternationality({
    issuerCountryCode: paymentData.issuerCountryCode,
    issuerCountrySource: paymentData.issuerCountrySource,
    maskedPan: paymentData.maskedPan,
    legacyIsInternational: paymentData.isInternational,
  })
}

function logPaymentInternationalityShadow(
  paymentId: string,
  legacyIsInternational: boolean,
  decision: CardInternationalityDecision | null,
): void {
  if (!decision) return

  logger.info('[CardInternationality][shadow] Classification recorded; financial behavior unchanged', {
    paymentId,
    shadowMode: true,
    status: decision.status,
    source: decision.source,
    reasonCode: decision.reasonCode,
    classificationVersion: decision.classificationVersion,
    legacyIsInternational,
    legacyComparison: decision.legacyComparison,
    registryMatched: decision.registryMatched,
  })
}

/**
 * ⭐ Helper: Resolve Blumon serial number to merchant account ID
 *
 * **Purpose:** Backward compatibility for old Android clients that send only `blumonSerialNumber`
 *
 * **Logic:**
 * 1. Find MerchantAccount where blumonSerialNumber matches
 * 2. Verify it's configured for the given venue
 * 3. Return merchant account ID or undefined
 *
 * **Example:**
 * ```typescript
 * const merchantId = await resolveBlumonSerialToMerchantId('venue_123', '2841548417')
 * // Returns: 'cuid_abc123' (MerchantAccount.id)
 * ```
 *
 * @param venueId Venue ID to scope the search
 * @param blumonSerialNumber Blumon serial number (e.g., "2841548417")
 * @returns MerchantAccount ID or undefined if not found
 */
async function resolveBlumonSerialToMerchantId(venueId: string, blumonSerialNumber: string): Promise<string | undefined> {
  try {
    // 1. Check venue-level configs
    const merchant = await prisma.merchantAccount.findFirst({
      where: {
        blumonSerialNumber,
        OR: [
          { venueConfigsPrimary: { some: { venueId } } },
          { venueConfigsSecondary: { some: { venueId } } },
          { venueConfigsTertiary: { some: { venueId } } },
        ],
      },
    })

    if (merchant) {
      logger.info(`Resolved blumonSerialNumber ${blumonSerialNumber} → merchantAccountId ${merchant.id} (venue config)`)
      return merchant.id
    }

    // 2. Fallback: check org-level configs via inheritance
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    if (venue?.organizationId) {
      const orgMerchant = await prisma.merchantAccount.findFirst({
        where: {
          blumonSerialNumber,
          OR: [
            { orgConfigsPrimary: { some: { organizationId: venue.organizationId } } },
            { orgConfigsSecondary: { some: { organizationId: venue.organizationId } } },
            { orgConfigsTertiary: { some: { organizationId: venue.organizationId } } },
          ],
        },
      })

      if (orgMerchant) {
        logger.info(`Resolved blumonSerialNumber ${blumonSerialNumber} → merchantAccountId ${orgMerchant.id} (org config)`)
        return orgMerchant.id
      }
    }

    logger.warn(`Could not resolve blumonSerialNumber ${blumonSerialNumber} for venue ${venueId}`)
    return undefined
  } catch (error) {
    logger.error(`Error resolving blumonSerialNumber ${blumonSerialNumber}:`, error)
    return undefined
  }
}

/**
 * ⭐ Helper: Resolve Terminal ID from device serial number
 *
 * **Purpose:** Auto-link payments/orders to the Terminal that processed them
 * using the device's unique serial number (e.g., "AVQD-2841548417")
 *
 * **Logic:**
 * 1. Find Terminal by serialNumber (unique field)
 * 2. Verify it belongs to the venue (security)
 * 3. Return terminal.id for foreign key assignment
 *
 * **Example:**
 * ```typescript
 * const terminalId = await resolveTerminalIdFromSerial('venue_123', 'AVQD-2841548417')
 * // Returns: 'cmhtgsr3100gi9k1we6pyr777' (Terminal.id)
 * ```
 *
 * @param venueId Venue ID to validate ownership
 * @param deviceSerialNumber Terminal serial number (e.g., "AVQD-2841548417")
 * @returns Terminal ID or null if not found
 */
async function resolveTerminalIdFromSerial(venueId: string, deviceSerialNumber: string): Promise<string | null> {
  try {
    const terminal = await prisma.terminal.findFirst({
      where: {
        serialNumber: deviceSerialNumber,
        venueId, // Security: ensure terminal belongs to this venue
      },
      select: { id: true },
    })

    if (terminal) {
      logger.debug(`✅ Resolved deviceSerialNumber ${deviceSerialNumber} → terminalId ${terminal.id}`)
      return terminal.id
    }

    logger.warn(`⚠️ Could not resolve deviceSerialNumber ${deviceSerialNumber} for venue ${venueId}`)
    return null
  } catch (error) {
    logger.error(`❌ Error resolving deviceSerialNumber ${deviceSerialNumber}:`, error)
    return null
  }
}

/**
 * Record a payment for a specific order
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param paymentData Payment creation data
 * @param userId User ID who processed the payment
 * @param orgId Organization ID
 * @returns Created payment with order information
 */
async function markAreaTicketPaymentForReconciliation(input: {
  venueId: string
  sessionId: string
  attemptId: string
  paymentId: string
}): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.areaTicketPaymentAttempt.updateMany({
      where: { id: input.attemptId, checkoutSessionId: input.sessionId },
      data: {
        status: 'UNKNOWN',
        paymentId: input.paymentId,
        lastCheckedAt: new Date(),
      },
    })
    await tx.areaTicketCheckoutSession.updateMany({
      where: { id: input.sessionId, venueId: input.venueId },
      data: {
        status: 'RECONCILIATION_REQUIRED',
        activePaymentAttemptId: input.attemptId,
        version: { increment: 1 },
      },
    })
  })
}

async function finalizeCapturedAreaTicketPayment(input: {
  venueId: string
  orderId: string
  paymentId: string
  sessionId: string
  attemptId: string
  staffId?: string | null
}): Promise<'PAID' | 'PARTIALLY_PAID'> {
  const areaTicketPayment = await import('../mobile/areaTicketV7.mobile.service')
  const finalization = await prisma.$transaction(
    tx =>
      areaTicketPayment.finalizeAreaTicketPaymentInTransaction(tx, {
        venueId: input.venueId,
        orderId: input.orderId,
        paymentId: input.paymentId,
        // The transaction recomputes this from durable COMPLETED payments.
        fullyPaid: false,
        staffId: input.staffId ?? undefined,
        reconcileCapturedPayment: true,
        locked: { sessionId: input.sessionId, attemptId: input.attemptId },
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
  return finalization.fullyPaid ? 'PAID' : 'PARTIALLY_PAID'
}

async function resumeCapturedAreaTicketPayment(
  venueId: string,
  orderId: string,
  payment: { id: string; processedById?: string | null },
  idempotencyKey?: string | null,
): Promise<'PAID' | 'PARTIALLY_PAID' | 'RECONCILIATION_REQUIRED' | null> {
  const session = await prisma.areaTicketCheckoutSession.findFirst({
    where: { venueId, orderId },
    select: { id: true, status: true, activePaymentAttemptId: true },
  })
  if (!session) return null

  const attempt = await prisma.areaTicketPaymentAttempt.findFirst({
    where: {
      checkoutSessionId: session.id,
      orderId,
      OR: [{ paymentId: payment.id }, ...(idempotencyKey ? [{ idempotencyKey }] : [])],
    },
    orderBy: { sequence: 'desc' },
  })
  if (!attempt) return session.status === 'PAID' ? 'PAID' : session.status === 'PARTIALLY_PAID' ? 'PARTIALLY_PAID' : null

  if (attempt.status === 'SUCCEEDED' && attempt.paymentId === payment.id) {
    if (session.status === 'PAID') return 'PAID'
    if (session.status === 'PARTIALLY_PAID') return 'PARTIALLY_PAID'
  }

  try {
    return await finalizeCapturedAreaTicketPayment({
      venueId,
      orderId,
      paymentId: payment.id,
      sessionId: session.id,
      attemptId: attempt.id,
      staffId: payment.processedById,
    })
  } catch (error) {
    await markAreaTicketPaymentForReconciliation({
      venueId,
      sessionId: session.id,
      attemptId: attempt.id,
      paymentId: payment.id,
    })
    logger.error('[AREA TICKETS v7] Reintento del pago capturado sigue requiriendo conciliación', {
      venueId,
      orderId,
      paymentId: payment.id,
      checkoutSessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'RECONCILIATION_REQUIRED'
  }
}

export async function recordOrderPayment(
  venueId: string,
  orderId: string,
  paymentData: PaymentCreationData,
  userId?: string,
  _orgId?: string,
) {
  logger.info('Recording order payment', { venueId, orderId, splitType: paymentData.splitType })
  // Tiempo desde la entrada al servicio. La TPV abandona a los 10 s: cada hito lleva
  // `elapsedMs` para que un cobro lento se pueda atribuir a un tramo, no adivinar.
  const startedAt = Date.now()
  const elapsedMs = () => Date.now() - startedAt

  // 🔴 Este camino cobra CONTRA UNA ORDEN desde la terminal, y la terminal es un
  // aparato de tarjeta: sus medios son efectivo y tarjeta, no el catálogo de tipos
  // propios del negocio ("Uber Eats", vales). Ese catálogo vive en el POS, que cobra
  // por `payCashOrder` / `recordFastPayment`. Rechazar aquí es explícito a propósito:
  // si algún día alguien conecta el catálogo a esta ruta, tiene que hacerlo estampando
  // los snapshots — no colándose con un `method` a medias.
  const classicMethod = paymentData.method
  if (paymentData.tenderTypeId != null || classicMethod == null) {
    throw new BadRequestError('Esta ruta de cobro no acepta tipos de pago del catálogo. Usa el punto de venta.')
  }

  // 🛡️ IDEMPOTENCY CHECK - Layered defense (Stripe/Square/Toast pattern)
  // See recordFastPayment for full explanation. Both checks run in sequence to
  // handle the legacy→new TPV transition correctly.
  if (paymentData.idempotencyKey) {
    const existingByKey = await prisma.payment.findUnique({
      where: {
        venueId_idempotencyKey: {
          venueId,
          idempotencyKey: paymentData.idempotencyKey,
        },
      },
      include: { receipts: true },
    })

    if (existingByKey) {
      logger.info('🔄 Idempotent retry detected by idempotencyKey — returning existing order payment', {
        venueId,
        orderId,
        idempotencyKey: paymentData.idempotencyKey,
        existingPaymentId: existingByKey.id,
      })
      const areaTicketCheckoutState =
        existingByKey.status === 'COMPLETED'
          ? await resumeCapturedAreaTicketPayment(venueId, orderId, existingByKey, paymentData.idempotencyKey)
          : null
      return {
        ...existingByKey,
        ...(areaTicketCheckoutState ? { areaTicketCheckoutState } : {}),
        digitalReceipt: await ensureDigitalReceiptResponse(existingByKey.id, existingByKey.receipts[0]),
      }
    }
  }

  if (paymentData.referenceNumber) {
    // Always-on referenceNumber check (catches legacy retries and legacy→new transition races)
    const existingPayment = await prisma.payment.findFirst({
      where: {
        venueId,
        referenceNumber: paymentData.referenceNumber,
        type: { not: 'REFUND' }, // Refunds share refNumber with originals — don't match against them
      },
      include: {
        receipts: true, // Include receipt data for idempotent response
      },
    })

    if (existingPayment) {
      logger.warn('🔄 Duplicate order payment attempt detected (referenceNumber check)', {
        venueId,
        orderId,
        referenceNumber: paymentData.referenceNumber,
        existingPaymentId: existingPayment.id,
        incomingIdempotencyKey: paymentData.idempotencyKey || null,
        existingIdempotencyKey: existingPayment.idempotencyKey || null,
        message: 'Returning existing payment (safe retry / legacy→new TPV transition)',
      })

      // Return existing payment with receipt (safe retry - client gets same response)
      const areaTicketCheckoutState =
        existingPayment.status === 'COMPLETED'
          ? await resumeCapturedAreaTicketPayment(
              venueId,
              orderId,
              existingPayment,
              paymentData.idempotencyKey ?? existingPayment.idempotencyKey,
            )
          : null
      return {
        ...existingPayment,
        ...(areaTicketCheckoutState ? { areaTicketCheckoutState } : {}),
        digitalReceipt: await ensureDigitalReceiptResponse(existingPayment.id, existingPayment.receipts[0]),
      }
    }
  }

  // Find the order directly by ID. Only scalar item fields are used from here on
  // (`id`, `total`, `areaTicketLineId`); the product/modifier/allocation/venue/payments
  // relations only fed the pre-transaction pre-flight removed on 2026-08-25, and the
  // post-commit inventory check re-reads the order with what it needs.
  const activeOrder = await prisma.order.findUnique({
    where: {
      id: orderId,
      venueId,
    },
    include: {
      items: true,
    },
  })

  if (!activeOrder) {
    throw new NotFoundError(`Order ${orderId} not found in venue ${venueId}`)
  }

  // Validate splitType business logic
  if (activeOrder.splitType && activeOrder.splitType !== paymentData.splitType) {
    // Define allowed transitions based on business rules
    const allowedTransitions = {
      PERPRODUCT: ['PERPRODUCT', 'FULLPAYMENT'], // Can only continue with same method or pay full
      EQUALPARTS: ['EQUALPARTS', 'FULLPAYMENT'], // Can only continue with same method or pay full
      CUSTOMAMOUNT: ['PERPRODUCT', 'EQUALPARTS', 'CUSTOMAMOUNT', 'FULLPAYMENT'], // Can use any method
      FULLPAYMENT: ['FULLPAYMENT'], // Only full payment allowed (order should be completed)
    }

    const allowedMethods = allowedTransitions[activeOrder.splitType] || []

    if (!allowedMethods.includes(paymentData.splitType)) {
      throw new BadRequestError(
        `Order has splitType ${activeOrder.splitType}. Cannot use ${paymentData.splitType}. Allowed methods: ${allowedMethods.join(', ')}`,
      )
    }
  }

  await assertVenueSalesEnabled(venueId)

  // Convert amounts from cents to decimal (Prisma expects Decimal)
  const totalAmount = paymentData.amount / 100
  const tipAmount = paymentData.tip / 100
  const hasAreaTicketLines = activeOrder.items.some(item => item.areaTicketLineId != null)
  if (hasAreaTicketLines && !paymentData.idempotencyKey) {
    throw new BadRequestError('Las ventas con vales requieren idempotencyKey. Reintenta el mismo pago con una llave estable.')
  }

  // Ya NO hay pre-flight de inventario ANTES de registrar el cobro. Desde la paridad
  // con Square (2026-08-12) ese chequeo no rechazaba nada — sólo repetía la misma
  // consulta que hace `updateOrderTotalsForStandalonePayment` tras el commit y
  // escribía dos líneas de log. Costaba ~1 s por cobro en un camino que el cliente
  // abandona a los 10 s (prod 2026-08-25: 7 cobros abandonados en una ventana, sólo la
  // idempotencia evitó el doble cobro). El ÚNICO chequeo de inventario vive post-commit
  // y viaja al cajero como `inventoryWarning`, nunca como error.

  // ✅ CORRECTED: Use validateStaffVenue helper for proper staffId validation
  const validatedStaffId = await validateStaffVenue(paymentData.staffId, venueId, userId)

  // ✅ CORRECTED: Find current open shift for THIS STAFF MEMBER (not just any shift)
  // CRITICAL: If multiple staff members have open shifts simultaneously,
  // we must match the payment to the correct staff's shift
  const currentShift = await prisma.shift.findFirst({
    where: {
      venueId,
      staffId: validatedStaffId, // ← FIX: Filter by staff member who made the payment
      status: 'OPEN',
      endTime: null,
    },
    orderBy: {
      startTime: 'desc',
    },
  })

  // ⭐ PROVIDER-AGNOSTIC MERCHANT TRACKING: Resolve merchantAccountId
  // Priority 1: Use merchantAccountId if provided by modern Android client
  // Priority 2: Resolve blumonSerialNumber → merchantAccountId for backward compatibility
  // Priority 3: Leave undefined (legacy payments before this feature)
  let merchantAccountId = paymentData.merchantAccountId

  if (!merchantAccountId && paymentData.blumonSerialNumber) {
    logger.info(`🔄 Resolving legacy blumonSerialNumber: ${paymentData.blumonSerialNumber}`)
    merchantAccountId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
  }

  if (merchantAccountId) {
    logger.info(`✅ Payment will be attributed to merchantAccountId: ${merchantAccountId}`)
  } else {
    logger.warn(`⚠️ No merchantAccountId - payment will have null merchant (legacy mode)`)
  }

  // ⭐ 3-TIER MERCHANT RESOLUTION (Stripe-inspired pattern)
  // TIER 1: Direct Attribution - Use provided merchantAccountId if valid + active
  // TIER 2: Inference Recovery - Infer from blumonSerialNumber (SOURCE OF TRUTH from processor)
  // TIER 3: Reconciliation Flag - Null with full context for manual resolution
  if (merchantAccountId) {
    const merchantExists = await prisma.merchantAccount.findUnique({
      where: { id: merchantAccountId },
      select: { id: true, active: true },
    })

    if (!merchantExists) {
      logger.error(`❌ MerchantAccount not found: ${merchantAccountId}`, {
        venueId,
        orderId,
        paymentMethod: classicMethod,
        providedId: merchantAccountId,
        blumonSerialNumber: paymentData.blumonSerialNumber,
        hint: 'Android may have stale config. Attempting TIER 2 recovery from blumonSerialNumber.',
      })

      // TIER 2: Attempt recovery from blumonSerialNumber (the actual serial Blumon used)
      if (paymentData.blumonSerialNumber) {
        const recoveredMerchantId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
        if (recoveredMerchantId) {
          logger.info(`✅ TIER 2 Recovery SUCCESS: Inferred merchant from blumonSerialNumber`, {
            providedMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            recoveredMerchantId,
          })
          merchantAccountId = recoveredMerchantId
        } else {
          // TIER 3: Cannot resolve - flag for reconciliation
          logger.error(`❌ TIER 3: Cannot resolve merchant - reconciliation required`, {
            providedMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            authorizationNumber: paymentData.authorizationNumber,
            referenceNumber: paymentData.referenceNumber,
            venueId,
            orderId,
          })
          merchantAccountId = undefined
        }
      } else {
        // No blumonSerialNumber for recovery - fall back to null
        logger.warn(`⚠️ No blumonSerialNumber for TIER 2 recovery - falling back to null`)
        merchantAccountId = undefined
      }
    } else if (!merchantExists.active) {
      logger.warn(`⚠️ MerchantAccount ${merchantAccountId} is inactive`, {
        venueId,
        orderId,
        paymentMethod: classicMethod,
        blumonSerialNumber: paymentData.blumonSerialNumber,
      })

      // TIER 2: Attempt recovery for inactive merchant (find another active one with same serial)
      if (paymentData.blumonSerialNumber) {
        const recoveredMerchantId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
        if (recoveredMerchantId && recoveredMerchantId !== merchantAccountId) {
          logger.info(`✅ TIER 2 Recovery: Found active merchant with same serial`, {
            inactiveMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            recoveredMerchantId,
          })
          merchantAccountId = recoveredMerchantId
        } else {
          merchantAccountId = undefined
        }
      } else {
        merchantAccountId = undefined
      }
    }
  }

  // ⭐ TERMINAL ATTRIBUTION: Resolve terminalId from device serial number
  // Links payment to the Terminal that processed it (for device-based reporting)
  let terminalId: string | null = null
  if (paymentData.deviceSerialNumber) {
    terminalId = await resolveTerminalIdFromSerial(venueId, paymentData.deviceSerialNumber)
  }

  // Shadow mode only: persist the new evidence/result beside the legacy boolean,
  // but keep every pricing and settlement consumer on the legacy path for now.
  const internationalityShadow = classifyPaymentInternationalityShadow(paymentData)
  const internationalityClassifiedAt = internationalityShadow ? new Date() : undefined

  // ⭐ ATOMICITY: Wrap critical payment creation in transaction (all or nothing)
  // This prevents orphaned records if any operation fails
  //
  // 🛡️ SAFETY NET: If two concurrent requests race past the idempotency fast-path
  // above, the @@unique([venueId, idempotencyKey]) constraint will throw P2002 on
  // the second request. We catch that below and return the winning payment, making
  // the concurrent retry behave exactly like an idempotent success.
  let payment: Awaited<ReturnType<typeof prisma.payment.create>>
  let lockedAreaCheckout: { sessionId: string; attemptId: string } | null = null
  let areaTicketCheckoutState: string | null = null
  // Faltante de inventario detectado con el cobro YA registrado. Viaja como aviso
  // en la respuesta — nunca como error, o el cajero vuelve a pasar la tarjeta.
  let inventoryWarning: OrderInventoryWarning | null = null
  try {
    payment = await prisma.$transaction(async tx => {
      if (paymentData.status === 'COMPLETED') {
        const areaTicketPayment = await import('../mobile/areaTicketV7.mobile.service')
        lockedAreaCheckout = await areaTicketPayment.lockAreaTicketCheckoutForPayment(tx, {
          venueId,
          orderId: activeOrder.id,
          idempotencyKey: paymentData.idempotencyKey,
          amount: new Prisma.Decimal(totalAmount),
          method: classicMethod as PaymentMethod,
        })
      }

      // Create the payment record
      const newPayment = await tx.payment.create({
        data: {
          venueId,
          orderId: activeOrder.id,
          amount: totalAmount,
          tipAmount,
          method: classicMethod as PaymentMethod, // Cast to PaymentMethod enum
          // Mismo criterio que la venta rápida: el detalle declarado a mano sólo se
          // guarda cuando el dinero NO pasó por Avoqado.
          externalSource: classicMethod === 'CASH' ? null : paymentData.externalSource?.trim()?.slice(0, 50) || null,
          status: paymentData.status as any, // Direct enum mapping since frontend sends correct values
          splitType: paymentData.splitType as SplitType, // Cast to SplitType enum
          source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
          processor: 'TBD',
          // Snapshot de MERCHANT_ROUTING_RULES (por qué la TPV mostró/eligió este merchant)
          routingEvaluation: paymentData.routingEvaluation ?? undefined,
          processorId: paymentData.mentaOperationId,
          processorData: {
            cardBrand: paymentData.cardBrand,
            last4: paymentData.last4,
            typeOfCard: paymentData.typeOfCard,
            bank: paymentData.bank,
            currency: paymentData.currency,
            mentaAuthorizationReference: paymentData.mentaAuthorizationReference,
            mentaTicketId: paymentData.mentaTicketId,
            isInternational: paymentData.isInternational,
            ...(paymentData.issuerCountryCode && paymentData.issuerCountrySource
              ? {
                  issuerCountryEvidence: {
                    code: paymentData.issuerCountryCode,
                    source: paymentData.issuerCountrySource,
                  },
                }
              : {}),
            // ⭐ Blumon serial for reconciliation (matches dashboard de Blumon)
            blumonSerialNumber: paymentData.blumonSerialNumber || null,
            // 💸 Blumon Operation Number (2025-12-16) - For CancelIcc refunds without webhook
            blumonOperationNumber: paymentData.blumonOperationNumber || null,
          },
          // New enhanced fields in the Payment table
          authorizationNumber: paymentData.authorizationNumber,
          referenceNumber: paymentData.referenceNumber,
          // 🛡️ Idempotency key (2026-04-08) - Stripe/Square/Toast pattern
          idempotencyKey: paymentData.idempotencyKey,
          maskedPan: paymentData.maskedPan,
          cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
          entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
          internationalityStatus: internationalityShadow?.status,
          internationalitySource: internationalityShadow?.source,
          issuerCountryCode: internationalityShadow?.issuerCountryCode,
          internationalityClassificationVersion: internationalityShadow?.classificationVersion,
          internationalityClassifiedAt,
          // ⭐ Provider-agnostic merchant account tracking
          merchantAccountId,
          // ⭐ Terminal that processed this payment (resolved from deviceSerialNumber)
          terminalId,
          processedById: validatedStaffId, // ✅ CORRECTED: Use validated staff ID
          shiftId: currentShift?.id,
          feePercentage: 0, // TODO: Calculate based on payment processor
          feeAmount: 0, // TODO: Calculate based on amount and percentage
          netAmount: totalAmount + tipAmount, // For now, net amount = total
          posRawData: {
            splitType: paymentData.splitType,
            staffId: paymentData.staffId, // ✅ CORRECTED: Use staffId field name consistently
            source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
            paidProductsId: paymentData.paidProductsId || [],
            ...(paymentData.equalPartsPartySize && { equalPartsPartySize: paymentData.equalPartsPartySize }),
            ...(paymentData.equalPartsPayedFor && { equalPartsPayedFor: paymentData.equalPartsPayedFor }),
            ...(paymentData.reviewRating && { reviewRating: paymentData.reviewRating }),
          },
        },
        include: {
          order: {
            include: {
              items: true,
              venue: true,
            },
          },
          processedBy: true,
        },
      })

      // Create VenueTransaction for financial tracking and settlement
      //
      // 🔴 `PENDING` significa "Avoqado todavía le debe este dinero al negocio". Estaba
      // FIJO, así que el efectivo del cajón —y ahora un cobro de Uber Eats, que Avoqado
      // jamás va a depositar— entraban a la cola de liquidación como saldo por depositar.
      // El lado de lectura (`availableBalance`) ya filtra con este mismo predicado, o sea
      // que el número que ve el dueño estaba bien; la FILA era la que mentía, y cualquier
      // consumidor nuevo la leería mal. "¿Esto lo deposita Avoqado?" tiene UNA autoridad:
      // `paymentIsAvoqadoSettled`. Sin tender reproduce el histórico para tarjeta
      // (PENDING) y corrige el efectivo a SETTLED — que es justo lo que ya hace el cobro
      // en efectivo del POS ("Cash is immediately settled").
      await tx.venueTransaction.create({
        data: {
          venueId,
          paymentId: newPayment.id,
          type: 'PAYMENT',
          grossAmount: totalAmount + tipAmount,
          feeAmount: newPayment.feeAmount,
          netAmount: newPayment.netAmount,
          // Lo que no pasa por Avoqado no tiene nada pendiente: nace liquidado.
          status: paymentIsAvoqadoSettled(newPayment) ? 'PENDING' : 'SETTLED',
        },
      })

      // Close the POS→TPV arbitration row (frees the terminal slot) atomically
      // with the Payment — the robust recovery path (survives socket loss/restart).
      if (paymentData.terminalPaymentRequestId) {
        await terminalPaymentService.closeRowFromPaymentTx(tx, paymentData.terminalPaymentRequestId, newPayment.id)
      }

      // Update Order.splitType if this is the first payment
      if (!activeOrder.splitType) {
        await tx.order.update({
          where: { id: activeOrder.id },
          data: { splitType: paymentData.splitType as any },
        })
      }

      // Handle split payment allocations based on splitType
      if (paymentData.splitType === 'PERPRODUCT' && paymentData.paidProductsId.length > 0) {
        // Create allocations for specific products
        const orderItems = activeOrder.items.filter((item: any) => paymentData.paidProductsId.includes(item.id))

        for (const item of orderItems) {
          await tx.paymentAllocation.create({
            data: {
              paymentId: newPayment.id,
              orderItemId: item.id,
              orderId: activeOrder.id,
              amount: item.total, // Allocate the full item amount
            },
          })
        }
      } else {
        // For other split types, create a general allocation to the order
        await tx.paymentAllocation.create({
          data: {
            paymentId: newPayment.id,
            orderId: activeOrder.id,
            amount: totalAmount,
          },
        })
      }

      // ✅ UPDATE SHIFT TOTALS: Increment shift sales and tips when payment is recorded
      if (currentShift) {
        await tx.shift.update({
          where: { id: currentShift.id },
          data: {
            totalSales: {
              increment: totalAmount,
            },
            totalTips: {
              increment: tipAmount,
            },
            totalOrders: {
              increment: 1,
            },
          },
        })
        logger.info('✅ Shift totals updated', {
          shiftId: currentShift.id,
          incrementedSales: totalAmount,
          incrementedTips: tipAmount,
        })
      }

      return newPayment
    })
  } catch (error) {
    // 🛡️ P2002 safety net: unique constraint violation on (venueId, idempotencyKey)
    // means another concurrent request already created this payment. Return the
    // winner as if this was a normal idempotent retry.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta as { target?: string[] } | undefined)?.target
      const isIdempotencyConflict = Array.isArray(target) && target.includes('idempotencyKey')

      if (isIdempotencyConflict && paymentData.idempotencyKey) {
        logger.warn('🛡️ [recordOrderPayment] Concurrent race blocked by unique index — returning winner', {
          venueId,
          orderId,
          idempotencyKey: paymentData.idempotencyKey,
          target,
        })

        const winner = await prisma.payment.findUnique({
          where: {
            venueId_idempotencyKey: {
              venueId,
              idempotencyKey: paymentData.idempotencyKey,
            },
          },
          include: { receipts: true },
        })

        if (winner) {
          const winnerAreaTicketCheckoutState =
            winner.status === 'COMPLETED'
              ? await resumeCapturedAreaTicketPayment(venueId, orderId, winner, paymentData.idempotencyKey)
              : null
          return {
            ...winner,
            ...(winnerAreaTicketCheckoutState ? { areaTicketCheckoutState: winnerAreaTicketCheckoutState } : {}),
            digitalReceipt: await ensureDigitalReceiptResponse(winner.id, winner.receipts[0]),
          }
        }

        logger.error('🚨 [recordOrderPayment] P2002 on idempotencyKey but winner not found — should be impossible', {
          venueId,
          orderId,
          idempotencyKey: paymentData.idempotencyKey,
        })
      }
    }
    throw error
  }

  logger.info('VenueTransaction created for payment', {
    paymentId: payment.id,
    grossAmount: totalAmount + tipAmount,
    feeAmount: payment.feeAmount,
    netAmount: payment.netAmount,
    elapsedMs: elapsedMs(),
  })
  logPaymentInternationalityShadow(payment.id, paymentData.isInternational, internationalityShadow)

  // 🔴 EL CAJÓN SUMA LA VENTA EN EFECTIVO (simétrico con el PAY_OUT del reembolso).
  // Ver `services/shared/cashDrawerPosting.ts`: decide con `tenderSemantics` si el
  // dinero entró al cajón, no lanza nunca, y es idempotente por paymentId.
  await postCashSaleToDrawer({
    venueId,
    paymentId: payment.id,
    method: payment.method,
    fundsFlow: payment.fundsFlow,
    tenderTypeId: payment.tenderTypeId,
    tenderCountsAsCash: payment.tenderCountsAsCash,
    status: payment.status,
    type: payment.type,
    amount: payment.amount,
    tipAmount: payment.tipAmount,
    staffId: payment.processedById,
    orderId: activeOrder.id,
  })

  // Create TransactionCost for financial tracking (only for Avoqado-processed non-cash payments)
  try {
    const costResult = await createTransactionCost(payment.id)

    // Update Payment and VenueTransaction with calculated fee values
    if (costResult && costResult.feeAmount > 0) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          feeAmount: costResult.feeAmount,
          netAmount: costResult.netAmount,
        },
      })

      await prisma.venueTransaction.update({
        where: { paymentId: payment.id },
        data: {
          feeAmount: costResult.feeAmount,
          netAmount: costResult.netAmount,
          netSettlementAmount: costResult.netAmount,
        },
      })

      logger.info('Payment and VenueTransaction updated with fee values', {
        paymentId: payment.id,
        feeAmount: costResult.feeAmount,
        netAmount: costResult.netAmount,
      })
    }
  } catch (transactionCostError) {
    logger.error('Failed to create TransactionCost', {
      paymentId: payment.id,
      error: transactionCostError,
    })
    // Don't fail the payment if TransactionCost creation fails
  }

  // Create Review record if reviewRating is provided
  if (paymentData.reviewRating) {
    try {
      const rating = mapTpvRatingToNumeric(paymentData.reviewRating)
      if (rating !== null) {
        await prisma.review.create({
          data: {
            venueId: activeOrder.venueId,
            paymentId: payment.id,
            overallRating: rating,
            source: 'TPV',
            servedById: paymentData.staffId, // Link to the staff who served
          },
        })
        logger.info('Review created successfully', { paymentId: payment.id, rating, originalRating: paymentData.reviewRating })
      } else {
        logger.warn('Invalid review rating provided', { paymentId: payment.id, rating: paymentData.reviewRating })
      }
    } catch (error) {
      logger.error('Failed to create review', { paymentId: payment.id, error })
      // Don't fail the payment if review creation fails
    }
  }

  // Generate digital receipt for TPV payments (AVOQADO origin)
  let digitalReceipt = null
  try {
    digitalReceipt = await generateDigitalReceipt(payment.id)
    logger.info('Digital receipt generated for payment', {
      paymentId: payment.id,
      receiptId: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // 🔌 REAL-TIME: Emit socket events based on payment status
  try {
    const paymentPayload = {
      paymentId: payment.id,
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      method: payment.method,
      status: payment.status.toLowerCase(), // Convert to lowercase for Android compatibility
      timestamp: new Date().toISOString(),
      tableId: activeOrder.tableId,
      metadata: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
      },
    }

    // Emit appropriate event based on payment status
    if (payment.status === 'COMPLETED') {
      socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_COMPLETED, paymentPayload)
      logger.info('🔌 PAYMENT_COMPLETED event emitted', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: payment.amount,
        elapsedMs: elapsedMs(),
      })

      // Create commission calculation for this payment (non-blocking)
      if (payment.type !== 'TEST') {
        createCommissionForPayment(payment.id).catch(err => {
          logger.error('Failed to create commission for payment', {
            paymentId: payment.id,
            orderId: activeOrder.id,
            error: err instanceof Error ? err.message : String(err),
          })
        })

        // Real-time auto-reorder: if this sale left any ingredient at/below its
        // reorder point, create the PO + email the supplier right away instead of
        // waiting for the nightly job. Non-blocking (never affects the payment)
        // and self-gated — the run checks AUTO_REORDER feature + PREMIUM tier +
        // config.enabled and skips items that already have an open PO.
        runAutoReorderForVenue(activeOrder.venueId).catch(err => {
          logger.error('Failed to run real-time auto-reorder after payment', {
            paymentId: payment.id,
            venueId: activeOrder.venueId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } else if (payment.status === 'PROCESSING') {
      socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_PROCESSING, paymentPayload)
      logger.info('🔌 PAYMENT_PROCESSING event emitted', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: payment.amount,
      })
    } else if (payment.status === 'FAILED') {
      socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_FAILED, {
        ...paymentPayload,
        errorMessage: 'Payment failed during processing',
      })
      logger.warn('🔌 PAYMENT_FAILED event emitted', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: payment.amount,
      })
    }

    // Emit order updated event to venue room
    socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.ORDER_UPDATED, {
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      status: activeOrder.status,
      paymentStatus: activeOrder.paymentStatus,
      timestamp: new Date().toISOString(),
    })

    logger.info('Socket events emitted successfully', {
      paymentId: payment.id,
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      paymentStatus: payment.status,
    })
  } catch (error) {
    logger.error('Failed to emit socket events', {
      paymentId: payment.id,
      orderId: activeOrder.id,
      error,
    })
    // Don't fail the payment if socket emission fails
  }

  // ✅ NUEVO: Detectar modo de operación y manejar pago según el contexto
  const isIntegratedMode = activeOrder.source === OrderSource.POS && activeOrder.externalId && activeOrder.externalId.trim() !== ''

  logger.info('Payment processing mode detected', {
    paymentId: payment.id,
    orderId: activeOrder.id,
    isIntegratedMode,
    orderSource: activeOrder.source,
    hasExternalId: !!activeOrder.externalId,
  })

  if (isIntegratedMode) {
    // MODO INTEGRADO: Enviar comando a POS, POS maneja los totales
    try {
      const isPartialPayment = totalAmount + tipAmount < parseFloat(activeOrder.total.toString())

      await publishCommand(`command.softrestaurant.${venueId}`, {
        entity: 'Payment',
        action: 'APPLY',
        payload: {
          orderExternalId: activeOrder.externalId,
          paymentData: {
            amount: totalAmount,
            tip: tipAmount,
            posPaymentMethodId: mapPaymentMethodToPOS(classicMethod),
            reference: paymentData.mentaOperationId || paymentData.authorizationNumber || '',
            isPartial: isPartialPayment,
          },
        },
      })

      // Track this payment command to prevent double deduction when POS sends back order.updated
      if (activeOrder.externalId) {
        trackRecentPaymentCommand(activeOrder.externalId, totalAmount + tipAmount)
      }

      logger.info('Payment command sent to POS (Integrated Mode)', {
        paymentId: payment.id,
        orderExternalId: activeOrder.externalId,
        isPartial: isPartialPayment,
      })
    } catch (rabbitMQError) {
      logger.error('Failed to send payment command to POS', {
        paymentId: payment.id,
        error: rabbitMQError,
      })
      // No fallar el pago si RabbitMQ falla
    }
  } else {
    // MODO AUTÓNOMO: Backend maneja los totales directamente
    try {
      const capturedAreaCheckout = lockedAreaCheckout as {
        sessionId: string
        attemptId: string
      } | null

      if (capturedAreaCheckout && payment.status === 'COMPLETED') {
        try {
          areaTicketCheckoutState = await finalizeCapturedAreaTicketPayment({
            venueId,
            orderId: activeOrder.id,
            paymentId: payment.id,
            sessionId: capturedAreaCheckout.sessionId,
            attemptId: capturedAreaCheckout.attemptId,
            staffId: validatedStaffId,
          })
        } catch (finalizationError) {
          // El proveedor ya confirmó el dinero. Nunca habilitar otro cobro:
          // congela la sesión y conserva el mismo intento para conciliación.
          await markAreaTicketPaymentForReconciliation({
            venueId,
            sessionId: capturedAreaCheckout.sessionId,
            attemptId: capturedAreaCheckout.attemptId,
            paymentId: payment.id,
          })
          logger.error('[AREA TICKETS v7] Pago capturado; finalización requiere conciliación', {
            venueId,
            orderId,
            paymentId: payment.id,
            checkoutSessionId: capturedAreaCheckout.sessionId,
            error: finalizationError instanceof Error ? finalizationError.message : String(finalizationError),
          })
          areaTicketCheckoutState = 'RECONCILIATION_REQUIRED'
        }
        if (areaTicketCheckoutState !== 'RECONCILIATION_REQUIRED') {
          try {
            // The atomic area-ticket transaction already persisted totals and
            // inventory. Re-enter only the coupon/referral/loyalty side effects.
            await updateOrderTotalsForStandalonePayment(activeOrder.id, totalAmount + tipAmount, tipAmount, payment.id, validatedStaffId, {
              areaTicketAlreadyFinalized: true,
            })
          } catch (sideEffectError) {
            logger.error('[AREA TICKETS v7] El pago finalizó, pero fallaron efectos secundarios no monetarios', {
              venueId,
              orderId,
              paymentId: payment.id,
              error: sideEffectError instanceof Error ? sideEffectError.message : String(sideEffectError),
            })
          }
        }
      } else {
        // ✅ FIX: Pass payment ID to exclude it from previousPayments calculation
        // ⭐ LOYALTY: Pass staffId for loyalty points attribution
        // ✅ FIX: Pass tipAmount separately to update order.tipAmount
        inventoryWarning = await updateOrderTotalsForStandalonePayment(
          activeOrder.id,
          totalAmount + tipAmount,
          tipAmount,
          payment.id,
          validatedStaffId,
        )
      }

      logger.info('Order totals updated directly in backend (Standalone Mode)', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        paymentAmount: totalAmount + tipAmount,
        elapsedMs: elapsedMs(),
      })
    } catch (updateError: any) {
      // ⚠️ Este re-throw ya NO puede alcanzar al inventario, y es a propósito.
      //
      // Decía "Validation errors should FAIL the payment", pero para cuando este
      // catch corre el Payment lleva rato comiteado: fallar aquí no des-cobra la
      // tarjeta, sólo le miente al cajero — que vuelve a pasarla con
      // `idempotencyKey`/`referenceNumber` nuevos y produce el doble cobro. Por eso
      // `updateOrderTotalsForStandalonePayment` ya no lanza por inventario: devuelve
      // un `inventoryWarning` que viaja en la respuesta 201.
      //
      // El clause se conserva como guard LATENTE, no como vía viva: a hoy (2026-08-12)
      // NINGUNA ruta post-commit produce `BadRequestError`/`NotFoundError`. Se verificó
      // una por una — el inventario ya no lanza; la rama de area tickets envuelve
      // `finalizeCapturedAreaTicketPayment` en su propio try/catch y lo único que queda
      // suelto ahí (`markAreaTicketPaymentForReconciliation`) sólo puede tronar con
      // errores de Prisma; el resto de `updateOrderTotalsForStandalonePayment` va en
      // try/catch. Su único throw propio vivo es el `Error` pelón de "order not found
      // for total update", que NO es BadRequest/NotFound y por diseño cae abajo sin
      // tumbar el cobro.
      //
      // 🔴 Si algún día vuelves a meter aquí un `BadRequestError` post-commit, estás
      // reabriendo el doble cobro: el POS pinta error sobre dinero que YA entró.
      // Devuelve un aviso en la respuesta (`inventoryWarning`), no un error.
      //
      // Lo que SÍ puede tronar hoy con el Payment ya comiteado es el `throw error` del
      // catch de `prisma.$transaction` (commit en duda: se pierde el ack, se cae la
      // conexión). Por eso el fallback de `recordFastPayment` sigue siendo necesario y
      // está anclado justo con ese escenario en `fastPaymentDelegation.test.ts`.
      if (updateError instanceof BadRequestError || updateError instanceof NotFoundError) {
        logger.error('❌ Payment rejected: Business validation failed', {
          paymentId: payment.id,
          orderId: activeOrder.id,
          error: updateError.message,
          reason: 'VALIDATION_ERROR',
        })
        throw updateError // Re-throw to fail the payment
      }

      logger.error('Failed to update order totals in standalone mode', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        error: updateError,
      })
      // Continue execution - payment is still recorded even if total update fails (infrastructure error only)
    }
  }

  logger.info('Payment recorded successfully', { paymentId: payment.id, amount: totalAmount, elapsedMs: elapsedMs() })

  // 🪝 Backfill any Blumon webhook that arrived BEFORE this Payment was recorded.
  // Fire-and-forget — never block the API response on reconciliation. The cron
  // worker (`BlumonWebhookReconciliationJob`) is the safety net if this fails.
  void import('./blumon-webhook.service').then(({ reconcileWebhooksForPayment }) =>
    reconcileWebhooksForPayment({
      id: payment.id,
      processorId: payment.processorId,
      referenceNumber: payment.referenceNumber,
      venueId,
    }).catch(err => {
      logger.error('🪝 [Blumon backfill] Failed to reconcile pending webhooks for order payment', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : err,
      })
    }),
  )

  // 🪝 Backfill any AngelPay webhook that arrived BEFORE this Payment was recorded.
  // AngelPay fires on charge-approval; the TPV records only after the cashier
  // dismisses AngelPay's success screen — often minutes later. No-op for non-AngelPay
  // payments (no matching pending webhook will exist).
  void import('./angelpay-webhook.service').then(({ reconcileAngelPayWebhookForPayment }) =>
    reconcileAngelPayWebhookForPayment({
      id: payment.id,
      idempotencyKey: payment.idempotencyKey,
      referenceNumber: payment.referenceNumber,
      venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      merchantAccountId: payment.merchantAccountId,
    }).catch(err => {
      logger.error('🪝 [AngelPay backfill] Failed to reconcile pending webhooks for order payment', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : err,
      })
    }),
  )

  // Add digital receipt info to payment response
  return {
    ...payment,
    ...(areaTicketCheckoutState ? { areaTicketCheckoutState } : {}),
    // Aditivo y con spread condicional (mismo criterio que `areaTicketCheckoutState`):
    // la llave está AUSENTE cuando no hay nada que avisar, así que ninguna app vieja
    // en la calle cambia de comportamiento.
    ...(inventoryWarning ? { inventoryWarning } : {}),
    digitalReceipt: digitalReceipt
      ? {
          id: digitalReceipt.id,
          accessKey: digitalReceipt.accessKey,
          receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${digitalReceipt.accessKey}`,
          autofacturaAvailable: await resolveAutofacturaAvailable(orderId),
        }
      : null,
  }
}

/**
 * ¿El Payment de ESTA llamada quedó comiteado?
 *
 * - `landed`       — sí, con certeza. NO se cae a FAST (duplicaría).
 * - `not-landed`   — no. Se cae a FAST (el dinero tiene que aterrizar en algún lado).
 * - `unverifiable` — el payload no trae NINGUNA llave de identidad y tampoco se pudo
 *                    censar la orden. Se cae a FAST: perder un cobro es peor que
 *                    duplicar un registro (ver `verifyDelegatedPaymentLanded`).
 */
type DelegatedPaymentVerdict = 'landed' | 'not-landed' | 'unverifiable'

/** ¿El payload trae con qué probar identidad? Hoy la TPV SIEMPRE manda `idempotencyKey`. */
function hasPaymentIdentityKey(paymentData: PaymentCreationData): boolean {
  return !!(paymentData.idempotencyKey || paymentData.referenceNumber)
}

/**
 * Censo de los pagos que la orden YA tenía antes de delegar.
 *
 * Sólo se usa para payloads SIN llave de identidad — o sea, nunca en producción: la TPV
 * manda `idempotencyKey` en todo cobro (`buildFastPaymentContext`) y las reposiciones de
 * la cola offline mandan `referenceNumber`. Es la red para un cliente que no cumpla el
 * contrato, no un camino caliente: con llave, esta consulta NO corre.
 *
 * Fail-open: si truena, devuelve null → el veredicto será `unverifiable` → FAST.
 */
async function snapshotOrderPaymentIds(venueId: string, orderId: string): Promise<Set<string> | null> {
  try {
    const rows = await prisma.payment.findMany({ where: { venueId, orderId }, select: { id: true } })
    return new Set(rows.map(r => r.id))
  } catch (err) {
    logger.error('⚠️ [FastPayment] No se pudo censar los pagos de la orden antes de delegar', {
      venueId,
      orderId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * ¿MI pago comiteó? Se le pregunta a la tabla `Payment` por IDENTIDAD.
 *
 * 🔴 Por qué NO se le pregunta a la fila de arbitraje: `TerminalPaymentRequest.paymentId`
 * es un binding HEURÍSTICO por diseño de este repo, no una prueba de identidad.
 *   · El watchdog (`terminal-payment.service.ts`) ata CUALQUIER Payment COMPLETED + tarjeta
 *     + posterior a la fila sobre esa orden; su propio comentario dice que un binding
 *     exacto "tendría que venir de una referencia request↔payment, no de aritmética".
 *   · `closeRow` escribe el paymentId que reporte la terminal por socket, y ese campo del
 *     resultado es opcional.
 *   · En el schema es `paymentId String?` "(soft ref)", sin FK.
 *
 * Leer EXISTENCIA en esa fila contesta "¿hay ALGÚN paymentId?", no "¿está el MÍO?" — y se
 * equivoca en las DOS direcciones, las dos caras:
 *   · paymentId AJENO + throw TEMPRANO (nada escrito) → creeríamos que aterrizó, no
 *     caeríamos a FAST, y el cobro no quedaría registrado en NINGÚN lado. Ésa es
 *     exactamente la regresión que este fallback vino a evitar.
 *   · Fila ya COMPLETED con paymentId NULO + throw POST-commit → creeríamos que no
 *     aterrizó y caeríamos a FAST: DOS Payments. Y no es teórico ni raro:
 *     `closeRowFromPaymentTx` retorna SIN escribir cuando la fila ya está COMPLETED
 *     (deliberado y ya testeado en `terminal-payment.service.test.ts`), y un resultado por
 *     socket con `status:'success'` sin paymentId deja la fila justo así ANTES de que la
 *     TPV registre por REST. Es una vía MAINLINE.
 *
 * La llave con la que se verifica aquí es la MISMA con la que la ruta FAST deduplica más
 * abajo, así que un falso negativo NO duplica: FAST encuentra el pago ya comiteado y lo
 * devuelve. Por eso, ante la duda, caer a FAST es la dirección segura.
 *
 * Sin ninguna llave, el último recurso es el censo antes/después de la orden: si apareció
 * un pago que no estaba, fue el nuestro.
 */
async function verifyDelegatedPaymentLanded(
  venueId: string,
  orderId: string,
  paymentData: PaymentCreationData,
  paymentIdsBeforeDelegation: Set<string> | null,
): Promise<DelegatedPaymentVerdict> {
  // Identidad exacta: `@@unique([venueId, idempotencyKey])` en Payment.
  if (paymentData.idempotencyKey) {
    const mine = await prisma.payment.findFirst({
      where: { venueId, orderId, idempotencyKey: paymentData.idempotencyKey },
      select: { id: true },
    })
    return mine ? 'landed' : 'not-landed'
  }

  // Igual que el Check 2 de idempotencia de FAST: los refunds comparten
  // `referenceNumber` con el original, por eso se excluyen.
  if (paymentData.referenceNumber) {
    const mine = await prisma.payment.findFirst({
      where: { venueId, orderId, referenceNumber: paymentData.referenceNumber, type: { not: 'REFUND' } },
      select: { id: true },
    })
    return mine ? 'landed' : 'not-landed'
  }

  if (paymentIdsBeforeDelegation) {
    const after = await prisma.payment.findMany({ where: { venueId, orderId }, select: { id: true } })
    return after.some(p => !paymentIdsBeforeDelegation.has(p.id)) ? 'landed' : 'not-landed'
  }

  return 'unverifiable'
}

/**
 * Record a fast payment (without specific table association)
 * @param venueId Venue ID
 * @param paymentData Payment creation data
 * @param userId User ID who processed the payment
 * @param orgId Organization ID
 * @returns Created payment
 */
export async function recordFastPayment(venueId: string, paymentData: PaymentCreationData, userId?: string, _orgId?: string) {
  logger.info('Recording fast payment', { venueId, amount: paymentData.amount, paymentData })

  // 🔴 EL CLIENTE EFECTIVO de esta venta. Por defecto, el que mandó quien registra el
  // cobro; si no vino y la solicitud de arbitraje trae uno sembrado por el POS, ése.
  //
  // Sin `terminalPaymentRequestId` esta variable NUNCA cambia, así que el camino de
  // EFECTIVO y el de las TPV viejas quedan byte por byte iguales a como estaban.
  let effectiveCustomerId: unknown = paymentData.customerId

  // 🔴 ¿Este dinero pertenece a una venta que YA existe? El cajero pudo mandar el cobro
  // desde el POS, cancelar, y la terminal cobrar igual. Ese cobro es de la venta que lo
  // originó —con sus productos—, no de una venta sintética vacía. La solicitud de
  // arbitraje guarda el `orderId`; hasta hoy sólo se usaba para cerrar la fila.
  //
  // Fail-open a propósito: si la consulta truena, se sigue por FAST. Un fallo de infra
  // jamás puede impedir registrar dinero que YA se cobró.
  if (paymentData.terminalPaymentRequestId) {
    let arbitrationRow: { orderId: string | null; venueId: string; status: string; customerId: string | null } | null = null
    try {
      arbitrationRow = await prisma.terminalPaymentRequest.findUnique({
        where: { requestId: paymentData.terminalPaymentRequestId },
        // 🔑 `customerId` es el cliente que el POS eligió antes de mandar el cobro a la
        // terminal. La TPV registra el pago con SU payload, que no lo lleva — sin esto,
        // la venta con tarjeta nace anónima mientras la misma venta en efectivo sí trae
        // cliente.
        select: { orderId: true, venueId: true, status: true, customerId: true },
      })
    } catch (err) {
      logger.error('⚠️ [FastPayment] No se pudo leer la solicitud de arbitraje — se sigue como venta rápida', {
        requestId: paymentData.terminalPaymentRequestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const target = resolveFastPaymentTarget(arbitrationRow, venueId)

    // 🔑 El del BODY GANA sobre el de la fila: es el dato más fresco (el cajero lo acaba
    // de elegir), mientras la fila puede llevar minutos escrita. `target.seededCustomerId`
    // ya pasó por el MISMO candado de inquilino que la orden — una fila de otro venue no
    // presta ni su orden ni su cliente.
    effectiveCustomerId = normalizeRequestedCustomerId(paymentData.customerId) ?? target.seededCustomerId

    // 🔴 `requestId` es `@unique` GLOBAL y lo genera el cliente: una colisión entre
    // inquilinos devolvería el `orderId` de OTRO negocio. Se degrada a venta rápida —
    // el dinero se registra en el venue del token, nunca cruzando la frontera — y se
    // alerta, porque una colisión así no debería ocurrir jamás.
    if (target.kind === 'fastOrder' && target.reason === 'venueMismatch') {
      logger.error(
        '🚨 [FastPayment] La solicitud de arbitraje pertenece a OTRO venue — se ignora su orden y se registra como venta rápida',
        {
          requestId: paymentData.terminalPaymentRequestId,
          expectedVenueId: venueId,
          rowVenueId: arbitrationRow?.venueId,
        },
      )
    }

    if (target.kind === 'existingOrder') {
      logger.info('🎯 [FastPayment] El cobro pertenece a una venta existente — no se crea venta rápida', {
        requestId: paymentData.terminalPaymentRequestId,
        orderId: target.orderId,
        priorStatus: arbitrationRow?.status,
      })
      // recordOrderPayment ya sabe descontar inventario, cerrar la orden, actualizar el
      // turno y cerrar la fila de arbitraje. No se reimplementa nada de eso aquí.
      //
      // 🔴 `return await` (no `return` a secas): así el try/catch de abajo SÍ atrapa
      // un rechazo de esta promesa. Con `return recordOrderPayment(...)` a secas, el
      // catch nunca vería el error — se propagaría directo al llamador.
      const requestId = paymentData.terminalPaymentRequestId
      // Sólo para payloads SIN llave de identidad (nunca en producción — ver
      // `snapshotOrderPaymentIds`): con llave, esta consulta NO corre.
      const paymentIdsBeforeDelegation = hasPaymentIdentityKey(paymentData) ? null : await snapshotOrderPaymentIds(venueId, target.orderId)
      try {
        const delegated = await recordOrderPayment(venueId, target.orderId, paymentData, userId, _orgId)
        // El cliente que eligió el cajero también cuenta cuando el cobro pertenece a una
        // venta que YA existe. Sólo RELLENA (nunca reasigna) y nunca lanza, así que no
        // altera la semántica del catch de abajo. Así `customerLink` viaja en TODAS las
        // respuestas exitosas de `/fast` y el cliente móvil no tiene que adivinar.
        const customerLink = await linkCustomerToExistingOrder(venueId, target.orderId, effectiveCustomerId)
        return { ...delegated, customerLink }
      } catch (err) {
        // 🔴 La tarjeta YA se cobró. Antes de esta delegación, ese dinero por lo menos
        // aterrizaba en una venta FAST. Si recordOrderPayment truena por dentro —
        // pre-flight de inventario rechazando por stock insuficiente, venue con
        // ventas deshabilitadas, split incompatible, orden no encontrada— y se deja
        // propagar el error, el cobro no aterriza en NINGÚN lado: sería una regresión
        // que introduciríamos nosotros, dejando el sistema peor que antes de este
        // cambio. Una venta FAST vacía es mala; ninguna venta es peor. Por eso se cae
        // a la ruta FAST de siempre en vez de propagar... PERO SÓLO si el pago no
        // aterrizó ya. Ver el chequeo de abajo.
        //
        // 🔴 [Ronda 2] recordOrderPayment puede tronar DESPUÉS de que su propia
        // transacción ya comitió el Payment: `updateOrderTotalsForStandalonePayment`
        // corre un pre-flight de inventario FUERA de la transacción (rama "autónoma"
        // — MODO AUTÓNOMO más abajo en recordOrderPayment) y, si rechaza por stock
        // insuficiente, el catch de recordOrderPayment relanza BadRequestError /
        // NotFoundError con el Payment YA escrito en firme. Caer a FAST en ESE caso
        // duplicaría el cobro — y sólo se salvaría si paymentData trae
        // idempotencyKey/referenceNumber (los checks de idempotencia de FAST, arriba
        // en esta misma función, encontrarían el pago ya comitteado y lo devolverían
        // en vez de duplicar). Que la TPV siempre mande uno de los dos es una
        // suposición operativa, no una invariante forzada — no basta como red.
        //
        // La señal real NO es la fila de arbitraje: su `paymentId` es un binding
        // heurístico que ni prueba que MI pago comiteó (puede traer uno AJENO) ni
        // prueba que no (llega a COMPLETED con paymentId nulo por vía mainline). Se
        // le pregunta a la tabla `Payment` por IDENTIDAD — el razonamiento completo,
        // con las dos formas de equivocarse y lo que cuesta cada una, está en
        // `verifyDelegatedPaymentLanded`.
        let verdict: DelegatedPaymentVerdict = 'unverifiable'
        try {
          verdict = await verifyDelegatedPaymentLanded(venueId, target.orderId, paymentData, paymentIdsBeforeDelegation)
        } catch (checkErr) {
          // No se pudo verificar. Fail-open consistente con el resto de esta función
          // (nunca perder un cobro por un fallo de infraestructura): se sigue a FAST,
          // donde los checks de idempotencia vuelven a mirar por la MISMA llave y
          // devuelven el pago existente en vez de duplicarlo.
          logger.error(
            '🚨 [FastPayment] No se pudo confirmar si el pago ya aterrizó tras el fallo de recordOrderPayment — se sigue a FAST bajo incertidumbre',
            {
              requestId,
              orderId: target.orderId,
              originalError: err instanceof Error ? err.message : String(err),
              verificationError: checkErr instanceof Error ? checkErr.message : String(checkErr),
            },
          )
        }

        if (verdict === 'landed') {
          // El dinero SÍ quedó registrado en su venta real — el fallo es del
          // pre-flight posterior (inventario, etc.), no del cobro en sí. Se deja
          // subir el error ORIGINAL tal cual para que el llamador vea la razón real,
          // en vez de disfrazarlo con un segundo Payment.
          //
          // 🚨 = el token estable que Better Stack usa para alertar (mismo patrón
          // que terminal-payment.service.ts).
          logger.error('🚨 [FastPayment] recordOrderPayment tronó DESPUÉS de comitear el pago — NO se cae a FAST (evita duplicar)', {
            requestId,
            orderId: target.orderId,
            error: err instanceof Error ? err.message : String(err),
          })
          throw err
        }

        // 🚨 = el token estable que Better Stack usa para alertar (mismo patrón que
        // terminal-payment.service.ts) — un cobro que no pudo aterrizar en su venta
        // real necesita que alguien lo revise, aunque el dinero SÍ quede registrado.
        //
        // `unverifiable` se distingue del `not-landed` limpio: significa que el
        // payload no traía NINGUNA llave de identidad (contrato incumplido — la TPV
        // siempre manda `idempotencyKey`) y tampoco hubo censo. Se cae a FAST igual,
        // porque perder el cobro es peor: el POS le diría al cajero que la venta
        // sigue sin pagar y volvería a pasar la tarjeta — un doble cobro REAL. Sin
        // llave, además, FAST no tiene con qué deduplicar, así que el residual de
        // duplicar el REGISTRO se acepta a cambio de no perder el DINERO.
        logger.error('🚨 [FastPayment] recordOrderPayment tronó al delegar — el cobro cae a venta rápida para no perderse', {
          requestId,
          orderId: target.orderId,
          verdict,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ⏱️ SOLO MEDICIÓN (2026-08-09). Prod: mediana 4,471 ms / p95 4,971 ms contra
  // 130 ms de red real México→Oregon: ~97% del tiempo es trabajo del servidor,
  // no internet. Antes de mover algo a segundo plano hay que saber QUÉ fase
  // pesa. No cambia orden, valores ni manejo de errores.
  const t = new PhaseTimer('recordFastPayment', { venueId, method: paymentData.method })

  // 🛡️ IDEMPOTENCY CHECK - Layered defense (Stripe/Square/Toast pattern)
  //
  // Check 1 (preferred):  idempotencyKey — client-generated UUID v4 per logical
  //                       payment attempt. TPV >= v1.10.10 sends this.
  // Check 2 (fallback):   referenceNumber — Blumon-generated per-transaction id.
  //                       Both legacy TPV (< v1.10.10) AND new TPV send this.
  //
  // BOTH checks run in sequence (not exclusively). This is crucial for the
  // legacy→new TPV transition: if a payment exists from an old TPV client (no
  // idempotencyKey) and a new TPV client sends a retry with the same ref but a
  // new idempotencyKey, Check 2 catches it and returns the existing payment
  // instead of creating a duplicate.
  //
  // If a concurrent request races past BOTH fast-path checks, the @@unique
  // constraint on (venueId, idempotencyKey) in the Payment table will throw
  // P2002 and we catch that below as the atomic safety net.
  if (paymentData.idempotencyKey) {
    const existingByKey = await prisma.payment.findUnique({
      where: {
        venueId_idempotencyKey: {
          venueId,
          idempotencyKey: paymentData.idempotencyKey,
        },
      },
      include: { receipts: true },
    })

    if (existingByKey) {
      logger.info('🔄 Idempotent retry detected by idempotencyKey — returning existing payment', {
        venueId,
        idempotencyKey: paymentData.idempotencyKey,
        existingPaymentId: existingByKey.id,
      })
      // 🔑 El reintento NO vuelve a cobrar, pero SÍ puede rellenar el cliente que faltaba:
      // si el primer intento entró anónimo, sin esto la venta se quedaba sin cliente para
      // siempre (la idempotencia devuelve el pago y nadie vuelve a mirar). Rellenar es
      // aditivo y no toca dinero; reasignar está prohibido (ver `fastPaymentCustomer.ts`).
      const customerLink = await linkCustomerToExistingOrder(venueId, existingByKey.orderId, effectiveCustomerId)
      return {
        ...existingByKey,
        digitalReceipt: await ensureDigitalReceiptResponse(existingByKey.id, existingByKey.receipts[0]),
        customerLink,
      }
    }
  }

  if (paymentData.referenceNumber) {
    // Always-on referenceNumber check — catches:
    //   (a) Legacy TPV retries (no idempotencyKey sent)
    //   (b) Transition-period retries (new TPV sends a fresh key, but the payment
    //       was already created by the legacy client with no key)
    const existingPayment = await prisma.payment.findFirst({
      where: {
        venueId,
        referenceNumber: paymentData.referenceNumber,
        type: { not: 'REFUND' }, // Refunds share referenceNumber with originals — don't match against them
      },
      include: {
        receipts: true, // Include receipt data for idempotent response
      },
    })

    if (existingPayment) {
      logger.warn('🔄 Duplicate payment attempt detected (referenceNumber check)', {
        venueId,
        referenceNumber: paymentData.referenceNumber,
        existingPaymentId: existingPayment.id,
        incomingIdempotencyKey: paymentData.idempotencyKey || null,
        existingIdempotencyKey: existingPayment.idempotencyKey || null,
        message: 'Returning existing payment (safe retry / legacy→new TPV transition)',
      })

      // Return existing payment with receipt (safe retry - client gets same response)
      // Mismo relleno de cliente que el check por `idempotencyKey`: un reintento legacy
      // (TPV < v1.10.10, sin llave) también puede traer el cliente que faltaba.
      const customerLink = await linkCustomerToExistingOrder(venueId, existingPayment.orderId, effectiveCustomerId)
      return {
        ...existingPayment,
        digitalReceipt: await ensureDigitalReceiptResponse(existingPayment.id, existingPayment.receipts[0]),
        customerLink,
      }
    }
  }

  await t.time('assertVenueSalesEnabled', () => assertVenueSalesEnabled(venueId))

  // Convert amounts from cents to decimal (Prisma expects Decimal)
  const totalAmount = paymentData.amount / 100
  const tipAmount = paymentData.tip / 100

  // ✅ CORRECTED: Use validateStaffVenue helper for proper staffId validation
  const validatedStaffId = await t.time('validateStaffVenue', () => validateStaffVenue(paymentData.staffId, venueId, userId))

  // ✅ CORRECTED: Find current open shift for THIS STAFF MEMBER (not just any shift)
  // CRITICAL: If multiple staff members have open shifts simultaneously,
  // we must match the payment to the correct staff's shift
  t.mark('idempotenciaYChequeosPrevios')
  const currentShift = await prisma.shift.findFirst({
    where: {
      venueId,
      staffId: validatedStaffId, // ← FIX: Filter by staff member who made the payment
      status: 'OPEN',
      endTime: null,
    },
    orderBy: {
      startTime: 'desc',
    },
  })

  // Map source from Android app format to PaymentSource enum
  const mapPaymentSource = (source?: string): PaymentSource => {
    if (!source) return 'OTHER'
    // Map "AVOQADO_TPV" from Android app to "TPV" enum value
    if (source === 'AVOQADO_TPV') return 'TPV'
    // Check if it's a valid PaymentSource enum value
    const validSources = ['TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER']
    return validSources.includes(source) ? (source as PaymentSource) : 'OTHER'
  }

  // ⭐ PROVIDER-AGNOSTIC MERCHANT TRACKING: Resolve merchantAccountId
  // Priority 1: Use merchantAccountId if provided by modern Android client
  // Priority 2: Resolve blumonSerialNumber → merchantAccountId for backward compatibility
  // Priority 3: Leave undefined (legacy payments before this feature)
  let merchantAccountId = paymentData.merchantAccountId

  if (!merchantAccountId && paymentData.blumonSerialNumber) {
    logger.info(`🔄 Resolving legacy blumonSerialNumber: ${paymentData.blumonSerialNumber}`)
    merchantAccountId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
  }

  if (merchantAccountId) {
    logger.info(`✅ Payment will be attributed to merchantAccountId: ${merchantAccountId}`)
  } else {
    logger.warn(`⚠️ No merchantAccountId - payment will have null merchant (legacy mode)`)
  }

  // ⭐ 3-TIER MERCHANT RESOLUTION (Stripe-inspired pattern) - Fast Payments
  // TIER 1: Direct Attribution - Use provided merchantAccountId if valid + active
  // TIER 2: Inference Recovery - Infer from blumonSerialNumber (SOURCE OF TRUTH from processor)
  // TIER 3: Reconciliation Flag - Null with full context for manual resolution
  if (merchantAccountId) {
    const merchantExists = await prisma.merchantAccount.findUnique({
      where: { id: merchantAccountId },
      select: { id: true, active: true },
    })

    if (!merchantExists) {
      logger.error(`❌ [FastPayment] MerchantAccount not found: ${merchantAccountId}`, {
        venueId,
        paymentMethod: paymentData.method,
        providedId: merchantAccountId,
        blumonSerialNumber: paymentData.blumonSerialNumber,
        hint: 'Android may have stale config. Attempting TIER 2 recovery from blumonSerialNumber.',
      })

      // TIER 2: Attempt recovery from blumonSerialNumber
      if (paymentData.blumonSerialNumber) {
        const recoveredMerchantId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
        if (recoveredMerchantId) {
          logger.info(`✅ [FastPayment] TIER 2 Recovery SUCCESS: Inferred merchant from blumonSerialNumber`, {
            providedMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            recoveredMerchantId,
          })
          merchantAccountId = recoveredMerchantId
        } else {
          logger.error(`❌ [FastPayment] TIER 3: Cannot resolve merchant - reconciliation required`, {
            providedMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            authorizationNumber: paymentData.authorizationNumber,
            referenceNumber: paymentData.referenceNumber,
            venueId,
          })
          merchantAccountId = undefined
        }
      } else {
        logger.warn(`⚠️ [FastPayment] No blumonSerialNumber for TIER 2 recovery - falling back to null`)
        merchantAccountId = undefined
      }
    } else if (!merchantExists.active) {
      logger.warn(`⚠️ [FastPayment] MerchantAccount ${merchantAccountId} is inactive`, {
        venueId,
        paymentMethod: paymentData.method,
        blumonSerialNumber: paymentData.blumonSerialNumber,
      })

      // TIER 2: Attempt recovery for inactive merchant
      if (paymentData.blumonSerialNumber) {
        const recoveredMerchantId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
        if (recoveredMerchantId && recoveredMerchantId !== merchantAccountId) {
          logger.info(`✅ [FastPayment] TIER 2 Recovery: Found active merchant with same serial`, {
            inactiveMerchantId: merchantAccountId,
            blumonSerialNumber: paymentData.blumonSerialNumber,
            recoveredMerchantId,
          })
          merchantAccountId = recoveredMerchantId
        } else {
          merchantAccountId = undefined
        }
      } else {
        merchantAccountId = undefined
      }
    }
  }

  // ⭐ TERMINAL ATTRIBUTION: Resolve terminalId from device serial number
  // Links order and payment to the Terminal that processed them (for device-based reporting)
  let terminalId: string | null = null
  if (paymentData.deviceSerialNumber) {
    terminalId = await resolveTerminalIdFromSerial(venueId, paymentData.deviceSerialNumber)
  }

  // Same additive shadow snapshot as order payments. No existing consumer reads
  // these fields yet, so old cost/settlement behavior remains byte-for-byte intact.
  const internationalityShadow = classifyPaymentInternationalityShadow(paymentData)
  const internationalityClassifiedAt = internationalityShadow ? new Date() : undefined

  // 🔴 EL CLIENTE DE LA VENTA. Se resuelve ANTES de abrir la transacción (para no tener
  // una consulta de lectura dentro del bloqueo del cobro) y su resultado se escribe
  // DENTRO del mismo `order.create` de abajo — nunca en un attach posterior, que podría
  // fallar DESPUÉS de registrar el dinero y dejar la venta sin cliente, que es justo el
  // defecto que esto vino a arreglar.
  //
  // Un cliente inválido NO tumba el cobro: devuelve `orderData.customerId = null` y un
  // aviso en la respuesta. El dinero ya está en la caja. Detalle en `fastPaymentCustomer.ts`.
  const { link: customerLink, orderData: customerOrderData } = await t.time('resolveFastOrderCustomer', () =>
    resolveFastOrderCustomer(venueId, effectiveCustomerId),
  )

  // ⭐ ATOMICITY: Wrap critical fast payment creation in transaction (all or nothing)
  // This prevents orphaned records if any operation fails
  //
  // 🛡️ SAFETY NET: If two concurrent requests race past the idempotency fast-path
  // above, the @@unique([venueId, idempotencyKey]) constraint will throw P2002 on
  // the second request. We catch that below and return the winning payment, making
  // the concurrent retry behave exactly like an idempotent success.
  let payment: Awaited<ReturnType<typeof prisma.payment.create>> & { processedBy: any }
  let fastOrder: Awaited<ReturnType<typeof prisma.order.create>>
  // 🔑 El tender resuelto se saca de la transacción a propósito: la respuesta al POS y
  // todo lo posterior tienen que ver el método REAL del cobro, no el que mandó el
  // cliente. (Aquí no hace falta para `payment.method` —ya viene del registro creado—
  // pero sí para no volver a leer el catálogo fuera de la tx.)
  const tenderState: { resolved: ResolvedTenderCharge | null } = { resolved: null }
  try {
    t.mark('turnoMerchantYTerminal')
    const result = await prisma.$transaction(async tx => {
      // 🔧 FIX: Use orderReference from Android if provided (ensures photos match order number)
      // Android generates "FAST-{timestamp}" ONCE when entering VerifyingPrePayment state
      // Photos are uploaded to Firebase with this same reference
      // This ensures photos at "venues/X/verifications/2024-01-01/FAST-123456_1.jpg" match the order
      const orderNumber = paymentData.orderReference || `FAST-${Date.now()}`

      // Create fast order
      const order = await tx.order.create({
        data: {
          venueId,
          orderNumber,
          type: 'TAKEOUT', // Fast payments are typically quick sales (para llevar)
          source: 'TPV',
          // ⭐ Terminal that created this order (resolved from deviceSerialNumber)
          terminalId,
          status: 'COMPLETED', // Fast payments are instantly paid, so order is completed
          completedAt: new Date(),
          subtotal: totalAmount, // Base amount (without tip)
          taxAmount: 0, // No tax for fast payments
          total: totalAmount + tipAmount, // ✅ FIX: Total = subtotal + tax + tip
          // ✅ FIX: Include tip and paid amounts for fast orders
          tipAmount, // Tip amount from this payment
          paidAmount: totalAmount + tipAmount, // Total paid (base + tip)
          remainingBalance: 0, // Fast payments are always fully paid
          paymentStatus: 'PAID',
          splitType: paymentData.splitType as any, // Set splitType for fast orders
          createdById: validatedStaffId, // Track which staff created the fast order
          servedById: validatedStaffId, // ⭐ KIOSK MODE FIX: Also set server to payment processor
          // 🔴 El cliente, en la MISMA transacción que el dinero: `Order.customerId`
          // (vínculo legacy) + `OrderCustomer` primario (vínculo moderno) — exactamente
          // lo que hace `POST /orders`. Sin cliente el objeto es vacío y la orden nace
          // idéntica a como nacía antes de este cambio.
          ...(customerOrderData ?? {}),
        },
      })

      // 🔑 Semántica de dinero SERVER-OWNED: si el POS referenció un tipo de pago del
      // catálogo, el método fiscal, la comisión, el cajón y la forma SAT salen de la
      // revisión CONGELADA — nunca de lo que mandó el cliente. Editar el catálogo
      // mañana no reinterpreta este cobro.
      const resolvedTender =
        paymentData.tenderTypeId != null && paymentData.tenderRevision != null
          ? await resolveTenderForCharge(
              venueId,
              paymentData.tenderTypeId,
              paymentData.tenderRevision,
              tx,
              paymentData.isOfflineReplay ? 'replay' : 'online',
            )
          : null
      tenderState.resolved = resolvedTender

      // Propina prohibida en un tipo configurado sin propina (Uber Eats ya la cobró en
      // su app). El POS no debería ofrecerla, pero la frontera no confía en la UI.
      if (resolvedTender && !resolvedTender.tenderCaptureTip && tipAmount > 0) {
        throw new BadRequestError(`El tipo de pago "${resolvedTender.tenderLabel}" no acepta propina.`)
      }

      const effectiveMethod = (resolvedTender?.method ?? paymentData.method) as PaymentMethod

      // Create the fast payment record
      const newPayment = await tx.payment.create({
        data: {
          venueId,
          orderId: order.id, // Fast payment - no order association
          amount: totalAmount,
          tipAmount,
          method: effectiveMethod,
          // El detalle del cobro declarado a mano sólo tiene sentido si el dinero NO
          // pasó por Avoqado; en efectivo se guarda null para no ensuciar el arqueo.
          // Con un tipo del catálogo el nombre vive en `tenderLabel`, no aquí: mezclarlos
          // haría que el desglose del corte contara el mismo cobro dos veces.
          externalSource: resolvedTender
            ? null
            : paymentData.method === 'CASH'
              ? null
              : paymentData.externalSource?.trim()?.slice(0, 50) || null,
          // Snapshots inmutables del tender, todos resueltos por el server.
          ...(resolvedTender
            ? {
                tenderTypeId: resolvedTender.tenderTypeId,
                tenderRevision: resolvedTender.tenderRevision,
                tenderLabel: resolvedTender.tenderLabel,
                tenderCountsAsCash: resolvedTender.tenderCountsAsCash,
                tenderCaptureTip: resolvedTender.tenderCaptureTip,
                tenderSatFormaPago: resolvedTender.tenderSatFormaPago,
                tenderCommissionPercent: resolvedTender.tenderCommissionPercent,
                tenderCommissionAmount: computeTenderCommission(resolvedTender.tenderCommissionPercent, new Prisma.Decimal(totalAmount)),
                fundsFlow: resolvedTender.fundsFlow,
              }
            : {}),
          status: paymentData.status as any, // Direct enum mapping since frontend sends correct values
          splitType: 'FULLPAYMENT' as SplitType, // Fast payments are always full payments
          source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
          processor: 'TBD',
          type: 'FAST',
          // Snapshot de MERCHANT_ROUTING_RULES (por qué la TPV mostró/eligió este merchant)
          routingEvaluation: paymentData.routingEvaluation ?? undefined,
          processorId: paymentData.mentaOperationId,
          processorData: {
            cardBrand: paymentData.cardBrand,
            last4: paymentData.last4,
            typeOfCard: paymentData.typeOfCard,
            bank: paymentData.bank,
            currency: paymentData.currency,
            authorizationNumber: paymentData.authorizationNumber,
            referenceNumber: paymentData.referenceNumber,
            isInternational: paymentData.isInternational,
            ...(paymentData.issuerCountryCode && paymentData.issuerCountrySource
              ? {
                  issuerCountryEvidence: {
                    code: paymentData.issuerCountryCode,
                    source: paymentData.issuerCountrySource,
                  },
                }
              : {}),
            // ⭐ Blumon serial for reconciliation (matches dashboard de Blumon)
            blumonSerialNumber: paymentData.blumonSerialNumber || null,
            // 💸 Blumon Operation Number (2025-12-16) - For CancelIcc refunds without webhook
            blumonOperationNumber: paymentData.blumonOperationNumber || null,
          },
          // New enhanced fields in the Payment table
          authorizationNumber: paymentData.authorizationNumber,
          referenceNumber: paymentData.referenceNumber,
          // 🛡️ Idempotency key (2026-04-08) - Stripe/Square/Toast pattern
          idempotencyKey: paymentData.idempotencyKey,
          maskedPan: paymentData.maskedPan,
          cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
          entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
          internationalityStatus: internationalityShadow?.status,
          internationalitySource: internationalityShadow?.source,
          issuerCountryCode: internationalityShadow?.issuerCountryCode,
          internationalityClassificationVersion: internationalityShadow?.classificationVersion,
          internationalityClassifiedAt,
          // ⭐ Provider-agnostic merchant account tracking
          merchantAccountId,
          // ⭐ Terminal that processed this payment (resolved from deviceSerialNumber)
          terminalId,
          processedById: validatedStaffId, // ✅ CORRECTED: Use validated staff ID
          shiftId: currentShift?.id,
          feePercentage: 0, // TODO: Calculate based on payment processor
          feeAmount: 0, // TODO: Calculate based on amount and percentage
          netAmount: totalAmount + tipAmount, // For now, net amount = total
          posRawData: {
            splitType: 'FULLPAYMENT',
            staffId: paymentData.staffId, // ✅ CORRECTED: Use staffId field name consistently
            source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
            paymentType: 'FAST',
            ...(paymentData.reviewRating && { reviewRating: paymentData.reviewRating }),
          },
        },
        include: {
          processedBy: true,
        },
      })

      // Create VenueTransaction for financial tracking and settlement
      //
      // 🔴 `PENDING` significa "Avoqado todavía le debe este dinero al negocio". Estaba
      // FIJO, así que el efectivo del cajón —y ahora un cobro de Uber Eats, que Avoqado
      // jamás va a depositar— entraban a la cola de liquidación como saldo por depositar.
      // El lado de lectura (`availableBalance`) ya filtra con este mismo predicado, o sea
      // que el número que ve el dueño estaba bien; la FILA era la que mentía, y cualquier
      // consumidor nuevo la leería mal. "¿Esto lo deposita Avoqado?" tiene UNA autoridad:
      // `paymentIsAvoqadoSettled`. Sin tender reproduce el histórico para tarjeta
      // (PENDING) y corrige el efectivo a SETTLED — que es justo lo que ya hace el cobro
      // en efectivo del POS ("Cash is immediately settled").
      await tx.venueTransaction.create({
        data: {
          venueId,
          paymentId: newPayment.id,
          type: 'PAYMENT',
          grossAmount: totalAmount + tipAmount,
          feeAmount: newPayment.feeAmount,
          netAmount: newPayment.netAmount,
          // Lo que no pasa por Avoqado no tiene nada pendiente: nace liquidado.
          status: paymentIsAvoqadoSettled(newPayment) ? 'PENDING' : 'SETTLED',
        },
      })

      // Create a general allocation for the fast payment
      await tx.paymentAllocation.create({
        data: {
          paymentId: newPayment.id,
          orderId: order.id,
          amount: totalAmount,
        },
      })

      // ✅ UPDATE SHIFT TOTALS: Increment shift sales and tips when fast payment is recorded
      if (currentShift) {
        await tx.shift.update({
          where: { id: currentShift.id },
          data: {
            totalSales: {
              increment: totalAmount,
            },
            totalTips: {
              increment: tipAmount,
            },
            totalOrders: {
              increment: 1,
            },
          },
        })
        logger.info('✅ Shift totals updated (fast payment)', {
          shiftId: currentShift.id,
          incrementedSales: totalAmount,
          incrementedTips: tipAmount,
        })
      }

      // 📸 Create SaleVerification if verification photos or barcodes were provided
      // This links the pre-uploaded Firebase photos to the payment record
      if (
        validatedStaffId &&
        ((paymentData.verificationPhotos && paymentData.verificationPhotos.length > 0) ||
          (paymentData.verificationBarcodes && paymentData.verificationBarcodes.length > 0))
      ) {
        await tx.saleVerification.create({
          data: {
            venueId,
            paymentId: newPayment.id,
            staffId: validatedStaffId,
            photos: paymentData.verificationPhotos || [],
            scannedProducts: paymentData.verificationBarcodes
              ? paymentData.verificationBarcodes.map((barcode: string) => ({
                  barcode,
                  format: 'UNKNOWN',
                  inventoryDeducted: false,
                }))
              : [],
            status: 'PENDING', // Will be processed for inventory deduction later
          },
        })
        logger.info('📸 SaleVerification created for fast payment', {
          paymentId: newPayment.id,
          photosCount: paymentData.verificationPhotos?.length || 0,
          barcodesCount: paymentData.verificationBarcodes?.length || 0,
        })
      }

      // Close the POS→TPV arbitration row (frees the terminal slot) atomically
      // with the Payment — the robust recovery path (survives socket loss/restart).
      if (paymentData.terminalPaymentRequestId) {
        await terminalPaymentService.closeRowFromPaymentTx(tx, paymentData.terminalPaymentRequestId, newPayment.id)
      }

      return { payment: newPayment, fastOrder: order }
    })
    payment = result.payment
    fastOrder = result.fastOrder
  } catch (error) {
    // 🛡️ P2002 safety net: unique constraint violation on (venueId, idempotencyKey)
    // means another concurrent request already created this payment. Return the
    // winner as if this was a normal idempotent retry.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta as { target?: string[] } | undefined)?.target
      const isIdempotencyConflict = Array.isArray(target) && target.includes('idempotencyKey')

      if (isIdempotencyConflict && paymentData.idempotencyKey) {
        logger.warn('🛡️ [recordFastPayment] Concurrent race blocked by unique index — returning winner', {
          venueId,
          idempotencyKey: paymentData.idempotencyKey,
          target,
        })

        const winner = await prisma.payment.findUnique({
          where: {
            venueId_idempotencyKey: {
              venueId,
              idempotencyKey: paymentData.idempotencyKey,
            },
          },
          include: { receipts: true },
        })

        if (winner) {
          // La carrera la ganó otra petición: su orden ya existe, así que el cliente se
          // rellena (nunca se reasigna) igual que en cualquier reintento idempotente.
          const winnerCustomerLink = await linkCustomerToExistingOrder(venueId, winner.orderId, effectiveCustomerId)
          return {
            ...winner,
            digitalReceipt: await ensureDigitalReceiptResponse(winner.id, winner.receipts[0]),
            customerLink: winnerCustomerLink,
          }
        }

        logger.error('🚨 [recordFastPayment] P2002 on idempotencyKey but winner not found — should be impossible', {
          venueId,
          idempotencyKey: paymentData.idempotencyKey,
        })
      }
    }
    throw error
  }

  logger.info('VenueTransaction created for fast payment', {
    paymentId: payment.id,
    grossAmount: totalAmount + tipAmount,
    feeAmount: payment.feeAmount,
    netAmount: payment.netAmount,
  })
  logPaymentInternationalityShadow(payment.id, paymentData.isInternational, internationalityShadow)

  // 🔴 EL CAJÓN SUMA LA VENTA EN EFECTIVO. Esta función NO es sólo de la TPV: el POS
  // móvil también cobra la venta rápida por aquí (`POST /mobile/venues/:venueId/fast`),
  // así que sin este enganche la venta sin cuenta se quedaba fuera del arqueo.
  await postCashSaleToDrawer({
    venueId,
    paymentId: payment.id,
    method: payment.method,
    fundsFlow: payment.fundsFlow,
    tenderTypeId: payment.tenderTypeId,
    tenderCountsAsCash: payment.tenderCountsAsCash,
    status: payment.status,
    type: payment.type,
    amount: payment.amount,
    tipAmount: payment.tipAmount,
    staffId: payment.processedById,
    orderId: fastOrder.id,
  })

  // Create TransactionCost for financial tracking (only for Avoqado-processed non-cash payments)
  try {
    await t.time('createTransactionCost', () => createTransactionCost(payment.id))
  } catch (transactionCostError) {
    logger.error('Failed to create TransactionCost for fast payment', {
      paymentId: payment.id,
      error: transactionCostError,
    })
    // Don't fail the payment if TransactionCost creation fails
  }

  // Create Review record if reviewRating is provided
  if (paymentData.reviewRating) {
    try {
      const rating = mapTpvRatingToNumeric(paymentData.reviewRating)
      if (rating !== null) {
        await prisma.review.create({
          data: {
            venueId: venueId,
            paymentId: payment.id,
            overallRating: rating,
            source: 'TPV',
            servedById: paymentData.staffId, // Link to the staff who served
          },
        })
        logger.info('Review created successfully for fast payment', {
          paymentId: payment.id,
          rating,
          originalRating: paymentData.reviewRating,
        })
      } else {
        logger.warn('Invalid review rating provided for fast payment', { paymentId: payment.id, rating: paymentData.reviewRating })
      }
    } catch (error) {
      logger.error('Failed to create review for fast payment', { paymentId: payment.id, error })
      // Don't fail the payment if review creation fails
    }
  }

  // Generate digital receipt for fast TPV payments (AVOQADO origin)
  let digitalReceipt = null
  try {
    digitalReceipt = await t.time('generateDigitalReceipt', () => generateDigitalReceipt(payment.id))
    logger.info('Digital receipt generated for fast payment', {
      paymentId: payment.id,
      receiptId: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt for fast payment', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // REFERRAL HOOK: trigger referral qualification if this fast order has a pending referral
  try {
    const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
    await t.time('referralOnOrderPaid', () => onOrderPaid({ orderId: fastOrder.id, venueId: fastOrder.venueId }))
  } catch (err) {
    console.error('[referral hook] onOrderPaid failed for order', fastOrder.id, err)
  }

  // 🔌 REAL-TIME: Emit socket events based on payment status (fast payment)
  try {
    const paymentPayload = {
      paymentId: payment.id,
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      method: payment.method,
      status: payment.status.toLowerCase(), // Convert to lowercase for Android compatibility
      type: 'FAST',
      timestamp: new Date().toISOString(),
      metadata: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
      },
    }

    // Emit appropriate event based on payment status
    if (payment.status === 'COMPLETED') {
      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_COMPLETED, paymentPayload)
      logger.info('🔌 PAYMENT_COMPLETED event emitted (fast payment)', {
        paymentId: payment.id,
        orderId: fastOrder.id,
        amount: payment.amount,
      })

      // Create commission calculation for this fast payment (non-blocking)
      if (payment.type !== 'TEST') {
        createCommissionForPayment(payment.id).catch(err => {
          logger.error('Failed to create commission for fast payment', {
            paymentId: payment.id,
            orderId: fastOrder.id,
            error: err instanceof Error ? err.message : String(err),
          })
        })

        // Real-time auto-reorder (see recordOrderPayment for rationale). Non-blocking + self-gated.
        runAutoReorderForVenue(venueId).catch(err => {
          logger.error('Failed to run real-time auto-reorder after fast payment', {
            paymentId: payment.id,
            venueId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } else if (payment.status === 'PROCESSING') {
      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_PROCESSING, paymentPayload)
      logger.info('🔌 PAYMENT_PROCESSING event emitted (fast payment)', {
        paymentId: payment.id,
        orderId: fastOrder.id,
        amount: payment.amount,
      })
    } else if (payment.status === 'FAILED') {
      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_FAILED, {
        ...paymentPayload,
        errorMessage: 'Fast payment failed during processing',
      })
      logger.warn('🔌 PAYMENT_FAILED event emitted (fast payment)', {
        paymentId: payment.id,
        orderId: fastOrder.id,
        amount: payment.amount,
      })
    }

    // Emit order updated event to venue room for the fast order
    socketManager.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      status: fastOrder.status,
      paymentStatus: fastOrder.paymentStatus,
      type: 'FAST',
      timestamp: new Date().toISOString(),
    })

    logger.info('Socket events emitted successfully for fast payment', {
      paymentId: payment.id,
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      paymentStatus: payment.status,
    })
  } catch (error) {
    logger.error('Failed to emit socket events for fast payment', {
      paymentId: payment.id,
      orderId: fastOrder.id,
      error,
    })
    // Don't fail the payment if socket emission fails
  }

  t.mark('transaccionSocketsYComisiones')
  logger.info('Fast payment recorded successfully', { paymentId: payment.id, amount: totalAmount })

  // 🪝 Backfill any Blumon webhook that arrived BEFORE this Payment was recorded.
  // Fire-and-forget — never block the API response on reconciliation. The cron
  // worker (`BlumonWebhookReconciliationJob`) is the safety net if this fails.
  void import('./blumon-webhook.service').then(({ reconcileWebhooksForPayment }) =>
    reconcileWebhooksForPayment({
      id: payment.id,
      processorId: payment.processorId,
      referenceNumber: payment.referenceNumber,
      venueId,
    }).catch(err => {
      logger.error('🪝 [Blumon backfill] Failed to reconcile pending webhooks for fast payment', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : err,
      })
    }),
  )

  // 🪝 Backfill any AngelPay webhook that arrived BEFORE this Payment was recorded.
  // AngelPay fires on charge-approval; the TPV records only after the cashier
  // dismisses AngelPay's success screen — often minutes later. No-op for non-AngelPay
  // payments (no matching pending webhook will exist).
  void import('./angelpay-webhook.service').then(({ reconcileAngelPayWebhookForPayment }) =>
    reconcileAngelPayWebhookForPayment({
      id: payment.id,
      idempotencyKey: payment.idempotencyKey,
      referenceNumber: payment.referenceNumber,
      venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      merchantAccountId: payment.merchantAccountId,
    }).catch(err => {
      logger.error('🪝 [AngelPay backfill] Failed to reconcile pending webhooks for fast payment', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : err,
      })
    }),
  )

  // Add digital receipt info to payment response
  const autofacturaAvailable = digitalReceipt
    ? await t.time('resolveAutofacturaAvailable', () => resolveAutofacturaAvailable(fastOrder?.id))
    : false
  t.end({ paymentId: payment.id })

  return {
    ...payment,
    digitalReceipt: digitalReceipt
      ? {
          id: digitalReceipt.id,
          accessKey: digitalReceipt.accessKey,
          receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${digitalReceipt.accessKey}`,
          autofacturaAvailable,
        }
      : null,
    // Campo ADITIVO: qué pasó con el cliente de esta venta. Un POS viejo lo ignora; los
    // nuevos pueden avisar al cajero y ofrecerle reasignar sin volver a cobrar.
    customerLink,
  }
}

/**
 * Get available merchant accounts for a venue
 * Returns active merchant accounts configured for the venue with display information
 * @param venueId Venue ID to get merchant accounts for
 * @param orgId Organization ID for authorization
 * @returns Array of available merchant accounts with display info
 */
export async function getVenueMerchantAccounts(venueId: string, _orgId?: string): Promise<any[]> {
  // Validate venue exists
  const venue = await prisma.venue.findFirst({
    where: { id: venueId },
    select: { id: true },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found or not accessible')
  }

  // Use inheritance: venue config → org config fallback
  const effective = await getEffectivePaymentConfig(venueId)

  if (!effective) {
    logger.warn('No payment configuration found for venue (checked venue + org)', { venueId })
    return []
  }

  const { config: paymentConfig, source } = effective
  logger.info('Resolved payment config for venue', { venueId, source })

  const accounts = []

  // Helper function to create account response object
  const createAccountResponse = (account: any, accountType: string) => {
    if (!account || !account.active) return null

    // Check if account has required credentials
    const credentials = account.credentialsEncrypted
    const hasValidCredentials = !!(credentials && credentials.merchantId && credentials.apiKey)

    return {
      id: account.id,
      accountType,
      displayName: account.displayName || `${account.provider.name} ${accountType}`,
      providerName: account.provider.name,
      providerCode: account.provider.code,
      active: account.active,
      hasValidCredentials,
      displayOrder: account.displayOrder,
      ecommerceMerchantId: account.ecommerceMerchantId,
      // 🚀 OPTIMIZATION: Include decrypted credentials for POS terminals
      // This eliminates the need for getMentaRoute API calls during payment
      credentials: hasValidCredentials
        ? {
            apiKey: credentials.apiKey,
            merchantId: credentials.merchantId,
            customerId: credentials.customerId || null,
          }
        : null,
    }
  }

  // Add primary account if exists and active
  if (paymentConfig.primaryAccount) {
    const primaryAccount = createAccountResponse(paymentConfig.primaryAccount, 'PRIMARY')
    if (primaryAccount) accounts.push(primaryAccount)
  }

  // Add secondary account if exists and active
  if (paymentConfig.secondaryAccount) {
    const secondaryAccount = createAccountResponse(paymentConfig.secondaryAccount, 'SECONDARY')
    if (secondaryAccount) accounts.push(secondaryAccount)
  }

  // Add tertiary account if exists and active
  if (paymentConfig.tertiaryAccount) {
    const tertiaryAccount = createAccountResponse(paymentConfig.tertiaryAccount, 'TERTIARY')
    if (tertiaryAccount) accounts.push(tertiaryAccount)
  }

  // Filter only accounts with valid credentials and sort by display order
  const validAccounts = accounts.filter(account => account.hasValidCredentials).sort((a, b) => a.displayOrder - b.displayOrder)

  logger.info('Retrieved merchant accounts for venue', {
    venueId,
    totalAccounts: accounts.length,
    validAccounts: validAccounts.length,
  })

  return validAccounts
}

/**
 * Interface for payment routing request data
 */
interface PaymentRoutingData {
  amount: number // Amount in cents
  merchantAccountId: string // Selected merchant account ID (user has already chosen primary/secondary/tertiary)
  terminalSerial: string // Terminal identifier
  bin?: string // Optional BIN for card routing
}

/**
 * Get payment routing configuration for the selected merchant account
 * This method retrieves the credentials and routing info for the merchant account selected by the user in TPV
 * @param venueId Venue ID
 * @param routingData Routing parameters from the request (includes user-selected merchant account)
 * @param orgId Organization ID for authorization
 * @returns Payment routing configuration with credentials and routing info for the selected account
 */
export async function getPaymentRouting(venueId: string, routingData: PaymentRoutingData, _orgId?: string): Promise<any> {
  logger.info('Getting payment routing configuration for user-selected merchant account', {
    venueId,
    merchantAccountId: routingData.merchantAccountId,
    amount: routingData.amount,
  })

  // Validate venue exists
  const venue = await prisma.venue.findFirst({
    where: { id: venueId },
    select: { id: true },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found or not accessible')
  }

  // Use inheritance: venue config → org config fallback
  const effective = await getEffectivePaymentConfig(venueId)

  if (!effective) {
    throw new BadRequestError('Venue payment configuration not found (checked venue + org)')
  }

  const { config: paymentConfig, source } = effective
  logger.info('Resolved payment config for routing', { venueId, source })

  // Find the specific merchant account by ID from the venue's configured accounts
  // The user has already selected which account they want to use (primary/secondary/tertiary)
  let selectedAccount: any = null
  let accountType: string = 'UNKNOWN'

  if (paymentConfig.primaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.primaryAccount
    accountType = 'PRIMARY'
  } else if (paymentConfig.secondaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.secondaryAccount
    accountType = 'SECONDARY'
  } else if (paymentConfig.tertiaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.tertiaryAccount
    accountType = 'TERTIARY'
  }

  if (!selectedAccount || !selectedAccount.active) {
    throw new NotFoundError('Selected merchant account not found or not active for this venue')
  }

  // Check if account has valid credentials
  const credentials = selectedAccount.credentialsEncrypted as any
  if (!credentials || !credentials.merchantId || !credentials.apiKey || !credentials.customerId) {
    throw new BadRequestError('Selected merchant account does not have valid payment processor credentials')
  }

  // Simple routing based on account type - the user has already made the routing decision by selecting the account
  const route = accountType.toLowerCase() // 'primary', 'secondary', or 'tertiary'
  const acquirer = selectedAccount.provider.code.toUpperCase() // 'MENTA', etc.

  // 🚨 CRITICAL FIX: Get proper terminal UUID instead of hardware serial
  // Fetch terminal record by serial number to get the proper UUID
  const terminal = await prisma.terminal.findFirst({
    where: {
      serialNumber: routingData.terminalSerial,
      venueId: venueId,
    },
  })

  if (!terminal) {
    throw new NotFoundError(`Terminal with serial ${routingData.terminalSerial} not found for venue ${venueId}`)
  }

  // Use Menta terminal UUID if available, otherwise use terminal's own UUID
  const terminalUuid = terminal.mentaTerminalId
  logger.info(`🎯 Using terminal UUID for payments: ${terminalUuid} (serial: ${routingData.terminalSerial})`)

  // The routing response contains the credentials for the user-selected merchant account
  const routingResponse = {
    route,
    acquirer,
    merchantId: credentials.merchantId,
    apiKeyMerchant: credentials.apiKey,
    customerId: credentials.customerId,
    terminalSerial: terminalUuid, // 🎯 CRITICAL: Return UUID instead of serial number
    amount: routingData.amount,
    // Additional routing metadata
    routingMetadata: {
      accountType,
      providerCode: selectedAccount.provider.code,
      ecommerceMerchantId: selectedAccount.ecommerceMerchantId,
      userSelected: true, // This routing was based on user selection, not automatic rules
      timestamp: new Date().toISOString(),
    },
  }

  logger.info('Payment routing configuration generated for user-selected account', {
    venueId,
    merchantAccountId: routingData.merchantAccountId,
    accountType,
    route,
    acquirer,
    userSelected: true,
    merchantId: credentials.merchantId.substring(0, 8) + '...',
  })

  return routingResponse
}

/**
 * ✅ NUEVO: Mapea métodos de pago del backend a códigos de POS
 * Convierte los métodos de pago de Avoqado a los códigos que entiende SoftRestaurant
 */
function mapPaymentMethodToPOS(method: PaymentMethod): string {
  logger.info('Mapping payment method to POS', { method })
  const paymentMethodMap: Record<PaymentMethod, string> = {
    CASH: 'ACARD', // ✅ CHANGED: Use DEB instead of AEF (tipo=2 CARD) to prevent $0.00 archiving issue
    CREDIT_CARD: 'CRE', // TAR. CREDITO
    DEBIT_CARD: 'DEB', // TAR. DEBITO
    DIGITAL_WALLET: 'MPY', // MARC PAYMENTS (como genérico para wallets)
    BANK_TRANSFER: 'DEB', // ✅ CHANGED: Use DEB instead of AEF to prevent $0.00 archiving
    CRYPTOCURRENCY: 'ACARD', // 🪙 B4Bit crypto payments - map to generic card type
    OTHER: 'ACARD', // ✅ CHANGED: Default to DEB instead of AEF
  }

  return paymentMethodMap[method] || 'ACARD' // ✅ CHANGED: Default fallback to DEB
}

// ==========================================
// COUPON FINALIZATION
// ==========================================

/**
 * Finalize coupon redemptions when order payment completes.
 * Called ONLY when order is fully paid - not on partial payments.
 *
 * This follows Toast/Square best practice: coupons are "applied" at checkout
 * but only "redeemed" (counted against limits) when payment succeeds.
 *
 * @param venueId Venue ID for logging
 * @param orderId Order ID to finalize coupons for
 */
async function finalizeCouponsForOrder(venueId: string, orderId: string): Promise<void> {
  // Find all coupon-based discounts on this order
  const couponDiscounts = await prisma.orderDiscount.findMany({
    where: {
      orderId,
      couponCodeId: { not: null },
    },
    include: {
      couponCode: {
        include: { discount: true },
      },
    },
  })

  if (couponDiscounts.length === 0) {
    logger.debug('🎟️ No coupons to finalize for order', { orderId })
    return
  }

  // Get order for customerId
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { customerId: true },
  })

  for (const orderDiscount of couponDiscounts) {
    if (!orderDiscount.couponCodeId || !orderDiscount.couponCode) continue

    // Check if already redeemed (idempotency - prevents double counting on retries)
    const existingRedemption = await prisma.couponRedemption.findUnique({
      where: { orderId },
    })
    if (existingRedemption) {
      logger.debug('🎟️ Coupon already redeemed for order, skipping', {
        orderId,
        couponCodeId: orderDiscount.couponCodeId,
      })
      continue
    }

    // Create redemption record
    await prisma.couponRedemption.create({
      data: {
        couponCodeId: orderDiscount.couponCodeId,
        orderId,
        customerId: order?.customerId,
        amountSaved: orderDiscount.amount,
      },
    })

    // Increment CouponCode.currentUses
    await prisma.couponCode.update({
      where: { id: orderDiscount.couponCodeId },
      data: { currentUses: { increment: 1 } },
    })

    // Increment Discount.currentUses
    if (orderDiscount.couponCode.discountId) {
      await prisma.discount.update({
        where: { id: orderDiscount.couponCode.discountId },
        data: { currentUses: { increment: 1 } },
      })
    }

    logger.info('✅ Coupon finalized on payment completion', {
      orderId,
      venueId,
      couponCode: orderDiscount.couponCode.code,
      couponCodeId: orderDiscount.couponCodeId,
      amountSaved: orderDiscount.amount.toString(),
    })
  }
}
