import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { earnPoints } from '../dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '../dashboard/customer.dashboard.service'
import { cerrarLealtadDeLaVenta, registrarErrorDeLealtad } from './cierreDeLealtad'

/**
 * Lealtad al quedar PAGADA una orden: métricas de visita y puntos/sellos.
 *
 * 🔴 UNA regla para TODOS los canales de cobro. Vivía copiada dentro de
 * `payment.tpv.service.ts` (el cobro de la PAX) y ningún otro camino la tenía:
 * el café pagado en efectivo desde el Sunmi (`payCashOrder`) no daba sello ni
 * puntos, mientras el MISMO café cobrado con tarjeta en la PAX sí (Testarudo,
 * 2026-09-01). Un cliente que pagó su séptimo café en efectivo se quedaba sin su
 * café gratis, y nadie se enteraba porque nada fallaba.
 *
 * Qué hace, en este orden:
 *   1. Traduce el Staff.id de quien cobró a StaffVenue.id — es lo que espera
 *      `LoyaltyTransaction.createdById` (una FK), y hacerlo aquí evita que cada
 *      llamador lo resuelva distinto.
 *   2. Métricas (totalVisits, lastVisitAt, totalSpent) para TODOS los clientes
 *      de la orden.
 *   3. Puntos —y el sello, que va DENTRO de `earnPoints`— SÓLO para el primario.
 *      Sin `OrderCustomer`, cae al `customerId` heredado que la orden ya trae.
 *
 * 🔴 NUNCA lanza. Corre después de que el dinero ya entró: un fallo de lealtad no
 * puede hacer ver como fallido un cobro que ya se registró. Cada paso va en su
 * propio try/catch para que las métricas de un cliente no le quiten el sello a
 * otro, y toda la función va envuelta por si la consulta inicial revienta.
 *
 * `earnPoints` y `grantStamp` son idempotentes por orden, así que reintentar un
 * cobro (cola offline, doble toque) no duplica puntos ni sellos.
 */

export interface LegacyOrderCustomer {
  id: string
  firstName: string | null
  lastName: string | null
}

export interface AwardLoyaltyForPaidOrderArgs {
  venueId: string
  orderId: string
  /**
   * Base de venta y cargos sin propinas. La propina pertenece al personal y no
   * genera puntos; todos los canales deben entregar esta misma base.
   */
  orderTotal: number
  /** Staff.id de quien cobró (se traduce a StaffVenue.id aquí). */
  staffId?: string | null
  /**
   * Respaldo para órdenes sin `OrderCustomer`: el cliente que la orden ya trae en
   * `customerId`. Se pasa desde lo que el llamador YA leyó para no consultar la
   * orden otra vez en el camino del dinero.
   */
  legacyCustomer?: LegacyOrderCustomer | null
  /**
   * 🔴 H5, segunda ola (recheck de Codex, 15-oct-2026): SÓLO lo lee `otorgarLealtadRespetandoReembolsos`. `true` = el autor
   * del sello sale del `Order.loyaltyStaffId` VIGENTE, leído en la MISMA sentencia que el cliente que se acredita (lo pide el
   * reconciliador: una liga tardía después de su reclamo cambia los dos a la vez). Esta función lo ignora.
   */
  actorDeLaVenta?: boolean
}

export interface AwardLoyaltyForPaidOrderResult {
  complete: boolean
  errors: string[]
  /**
   * SÓLO con `{ cerrar: false }`: si esta corrida leyó la venta «sin cliente». Quien cierra después
   * (`cerrarLealtadDeLaVenta`) lo necesita para aplicar la MISMA guarda B1 que habría aplicado este cierre.
   */
  leyoSinCliente?: boolean
}

export interface OpcionesDeLealtad {
  /**
   * 🔴 H1 (auditoría de Codex del código, 15-oct-2026): `false` = NO marcar `loyaltyProcessedAt` al terminar bien. Lo pide el
   * envoltorio `otorgarLealtadRespetandoReembolsos`: él cierra SÓLO después de su comprobación final de reembolso y de
   * completar la reversión. Si esta función cerrara antes y la reversión fallara, el reconciliador ya no vería la venta y el
   * sello quedaría vivo sobre una venta devuelta. Los demás llamadores (los cobros) no lo pasan y cierran como siempre.
   */
  cerrar?: boolean
  /**
   * 🔴 H4, segunda ola (recheck de Codex, 15-oct-2026): el cliente que el envoltorio YA validó (nadie más recibió sello ni puntos
   * de esta venta). Con él, esta función acredita SÓLO a ese cliente y nunca vuelve a resolver otro: si al leer las
   * asociaciones el primario (o, sin `OrderCustomer`, el heredado) ya no es ése —la TPV lo cambió en medio— no acredita a
   * nadie (ni la visita) y deja la venta pendiente para la vuelta siguiente, que vuelve a validar. `null` = validó «sin
   * cliente». Sin la opción (los cobros), todo sigue como siempre.
   */
  beneficiario?: string | null
}

function nombre(c: { firstName: string | null; lastName: string | null } | null | undefined): string {
  return `${c?.firstName || ''} ${c?.lastName || ''}`.trim()
}

export async function awardLoyaltyForPaidOrder(
  args: AwardLoyaltyForPaidOrderArgs,
  opciones: OpcionesDeLealtad = {},
): Promise<AwardLoyaltyForPaidOrderResult> {
  const { venueId, orderId, orderTotal } = args
  const errors: string[] = []
  // ¿Esta corrida leyó la orden SIN ningún cliente? Su cierre lleva una guarda (B1, abajo).
  let leyoSinCliente = false
  try {
    let staffVenueId: string | undefined
    if (args.staffId) {
      const staffVenue = await prisma.staffVenue.findFirst({
        where: { staffId: args.staffId, venueId },
        select: { id: true },
      })
      staffVenueId = staffVenue?.id
    }

    // `?? []`: un mock sin lista (o una consulta rara) no puede convertir esto en
    // un TypeError que se trague el resto.
    const orderCustomers =
      (await prisma.orderCustomer.findMany({
        where: { orderId },
        include: { customer: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { addedAt: 'asc' },
      })) ?? []

    // H4 (segunda ola): con un beneficiario fijado, el que esta lectura resolvería tiene que ser ése, o no se acredita a nadie.
    const fijado = opciones.beneficiario !== undefined
    const resuelto =
      orderCustomers.length > 0 ? (orderCustomers.find(oc => oc.isPrimary)?.customerId ?? null) : (args.legacyCustomer?.id ?? null)

    if (fijado && resuelto !== opciones.beneficiario) {
      errors.push(`beneficiario:cambió (validado ${opciones.beneficiario ?? 'ninguno'}, ahora ${resuelto ?? 'ninguno'})`)
      logger.warn('⚠️ Loyalty skipped: the order customer changed after it was validated; the next pass revalidates', {
        orderId,
        venueId,
        validado: opciones.beneficiario ?? null,
        ahora: resuelto,
      })
    } else if (orderCustomers.length > 0) {
      for (const oc of orderCustomers) {
        try {
          await updateCustomerMetrics(oc.customerId, orderTotal, orderId, venueId)
          logger.info('📊 Customer metrics updated', {
            orderId,
            customerId: oc.customerId,
            customerName: nombre(oc.customer),
            isPrimary: oc.isPrimary,
          })
        } catch (metricsError: any) {
          errors.push(`metrics:${oc.customerId}:${metricsError?.message ?? String(metricsError)}`)
          logger.error('⚠️ Failed to update customer metrics (continuing)', {
            orderId,
            customerId: oc.customerId,
            error: metricsError?.message,
          })
        }

        // Puntos y sello SÓLO al primario (el primero que se agregó a la cuenta) — y, con beneficiario fijado, sólo a ése.
        if (oc.isPrimary && (!fijado || oc.customerId === opciones.beneficiario)) {
          const credited = await acreditar(
            venueId,
            oc.customerId,
            nombre(oc.customer),
            orderTotal,
            orderId,
            staffVenueId,
            'PRIMARY customer',
          )
          if (!credited) errors.push(`loyalty:${oc.customerId}`)
        }
      }
    } else if (args.legacyCustomer?.id) {
      const legacy = args.legacyCustomer
      try {
        await updateCustomerMetrics(legacy.id, orderTotal, orderId, venueId)
      } catch (metricsError: any) {
        errors.push(`metrics:${legacy.id}:${metricsError?.message ?? String(metricsError)}`)
        logger.error('⚠️ Failed to update customer metrics (continuing)', {
          orderId,
          customerId: legacy.id,
          error: metricsError?.message,
        })
      }
      const credited = await acreditar(venueId, legacy.id, nombre(legacy), orderTotal, orderId, staffVenueId, 'legacy single customer')
      if (!credited) errors.push(`loyalty:${legacy.id}`)
    } else {
      leyoSinCliente = true
      logger.info('⏭️ Loyalty points skipped: Order has no customer', {
        orderId,
        hasCustomerId: false,
        orderCustomersCount: 0,
        isGuestOrder: true,
      })
    }
  } catch (error: any) {
    errors.push(`query:${error?.message ?? String(error)}`)
    logger.error('⚠️ Loyalty on paid order failed (payment still succeeded)', {
      orderId,
      venueId,
      error: error?.message,
    })
  }

  const complete = errors.length === 0
  const cerrar = opciones.cerrar !== false
  try {
    if (complete) {
      // B1 + la marca de fila: la guarda del cierre «sin cliente» vive en `cerrarLealtadDeLaVenta`.
      if (cerrar) await cerrarLealtadDeLaVenta(venueId, orderId, { leyoSinCliente })
    } else {
      await registrarErrorDeLealtad(venueId, orderId, errors.join(' | '))
    }
  } catch (markerError: any) {
    const message = `marker:${markerError?.message ?? String(markerError)}`
    errors.push(message)
    logger.error('⚠️ Loyalty outcome marker failed; reconciler will retry', { orderId, venueId, error: message })
    return { complete: false, errors }
  }

  return cerrar ? { complete, errors } : { complete, errors, leyoSinCliente }
}

async function acreditar(
  venueId: string,
  customerId: string,
  customerName: string,
  orderTotal: number,
  orderId: string,
  staffVenueId: string | undefined,
  quien: string,
): Promise<boolean> {
  try {
    const loyaltyResult = await earnPoints(venueId, customerId, orderTotal, orderId, staffVenueId)
    logger.info(`🎁 Loyalty points earned (${quien})`, {
      orderId,
      customerId,
      customerName,
      orderTotal,
      pointsEarned: loyaltyResult.pointsEarned,
      newBalance: loyaltyResult.newBalance,
    })
    return true
  } catch (loyaltyError: any) {
    const message: string = loyaltyError?.message ?? ''
    logger.error('⚠️ Failed to earn loyalty points (payment still succeeded)', {
      orderId,
      customerId,
      error: message,
      reason: message.includes('not enabled') ? 'LOYALTY_DISABLED' : 'LOYALTY_ERROR',
    })
    return false
  }
}
