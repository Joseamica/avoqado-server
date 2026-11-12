import { LoyaltyConfig, LoyaltyTransactionType, Prisma, StampEventType, StampRewardStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '../../utils/serializableRetry'
import { venueStartOfDay, venueEndOfDay } from '../../utils/datetime'
import logger from '../../config/logger'
import { logAction } from '../dashboard/activity-log.service'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { ventaTieneReembolso } from '../shared/ligaDeClienteEnVenta'
import { decidirPromoDeLaVentaEnTx, registrarUsoEnTx } from '../loyalty/promotions/promoDeLaVenta'
import { sellosConPromo } from '../loyalty/promotions/evaluarPromo'

/**
 * Cuarta ola (15-oct-2026): el MISMO presupuesto que la escritura de los puntos (`PRESUPUESTO_DE_LA_LEALTAD_DE_LA_VENTA` en
 * `loyalty.dashboard.service.ts`, con su porqué): esta transacción espera también el candado de la VENTA, y con los 5 s por
 * defecto de Prisma un intento que la esperara más se vencía y el sello quedaba para otro día. No se importa de allá porque
 * aquel módulo importa éste.
 */
const PRESUPUESTO_DEL_SELLO = { maxWait: 10_000, timeout: 15_000 } as const
import { notifyCustomerPassUpdated } from './notifyPassUpdated.service'
import { encolarAvisoDeTarjetaEnTx } from './walletPassOutbox.service'
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
 *    índice `StampEvent_venueId_orderId_part_earn_unique` (parte 0 = el sello de siempre); el chequeo sólo evita el
 *    viaje. Por eso una violación de ESE índice se traduce a "ya estaba sellado"; cualquier otro único
 *    (premio, cartilla) se propaga. Y dos ventas del mismo cliente se forman en un candado por (negocio, cliente):
 *    el sello propio, el tope y la cartilla se leen dentro. La reversión toma el MISMO candado.
 * 2. **El día es el del NEGOCIO.** Producción corre en UTC: un día "de servidor"
 *    se corta a las 6 de la tarde en México, y el mismo cliente podría sellar dos
 *    veces la misma noche.
 * 3. **Cada sello lleva autor.** Es lo que hace vendible esto frente a la tarjeta
 *    de cartón, donde el empleado sella de más a un conocido y nadie se entera.
 */

// `ORDER_REFUNDED` es interno: sólo lo lee `earnPoints`; ninguna respuesta de la API lo manda a las apps.
export type GrantStampReason =
  | 'STAMPS_DISABLED'
  | 'ALREADY_STAMPED'
  | 'DAILY_LIMIT_REACHED'
  | 'PROGRAM_INACTIVE'
  | 'OTHER_CUSTOMER'
  | 'ORDER_REFUNDED'

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
  /** La cartilla de la parte 0 (la de siempre): su avance y su meta tras el sello. */
  stampsEarned?: number
  stampsRequired?: number
  stampCardId?: string
  /** True cuando la venta completó al menos una cartilla (si completó alguna, completó la de la parte 0). */
  completed?: boolean
  /** El primer premio que nació (el de la cartilla de la parte 0). */
  rewardId?: string
  /** Promos de lealtad: cuántos sellos dio la venta (1 sin promo). */
  stampsAdded?: number
  /** Todos los premios que nacieron, en orden (una venta con promo puede completar varias cartillas). */
  rewardIds?: string[]
  /** La promo que dio sellos de más, si la hubo. */
  promotionId?: string
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
  /**
   * El monto de la venta SIN propina, el mismo con que `earnPoints` calcula sus puntos: con él la promo revisa el gasto mínimo y
   * el monto que califica (spec §4.3 regla 5). Sin él (un llamador que no lo trae) se usa el total de la orden menos su propina.
   */
  amount?: number
}

/**
 * Los índices que garantizan «cada parte de un pago se sella una vez» y «se revierte una vez» (parciales y crudos: Prisma no
 * los conoce por nombre). El del sello era `(venueId, orderId)` (20260826145859); desde las promos de lealtad (20261112190000)
 * los dos son `(venueId, orderId, part)`.
 */
const UNICO_SELLO_DE_LA_ORDEN = 'StampEvent_venueId_orderId_part_earn_unique'
const UNICA_REVERSA_DE_LA_ORDEN = 'StampEvent_venueId_orderId_part_reversal_unique'

/**
 * Una venta con promo da a lo más 10 sellos (validación del panel): con cartillas de 2 caben en 6 partes. 11 deja holgura;
 * pasarlo sólo pasa con una configuración inválida, y entonces se lanza en vez de sellar de más (ruling 6).
 */
const TOPE_DE_PARTES = 11

/**
 * ¿Este P2002 es el índice `indice` de ESTA orden, y no el premio ni la cartilla siguiente? (auditoría A #3, 14-oct-2026)
 *
 * Antes cualquier P2002 se leía como «ya estaba sellado». Si el choque era del premio (`StampReward.stampCardId`) o de la
 * cartilla siguiente (`StampCard[customerId, venueId, cycle]`), la transacción se revertía y el sello de una venta DISTINTA se
 * perdía en silencio. Se aceptan las formas que `esChoqueDelUnico` (turnoDeCaja.ts) midió contra Postgres: el nombre del índice
 * en `meta.constraint` / `meta.target` (suelto o en un arreglo de uno), o la lista EXACTA de columnas `['venueId','orderId','part']`
 * del modelo StampEvent. Los dos índices tienen esas columnas, pero cada transacción inserta un solo tipo (el sello sólo EARN,
 * la reversa sólo REVERSAL), así que las columnas señalan al índice de quien pregunta.
 * Sin descriptor no se adivina: se relanza (`earnPoints` lo difiere y el reconciliador reintenta).
 */
function esChoqueDelUnicoDeLaOrden(error: unknown, indice: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const meta = error.meta as { modelName?: unknown; target?: unknown; constraint?: unknown } | undefined
  const descriptor = meta?.constraint ?? meta?.target
  if (descriptor === indice) return true
  if (Array.isArray(descriptor) && descriptor.length === 1 && descriptor[0] === indice) return true
  return (
    (meta?.modelName === undefined || meta.modelName === 'StampEvent') &&
    Array.isArray(descriptor) &&
    descriptor.length === 3 &&
    descriptor[0] === 'venueId' &&
    descriptor[1] === 'orderId' &&
    descriptor[2] === 'part'
  )
}

type DentroDelCandado =
  | { otorgado: false; reason: 'DAILY_LIMIT_REACHED' }
  | { otorgado: false; reason: 'ORDER_REFUNDED' }
  | { otorgado: false; reason: 'ALREADY_STAMPED'; cardId: string }
  | { otorgado: false; reason: 'OTHER_CUSTOMER' }
  | {
      otorgado: true
      /** La cartilla de la parte 0, con su avance y meta tras el sello. */
      cardId: string
      ganados: number
      meta: number
      completed: boolean
      /** La última cartilla que tocó la venta: donde va su avance de hoy (la liga del correo del primer sello). */
      ultimaCardId: string
      stampsAdded: number
      rewardIds: string[]
      promotionId?: string
    }

/**
 * La cartilla se llenó: la marca completada, deja su premio PENDING y abre la siguiente. Corre DENTRO de la transacción de
 * quien la llama (el sello de `grantStamp` y el ajuste a mano `adjustStamps`). Sin cambio de conducta respecto a cuando vivía
 * en línea dentro de `grantStamp`.
 * 🔴 Quien la llama YA tiene el candado del cliente (`pg_advisory_xact_lock(hashtext(venueId), hashtext(customerId))`) y la
 * llama sólo cuando la cartilla ACABA de llegar a su meta: sin ese candado, el paso D2 («¿hay otra abierta?» → crear) no es seguro.
 */
async function completarCartilla(
  tx: TxConReintento,
  card: { id: string; cycle: number },
  config: StampConfigView,
  venueId: string,
  customerId: string,
): Promise<{ rewardId: string }> {
  await tx.stampCard.update({ where: { id: card.id }, data: { completedAt: new Date() } })

  // 🔴 El premio CONGELA sus condiciones (quien ya lo ganó recibe lo que se le prometió).
  const condiciones = {
    status: StampRewardStatus.PENDING,
    rewardType: config.stampRewardType,
    rewardValue: config.stampRewardValue as Prisma.Decimal | null,
    rewardProductId: config.stampRewardProductId,
    rewardLabel: config.stampRewardLabel,
  }
  // 🔴 D1 (21-oct): una devolución reabre la cartilla llena y CANCELA su premio, pero la fila se queda (un premio por
  // cartilla: `stampCardId @unique`). Crear otro chocaba y la compra perdía su sello en cada reintento. Se REACTIVA el
  // mismo, se ganó hoy: condiciones y fecha de hoy, sin rastro de canje (como `refundStampRewardForOrderDiscount`).
  const anterior = await tx.stampReward.findUnique({ where: { stampCardId: card.id }, select: { id: true, status: true } })
  const premio =
    anterior?.status === StampRewardStatus.CANCELLED
      ? await tx.stampReward.update({
          where: { id: anterior.id },
          data: { ...condiciones, redeemedAt: null, orderDiscountId: null, expiresAt: null, createdAt: new Date() },
          select: { id: true },
        })
      : await tx.stampReward.create({
          data: { stampCardId: card.id, customerId, venueId, ...condiciones },
          select: { id: true },
        })

  // 🔴 Y la siguiente cartilla arranca AQUÍ, no al canjear el premio (hallazgo C7), con la regla de HOY. Su número sale de la
  // ÚLTIMA cartilla, no de ésta (D1, Codex r1 #1): una devolución puede reabrir una cartilla vieja cuando ya existen otras
  // llenas después de ella, y «ésta + 1» chocaría con `[customerId, venueId, cycle]`.
  // Y si ya hay otra abierta (la que quedó cuando una devolución reabrió ésta, D2), ésa es la siguiente: no se crea otra.
  const otraAbierta = await tx.stampCard.findFirst({
    where: { venueId, customerId, completedAt: null, id: { not: card.id } },
    select: { id: true },
  })
  if (!otraAbierta) {
    const ultimaCartilla = await tx.stampCard.findFirst({
      where: { venueId, customerId },
      orderBy: { cycle: 'desc' },
      select: { cycle: true },
    })
    await tx.stampCard.create({
      data: {
        venueId,
        customerId,
        cycle: Math.max(card.cycle, ultimaCartilla?.cycle ?? 0) + 1,
        stampsRequired: config.stampsRequired,
        stampsEarned: 0,
      },
    })
  }

  return { rewardId: premio.id }
}

/**
 * Abre la cartilla de un cliente que no tiene ninguna abierta: ciclo = último + 1, con la meta de HOY, que queda congelada en
 * ella. Dentro del candado del cliente, como `completarCartilla`.
 */
async function abrirCartilla(tx: TxConReintento, venueId: string, customerId: string, stampsRequired: number) {
  const ultima = await tx.stampCard.findFirst({
    where: { venueId, customerId },
    orderBy: { cycle: 'desc' },
    select: { cycle: true },
  })
  return tx.stampCard.create({
    data: { venueId, customerId, cycle: (ultima?.cycle ?? 0) + 1, stampsRequired, stampsEarned: 0 },
  })
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
  // levantar una transacción cuando ya sabemos que va a rebotar. «Sellada» = tiene su parte 0 (todas nacen juntas).
  const yaSellado = await prisma.stampEvent.findFirst({
    where: { venueId, orderId, type: StampEventType.EARN, part: 0 },
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
    const resultado = await withDeadlockRetry(
      async (tx): Promise<DentroDelCandado> => {
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
          where: { venueId, orderId, type: StampEventType.EARN, part: 0 },
          select: { id: true, stampCardId: true },
        })
        if (propio) return { otorgado: false, reason: 'ALREADY_STAMPED', cardId: propio.stampCardId }

        const venta = await tx.order.findFirst({
          where: { id: orderId, venueId },
          select: { loyaltySaleAt: true, loyaltyEligibleAt: true, total: true, tipAmount: true },
        })
        const soldAt = venta?.loyaltySaleAt ?? venta?.loyaltyEligibleAt ?? new Date()

        // 🔴 D3 (24-oct): una venta ya devuelta no da sello, la misma regla que la lealtad tardía (`ventaTieneReembolso`). Se lee
        // bajo el candado de la venta: si la devolución entra DESPUÉS de esta lectura, su reversa espera ese mismo candado (ver
        // `reverseStampForOrder`) y quita el sello que esta transacción deje.
        if (await ventaTieneReembolso(tx, { venueId, orderId })) return { otorgado: false, reason: 'ORDER_REFUNDED' }

        // H4, tercera ola: si OTRO cliente ya recibió los PUNTOS de esta venta, este sello tampoco se da.
        const puntosDeOtro = await tx.loyaltyTransaction.findFirst({
          where: { orderId, type: LoyaltyTransactionType.EARN, customerId: { not: customerId }, customer: { venueId } },
          select: { customerId: true },
        })
        if (puntosDeOtro) return { otorgado: false, reason: 'OTHER_CUSTOMER' }

        // 🔴 El tope se cuenta en el día del VENUE, y DENTRO del candado. Cuenta VISITAS (la parte 0 de cada venta), no sellos:
        // una venta ×2 que cruzó de cartilla es una visita (spec §4.3 regla 9, ruling 8). `topeDelDiaAlcanzado` cuenta igual.
        if (tz) {
          const hoy = await tx.stampEvent.count({
            where: {
              venueId,
              type: StampEventType.EARN,
              part: 0,
              stampCard: { customerId },
              createdAt: { gte: venueStartOfDay(tz, soldAt), lte: venueEndOfDay(tz, soldAt) },
            },
          })
          if (hoy >= config.maxStampsPerDay) return { otorgado: false, reason: 'DAILY_LIMIT_REACHED' }
        }

        // ── Promos de lealtad (spec §4.3): se decide DESPUÉS de las reglas normales (regla 8: si la venta no daba sello, la promo
        // tampoco) y DENTRO del candado de la clienta, para que dos ventas a la vez no se salten «1 vez al día». La hora es la de
        // la venta (regla 3); el monto, el mismo sin propina de los puntos (regla 5).
        const amount =
          options.amount ??
          Prisma.Decimal.max(0, new Prisma.Decimal(venta?.total ?? 0).minus(venta?.tipAmount ?? 0))
            .toDecimalPlaces(2)
            .toNumber()
        const decision = await decidirPromoDeLaVentaEnTx(tx, { venueId, customerId, orderId, soldAt, amount })
        // Nunca menos que el sello de siempre, aunque una promo inválida dijera 0.
        const sellos = Math.max(1, sellosConPromo(decision))
        // La promo se anota en el sello sólo si dio sellos de más (un «+N puntos» no toca los sellos).
        const promotionId = sellos > 1 ? decision?.promotionId : undefined

        // Los sellos se reparten en PARTES, una por cartilla que tocan (regla 10): cada parte llena la abierta más vieja hasta su
        // meta; si la completa, nace su premio y la siguiente parte va a la abierta que siga. Sin promo es UNA parte de 1 sello: lo
        // de siempre. El índice único (venta, parte) garantiza que ninguna parte se sella dos veces; todas nacen en esta transacción.
        let restante = sellos
        let primera: { cardId: string; ganados: number; meta: number; completed: boolean } | undefined
        let ultimaCardId = ''
        const rewardIds: string[] = []
        for (let part = 0; restante > 0; part++) {
          if (part >= TOPE_DE_PARTES) throw new Error(`Sello con promo: la venta ${orderId} pide más de ${TOPE_DE_PARTES} partes`)

          // La cartilla en curso, o una nueva — también DENTRO del candado. `stampsRequired` se COPIA aquí y queda congelado: si
          // el negocio cambia la regla mañana, quien ya empezó conserva la suya.
          // 🔴 La abierta MÁS VIEJA (D2): una devolución puede reabrir una cartilla llena cuando ya existe la siguiente; se termina
          // primero la reabierta. Con una sola abierta (lo normal) es la misma de siempre.
          let card = await tx.stampCard.findFirst({
            where: { venueId, customerId, completedAt: null },
            orderBy: { cycle: 'asc' },
          })
          if (!card) card = await abrirCartilla(tx, venueId, customerId, config.stampsRequired)

          // Hasta la meta de ESTA cartilla. Una abierta que ya estuviera en su meta (no debería) recibe 1 y se completa, como antes.
          const faltan = card.stampsRequired - card.stampsEarned
          const quantity = Math.min(restante, faltan > 0 ? faltan : 1)
          await tx.stampEvent.create({
            data: {
              stampCardId: card.id,
              venueId,
              orderId,
              type: StampEventType.EARN,
              part,
              quantity,
              promotionId,
              createdById: options.staffVenueId,
              terminalId: options.terminalId,
              createdAt: soldAt,
            },
          })
          // El contador se mueve en la MISMA transacción que su evento: si viven
          // separados, un fallo a medias deja el cache mintiendo sobre el libro.
          const actualizada = await tx.stampCard.update({
            where: { id: card.id },
            data: { stampsEarned: { increment: quantity } },
            select: { stampsEarned: true, stampsRequired: true },
          })
          restante -= quantity
          ultimaCardId = card.id

          const ganados = actualizada.stampsEarned
          const meta = actualizada.stampsRequired ?? card.stampsRequired
          // ── La cartilla se llenó ────────────────────────────────────────────────
          const completed = ganados >= meta
          if (completed) rewardIds.push((await completarCartilla(tx, card, config, venueId, customerId)).rewardId)
          primera ??= { cardId: card.id, ganados, meta, completed }
        }

        await encolarAvisoDeTarjetaEnTx(tx, { venueId, customerId, motivo: 'SELLO' })
        // El bono gasta el límite de la clienta en la MISMA transacción que sus sellos (regla 14). Sin bono no hay fila.
        if (decision && sellos > 1) await registrarUsoEnTx(tx, { venueId, customerId, orderId, soldAt, decision, stampsBonus: sellos - 1 })

        return { otorgado: true, ...primera!, ultimaCardId, stampsAdded: sellos, rewardIds, promotionId }
      },
      { etiqueta: 'grantStamp', ...PRESUPUESTO_DEL_SELLO },
    )

    if (!resultado.otorgado) {
      return resultado.reason === 'ALREADY_STAMPED'
        ? { granted: false, reason: 'ALREADY_STAMPED', stampCardId: resultado.cardId }
        : { granted: false, reason: resultado.reason }
    }

    // 🔴 El sello subió: avisarle al teléfono del cliente (en segundo plano; `notifyCustomerPassUpdated` nunca lanza).
    enSegundoPlano('aviso', notifyCustomerPassUpdated(venueId, customerId))
    // 🔴 Y si es su PRIMER sello, mandarle la liga para que guarde la tarjeta (`sendFirstStampEmailIfDue` decide y nunca lanza).
    // La liga muestra el avance de la ÚLTIMA cartilla que tocó la venta (con una sola parte, la de siempre).
    enSegundoPlano('correo', sendFirstStampEmailIfDue(venueId, customerId, resultado.ultimaCardId))

    return {
      granted: true,
      stampCardId: resultado.cardId,
      stampsEarned: resultado.ganados,
      stampsRequired: resultado.meta,
      completed: resultado.completed,
      rewardId: resultado.rewardIds[0],
      stampsAdded: resultado.stampsAdded,
      rewardIds: resultado.rewardIds,
      promotionId: resultado.promotionId,
    }
  } catch (error: unknown) {
    // 🔴 SÓLO el índice del sello de esta orden es «otro cobro simultáneo ya la selló». No se propaga: el cobro se vería
    // fallido aunque el dinero entró. Cualquier otro P2002 (premio, cartilla) SÍ se propaga (auditoría A #3).
    if (esChoqueDelUnicoDeLaOrden(error, UNICO_SELLO_DE_LA_ORDEN)) {
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
  /** La cartilla que se está leyendo (la abierta más vieja); null si aún no tiene. El ajuste a mano la manda en su CAS. */
  stampCardId: string | null
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
    // La abierta MÁS VIEJA: la misma que llena `grantStamp` (D2). Con una sola abierta es la de siempre.
    prisma.stampCard.findFirst({
      where: { venueId, customerId, completedAt: null },
      orderBy: { cycle: 'asc' },
      select: { id: true, stampsEarned: true, stampsRequired: true },
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
    stampCardId: card?.id ?? null,
  }
}

export interface ReverseStampResult {
  reversed: boolean
  stampCardId?: string
}

/** Hasta 2 reintentos (100 ms, 300 ms) si la transacción se vence esperando un candado (P2028); cualquier otro error sube. */
async function reintentarSiSeVence<T>(venueId: string, orderId: string, correr: () => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await correr()
    } catch (error) {
      const vencida = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028'
      if (!vencida || intento >= 2) throw error
      logger.warn('Reversa de sello vencida esperando el candado (P2028): se reintenta', { venueId, orderId, intento: intento + 1 })
      await new Promise(resolve => setTimeout(resolve, 100 * 3 ** intento))
    }
  }
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
 *
 * Promos de lealtad (Task 6): una venta puede haber dado varios sellos en varias PARTES (una por cartilla). Se quita la suma
 * de todas, en una o varias cartillas, con un asiento REVERSAL por cartilla tocada (parte 0, 1, 2…). Con un sello, lo de siempre.
 */
export async function reverseStampForOrder(
  venueId: string,
  orderId: string,
  options: { staffVenueId?: string } = {},
): Promise<ReverseStampResult> {
  // 🔴 D3 (24-oct): el sello se busca bajo el candado de la VENTA, el mismo que `grantStamp` sostiene hasta su commit. Sin él, un
  // cobro que estaba otorgando cuando entró la devolución todavía no se veía aquí; la reversión salía sin hacer nada y el sello
  // quedaba vivo. Transacción corta y sólo con ese candado: nunca se toma junto con el del cliente (no hay orden inverso).
  // Con los mismos reintentos P2028 que la reversa (Codex D3-r1 #1): si esta lectura se vence, el sello no puede quedar vivo.
  const otorgado = await reintentarSiSeVence(venueId, orderId, () =>
    prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${orderId}))`
      // La parte 0 es el sello de siempre y su cartilla es «la de la venta»; las demás (el sobrante de una promo) sólo suman.
      const parte0 = await tx.stampEvent.findFirst({
        where: { venueId, orderId, type: StampEventType.EARN, part: 0 },
        select: { id: true, stampCardId: true, quantity: true },
      })
      if (!parte0) return null
      const demas = await tx.stampEvent.findMany({
        where: { venueId, orderId, type: StampEventType.EARN, part: { gt: 0 } },
        select: { quantity: true },
        take: TOPE_DE_PARTES,
      })
      return { stampCardId: parte0.stampCardId, cantidad: demas.reduce((s, d) => s + d.quantity, parte0.quantity ?? 1) }
    }, PRESUPUESTO_DEL_SELLO),
  )
  if (!otorgado) return { reversed: false }

  // 🔴 Un mismo cobro puede reembolsarse en partes, y cada parte pasa por aquí. Sin
  // este guard el cliente perdería dos sellos por una sola compra devuelta.
  const yaRevertido = await prisma.stampEvent.count({
    where: { venueId, orderId, type: StampEventType.REVERSAL },
  })
  if (yaRevertido > 0) return { reversed: false, stampCardId: otorgado.stampCardId }

  const cantidad = otorgado.cantidad
  // El dueño de la cartilla del sello original: con él se forma el candado, igual que en `grantStamp`.
  const original = await prisma.stampCard.findUnique({ where: { id: otorgado.stampCardId }, select: { customerId: true } })
  if (!original) return { reversed: false }
  const customerId = original.customerId

  // 🔴 Quinta ola (recheck 4 de Codex, 15-oct-2026): el MISMO presupuesto que `grantStamp` (`PRESUPUESTO_DEL_SELLO`), porque
  // espera el mismo candado del cliente y un otorgamiento puede retenerlo hasta 15 s mientras espera el de su venta. Con los
  // 5 s por defecto, la reversión de un reembolso se vencía y el sello de la venta devuelta quedaba vivo (el reembolso sólo lo
  // registra). Y si aun así se vence (P2028), hasta 2 reintentos (100 ms, 300 ms): es idempotente porque cada intento vuelve a
  // tomar el candado y relee las reversas de la venta antes de escribir, con el índice único de la reversa detrás.
  const revertirConReintento = () =>
    reintentarSiSeVence(venueId, orderId, () =>
      withDeadlockRetry(revertirDentroDelCandado, { etiqueta: 'reverseStampForOrder', ...PRESUPUESTO_DEL_SELLO }),
    )
  // R65 b: «revertida» sale en el RETORNO del cuerpo; un intento abortado (40P01 o P2028) no deja nada a medias.
  const revertirDentroDelCandado = async (tx: TxConReintento): Promise<boolean> => {
    // 🔴 PRIMERA sentencia: el candado (negocio, cliente). Un otorgamiento del mismo cliente que esté completando la cartilla
    // termina antes de que aquí se lea nada.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${customerId}))`

    // Otra reversión de esta venta pudo hacer commit mientras ésta esperaba el candado.
    const reversasDentro = await tx.stampEvent.count({ where: { venueId, orderId, type: StampEventType.REVERSAL } })
    if (reversasDentro > 0) return false

    const card = await tx.stampCard.findUnique({
      where: { id: otorgado.stampCardId },
      select: { id: true, venueId: true, customerId: true, cycle: true, stampsEarned: true, completedAt: true },
    })
    if (!card) return false

    // 🔴 ¿De qué cartilla salen los sellos? (D3, 21-oct, founder: «A, como Square»). UNA sola regla para todos los estados
    // (varias llenas, varias abiertas por D2, canjes de por medio): de cartillas que TENGAN sellos, en este orden:
    //   1. abiertas (la de la venta, luego la más nueva): no tocan ningún premio — «consume primero el avance nuevo»;
    //   2. llenas con premio SIN cobrar (la de la venta, luego la más nueva): el premio se cancela y la cartilla se reabre;
    //   3. llenas con premio ya cobrado: sólo pierden sellos; lo cobrado no se quita.
    // Nunca se quita más de lo que una cartilla tiene, así que nunca hay negativos, y ningún premio pendiente queda sin sus sellos.
    // Antes eran reglas sueltas por caso y cada combinación nueva dejaba una cartilla en −1 (Codex D2-r1, D3-r1).
    // Un nivel a la vez y en el orden de la regla, sin traer listas (un tope podía dejar fuera la cartilla correcta, Codex
    // D3-r2 #2): primero la de la venta si está en ese nivel, luego la más nueva del nivel.
    // Promos (ruling 1, Codex r1 del plan): una venta de N sellos vacía NIVEL POR NIVEL, quitando de cada cartilla lo que tenga
    // hasta completar N; sólo pasa al siguiente nivel cuando el actual ya no tiene sellos. Así dos abiertas con 1 sello cubren una
    // devolución de 2 sin cancelar un premio pendiente. Con N = 1 es exactamente la regla de siempre.
    const delCliente = { venueId, customerId: card.customerId, stampsEarned: { gte: 1 } }
    const niveles: Prisma.StampCardWhereInput[] = [
      { ...delCliente, completedAt: null },
      { ...delCliente, completedAt: { not: null }, rewards: { some: { status: StampRewardStatus.PENDING } } },
      { ...delCliente, completedAt: { not: null }, rewards: { none: { status: StampRewardStatus.PENDING } } },
      // Red de seguridad (Codex D3-r5 #1): entre una consulta y otra, quitar un canje puede pasar un premio de cobrado a por
      // cobrar y la cartilla «cambia de nivel» sin aparecer en ninguno. Cualquiera con sellos; la relectura bajo la fila
      // del premio decide qué hacer con él.
      delCliente,
    ]
    let restante = cantidad
    let parte = 0
    for (const donde of niveles) {
      while (restante > 0) {
        const elegida =
          (await tx.stampCard.findFirst({ where: { ...donde, id: card.id }, select: { id: true, stampsEarned: true } })) ??
          (await tx.stampCard.findFirst({ where: donde, orderBy: { cycle: 'desc' }, select: { id: true, stampsEarned: true } }))
        if (!elegida) break
        // Lo que tenga, hasta lo que falta: la cartilla queda en 0 (no se vuelve a elegir) o ya no falta nada.
        const quita = Math.min(elegida.stampsEarned, restante)
        restante -= quita

        // Negativo: el libro se lee sumando, así que el asiento contrario resta. Uno por cartilla tocada, con su parte.
        await tx.stampEvent.create({
          data: {
            stampCardId: elegida.id,
            venueId,
            orderId,
            type: StampEventType.REVERSAL,
            part: parte++,
            quantity: -quita,
            createdById: options.staffVenueId,
          },
        })

        // El contador vive en la MISMA transacción que su asiento. Si se separan, un
        // fallo a medias deja al cliente viendo un avance que el libro no respalda.
        // 🔴 Candado de FILA del PREMIO de esa cartilla (si tiene), DESPUÉS del asiento, y se vuelve a mirar (Codex D3-r2 #1,
        // r3 y r4): quitar un premio canjeado de una cuenta toma esa misma fila para decidir si vuelve por cobrar, así que las
        // dos van en fila. No es la fila de la CARTILLA (el asiento ya la toca por su llave foránea y cerraba un círculo con la
        // liquidación de cuentas) ni el candado del cliente (r3). La cartilla se resta DESPUÉS, con el premio ya decidido.
        await tx.$queryRaw`SELECT id FROM "StampReward" WHERE "stampCardId" = ${elegida.id} FOR UPDATE`
        const ahora = await tx.stampCard.findUnique({
          where: { id: elegida.id },
          select: { completedAt: true, rewards: { select: { status: true }, take: 1 } },
        })
        let reabrir = false
        if (ahora?.completedAt && ahora.rewards?.[0]?.status === StampRewardStatus.PENDING) {
          const cancelled = await tx.stampReward.updateMany({
            where: { stampCardId: elegida.id, status: StampRewardStatus.PENDING },
            data: { status: StampRewardStatus.CANCELLED },
          })
          reabrir = cancelled.count > 0
        }
        await tx.stampCard.update({
          where: { id: elegida.id },
          data: { stampsEarned: { decrement: quita }, ...(reabrir ? { completedAt: null } : {}) },
        })
      }
    }

    if (parte === 0) {
      // Ninguna cartilla tiene sellos: datos de antes de esta regla. Queda el asiento (la venta no se revierte dos veces)
      // pero resta 0 porque no restó nada: así el libro (suma de asientos) sigue igual al contador. Nunca negativos.
      logger.warn('Reversa de sello sin cartilla con saldo: no se resta', { venueId, orderId, stampCardId: card.id })
      await tx.stampEvent.create({
        data: { stampCardId: card.id, venueId, orderId, type: StampEventType.REVERSAL, quantity: 0, createdById: options.staffVenueId },
      })
      return true
    }
    // Se quitó parte, no todo: lo demás ya no estaba en ninguna cartilla. Igual que arriba: nunca negativos.
    if (restante > 0) logger.warn('Reversa de sello incompleta: las cartillas no tenían todos los sellos', { venueId, orderId, restante })
    await encolarAvisoDeTarjetaEnTx(tx, { venueId, customerId, motivo: 'SELLO_REVERTIDO' })
    return true
  }
  let revertida: boolean
  try {
    revertida = await revertirConReintento()
  } catch (error: unknown) {
    // SÓLO el índice de la reversa de esta venta es «otra reversa ganó»; cualquier otro P2002 sube (como en `grantStamp`).
    if (esChoqueDelUnicoDeLaOrden(error, UNICA_REVERSA_DE_LA_ORDEN)) {
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

// ── Sellos a mano (23-oct-2026) ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * La VERSIÓN de una cartilla: cuántos asientos tiene; 0 si no hay cartilla. Los asientos nunca se borran ni se editan, así que
 * sólo sube: es lo que el ajuste a mano compara además del id y del número.
 */
export async function contarVersionDeCartilla(stampCardId: string | null, db: Prisma.TransactionClient = prisma): Promise<number> {
  if (!stampCardId) return 0
  return db.stampEvent.count({ where: { stampCardId } })
}

export interface AdjustStampsInput {
  /** El TOTAL que debe quedar en la cartilla abierta (como habla el negocio al migrar un cartón), no un +/−. */
  stampsEarned: number
  /** Lo que vio quien pide el ajuste: la cartilla (null si no había), su número, su versión y su META. Es el CAS. */
  expectedStampCardId: string | null
  expectedStampsEarned: number
  expectedVersion: number
  /** La meta que vio: la de la cartilla, o la de la config si no había cartilla (F1: sin ella, «null/0/0» no ve un cambio de meta). */
  expectedStampsRequired: number
  reason: string
  /** 🔴 StaffVenue.id, la FK del asiento. Opcional: un dueño de la organización puede no tener fila en StaffVenue. */
  staffVenueId?: string
  /** Staff.id: el autor en la bitácora (siempre lo hay, aunque no haya StaffVenue). */
  actorStaffId?: string
}

export interface AdjustStampsResult {
  stampCardId: string
  from: number
  to: number
  delta: number
  completed: boolean
  rewardId?: string
  stampsRequired: number
}

/**
 * Ajuste a mano de los sellos de un cliente: migrar su cartón de papel o corregir un error.
 *
 * 🔴 DINERO. Un sello de más es producto regalado, y un ajuste aplicado dos veces (doble clic, reintento del panel) puede ser
 * un premio regalado. Por eso:
 * - Se escribe el TOTAL y el servidor calcula la diferencia: un asiento ADJUST con signo, motivo y autor. Nunca se borra nada.
 * - CAS sobre la cartilla, su número y su VERSIÓN, DENTRO del candado del cliente. Sólo el número no basta (Codex r1 #1): un
 *   ajuste que completa deja otra cartilla en 0 y el reintento volvería a cumplir «0». Id y número tampoco (Codex r2 #1): una
 *   devolución puede reabrir la MISMA cartilla al mismo número. La versión sólo sube: ninguna secuencia revive una petición vieja.
 *   Y la META (F1, 24-oct): sin cartilla, «null/0/0» coincide aunque otro admin haya cambiado la meta de la config.
 * - La meta es la CONGELADA de la cartilla, no la de la config. Llegar a ella completa igual que un sello (`completarCartilla`).
 * - Sin correo del primer sello: es una migración, no una visita.
 */
export async function adjustStamps(venueId: string, customerId: string, input: AdjustStampsInput): Promise<AdjustStampsResult> {
  const reason = input.reason.trim()
  if (reason.length < 5 || reason.length > 500) throw new BadRequestError('El motivo debe tener de 5 a 500 caracteres', 'INVALID_REASON')

  const customer = await prisma.customer.findFirst({ where: { id: customerId, venueId }, select: { id: true } })
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  const resultado = await withDeadlockRetry(
    async (tx): Promise<AdjustStampsResult> => {
      // 🔴 PRIMERA sentencia: el MISMO candado (negocio, cliente) que `grantStamp` y la reversa. Una venta o una devolución del
      // cliente termina antes de que aquí se lea la cartilla. No hay venta, así que no hay segundo candado.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${customerId}))`

      // F3: la config se lee DESPUÉS del candado, y esa UNA lectura compara y abre la cartilla. Sin `FOR SHARE` a propósito: con
      // una sola lectura, cualquier orden contra un cambio de config de otro admin es válido (el ajuste fue antes, con lo que vio
      // el gerente, o después, y da 409).
      const config = await tx.loyaltyConfig.findUnique({ where: { venueId } })
      if (!config || !config.active || !config.stampsEnabled)
        throw new ConflictError('El programa de sellos está apagado', 'STAMPS_DISABLED')

      // La abierta MÁS VIEJA: la que llena `grantStamp` y la que muestra `getStampCardStatus` (D2).
      let card = await tx.stampCard.findFirst({
        where: { venueId, customerId, completedAt: null },
        orderBy: { cycle: 'asc' },
        select: { id: true, cycle: true, stampsEarned: true, stampsRequired: true },
      })
      const version = await contarVersionDeCartilla(card?.id ?? null, tx)
      // La meta va en la MISMA comparación, antes de abrir la cartilla y antes de validar el total (F1).
      const stampsRequired = card?.stampsRequired ?? config.stampsRequired
      if (
        (card?.id ?? null) !== input.expectedStampCardId ||
        (card?.stampsEarned ?? 0) !== input.expectedStampsEarned ||
        version !== input.expectedVersion ||
        stampsRequired !== input.expectedStampsRequired
      ) {
        // La foto COMPLETA de hoy: el cliente la reemplaza entera y sólo un acto nuevo del usuario la usa.
        throw new ConflictError('Los sellos de este cliente cambiaron mientras tanto', 'STAMPS_CHANGED', {
          stampCardId: card?.id ?? null,
          stampsEarned: card?.stampsEarned ?? 0,
          stampsRequired,
          version,
          rewardLabel: config.stampRewardLabel,
        })
      }
      // Sin cartilla (y se esperaba ninguna): se abre igual que con el primer sello. Si el ajuste rebota abajo, se revierte.
      if (!card) card = await abrirCartilla(tx, venueId, customerId, config.stampsRequired)

      const from = card.stampsEarned
      const to = input.stampsEarned
      if (to < 0 || to > card.stampsRequired) throw new BadRequestError('No puede pasar de la meta de la tarjeta', 'ABOVE_GOAL')
      if (to === from) throw new BadRequestError('No hay cambio', 'NO_CHANGE')
      const delta = to - from

      await tx.stampEvent.create({
        data: {
          stampCardId: card.id,
          venueId,
          orderId: null,
          type: StampEventType.ADJUST,
          quantity: delta,
          reason,
          createdById: input.staffVenueId ?? null,
        },
      })
      // El contador en la MISMA transacción que su asiento. Valor absoluto: dentro del candado, todo el que lo mueve está formado.
      await tx.stampCard.update({ where: { id: card.id }, data: { stampsEarned: to } })

      await encolarAvisoDeTarjetaEnTx(tx, { venueId, customerId, motivo: 'AJUSTE' })
      const base = { stampCardId: card.id, from, to, delta, stampsRequired: card.stampsRequired }
      if (to < card.stampsRequired) return { ...base, completed: false }
      const { rewardId } = await completarCartilla(tx, card, config, venueId, customerId)
      return { ...base, completed: true, rewardId }
    },
    { etiqueta: 'adjustStamps', ...PRESUPUESTO_DEL_SELLO },
  )

  // La tarjeta del teléfono refleja el ajuste, como con un sello (en segundo plano; nunca lanza).
  enSegundoPlano('aviso', notifyCustomerPassUpdated(venueId, customerId))
  // 🔴 Un ajuste a mano es justo lo que un dueño audita: quién, cuánto y por qué. Fire-and-forget: no deshace el ajuste.
  const { stampCardId, from, to, delta, completed, rewardId } = resultado
  void logAction({
    staffId: input.actorStaffId,
    venueId,
    action: 'STAMPS_ADJUSTED',
    entity: 'Customer',
    entityId: customerId,
    data: { stampCardId, from, to, delta, reason, completed, rewardId },
  })

  return resultado
}
