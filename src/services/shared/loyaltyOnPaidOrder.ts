import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { earnPoints } from '../dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '../dashboard/customer.dashboard.service'

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
   * El `Order.total` tal como quedó escrito al cobrar. Es la MISMA base que usa
   * la PAX; cambiarla en un canal y no en otro haría que el mismo café diera
   * puntos distintos según cómo se pagó.
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
}

function nombre(c: { firstName: string | null; lastName: string | null } | null | undefined): string {
  return `${c?.firstName || ''} ${c?.lastName || ''}`.trim()
}

export async function awardLoyaltyForPaidOrder(args: AwardLoyaltyForPaidOrderArgs): Promise<void> {
  const { venueId, orderId, orderTotal } = args
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

    if (orderCustomers.length > 0) {
      for (const oc of orderCustomers) {
        try {
          await updateCustomerMetrics(oc.customerId, orderTotal)
          logger.info('📊 Customer metrics updated', {
            orderId,
            customerId: oc.customerId,
            customerName: nombre(oc.customer),
            isPrimary: oc.isPrimary,
          })
        } catch (metricsError: any) {
          logger.error('⚠️ Failed to update customer metrics (continuing)', {
            orderId,
            customerId: oc.customerId,
            error: metricsError?.message,
          })
        }

        // Puntos y sello SÓLO al primario (el primero que se agregó a la cuenta).
        if (oc.isPrimary) {
          await acreditar(venueId, oc.customerId, nombre(oc.customer), orderTotal, orderId, staffVenueId, 'PRIMARY customer')
        }
      }
      return
    }

    const legacy = args.legacyCustomer
    if (legacy?.id) {
      try {
        await updateCustomerMetrics(legacy.id, orderTotal)
      } catch (metricsError: any) {
        logger.error('⚠️ Failed to update customer metrics (continuing)', {
          orderId,
          customerId: legacy.id,
          error: metricsError?.message,
        })
      }
      await acreditar(venueId, legacy.id, nombre(legacy), orderTotal, orderId, staffVenueId, 'legacy single customer')
      return
    }

    logger.info('⏭️ Loyalty points skipped: Order has no customer', {
      orderId,
      hasCustomerId: false,
      orderCustomersCount: 0,
      isGuestOrder: true,
    })
  } catch (error: any) {
    logger.error('⚠️ Loyalty on paid order failed (payment still succeeded)', {
      orderId,
      venueId,
      error: error?.message,
    })
  }
}

async function acreditar(
  venueId: string,
  customerId: string,
  customerName: string,
  orderTotal: number,
  orderId: string,
  staffVenueId: string | undefined,
  quien: string,
): Promise<void> {
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
  } catch (loyaltyError: any) {
    const message: string = loyaltyError?.message ?? ''
    logger.error('⚠️ Failed to earn loyalty points (payment still succeeded)', {
      orderId,
      customerId,
      error: message,
      reason: message.includes('not enabled') ? 'LOYALTY_DISABLED' : 'LOYALTY_ERROR',
    })
  }
}
