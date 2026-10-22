import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { earnPoints } from '../dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '../dashboard/customer.dashboard.service'
import { cerrarLealtadDeLaVenta, registrarErrorDeLealtad } from './cierreDeLealtad'
import { leerSiEsCuentaDeTarjetas } from '../giftCards/giftCardMarks'
import { WHERE_PAYMENT_IS_EXCHANGE_CREDIT, esVentaNuevaDeCambio } from '../exchanges/exchangeMarks'

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
 * 🔴 F1 (ronda 1 post-QA de sellos tardíos, P1 de Codex; decisión «A» del founder): ligas SIN primario no cuentan para la
 * lealtad — ni puntos/sello ni visita—: la venta se trata como si esas ligas no existieran (cae al heredado, o «sin
 * cliente»). Es el estado que deja la TPV cuando alguien SIN `payments:create` liga un cliente a una venta YA cobrada: lo liga
 * como acompañante (`order.tpv.service.ts`), y ni este cobro en curso ni el reconciliador lo hacen beneficiario. Con primario,
 * todo sigue igual (los acompañantes cuentan su visita).
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
  /**
   * 🔴 H4, tercera ola (recheck 2 de Codex, 15-oct-2026): `earnPoints` vio, con el candado de la venta, que OTRO cliente ya
   * recibió sus puntos o su sello. A éste no se le dio nada (y, con beneficiario fijado, ni la visita). Sólo aparece entonces.
   */
  otroCliente?: true
  /** F2 (ronda 1 post-QA): lo que ESTA corrida creó (sello y/o puntos), según `earnPoints`. Sólo aparece si creó algo. */
  otorgado?: { sello: boolean; puntos: boolean }
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

/** Lo que la venta premia con puntos y sello. */
interface PremioDeLaVenta {
  /** Sobre cuánto se calculan los puntos. */
  base: number
  /** La venta nueva de un cambio: puntos sí, sello no. */
  sinSello: boolean
}

/**
 * Cambio de producto (spec 2026-10-20 §7.7): la venta nueva de un cambio NO da sello —no es una visita nueva, aunque se haya
 * llevado algo sin regresar nada— y sus puntos salen sólo de lo cobrado de más: lo pagado con «Crédito de cambio» ya dio puntos
 * en la venta original. El sello lo decide SER la venta nueva de un cambio (`Exchange.newOrderId`), no el importe del crédito.
 * Una venta sin crédito que no es de un cambio sale igual que siempre (la base es `orderTotal`). Dos lecturas por índice.
 */
async function premioDeLaVenta(venueId: string, orderId: string, orderTotal: number): Promise<PremioDeLaVenta> {
  const [credito, sinSello] = await Promise.all([
    prisma.payment.aggregate({
      // Los cobros capturados con el crédito, sin reembolsos (`type` admite NULL: el `not` pelón la dejaría fuera).
      where: {
        orderId,
        venueId,
        status: 'COMPLETED',
        AND: [{ OR: [{ type: null }, { type: { not: 'REFUND' } }] }, WHERE_PAYMENT_IS_EXCHANGE_CREDIT],
      },
      _sum: { amount: true },
    }),
    esVentaNuevaDeCambio(prisma, orderId),
  ])
  const pagadoConCredito = credito._sum.amount ?? new Prisma.Decimal(0)
  if (pagadoConCredito.lte(0)) return { base: orderTotal, sinSello }
  // En Decimal: los pesos con centavos no se redondean de más ni de menos al restar.
  return { base: Prisma.Decimal.max(0, new Prisma.Decimal(orderTotal).minus(pagadoConCredito)).toNumber(), sinSello }
}

export async function awardLoyaltyForPaidOrder(
  args: AwardLoyaltyForPaidOrderArgs,
  opciones: OpcionesDeLealtad = {},
): Promise<AwardLoyaltyForPaidOrderResult> {
  const { venueId, orderId, orderTotal } = args
  const errors: string[] = []
  // ¿Esta corrida leyó la orden SIN ningún cliente? Su cierre lleva una guarda (B1, abajo).
  let leyoSinCliente = false
  // H4, tercera ola: `earnPoints` dijo que OTRO cliente ya recibió la lealtad de esta venta (dos intentos a la vez).
  let otroCliente = false
  // F2: lo que ESTA corrida creó (lo dice `earnPoints`).
  let otorgado: { sello: boolean; puntos: boolean } | undefined
  try {
    let staffVenueId: string | undefined
    if (args.staffId) {
      const staffVenue = await prisma.staffVenue.findFirst({
        where: { staffId: args.staffId, venueId },
        select: { id: true },
      })
      staffVenueId = staffVenue?.id
    }

    // R1 (tarjetas de regalo): vender una tarjeta no es una compra — sin métricas de gasto, puntos ni sello. La cuenta queda
    // procesada abajo (`complete`), así el reconciliador no la repite. Usarla en otra cuenta sí acredita como cualquier compra.
    const esVentaDeTarjetas = await leerSiEsCuentaDeTarjetas(prisma, orderId)

    // `?? []`: un mock sin lista (o una consulta rara) no puede convertir esto en
    // un TypeError que se trague el resto.
    const todasLasLigas = esVentaDeTarjetas
      ? []
      : ((await prisma.orderCustomer.findMany({
          where: { orderId },
          include: { customer: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { addedAt: 'asc' },
        })) ?? [])
    // 🔴 F1: sin primario, las ligas no cuentan (acompañantes de una liga sin `payments:create` a una venta ya cobrada).
    const orderCustomers = todasLasLigas.some(oc => oc.isPrimary) ? todasLasLigas : []

    // H4 (segunda ola): con un beneficiario fijado, el que esta lectura resolvería tiene que ser ése, o no se acredita a nadie.
    const fijado = opciones.beneficiario !== undefined
    const resuelto =
      orderCustomers.length > 0 ? (orderCustomers.find(oc => oc.isPrimary)?.customerId ?? null) : (args.legacyCustomer?.id ?? null)

    if (esVentaDeTarjetas) {
      logger.info('⏭️ Lealtad omitida: la cuenta es de tarjetas de regalo (se premia al usarlas)', { orderId, venueId })
    } else if (fijado && resuelto !== opciones.beneficiario) {
      errors.push(`beneficiario:cambió (validado ${opciones.beneficiario ?? 'ninguno'}, ahora ${resuelto ?? 'ninguno'})`)
      logger.warn('⚠️ Loyalty skipped: the order customer changed after it was validated; the next pass revalidates', {
        orderId,
        venueId,
        validado: opciones.beneficiario ?? null,
        ahora: resuelto,
      })
    } else if (orderCustomers.length > 0) {
      // Si esta lectura truena, la venta queda pendiente (el reconciliador la reintenta) en vez de premiar el total.
      const premio = await premioDeLaVenta(venueId, orderId, orderTotal)
      // La visita (métricas) de UN cliente de la venta; un fallo no le quita el sello a nadie.
      const medirVisita = async (oc: (typeof orderCustomers)[number]) => {
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
      }
      // Puntos y sello SÓLO al primario (el primero que se agregó a la cuenta) — y, con beneficiario fijado, sólo a ése.
      const acreditarSiEsPrimario = async (oc: (typeof orderCustomers)[number]) => {
        if (!oc.isPrimary || (fijado && oc.customerId !== opciones.beneficiario)) return
        const r = await acreditar(venueId, oc.customerId, nombre(oc.customer), premio, orderId, staffVenueId, 'PRIMARY customer')
        if (r.estado === 'FALLO') errors.push(`loyalty:${oc.customerId}`)
        if (r.estado === 'OTRO_CLIENTE') otroCliente = true
        if (r.otorgado) otorgado = r.otorgado
      }

      if (fijado) {
        // 🔴 H4, tercera ola: en la recuperación se acredita PRIMERO y la visita va después. Si `earnPoints` dice que OTRO
        // cliente ya ganó esta venta (dos intentos a la vez), a nadie de esta corrida se le cuenta la visita: la venta no es suya.
        for (const oc of orderCustomers) await acreditarSiEsPrimario(oc)
        if (!otroCliente) for (const oc of orderCustomers) await medirVisita(oc)
      } else {
        // Los cobros: el orden de siempre, cliente por cliente (visita y luego, si es el primario, puntos y sello).
        for (const oc of orderCustomers) {
          await medirVisita(oc)
          await acreditarSiEsPrimario(oc)
        }
      }
    } else if (args.legacyCustomer?.id) {
      const legacy = args.legacyCustomer
      const premio = await premioDeLaVenta(venueId, orderId, orderTotal)
      const medirVisitaHeredada = async () => {
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
      }
      const acreditarHeredado = async () => {
        const r = await acreditar(venueId, legacy.id, nombre(legacy), premio, orderId, staffVenueId, 'legacy single customer')
        if (r.estado === 'FALLO') errors.push(`loyalty:${legacy.id}`)
        if (r.estado === 'OTRO_CLIENTE') otroCliente = true
        if (r.otorgado) otorgado = r.otorgado
      }
      if (fijado) {
        await acreditarHeredado()
        if (!otroCliente) await medirVisitaHeredada()
      } else {
        await medirVisitaHeredada()
        await acreditarHeredado()
      }
    } else {
      leyoSinCliente = true
      logger.info('⏭️ Loyalty points skipped: Order has no customer', {
        orderId,
        hasCustomerId: false,
        orderCustomersCount: 0,
        // F1: ligas sin primario (acompañantes sin permiso de cobro) que la lealtad no cuenta.
        ligasSinPrimario: todasLasLigas.length,
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
    // R3-1: lo otorgado es un hecho aunque la marca falle; quien audita lo necesita.
    return { complete: false, errors, ...(otorgado ? { otorgado } : {}) }
  }

  const conOtro = otroCliente ? { otroCliente: true as const } : {}
  const conOtorgado = otorgado ? { otorgado } : {}
  return cerrar ? { complete, errors, ...conOtro, ...conOtorgado } : { complete, errors, leyoSinCliente, ...conOtro, ...conOtorgado }
}

/** R3-1: el hecho «esta llamada otorgó X antes de fallar» que `earnPoints` cuelga de su error, si lo trae. */
function otorgadoDelError(error: unknown): { sello: boolean; puntos: boolean } | undefined {
  const hecho = (error as { otorgadoAntesDelFallo?: { sello?: unknown; puntos?: unknown } } | null)?.otorgadoAntesDelFallo
  if (!hecho || (hecho.sello !== true && hecho.puntos !== true)) return undefined
  return { sello: hecho.sello === true, puntos: hecho.puntos === true }
}

async function acreditar(
  venueId: string,
  customerId: string,
  customerName: string,
  premio: PremioDeLaVenta,
  orderId: string,
  staffVenueId: string | undefined,
  quien: string,
): Promise<{ estado: 'ACREDITADO' | 'FALLO' | 'OTRO_CLIENTE'; otorgado?: { sello: boolean; puntos: boolean } }> {
  if (premio.sinSello && premio.base <= 0) {
    // Cambio parejo o con devolución: nada cobrado de más y sin sello. No es un fallo: no hay nada que dar.
    logger.info(`⏭️ Lealtad omitida (${quien}): la venta nueva de un cambio no cobró nada de más`, { orderId, customerId })
    return { estado: 'ACREDITADO' }
  }
  try {
    const loyaltyResult = premio.sinSello
      ? await earnPoints(venueId, customerId, premio.base, orderId, staffVenueId, { skipStamp: true })
      : await earnPoints(venueId, customerId, premio.base, orderId, staffVenueId)
    if (loyaltyResult.otroCliente) {
      logger.warn(`⚠️ Loyalty not credited (${quien}): another customer already earned this order`, { orderId, customerId })
      // 🔴 R4-1 (ronda 4): en la carrera H4 esta llamada pudo SELLAR antes de ver que otro cliente ya tenía los puntos. Es un
      // hecho: viaja para que la auditoría de la liga no lo pierda.
      return { estado: 'OTRO_CLIENTE', ...(loyaltyResult.otorgado ? { otorgado: loyaltyResult.otorgado } : {}) }
    }
    logger.info(`🎁 Loyalty points earned (${quien})`, {
      orderId,
      customerId,
      customerName,
      orderTotal: premio.base,
      pointsEarned: loyaltyResult.pointsEarned,
      newBalance: loyaltyResult.newBalance,
    })
    return { estado: 'ACREDITADO', ...(loyaltyResult.otorgado ? { otorgado: loyaltyResult.otorgado } : {}) }
  } catch (loyaltyError: any) {
    const message: string = loyaltyError?.message ?? ''
    logger.error('⚠️ Failed to earn loyalty points (payment still succeeded)', {
      orderId,
      customerId,
      error: message,
      reason: message.includes('not enabled') ? 'LOYALTY_DISABLED' : 'LOYALTY_ERROR',
    })
    // 🔴 R3-1 (ronda 3): `earnPoints` pudo otorgar una pieza ANTES de tronar (los puntos, si falló el sello; el sello, si falló
    // la escritura de los puntos) y lo trae en el error. Es un hecho: viaja para que la auditoría de la liga no lo pierda.
    const otorgado = otorgadoDelError(loyaltyError)
    return { estado: 'FALLO', ...(otorgado ? { otorgado } : {}) }
  }
}
