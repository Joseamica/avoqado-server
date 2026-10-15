import { LoyaltyTransactionType, PaymentType, Prisma, StampEventType, TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getStampCardStatus, reverseStampForOrder } from '@/services/wallet/stampLedger.service'
import { venueEndOfDay, venueStartOfDay } from '@/utils/datetime'
import { awardLoyaltyForPaidOrder, type AwardLoyaltyForPaidOrderArgs, type AwardLoyaltyForPaidOrderResult } from './loyaltyOnPaidOrder'

/**
 * Sello TARDÍO: el cliente se liga a una venta que YA se cobró (spec 2026-10-14 §3.1).
 *
 * 🔴 Testarudo, 14-oct-2026: el barista agrega al cliente en «Cobro exitoso», después de pagar. La lealtad corre UNA vez al
 * saldarse la venta (`awardLoyaltyForPaidOrder`); sin cliente marca `loyaltyProcessedAt` y nunca vuelve. 3 de 5 ventas con
 * cliente perdieron su sello y nadie se enteró. Ahora TODO camino que liga un cliente a una venta pagada pasa por aquí.
 *
 * Reglas (cerradas por el founder): 24 h desde que se saldó; un sello por venta (índice único); sólo al primario; el tope
 * diario del negocio cuenta el día en que se da; sólo ventas saldadas. Fuera de eso el cliente SÍ queda ligado (recibo,
 * CFDI) y la respuesta dice por qué no sumó.
 *
 * 🔴 NUNCA lanza: corre después de que la liga ya se guardó. Un fallo aquí devuelve `null` y queda en el log. Y no se pierde:
 * la misma transacción que ligó al cliente reabrió el trabajo durable (`reabrirLealtadSiAplica`), así que el reconciliador de
 * siempre (`loyalty-reconciliation.job.ts`) termina lo que este intento no pudo (auditoría A #1).
 */

export const LATE_STAMP_WINDOW_MS = 24 * 60 * 60 * 1000

export type SaleStampReason = 'NOT_PAID' | 'WINDOW_EXPIRED' | 'OTHER_CUSTOMER' | 'DAILY_LIMIT' | 'PENDING' | 'ERROR'

/** Contrato con las apps (Android/iOS): campo OPCIONAL `loyalty`. */
export interface SaleStampOutcome {
  /** Programa de sellos activo para el venue; false ⇒ la app NO pinta nada. */
  stampsEnabled: boolean
  /** Esta venta ya le sumó su sello a ESTE cliente (ahora o antes). */
  stamped: boolean
  /** null cuando stamped=true o stampsEnabled=false. */
  reason: SaleStampReason | null
  /** Cartilla ABIERTA después del sello (si completó, la nueva arranca en 0). */
  stampsEarned: number
  stampsRequired: number
  /** Tiene al menos un premio PENDING por cobrar. */
  rewardReady: boolean
}

/** Lo que la regla concluye antes de traducirlo al contrato. `OPEN` = cuenta aún no saldada: el sello se decide al saldarla. */
export type SaleStampDecision = 'OPEN' | 'NOT_PAID' | 'STAMPED' | 'OTHER_CUSTOMER' | 'NO_ANCHOR' | 'WINDOW_EXPIRED' | 'ELIGIBLE'

export interface SaleStampSnapshot {
  /** El cliente por el que se pregunta. */
  customerId: string
  status: string
  paymentStatus: string
  /** Hay al menos un `Payment` REFUND COMPLETED (contado EXACTO, auditoría A #2). Un reembolso de la TPV deja la orden PAID. */
  reembolsada: boolean
  hasReversal: boolean
  primaryCustomerId: string | null
  /** Dueño de la cartilla donde cayó el EARN de esta venta, si lo hay. */
  stampOwnerCustomerId: string | null
  /** Clientes que ya recibieron PUNTOS (LoyaltyTransaction EARN) por esta venta. */
  pointsOwnerCustomerIds: string[]
  /** Cuándo se saldó: `loyaltyEligibleAt` o el último cobro completado. */
  settledAt: Date | null
}

const SIN_VENTA = new Set(['CANCELLED', 'DELETED'])

/**
 * La regla, pura. El orden de las preguntas importa: lo devuelto/cancelado gana a todo; lo de otro cliente gana al plazo.
 * `ignorarPlazo` existe SÓLO para la reparación de datos (S9, spec §3.6): ni el plazo de 24 h ni el ancla cuentan; todo lo
 * demás (saldada, no cancelada, sin reembolso, sin otro dueño) sí.
 */
export function decideSaleStamp(s: SaleStampSnapshot, nowMs: number, opciones: { ignorarPlazo?: boolean } = {}): SaleStampDecision {
  // 🔴 Un reembolso de la TPV deja la orden en PAID: se mira el dinero devuelto y la reversa del sello, no sólo el estado.
  if (SIN_VENTA.has(s.status) || s.paymentStatus === 'REFUNDED' || s.reembolsada || s.hasReversal) return 'NOT_PAID'
  if (s.paymentStatus !== 'PAID') return 'OPEN'
  if (s.stampOwnerCustomerId === s.customerId) return 'STAMPED'
  if (s.stampOwnerCustomerId) return 'OTHER_CUSTOMER'
  if (s.primaryCustomerId && s.primaryCustomerId !== s.customerId) return 'OTHER_CUSTOMER'
  // Venta vieja con `Order.customerId` heredado que ya cobró puntos: sin esto, el agregado tarde cobraría puntos otra vez
  // (la idempotencia de `earnPoints` es por cliente+orden, no por orden).
  if (s.pointsOwnerCustomerIds.some(id => id !== s.customerId)) return 'OTHER_CUSTOMER'
  if (opciones.ignorarPlazo) return 'ELIGIBLE'
  if (!s.settledAt) return 'NO_ANCHOR'
  if (nowMs - s.settledAt.getTime() > LATE_STAMP_WINDOW_MS) return 'WINDOW_EXPIRED'
  return 'ELIGIBLE'
}

/**
 * ¿Hay que correr —o COMPLETAR— la lealtad de esta venta para este cliente? Es `decideSaleStamp` SIN contar el sello propio.
 *
 * 🔴 Auditoría A #1: `awardLoyaltyForPaidOrder` sella ANTES de acreditar (`earnPoints` → `grantStamp`). Si el proceso se cae
 * entre uno y otro, la venta queda con su sello y sin puntos. Saltarse la llamada «porque ya está sellada» dejaba esos puntos
 * perdidos para siempre; llamarla otra vez es seguro (idempotente por orden) y completa lo que falte.
 */
export function esElegibleParaLealtad(s: SaleStampSnapshot, nowMs: number, opciones: { ignorarPlazo?: boolean } = {}): boolean {
  const sinSelloPropio = s.stampOwnerCustomerId === s.customerId ? { ...s, stampOwnerCustomerId: null } : s
  return decideSaleStamp(sinSelloPropio, nowMs, opciones) === 'ELIGIBLE'
}

const VENTA_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  total: true,
  tipAmount: true,
  customerId: true,
  loyaltyEligibleAt: true,
  loyaltyProcessedAt: true,
  orderCustomers: { where: { isPrimary: true }, select: { customerId: true }, take: 1 },
  // Sólo el ÚLTIMO cobro completado que no es reembolso: es el ancla del plazo cuando `loyaltyEligibleAt` es null. Los
  // reembolsos se CUENTAN aparte y exactos (`leerVenta`): leerlos de una lista con tope escondía el que quedara fuera.
  payments: {
    // 🔴 `Payment.type` es OPCIONAL: en SQL un `type <> 'REFUND'` deja fuera las filas con NULL, y una venta cobrada con
    // una de ésas se quedaría sin ancla («no se puede medir el plazo») aunque sí se cobró. Mismo patrón que
    // `terminal-payment.service.ts`.
    where: { status: TransactionStatus.COMPLETED, OR: [{ type: null }, { type: { not: PaymentType.REFUND } }] },
    select: { createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
  },
  stampEvents: {
    where: { type: { in: [StampEventType.EARN, StampEventType.REVERSAL] } },
    select: { type: true, stampCard: { select: { customerId: true } } },
    take: 10,
  },
  loyaltyTransactions: { where: { type: LoyaltyTransactionType.EARN }, select: { customerId: true }, take: 10 },
} satisfies Prisma.OrderSelect

type Venta = Prisma.OrderGetPayload<{ select: typeof VENTA_SELECT }> & { reembolsada: boolean }

/** El cliente global o el de una transacción (la reapertura lee DENTRO de la transacción de la liga). */
type LectorDeVenta = Pick<Prisma.TransactionClient, 'order' | 'payment'>

interface Programa {
  stampsEnabled: boolean
  maxStampsPerDay: number
}

/** 🔴 Reembolso EXACTO (auditoría A #2): un `count` por la orden, sin tope de lista que esconda nada. */
async function contarReembolsos(db: LectorDeVenta, venueId: string, orderId: string): Promise<number> {
  return db.payment.count({ where: { orderId, venueId, type: PaymentType.REFUND, status: TransactionStatus.COMPLETED } })
}

async function leerVenta(db: LectorDeVenta, venueId: string, orderId: string): Promise<Venta | null> {
  const venta = await db.order.findFirst({ where: { id: orderId, venueId }, select: VENTA_SELECT })
  if (!venta) return null
  return { ...venta, reembolsada: (await contarReembolsos(db, venueId, orderId)) > 0 }
}

function fotoPara(venta: Venta, customerId: string): SaleStampSnapshot {
  const earn = venta.stampEvents.find(e => e.type === StampEventType.EARN)
  return {
    customerId,
    status: venta.status,
    paymentStatus: venta.paymentStatus,
    reembolsada: venta.reembolsada,
    hasReversal: venta.stampEvents.some(e => e.type === StampEventType.REVERSAL),
    primaryCustomerId: venta.orderCustomers[0]?.customerId ?? null,
    stampOwnerCustomerId: earn?.stampCard.customerId ?? null,
    pointsOwnerCustomerIds: venta.loyaltyTransactions.map(t => t.customerId),
    settledAt: venta.loyaltyEligibleAt ?? venta.payments[0]?.createdAt ?? null,
  }
}

/** La foto de la regla para una venta y un cliente, leída con `db`. La usa la reparación de datos (S9). */
export async function fotoDeLaVenta(
  db: LectorDeVenta,
  args: { venueId: string; orderId: string; customerId: string },
): Promise<SaleStampSnapshot | null> {
  const venta = await leerVenta(db, args.venueId, args.orderId)
  return venta ? fotoPara(venta, args.customerId) : null
}

/**
 * 🔴 Reabre el trabajo DURABLE de lealtad de la venta (auditoría A #1). Se llama DENTRO de la transacción que liga al cliente
 * (S4: `attachCustomerToOrder`; S5: los dos «agregar cliente» de la TPV).
 *
 * Sin esto: la venta se cobró sin cliente y ya tiene `loyaltyProcessedAt`; si el intento inmediato fallaba, el reconciliador
 * (que sólo mira `loyaltyProcessedAt: null`) nunca la rescataba y el sello se perdía otra vez, en silencio.
 *
 * Sólo si la venta es elegible (saldada, ≤ 24 h, sin reembolso, sin otro dueño; el sello propio no cuenta) y ESTE cliente quedó
 * como primario. Si `loyaltyEligibleAt` era null, se pone a la hora del último cobro —la MISMA ancla del plazo— para que el
 * reconciliador la vea. `loyaltyAttempts` no se toca (ruling 1). Devuelve true si reabrió.
 *
 * Poner `loyaltyProcessingAt` en null también invalida el reclamo de una vuelta del reconciliador que esté en curso: esa vuelta
 * ya no puede cerrar la venta con lo que leyó antes de la liga (B1, ronda B; el cierre del reconciliador exige SU reclamo).
 */
export async function reabrirLealtadSiAplica(
  tx: Prisma.TransactionClient,
  args: { venueId: string; orderId: string; customerId: string },
  nowMs: number = Date.now(),
): Promise<boolean> {
  const venta = await leerVenta(tx, args.venueId, args.orderId)
  if (!venta) return false
  if (venta.orderCustomers[0]?.customerId !== args.customerId) return false
  const foto = fotoPara(venta, args.customerId)
  if (!esElegibleParaLealtad(foto, nowMs)) return false
  const reabierta = await tx.order.updateMany({
    where: { id: args.orderId, venueId: args.venueId },
    data: {
      loyaltyProcessedAt: null,
      loyaltyProcessingAt: null,
      loyaltyLastError: null,
      ...(venta.loyaltyEligibleAt ? {} : { loyaltyEligibleAt: foto.settledAt }),
    },
  })
  return reabierta.count === 1
}

export interface ResultadoDeLealtadRespetandoReembolsos extends AwardLoyaltyForPaidOrderResult {
  /** La venta ya tenía —o recibió MIENTRAS se otorgaba— un reembolso COMPLETED: no se otorgó, o el sello se revirtió. */
  reembolsada: boolean
}

/**
 * 🔴 B2 (auditoría de Codex, ronda B, 14-oct-2026): el ÚNICO camino para otorgar la lealtad de una venta FUERA del cobro.
 * Lo usan la liga tardía (`awardLoyaltyForLateCustomer`), el reconciliador (`loyalty-reconciliation.job.ts`) y la
 * reparación de datos (S9, al APLICAR cada venta).
 *
 * El caso que lo pidió: el intento inmediato de la liga falla ANTES del sello; se devuelve el pago y la reversa del reembolso
 * no encuentra sello que revertir; después, el reconciliador llamaba directo a `awardLoyaltyForPaidOrder` —que no mira
 * reembolsos—, creaba el sello y daba la venta por terminada. Un cliente sumaba su sello por un café que le devolvieron.
 *
 *   1. Si la venta YA tiene un reembolso COMPLETED (conteo exacto), no otorga nada y la deja cerrada como procesada: el
 *      reconciliador no vuelve a tomar una venta devuelta.
 *   2. Si no, corre la lealtad de siempre (idempotente).
 *   3. Vuelve a contar: si el reembolso entró MIENTRAS se otorgaba, revierte el sello (`reverseStampForOrder`, idempotente:
 *      si la reversa del reembolso también lo hace, la segunda no hace nada).
 *
 * Sin candado de reembolso (el motor escribe en transacciones propias) y sin reiniciar la ventana de 24 h. Un fallo al
 * revertir SUBE: la liga y el reconciliador ya registran sus fallos; tragárselo dejaría el sello vivo sin que nadie se
 * entere. `awardLoyaltyForPaidOrder` en sí nunca lanza.
 */
export async function otorgarLealtadRespetandoReembolsos(
  args: AwardLoyaltyForPaidOrderArgs,
): Promise<ResultadoDeLealtadRespetandoReembolsos> {
  const { venueId, orderId } = args
  if ((await contarReembolsos(prisma, venueId, orderId)) > 0) {
    await prisma.order.updateMany({
      where: { id: orderId, venueId, loyaltyEligibleAt: { not: null }, loyaltyProcessedAt: null },
      data: { loyaltyProcessedAt: new Date(), loyaltyProcessingAt: null, loyaltyLastError: null },
    })
    logger.info('[LEALTAD] venta con reembolso: no se otorga lealtad y queda cerrada', { venueId, orderId })
    return { complete: true, errors: [], reembolsada: true }
  }

  const resultado = await awardLoyaltyForPaidOrder(args)

  if ((await contarReembolsos(prisma, venueId, orderId)) > 0) {
    // 🔴 Auditoría A #2: el reembolso entró MIENTRAS se otorgaba. Si su reversa corrió antes de que el sello existiera, no
    // encontró nada que revertir; este sello quedaría vivo sobre una venta devuelta.
    logger.warn('[LEALTAD] la venta se reembolsó mientras se otorgaba su lealtad: se revierte el sello', { venueId, orderId })
    await reverseStampForOrder(venueId, orderId)
    return { ...resultado, reembolsada: true }
  }
  return { ...resultado, reembolsada: false }
}

/** Los tres candados que ya exigen `earnPoints` + `grantStamp`: plan, programa activo y sellos prendidos. */
async function leerPrograma(venueId: string): Promise<Programa> {
  const [config, conPlan] = await Promise.all([
    prisma.loyaltyConfig.findUnique({ where: { venueId }, select: { active: true, stampsEnabled: true, maxStampsPerDay: true } }),
    venueHasFeatureAccess(venueId, 'LOYALTY_PROGRAM'),
  ])
  return { stampsEnabled: Boolean(conPlan && config?.active && config?.stampsEnabled), maxStampsPerDay: config?.maxStampsPerDay ?? 0 }
}

/** El MISMO conteo que `grantStamp`: EARN del cliente en el día del VENUE. Tope 0 = sin tope. */
async function topeDelDiaAlcanzado(venueId: string, customerId: string, programa: Programa, nowMs: number): Promise<boolean> {
  if (!programa.stampsEnabled || programa.maxStampsPerDay <= 0) return false
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone ?? 'America/Mexico_City'
  const ref = new Date(nowMs)
  const hoy = await prisma.stampEvent.count({
    where: {
      venueId,
      type: StampEventType.EARN,
      stampCard: { customerId },
      createdAt: { gte: venueStartOfDay(tz, ref), lte: venueEndOfDay(tz, ref) },
    },
  })
  return hoy >= programa.maxStampsPerDay
}

async function motivo(
  decision: SaleStampDecision,
  venueId: string,
  customerId: string,
  programa: Programa,
  nowMs: number,
): Promise<SaleStampReason | null> {
  switch (decision) {
    case 'STAMPED':
      return null
    case 'OPEN':
    case 'NOT_PAID':
      return 'NOT_PAID'
    case 'OTHER_CUSTOMER':
      return 'OTHER_CUSTOMER'
    case 'WINDOW_EXPIRED':
      return 'WINDOW_EXPIRED'
    case 'NO_ANCHOR':
      return 'ERROR'
    case 'ELIGIBLE':
      return (await topeDelDiaAlcanzado(venueId, customerId, programa, nowMs)) ? 'DAILY_LIMIT' : 'ERROR'
  }
}

async function armarResultado(
  venueId: string,
  customerId: string,
  programa: Programa,
  stamped: boolean,
  reason: SaleStampReason | null,
): Promise<SaleStampOutcome> {
  const tarjeta = await getStampCardStatus(venueId, customerId)
  return {
    stampsEnabled: programa.stampsEnabled,
    stamped,
    reason: programa.stampsEnabled && !stamped ? reason : null,
    stampsEarned: tarjeta.stampsEarned,
    stampsRequired: tarjeta.stampsRequired,
    rewardReady: tarjeta.pendingRewards > 0,
  }
}

const minutosDesde = (settledAt: Date | null, nowMs: number): number | null =>
  settledAt ? Math.floor((nowMs - settledAt.getTime()) / 60_000) : null

async function describir(venueId: string, customerId: string, venta: Venta, programa: Programa, nowMs: number): Promise<SaleStampOutcome> {
  const decision = decideSaleStamp(fotoPara(venta, customerId), nowMs)
  const stamped = decision === 'STAMPED'
  return armarResultado(venueId, customerId, programa, stamped, await motivo(decision, venueId, customerId, programa, nowMs))
}

/** Sólo LEE: describe el sello de una venta para un cliente. No otorga nada. */
export async function describeSaleStamp(args: { venueId: string; orderId: string; customerId: string }): Promise<SaleStampOutcome> {
  const nowMs = Date.now()
  const [venta, programa] = await Promise.all([leerVenta(prisma, args.venueId, args.orderId), leerPrograma(args.venueId)])
  if (!venta) return armarResultado(args.venueId, args.customerId, programa, false, 'ERROR')
  return describir(args.venueId, args.customerId, venta, programa, nowMs)
}

/**
 * Después de ligar al cliente: si la venta está saldada, dentro de 24 h y el cliente es (o será) su primario, corre la
 * lealtad completa (visita, puntos y sello, todo idempotente) — también si el sello de este cliente ya existe, para completar
 * lo que falte. Siempre por `otorgarLealtadRespetandoReembolsos` (B2). `null` = venta abierta o inexistente o falla: la app
 * no pinta nada.
 */
export async function awardLoyaltyForLateCustomer(args: {
  venueId: string
  orderId: string
  customerId: string
  staffId?: string | null
}): Promise<SaleStampOutcome | null> {
  const { venueId, orderId, customerId } = args
  try {
    const nowMs = Date.now()
    const [venta, programa] = await Promise.all([leerVenta(prisma, venueId, orderId), leerPrograma(venueId)])
    if (!venta) return null
    const foto = fotoPara(venta, customerId)
    const antes = decideSaleStamp(foto, nowMs)
    // Cuenta aún sin saldar: quien la salde corre la lealtad, y este cliente ya es su primario. Decir «no suma» sería falso.
    if (antes === 'OPEN') return null

    // Tipo explícito: `antes` ya viene sin 'OPEN' y una relectura puede devolver cualquier decisión.
    let decision: SaleStampDecision = antes
    // 🔴 SIEMPRE que sea elegible, aunque el sello de ESTE cliente ya exista (auditoría A #1): la llamada es idempotente y
    // completa los puntos o la visita que una caída entre el sello y los puntos hubiera dejado pendientes.
    if (esElegibleParaLealtad(foto, nowMs)) {
      // Base: venta y cargos sin propina — la misma que el cobro y el reconciliador (la propina es del personal).
      const resultado = await otorgarLealtadRespetandoReembolsos({
        venueId,
        orderId,
        orderTotal: Math.max(0, Number(venta.total) - Number(venta.tipAmount ?? 0)),
        staffId: args.staffId ?? null,
        legacyCustomer: null,
      })
      if (!resultado.complete) {
        // No se pierde: la liga reabrió la venta en su transacción y el reconciliador la reintenta.
        logger.warn('[LEALTAD TARDÍA] la lealtad de la venta quedó incompleta', { venueId, orderId, customerId, errors: resultado.errors })
      }
      if (resultado.reembolsada) {
        // El reembolso entró entre la lectura y el otorgamiento, o mientras se otorgaba (el envoltorio ya revirtió el sello).
        logger.warn('[LEALTAD TARDÍA] la venta se reembolsó mientras se ligaba: no suma sello', { venueId, orderId, customerId })
        decision = 'NOT_PAID'
      } else {
        const despues = await leerVenta(prisma, venueId, orderId)
        decision = despues ? decideSaleStamp(fotoPara(despues, customerId), nowMs) : antes
      }
    }
    if (decision === 'NO_ANCHOR') {
      logger.warn('[LEALTAD TARDÍA] venta pagada sin hora de cobro: no se puede medir el plazo, no se sella', { venueId, orderId })
    }

    const stamped = decision === 'STAMPED'
    const outcome = await armarResultado(
      venueId,
      customerId,
      programa,
      stamped,
      await motivo(decision, venueId, customerId, programa, nowMs),
    )

    // Auditoría (spec §3.1): quién ligó a quién a una venta YA cobrada, y si sumó. No en una re-liga de una venta que ya
    // tenía su sello para este cliente: eso es un doble toque, no un hecho nuevo.
    if (antes !== 'STAMPED' && (venta.paymentStatus === 'PAID' || venta.paymentStatus === 'REFUNDED')) {
      void logAction({
        action: 'CUSTOMER_ATTACHED_TO_PAID_ORDER',
        entity: 'Order',
        entityId: orderId,
        staffId: args.staffId ?? null,
        venueId,
        data: {
          customerId,
          orderNumber: venta.orderNumber,
          // La decisión ANTES de otorgar (ELIGIBLE, WINDOW_EXPIRED…): con `stamped` dice qué se pidió y qué pasó.
          decision: antes,
          stamped: outcome.stamped,
          reason: outcome.reason,
          minutosDesdeElCobro: minutosDesde(foto.settledAt, nowMs),
        },
      })
    }
    return outcome
  } catch (error) {
    logger.error('[LEALTAD TARDÍA] falló; el cliente ya quedó ligado a la venta', {
      venueId,
      orderId,
      customerId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * GET de la app tras un cobro que YA traía cliente desde el carrito. `null` si la venta no tiene cliente o sigue abierta.
 * `PENDING` si está saldada y la lealtad aún no termina (la app reintenta una vez a los ~2 s).
 */
export async function describeSaleStampForPayment(args: { venueId: string; paymentId: string }): Promise<SaleStampOutcome | null> {
  const pago = await prisma.payment.findFirst({ where: { id: args.paymentId, venueId: args.venueId }, select: { orderId: true } })
  if (!pago) throw new NotFoundError('Pago no encontrado')
  const nowMs = Date.now()
  const [venta, programa] = await Promise.all([leerVenta(prisma, args.venueId, pago.orderId), leerPrograma(args.venueId)])
  if (!venta) throw new NotFoundError('Pago no encontrado')
  const customerId = venta.orderCustomers[0]?.customerId ?? venta.customerId ?? null
  if (!customerId) return null
  const decision = decideSaleStamp(fotoPara(venta, customerId), nowMs)
  if (decision === 'OPEN') return null
  const sinProcesar = venta.paymentStatus === 'PAID' && venta.loyaltyEligibleAt !== null && venta.loyaltyProcessedAt === null
  if (sinProcesar && decision !== 'STAMPED' && decision !== 'NOT_PAID') {
    return armarResultado(args.venueId, customerId, programa, false, 'PENDING')
  }
  return describir(args.venueId, customerId, venta, programa, nowMs)
}

export interface SaleStampPreview {
  orderNumber: string
  decision: SaleStampDecision
  stampsEnabled: boolean
  dailyLimitReached: boolean
  minutosDesdeElCobro: number | null
}

/** Vista previa ANTES de ligar (MCP). Sin primario, el cliente se volvería primario: por eso cuenta como elegible. */
export async function previewSaleStamp(args: { venueId: string; orderId: string; customerId: string }): Promise<SaleStampPreview | null> {
  const nowMs = Date.now()
  const [venta, programa] = await Promise.all([leerVenta(prisma, args.venueId, args.orderId), leerPrograma(args.venueId)])
  if (!venta) return null
  const foto = fotoPara(venta, args.customerId)
  const decision = decideSaleStamp(foto, nowMs)
  return {
    orderNumber: venta.orderNumber,
    decision,
    stampsEnabled: programa.stampsEnabled,
    dailyLimitReached: decision === 'ELIGIBLE' ? await topeDelDiaAlcanzado(args.venueId, args.customerId, programa, nowMs) : false,
    minutosDesdeElCobro: minutosDesde(foto.settledAt, nowMs),
  }
}
