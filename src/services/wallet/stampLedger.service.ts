import { LoyaltyConfig, Prisma, StampEventType, StampRewardStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '../../utils/datetime'
import logger from '../../config/logger'
import { logAction } from '../dashboard/activity-log.service'
import { notifyCustomerPassUpdated } from './notifyPassUpdated.service'

/**
 * El libro de sellos: otorgar, contar y auditar.
 *
 * 🔴 DINERO. Un sello es lo que el cliente cambia por producto gratis: uno de más
 * es producto regalado, uno de menos es un cliente enojado en el mostrador.
 *
 * Tres invariantes que sostienen esto:
 *
 * 1. **Un pago = exactamente un sello.** La garantía NO es el chequeo previo de
 *    este archivo — entre un SELECT y un INSERT cabe otro cobro. La garantía es el
 *    índice `StampEvent_venueId_orderId_earn_unique`; el chequeo sólo evita el
 *    viaje. Por eso una violación de unicidad se traduce a "ya estaba sellado".
 * 2. **El día es el del NEGOCIO.** Producción corre en UTC: un día "de servidor"
 *    se corta a las 6 de la tarde en México, y el mismo cliente podría sellar dos
 *    veces la misma noche.
 * 3. **Cada sello lleva autor.** Es lo que hace vendible esto frente a la tarjeta
 *    de cartón, donde el empleado sella de más a un conocido y nadie se entera.
 */

export type GrantStampReason = 'STAMPS_DISABLED' | 'ALREADY_STAMPED' | 'DAILY_LIMIT_REACHED' | 'PROGRAM_INACTIVE'

export interface GrantStampResult {
  granted: boolean
  reason?: GrantStampReason
  stampsEarned?: number
  stampsRequired?: number
  stampCardId?: string
  /** True cuando este sello completó la cartilla. */
  completed?: boolean
  /** El premio que nació al completarla, si la completó. */
  rewardId?: string
}

/**
 * SÓLO los campos de la configuración que el sellado lee.
 *
 * 🔴 Pedir el `LoyaltyConfig` entero acoplaba esta función a la forma EXACTA con la
 * que cada llamador lo hubiera obtenido — y no todos la traen igual:
 * `getOrCreateLoyaltyConfig` devuelve `pointsPerDollar` y `redemptionRate` ya
 * convertidos a número, no como Decimal. Nombrar lo que de verdad se usa deja que
 * cualquiera de las dos formas entre, y documenta la dependencia real.
 */
export type StampConfigView = Pick<
  LoyaltyConfig,
  | 'active'
  | 'stampsEnabled'
  | 'stampsRequired'
  | 'maxStampsPerDay'
  | 'stampRewardType'
  | 'stampRewardValue'
  | 'stampRewardProductId'
  | 'stampRewardLabel'
>

export interface GrantStampOptions {
  /** 🔴 StaffVenue.id, NO Staff.id. Es una FK directa. */
  staffVenueId?: string
  terminalId?: string
  /**
   * La config de lealtad, si quien llama YA la leyó.
   *
   * `earnPoints` la tiene en la mano cuando invoca esto, y corre en cada cobro de
   * cada negocio: releerla ahí serían miles de consultas al día que no aportan
   * nada, sobre todo en los venues que ni siquiera usan sellos.
   */
  config?: StampConfigView | null
}

export async function grantStamp(
  venueId: string,
  customerId: string,
  orderId: string,
  options: GrantStampOptions = {},
): Promise<GrantStampResult> {
  const config = options.config ?? (await prisma.loyaltyConfig.findUnique({ where: { venueId } }))

  if (!config || !config.active) return { granted: false, reason: 'PROGRAM_INACTIVE' }
  if (!config.stampsEnabled) return { granted: false, reason: 'STAMPS_DISABLED' }

  // Atajo barato. La garantía de verdad es el índice único; esto sólo evita
  // levantar una transacción cuando ya sabemos que va a rebotar.
  const yaSellado = await prisma.stampEvent.findFirst({
    where: { venueId, orderId, type: StampEventType.EARN },
    select: { id: true, stampCardId: true },
  })
  if (yaSellado) return { granted: false, reason: 'ALREADY_STAMPED', stampCardId: yaSellado.stampCardId }

  // 🔴 El tope se cuenta en el día del VENUE. Un tope de 0 significa SIN tope:
  // un negocio que escribe 0 quiere decir "ilimitado", y leerlo como "cero sellos
  // al día" apagaría su programa entero sin avisarle a nadie.
  if (config.maxStampsPerDay > 0) {
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
    const tz = venue?.timezone ?? 'America/Mexico_City'
    const hoy = await prisma.stampEvent.count({
      where: {
        venueId,
        type: StampEventType.EARN,
        stampCard: { customerId },
        createdAt: { gte: venueStartOfDay(tz), lte: venueEndOfDay(tz) },
      },
    })
    if (hoy >= config.maxStampsPerDay) return { granted: false, reason: 'DAILY_LIMIT_REACHED' }
  }

  // La cartilla en curso, o una nueva. `stampsRequired` se COPIA aquí y queda
  // congelado: si el negocio cambia la regla mañana, quien ya empezó conserva la
  // suya. Cambiarla bajo los pies del cliente es la queja más cara de un programa
  // de lealtad.
  let card = await prisma.stampCard.findFirst({
    where: { venueId, customerId, completedAt: null },
    orderBy: { cycle: 'desc' },
  })
  if (!card) {
    const ultima = await prisma.stampCard.findFirst({
      where: { venueId, customerId },
      orderBy: { cycle: 'desc' },
      select: { cycle: true },
    })
    card = await prisma.stampCard.create({
      data: {
        venueId,
        customerId,
        cycle: (ultima?.cycle ?? 0) + 1,
        stampsRequired: config.stampsRequired,
        stampsEarned: 0,
      },
    })
  }

  const cardId = card.id
  const requeridos = card.stampsRequired
  const cycleActual = card.cycle

  try {
    const resultado = await prisma.$transaction(async tx => {
      await tx.stampEvent.create({
        data: {
          stampCardId: cardId,
          venueId,
          orderId,
          type: StampEventType.EARN,
          quantity: 1,
          createdById: options.staffVenueId,
          terminalId: options.terminalId,
        },
      })
      // El contador se mueve en la MISMA transacción que su evento: si viven
      // separados, un fallo a medias deja el cache mintiendo sobre el libro.
      const actualizada = await tx.stampCard.update({
        where: { id: cardId },
        data: { stampsEarned: { increment: 1 } },
        select: { stampsEarned: true, stampsRequired: true },
      })

      const ganados = actualizada.stampsEarned
      const meta = actualizada.stampsRequired ?? requeridos
      if (ganados < meta) return { ganados, meta, completed: false as const, rewardId: undefined }

      // ── La cartilla se llenó ────────────────────────────────────────────────
      await tx.stampCard.update({ where: { id: cardId }, data: { completedAt: new Date() } })

      // 🔴 El premio CONGELA sus condiciones. Si el negocio cambia mañana "un
      // café" por "10% de descuento", quien ya lo ganó recibe lo que se le
      // prometió — cambiárselo después es la forma más rápida de perder al
      // cliente que más veces volvió.
      const premio = await tx.stampReward.create({
        data: {
          stampCardId: cardId,
          customerId,
          venueId,
          status: StampRewardStatus.PENDING,
          rewardType: config.stampRewardType,
          rewardValue: config.stampRewardValue as Prisma.Decimal | null,
          rewardProductId: config.stampRewardProductId,
          rewardLabel: config.stampRewardLabel,
        },
        select: { id: true },
      })

      // 🔴 Y la siguiente cartilla arranca AQUÍ, no al canjear el premio.
      //
      // Entre que el cliente llena su cartilla y vuelve a pasar por su café gratis
      // pueden pasar semanas — y todo lo que compre mientras tanto se tiraría a la
      // basura. Es el hallazgo C7 de la auditoría y la corrección de mi diseño
      // original, que decía justamente lo contrario.
      //
      // La nueva nace con la regla de HOY (al revés que la congelada): el ciclo
      // que empieza usa la configuración vigente.
      await tx.stampCard.create({
        data: {
          venueId,
          customerId,
          cycle: cycleActual + 1,
          stampsRequired: config.stampsRequired,
          stampsEarned: 0,
        },
      })

      return { ganados, meta, completed: true as const, rewardId: premio.id }
    })

    // 🔴 El sello subió: avisarle al teléfono del cliente. Sin esto su tarjeta sigue
    // mostrando el número anterior hasta que la vuelva a descargar — que en la
    // práctica no ocurre nunca. Fire-and-forget: el aviso es un extra, el cobro es el
    // negocio, y `notifyCustomerPassUpdated` nunca lanza.
    void notifyCustomerPassUpdated(venueId, customerId)

    return {
      granted: true,
      stampCardId: cardId,
      stampsEarned: resultado.ganados,
      stampsRequired: resultado.meta,
      completed: resultado.completed,
      rewardId: resultado.rewardId,
    }
  } catch (error: any) {
    // 🔴 P2002 = el índice único hizo su trabajo: otro cobro simultáneo ya selló
    // esta orden. NO es un error que deba propagarse — si se propaga, el cobro se
    // ve fallido aunque el dinero entró, que es mucho peor que no sellar.
    if (error?.code === 'P2002') {
      logger.info('Sello duplicado evitado por el índice único', { venueId, orderId, customerId })
      return { granted: false, reason: 'ALREADY_STAMPED', stampCardId: cardId }
    }
    throw error
  }
}

export interface StampCardStatus {
  stampsEarned: number
  stampsRequired: number
  rewardLabel: string
  /** Premios ya ganados y aun sin canjear. */
  pendingRewards: number
}

/**
 * El avance de un cliente, tal como debe leerse en su credencial.
 *
 * 🔴 Nunca lanza y siempre devuelve numeros usables. Se llama desde la emision del
 * pase, que es interactiva: un cliente pidiendo su tarjeta no puede recibir un error
 * porque su negocio no ha configurado sellos todavia — recibe una cartilla en cero.
 *
 * 🔴 Y lee `stampsRequired` de la CARTILLA, no de la configuracion. Son distintos a
 * proposito: la cartilla congela la regla con la que nacio, asi que un cliente que
 * junto 6 de 7 sigue viendo "de 7" aunque el negocio ya haya cambiado a 10.
 */
export async function getStampCardStatus(venueId: string, customerId: string): Promise<StampCardStatus> {
  const [config, card, pendingRewards] = await Promise.all([
    prisma.loyaltyConfig.findUnique({ where: { venueId } }),
    prisma.stampCard.findFirst({
      where: { venueId, customerId, completedAt: null },
      orderBy: { cycle: 'desc' },
      select: { stampsEarned: true, stampsRequired: true },
    }),
    prisma.stampReward.count({ where: { venueId, customerId, status: StampRewardStatus.PENDING } }),
  ])

  return {
    stampsEarned: card?.stampsEarned ?? 0,
    // El orden importa: la cartilla manda sobre la config, y el 10 es el ultimo
    // recurso para un negocio sin nada configurado.
    stampsRequired: card?.stampsRequired ?? config?.stampsRequired ?? 10,
    rewardLabel: config?.stampRewardLabel ?? 'Un producto gratis',
    pendingRewards,
  }
}

export interface ReverseStampResult {
  reversed: boolean
  stampCardId?: string
}

/**
 * Revierte el sello que otorgó una venta que se reembolsó.
 *
 * 🔴 DINERO. Sin esto el cliente avanza en su cartilla por algo que devolvió, y acaba
 * cobrando un premio que no se ganó. Con un café son centavos; con varios clientes
 * haciéndolo, es una cartilla regalada cada semana.
 *
 * 🔴 Es un LIBRO, no un contador: el evento original se QUEDA y nace un asiento
 * contrario. Borrar el EARN haría desaparecer el rastro de que ese cliente sí compró,
 * y el día que reclame no habría con qué reconstruir su historia.
 *
 * Nunca lanza por no encontrar nada: la inmensa mayoría de los reembolsos son de
 * ventas sin cartilla, y este camino corre en todos.
 */
export async function reverseStampForOrder(
  venueId: string,
  orderId: string,
  options: { staffVenueId?: string } = {},
): Promise<ReverseStampResult> {
  const otorgado = await prisma.stampEvent.findFirst({
    where: { venueId, orderId, type: StampEventType.EARN },
    select: { id: true, stampCardId: true, quantity: true },
  })
  if (!otorgado) return { reversed: false }

  // 🔴 Un mismo cobro puede reembolsarse en partes, y cada parte pasa por aquí. Sin
  // este guard el cliente perdería dos sellos por una sola compra devuelta.
  const yaRevertido = await prisma.stampEvent.count({
    where: { venueId, orderId, type: StampEventType.REVERSAL },
  })
  if (yaRevertido > 0) return { reversed: false, stampCardId: otorgado.stampCardId }

  const cantidad = otorgado.quantity ?? 1

  await prisma.$transaction(async tx => {
    await tx.stampEvent.create({
      data: {
        stampCardId: otorgado.stampCardId,
        venueId,
        orderId,
        type: StampEventType.REVERSAL,
        // Negativo: el libro se lee sumando, así que el asiento contrario resta.
        quantity: -cantidad,
        createdById: options.staffVenueId,
      },
    })

    // El contador vive en la MISMA transacción que su asiento. Si se separan, un
    // fallo a medias deja al cliente viendo un avance que el libro no respalda.
    await tx.stampCard.update({
      where: { id: otorgado.stampCardId },
      data: { stampsEarned: { decrement: cantidad } },
    })
  })

  // 🔴 Quitar un sello SÍ se registra; otorgarlo NO.
  //
  // Otorgar pasa en cada cobro de cada negocio: registrarlo inflaría la bitácora
  // hasta volverla inútil, y la regla del repo es explícita — se registran las
  // ANOMALÍAS que un dueño audita, no el ruido de todos los días. El sello otorgado
  // ya queda en su propio libro (`StampEvent`), que es donde se reconstruye.
  //
  // Quitarlo es justo lo que alguien va a mirar cuando un cliente reclame que perdió
  // un sello. Fire-and-forget: un fallo de auditoría no puede deshacer la reversión.
  void logAction({
    action: 'STAMP_REVERSED',
    entity: 'StampCard',
    entityId: otorgado.stampCardId,
    venueId,
    data: { orderId, quantity: cantidad, motivo: 'La venta que lo otorgó fue reembolsada' },
  })

  // El sello se fue: la tarjeta tiene que reflejarlo igual que cuando sube.
  const cliente = await prisma.stampCard.findUnique({ where: { id: otorgado.stampCardId }, select: { customerId: true } })
  if (cliente) void notifyCustomerPassUpdated(venueId, cliente.customerId)

  logger.info('Sello revertido por reembolso', { venueId, orderId, stampCardId: otorgado.stampCardId })

  return { reversed: true, stampCardId: otorgado.stampCardId }
}
