import { LoyaltyConfig, LoyaltyTransactionType, Prisma, StampEventType, StampRewardStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '../../utils/datetime'
import logger from '../../config/logger'
import { logAction } from '../dashboard/activity-log.service'

/**
 * Cuarta ola (15-oct-2026): el MISMO presupuesto que la escritura de los puntos (`PRESUPUESTO_DE_LA_LEALTAD_DE_LA_VENTA` en
 * `loyalty.dashboard.service.ts`, con su porqué): esta transacción espera también el candado de la VENTA, y con los 5 s por
 * defecto de Prisma un intento que la esperara más se vencía y el sello quedaba para otro día. No se importa de allá porque
 * aquel módulo importa éste.
 */
const PRESUPUESTO_DEL_SELLO = { maxWait: 10_000, timeout: 15_000 } as const
import { notifyCustomerPassUpdated } from './notifyPassUpdated.service'
import { sendFirstStampEmailIfDue } from './firstStampEmail.service'

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
 *    viaje. Por eso una violación de ESE índice se traduce a "ya estaba sellado"; cualquier otro único
 *    (premio, cartilla) se propaga. Y dos ventas del mismo cliente se forman en un candado por (negocio, cliente):
 *    el sello propio, el tope y la cartilla se leen dentro. La reversión toma el MISMO candado.
 * 2. **El día es el del NEGOCIO.** Producción corre en UTC: un día "de servidor"
 *    se corta a las 6 de la tarde en México, y el mismo cliente podría sellar dos
 *    veces la misma noche.
 * 3. **Cada sello lleva autor.** Es lo que hace vendible esto frente a la tarjeta
 *    de cartón, donde el empleado sella de más a un conocido y nadie se entera.
 */

export type GrantStampReason = 'STAMPS_DISABLED' | 'ALREADY_STAMPED' | 'DAILY_LIMIT_REACHED' | 'PROGRAM_INACTIVE' | 'OTHER_CUSTOMER'

// ── Avisos al pase y correos del primer sello, en SEGUNDO PLANO (H7) ───────────────────────────────────────────────────
//
// 🔴 H7 (auditoría de Codex del código + revisión final Important 1, 15-oct-2026): el cobro NO espera estos avisos (nunca
// lanzan y no pueden demorar el dinero), pero un proceso corto —el script de reparación— terminaba con `process.exit` y los
// cortaba a medias. Se rastrean los que siguen en vuelo para que quien termina el proceso los espere. En el servidor esto
// sólo guarda promesas vivas (se sueltan al terminar) y cuatro contadores.

const efectosEnVuelo = new Set<Promise<void>>()
const efectosTerminados = { avisosAlPase: 0, tarjetasAvisadas: 0, avisosFallidos: 0, correosDePrimerSello: 0 }

function enSegundoPlano(tipo: 'aviso' | 'correo', trabajo: unknown): void {
  const p: Promise<void> = Promise.resolve(trabajo).then(
    resultado => {
      if (tipo === 'correo') {
        efectosTerminados.correosDePrimerSello += 1
        return
      }
      const aviso = resultado as { notified?: number; failed?: boolean } | undefined
      efectosTerminados.avisosAlPase += 1
      efectosTerminados.tarjetasAvisadas += aviso?.notified ?? 0
      if (aviso?.failed) efectosTerminados.avisosFallidos += 1
    },
    () => {
      // Ninguno de los dos lanza; si algún día lo hiciera, aquí no tumba nada y queda contado.
      if (tipo === 'aviso') efectosTerminados.avisosFallidos += 1
    },
  )
  efectosEnVuelo.add(p)
  void p.finally(() => efectosEnVuelo.delete(p))
}

export interface ResumenDeEfectosDeSellos {
  /** Avisos al pase que terminaron en este proceso. */
  avisosAlPase: number
  /** Suma de tarjetas (aparatos o pases de Google) que esos avisos actualizaron. */
  tarjetasAvisadas: number
  avisosFallidos: number
  /** Revisiones del correo del primer sello que terminaron (sólo se manda si es el primero y hay correo). */
  correosDePrimerSello: number
  /** Los que seguían en vuelo al vencer `maxMs`. */
  pendientes: number
}

/** Espera (con tope) los avisos y correos que los sellos dejaron corriendo, y devuelve lo acumulado en este proceso. */
export async function esperarEfectosDeSellos(opciones: { maxMs?: number } = {}): Promise<ResumenDeEfectosDeSellos> {
  const limite = Date.now() + (opciones.maxMs ?? 60_000)
  while (efectosEnVuelo.size > 0 && Date.now() < limite) {
    let vence: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([...efectosEnVuelo]),
      new Promise<void>(resolve => {
        vence = setTimeout(resolve, Math.max(0, limite - Date.now()))
      }),
    ])
    if (vence) clearTimeout(vence)
  }
  return { ...efectosTerminados, pendientes: efectosEnVuelo.size }
}

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

/** El índice que garantiza «un pago = un sello» (migración 20260826145859; parcial y crudo: Prisma no lo conoce por nombre). */
const UNICO_SELLO_DE_LA_ORDEN = 'StampEvent_venueId_orderId_earn_unique'

/**
 * ¿Este P2002 es el sello de ESTA orden, y no el premio ni la cartilla siguiente? (auditoría A #3, 14-oct-2026)
 *
 * Antes cualquier P2002 se leía como «ya estaba sellado». Si el choque era del premio (`StampReward.stampCardId`) o de la
 * cartilla siguiente (`StampCard[customerId, venueId, cycle]`), la transacción se revertía y el sello de una venta DISTINTA se
 * perdía en silencio. Se aceptan las formas que `esChoqueDelUnico` (turnoDeCaja.ts) midió contra Postgres: el nombre del índice
 * en `meta.constraint` / `meta.target` (suelto o en un arreglo de uno), o la lista EXACTA de columnas `['venueId','orderId']` del
 * modelo StampEvent. El otro único de esas columnas (`…_reversal_unique`) no se puede tocar aquí: sólo se insertan EARN.
 * Sin descriptor no se adivina: se relanza (`earnPoints` lo difiere y el reconciliador reintenta).
 */
function esChoqueDelSelloDeLaOrden(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const meta = error.meta as { modelName?: unknown; target?: unknown; constraint?: unknown } | undefined
  const descriptor = meta?.constraint ?? meta?.target
  if (descriptor === UNICO_SELLO_DE_LA_ORDEN) return true
  if (Array.isArray(descriptor) && descriptor.length === 1 && descriptor[0] === UNICO_SELLO_DE_LA_ORDEN) return true
  return (
    (meta?.modelName === undefined || meta.modelName === 'StampEvent') &&
    Array.isArray(descriptor) &&
    descriptor.length === 2 &&
    descriptor[0] === 'venueId' &&
    descriptor[1] === 'orderId'
  )
}

type DentroDelCandado =
  | { otorgado: false; reason: 'DAILY_LIMIT_REACHED' }
  | { otorgado: false; reason: 'ALREADY_STAMPED'; cardId: string }
  | { otorgado: false; reason: 'OTHER_CUSTOMER' }
  | { otorgado: true; cardId: string; ganados: number; meta: number; completed: boolean; rewardId?: string }

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

  // La zona del venue no es parte de la carrera: se lee fuera. Un tope de 0 significa SIN tope: un negocio que escribe 0
  // quiere decir "ilimitado", y leerlo como "cero sellos al día" apagaría su programa entero sin avisarle a nadie.
  const tz =
    config.maxStampsPerDay > 0
      ? ((await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone ?? 'America/Mexico_City')
      : null

  try {
    const resultado = await prisma.$transaction(async (tx): Promise<DentroDelCandado> => {
      // 🔴 PRIMERA sentencia (auditoría A #3): un candado por (negocio, cliente). Dos ventas DISTINTAS del mismo cliente se
      // forman aquí; la segunda lee el tope y la cartilla DESPUÉS de que la primera hizo commit. Sin él, las dos pasaban el
      // tope de 1 al día, o las dos llenaban la misma cartilla y el sello de la segunda se perdía al chocar con el premio.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${customerId}))`

      // 🔴 H4, tercera ola (recheck 2 de Codex, 15-oct-2026): y en seguida el candado de la VENTA —el mismo que toma la escritura
      // de los puntos en `earnPoints`—. Los puntos y el sello de una venta son de UN cliente: dos intentos pueden validar a
      // clientes distintos (la TPV cambió al primario entre uno y otro) antes del primer EARN, y el candado de arriba es por
      // CLIENTE, no los forma. Siempre en este orden: candado del cliente → candado de la venta; nadie toma el inverso.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${orderId}))`

      // 🔴 F2 (rulings del código, 15-oct-2026): la PRIMERA lectura dentro de los candados es el sello de ESTA orden. Dos llamadas
      // de la MISMA venta a la vez (doble toque, liga + reconciliador) pasan las dos el atajo de afuera; la segunda espera aquí
      // y, sin esta relectura, contaba el sello que la primera acababa de dar como «el de hoy» y respondía DAILY_LIMIT: falso
      // para esta venta, que sí quedó sellada. (Un segundo sello, de quien sea, también lo impide el índice único por venta.)
      const propio = await tx.stampEvent.findFirst({
        where: { venueId, orderId, type: StampEventType.EARN },
        select: { id: true, stampCardId: true },
      })
      if (propio) return { otorgado: false, reason: 'ALREADY_STAMPED', cardId: propio.stampCardId }

      // H4, tercera ola: si OTRO cliente ya recibió los PUNTOS de esta venta, este sello tampoco se da.
      const puntosDeOtro = await tx.loyaltyTransaction.findFirst({
        where: { orderId, type: LoyaltyTransactionType.EARN, customerId: { not: customerId }, customer: { venueId } },
        select: { customerId: true },
      })
      if (puntosDeOtro) return { otorgado: false, reason: 'OTHER_CUSTOMER' }

      // 🔴 El tope se cuenta en el día del VENUE, y DENTRO del candado.
      if (tz) {
        const hoy = await tx.stampEvent.count({
          where: {
            venueId,
            type: StampEventType.EARN,
            stampCard: { customerId },
            createdAt: { gte: venueStartOfDay(tz), lte: venueEndOfDay(tz) },
          },
        })
        if (hoy >= config.maxStampsPerDay) return { otorgado: false, reason: 'DAILY_LIMIT_REACHED' }
      }

      // La cartilla en curso, o una nueva — también DENTRO del candado. `stampsRequired` se COPIA aquí y queda congelado: si
      // el negocio cambia la regla mañana, quien ya empezó conserva la suya.
      let card = await tx.stampCard.findFirst({
        where: { venueId, customerId, completedAt: null },
        orderBy: { cycle: 'desc' },
      })
      if (!card) {
        const ultima = await tx.stampCard.findFirst({
          where: { venueId, customerId },
          orderBy: { cycle: 'desc' },
          select: { cycle: true },
        })
        card = await tx.stampCard.create({
          data: {
            venueId,
            customerId,
            cycle: (ultima?.cycle ?? 0) + 1,
            stampsRequired: config.stampsRequired,
            stampsEarned: 0,
          },
        })
      }

      await tx.stampEvent.create({
        data: {
          stampCardId: card.id,
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
        where: { id: card.id },
        data: { stampsEarned: { increment: 1 } },
        select: { stampsEarned: true, stampsRequired: true },
      })

      const ganados = actualizada.stampsEarned
      const meta = actualizada.stampsRequired ?? card.stampsRequired
      if (ganados < meta) return { otorgado: true, cardId: card.id, ganados, meta, completed: false }

      // ── La cartilla se llenó ────────────────────────────────────────────────
      await tx.stampCard.update({ where: { id: card.id }, data: { completedAt: new Date() } })

      // 🔴 El premio CONGELA sus condiciones (quien ya lo ganó recibe lo que se le prometió).
      const premio = await tx.stampReward.create({
        data: {
          stampCardId: card.id,
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

      // 🔴 Y la siguiente cartilla arranca AQUÍ, no al canjear el premio (hallazgo C7), con la regla de HOY.
      await tx.stampCard.create({
        data: {
          venueId,
          customerId,
          cycle: card.cycle + 1,
          stampsRequired: config.stampsRequired,
          stampsEarned: 0,
        },
      })

      return { otorgado: true, cardId: card.id, ganados, meta, completed: true, rewardId: premio.id }
    }, PRESUPUESTO_DEL_SELLO)

    if (!resultado.otorgado) {
      return resultado.reason === 'ALREADY_STAMPED'
        ? { granted: false, reason: 'ALREADY_STAMPED', stampCardId: resultado.cardId }
        : { granted: false, reason: resultado.reason }
    }

    // 🔴 El sello subió: avisarle al teléfono del cliente (en segundo plano; `notifyCustomerPassUpdated` nunca lanza).
    enSegundoPlano('aviso', notifyCustomerPassUpdated(venueId, customerId))
    // 🔴 Y si es su PRIMER sello, mandarle la liga para que guarde la tarjeta (`sendFirstStampEmailIfDue` decide y nunca lanza).
    enSegundoPlano('correo', sendFirstStampEmailIfDue(venueId, customerId, resultado.cardId))

    return {
      granted: true,
      stampCardId: resultado.cardId,
      stampsEarned: resultado.ganados,
      stampsRequired: resultado.meta,
      completed: resultado.completed,
      rewardId: resultado.rewardId,
    }
  } catch (error: unknown) {
    // 🔴 SÓLO el índice del sello de esta orden es «otro cobro simultáneo ya la selló». No se propaga: el cobro se vería
    // fallido aunque el dinero entró. Cualquier otro P2002 (premio, cartilla) SÍ se propaga (auditoría A #3).
    if (esChoqueDelSelloDeLaOrden(error)) {
      logger.info('Sello duplicado evitado por el índice único', { venueId, orderId, customerId })
      return { granted: false, reason: 'ALREADY_STAMPED' }
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
 *
 * 🔴 H3 (auditoría de Codex del código, 15-oct-2026): toma el MISMO candado (negocio, cliente) que `grantStamp`, como
 * PRIMERA sentencia de su transacción, y lee la cartilla DESPUÉS. Sin él, la reversión leía la cartilla en 2/3; otra venta
 * del mismo cliente la completaba (premio + cartilla nueva) y la reversión restaba con su lectura vieja: la cartilla quedaba
 * «2 de 3, completada, con un premio pendiente» que el cliente ya no se había ganado. El cliente sale de la cartilla del
 * sello ORIGINAL (una cartilla nunca cambia de dueño).
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
  // El dueño de la cartilla del sello original: con él se forma el candado, igual que en `grantStamp`.
  const original = await prisma.stampCard.findUnique({ where: { id: otorgado.stampCardId }, select: { customerId: true } })
  if (!original) return { reversed: false }
  const customerId = original.customerId

  let revertida = false
  try {
    await prisma.$transaction(async tx => {
      // 🔴 PRIMERA sentencia: el candado (negocio, cliente). Un otorgamiento del mismo cliente que esté completando la cartilla
      // termina antes de que aquí se lea nada.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${customerId}))`

      // Otra reversión de esta venta pudo hacer commit mientras ésta esperaba el candado.
      const reversasDentro = await tx.stampEvent.count({ where: { venueId, orderId, type: StampEventType.REVERSAL } })
      if (reversasDentro > 0) return

      const card = await tx.stampCard.findUnique({
        where: { id: otorgado.stampCardId },
        select: { id: true, venueId: true, customerId: true, cycle: true, stampsEarned: true, completedAt: true },
      })
      if (!card) return

      let targetCardId = card.id
      let reopenCompletedCard = false

      if (card.completedAt) {
        const current = await tx.stampCard.findFirst({
          where: { venueId, customerId: card.customerId, completedAt: null, id: { not: card.id } },
          orderBy: { cycle: 'desc' },
          select: { id: true, stampsEarned: true, completedAt: true },
        })

        // Purchases made after completing the old card already replace the refunded
        // stamp. Consume that newer progress first, preserving the legitimately earned
        // reward and avoiding two simultaneously-open cards.
        if (current && current.stampsEarned >= cantidad) {
          targetCardId = current.id
        } else {
          const cancelled = await tx.stampReward.updateMany({
            where: { stampCardId: card.id, status: StampRewardStatus.PENDING },
            data: { status: StampRewardStatus.CANCELLED },
          })
          reopenCompletedCard = cancelled.count > 0
          if (reopenCompletedCard && current?.stampsEarned === 0) {
            await tx.stampCard.delete({ where: { id: current.id } })
          }
        }
      }

      await tx.stampEvent.create({
        data: {
          stampCardId: targetCardId,
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
        where: { id: targetCardId },
        data: {
          stampsEarned: { decrement: cantidad },
          ...(reopenCompletedCard ? { completedAt: null } : {}),
        },
      })
      revertida = true
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      logger.info('Reversa de sello duplicada evitada por el índice único', { venueId, orderId })
      return { reversed: false, stampCardId: otorgado.stampCardId }
    }
    throw error
  }
  if (!revertida) return { reversed: false, stampCardId: otorgado.stampCardId }

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
  enSegundoPlano('aviso', notifyCustomerPassUpdated(venueId, customerId))

  logger.info('Sello revertido por reembolso', { venueId, orderId, stampCardId: otorgado.stampCardId })

  return { reversed: true, stampCardId: otorgado.stampCardId }
}
