import { LoyaltyTransactionType, PaymentType, Prisma, StampEventType, TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getStampCardStatus, reverseStampForOrder } from '@/services/wallet/stampLedger.service'
import { venueEndOfDay, venueStartOfDay } from '@/utils/datetime'
import { awardLoyaltyForPaidOrder, type AwardLoyaltyForPaidOrderArgs, type AwardLoyaltyForPaidOrderResult } from './loyaltyOnPaidOrder'
import { cerrarLealtadDeLaVenta, registrarErrorDeLealtad } from './cierreDeLealtad'
import { MARCA_LEALTAD_REABIERTA } from './lealtadReabierta'

/** La marca de fila que deja la reapertura (ver `lealtadReabierta.ts`). */
export { MARCA_LEALTAD_REABIERTA }

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
 *
 * 🔴 Deja la MARCA de fila `loyaltyLastError = MARCA_LEALTAD_REABIERTA` (no null), y el llamador la escribe como ÚLTIMA
 * escritura de su transacción: el cierre «sin cliente» de `awardLoyaltyForPaidOrder` que esté esperando el candado de esta
 * fila sólo relee sus columnas al soltarse, y la marca lo detiene (medido contra Postgres por S3b; ver `lealtadReabierta.ts`).
 * Los cierres buenos la borran (`loyaltyLastError = null`).
 *
 * 🔴 H5 (auditoría de Codex del código + revisión final Minor 5, 15-oct-2026): guarda al actor de la liga (`staffId`, quien
 * agregó al cliente) en `Order.loyaltyStaffId`. Si el intento inmediato falla, el reconciliador sella con ESE valor (spec:
 * cada sello lleva a quien agregó al cliente), no con el de quien cobró. Sin actor conocido no se toca.
 */
export async function reabrirLealtadSiAplica(
  tx: Prisma.TransactionClient,
  args: { venueId: string; orderId: string; customerId: string; staffId?: string | null },
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
      loyaltyLastError: MARCA_LEALTAD_REABIERTA,
      ...(args.staffId ? { loyaltyStaffId: args.staffId } : {}),
      ...(venta.loyaltyEligibleAt ? {} : { loyaltyEligibleAt: foto.settledAt }),
    },
  })
  return reabierta.count === 1
}

export interface ResultadoDeLealtadRespetandoReembolsos extends AwardLoyaltyForPaidOrderResult {
  /** La venta ya tenía —o recibió MIENTRAS se otorgaba— un reembolso COMPLETED: no se otorgó, o el sello se revirtió. */
  reembolsada: boolean
  /** H4: la venta ya le había dado sello o puntos a OTRO cliente: no se acreditó al primario actual y quedó cerrada. */
  otroCliente?: true
}

interface FotoDelBeneficiario {
  /** El cliente que la lealtad acreditaría: el primario, o sin `OrderCustomer` el heredado que pasa quien llama. */
  beneficiario: string | null
  /** Un cliente DISTINTO del beneficiario que ya recibió sello o puntos de esta venta, o null. */
  otroDueno: string | null
  /** `Order.loyaltyStaffId` vigente (H5). */
  staffId: string | null
}

/**
 * 🔴 H4 (auditoría de Codex del código, 15-oct-2026): ¿esta venta ya le dio sello o puntos a un cliente DISTINTO del que la
 * lealtad acreditaría ahora? El caso: Ana recibió el sello y los puntos, la venta quedó pendiente por otro efecto, la TPV quitó
 * a Ana y puso a Beto. El reconciliador corría la lealtad para Beto: `grantStamp` decía «ya sellada» (el sello es POR VENTA),
 * pero `earnPoints` deduplica por cliente + venta y le daba a Beto los puntos de la compra de Ana. Es la MISMA regla de dueño
 * que `decideSaleStamp` (OTHER_CUSTOMER), aplicada también a la recuperación.
 *
 * 🔴 Segunda ola (recheck de Codex): UNA sola sentencia —una sola foto de la base— con el primario, cuántos clientes hay, el
 * actor vigente (`loyaltyStaffId`, H5) y los dueños de los EARN. El beneficiario validado aquí viaja a la lealtad
 * (`{ beneficiario }`), que acredita SÓLO a ése: si la TPV cambia al cliente entre esta foto y la lealtad, no se acredita a
 * nadie y la vuelta siguiente valida otra vez. `null` = la venta no existe en este negocio.
 */
async function fotoDelBeneficiario(args: AwardLoyaltyForPaidOrderArgs): Promise<FotoDelBeneficiario | null> {
  const filas =
    (await prisma.$queryRaw<
      Array<{ staffId: string | null; primario: string | null; clientes: number; sellos: string[] | null; puntos: string[] | null }>
    >(Prisma.sql`SELECT o."loyaltyStaffId" AS "staffId",
      (SELECT oc."customerId" FROM "OrderCustomer" oc WHERE oc."orderId" = o."id" AND oc."isPrimary" = true ORDER BY oc."addedAt" ASC LIMIT 1) AS "primario",
      (SELECT COUNT(*)::int FROM "OrderCustomer" oc WHERE oc."orderId" = o."id") AS "clientes",
      ARRAY(SELECT DISTINCT sc."customerId" FROM "StampEvent" se JOIN "StampCard" sc ON sc."id" = se."stampCardId"
            WHERE se."orderId" = o."id" AND se."venueId" = o."venueId" AND se."type" = 'EARN') AS "sellos",
      ARRAY(SELECT DISTINCT lt."customerId" FROM "LoyaltyTransaction" lt WHERE lt."orderId" = o."id" AND lt."type" = 'EARN') AS "puntos"
      FROM "Order" o WHERE o."id" = ${args.orderId} AND o."venueId" = ${args.venueId}`)) ?? []
  const foto = filas[0]
  if (!foto) return null
  // 🔴 F1 (ronda 1 post-QA): la MISMA regla que `awardLoyaltyForPaidOrder`: ligas sin primario (acompañantes de una liga sin
  // `payments:create` a una venta cobrada) no cuentan; el beneficiario es el de la venta sin ellas (el heredado, o nadie).
  const beneficiario = foto.primario ?? args.legacyCustomer?.id ?? null
  const duenos = [...(foto.sellos ?? []), ...(foto.puntos ?? [])]
  return { beneficiario, otroDueno: duenos.find(d => d !== beneficiario) ?? null, staffId: foto.staffId ?? null }
}

/**
 * Revierte el sello de una venta devuelta SIN lanzar. `null` = revertido (o no había nada que revertir); texto = el error,
 * que además queda en la venta (sin pisar la marca de una liga tardía) y en el log.
 */
async function revertirSelloDeVentaDevuelta(venueId: string, orderId: string): Promise<string | null> {
  try {
    await reverseStampForOrder(venueId, orderId)
    return null
  } catch (error) {
    const texto = `reversal:${error instanceof Error ? error.message : String(error)}`
    logger.error('[LEALTAD] no se pudo revertir el sello de una venta reembolsada: queda pendiente para el reconciliador', {
      venueId,
      orderId,
      error: texto,
    })
    await registrarErrorDeLealtad(venueId, orderId, texto).catch(() => undefined)
    return texto
  }
}

/** Cierra la venta como procesada sin lanzar: un fallo aquí la deja pendiente y se reporta en `errors`. */
async function cerrarSinLanzar(venueId: string, orderId: string, leyoSinCliente: boolean): Promise<string | null> {
  try {
    await cerrarLealtadDeLaVenta(venueId, orderId, { leyoSinCliente })
    return null
  } catch (error) {
    const texto = `marker:${error instanceof Error ? error.message : String(error)}`
    logger.error('[LEALTAD] no se pudo cerrar la lealtad de la venta; el reconciliador la reintenta', { venueId, orderId, error: texto })
    return texto
  }
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
 * 🔴 H1 (auditoría de Codex del código, 15-oct-2026): ESTE envoltorio es quien CIERRA la venta (`loyaltyProcessedAt`), y
 * sólo después de la comprobación final de reembolso y de completar la reversión. Antes la lealtad cerraba primero: si luego
 * fallaba la reversión, la venta quedaba «procesada» con el sello vivo y el reconciliador ya no la buscaba.
 *
 *   1. Si la venta YA tiene un reembolso COMPLETED (conteo exacto), no otorga nada: revierte un sello que la venta hubiera dado
 *      antes (idempotente) y SÓLO entonces la cierra: el reconciliador no vuelve a tomar una venta devuelta.
 *   2. Si la venta ya le dio sello o puntos a OTRO cliente (H4), no acredita al primario actual y la cierra (`otroCliente`).
 *      Si no, corre la lealtad de siempre (idempotente) SIN que cierre (`{ cerrar: false }`).
 *   3. Vuelve a contar: si el reembolso entró MIENTRAS se otorgaba, revierte el sello (`reverseStampForOrder`, idempotente:
 *      si la reversa del reembolso también lo hace, la segunda no hace nada).
 *   4. Cierra si la lealtad terminó, con la MISMA guarda B1 que habría usado la lealtad.
 *
 * Si la reversión falla, NO cierra: devuelve `complete: false` con el error (también queda en la venta y en el log) y el
 * reconciliador la reintenta (en su vuelta, el paso 1 revierte y cierra). Sin candado de reembolso (el motor escribe en
 * transacciones propias) y sin reiniciar la ventana de 24 h. `awardLoyaltyForPaidOrder` en sí nunca lanza; un conteo que
 * truena sí sube (sus llamadores lo registran).
 */
export async function otorgarLealtadRespetandoReembolsos(
  args: AwardLoyaltyForPaidOrderArgs,
): Promise<ResultadoDeLealtadRespetandoReembolsos> {
  const { venueId, orderId } = args
  if ((await contarReembolsos(prisma, venueId, orderId)) > 0) {
    const falloAlRevertir = await revertirSelloDeVentaDevuelta(venueId, orderId)
    if (falloAlRevertir) return { complete: false, errors: [falloAlRevertir], reembolsada: true }
    const falloAlCerrar = await cerrarSinLanzar(venueId, orderId, false)
    if (falloAlCerrar) return { complete: false, errors: [falloAlCerrar], reembolsada: true }
    logger.info('[LEALTAD] venta con reembolso: no se otorga lealtad y queda cerrada', { venueId, orderId })
    return { complete: true, errors: [], reembolsada: true }
  }

  // 🔴 H4: lo que esta venta ya le dio a OTRO cliente no se le vuelve a dar al primario de ahora. Se cierra: no hay nada que
  // recuperar para él (la liga tardía ya responde OTHER_CUSTOMER con la misma regla).
  const foto = await fotoDelBeneficiario(args)
  if (foto?.otroDueno) {
    logger.warn('[LEALTAD] la venta ya le dio sello o puntos a otro cliente: no se acredita al primario actual', {
      venueId,
      orderId,
      otroDueno: foto.otroDueno,
    })
    const falloAlCerrar = await cerrarSinLanzar(venueId, orderId, false)
    if (falloAlCerrar) return { complete: false, errors: [falloAlCerrar], reembolsada: false }
    return { complete: true, errors: [], reembolsada: false, otroCliente: true }
  }

  // H4 (segunda ola): la lealtad acredita SÓLO al beneficiario de esta foto. H5 (segunda ola): con `actorDeLaVenta`, el autor
  // del sello es el `loyaltyStaffId` de la MISMA foto, nunca el que quien llama leyó antes (una liga pudo cambiar los dos).
  const resultado: AwardLoyaltyForPaidOrderResult = foto
    ? await awardLoyaltyForPaidOrder(
        { ...args, staffId: args.actorDeLaVenta ? foto.staffId : args.staffId },
        { cerrar: false, beneficiario: foto.beneficiario },
      )
    : await awardLoyaltyForPaidOrder(args, { cerrar: false })
  const errores = [...resultado.errors]
  // H4, tercera ola: otro intento ganó la venta para OTRO cliente mientras ésta acreditaba; se cierra como OTHER_CUSTOMER.
  // F2 (ronda 1): y lo que ESTA corrida creó, para la auditoría de una re-liga.
  const conOtro = {
    ...(resultado.otroCliente ? { otroCliente: true as const } : {}),
    ...(resultado.otorgado ? { otorgado: resultado.otorgado } : {}),
  }

  if ((await contarReembolsos(prisma, venueId, orderId)) > 0) {
    // 🔴 Auditoría A #2: el reembolso entró MIENTRAS se otorgaba. Si su reversa corrió antes de que el sello existiera, no
    // encontró nada que revertir; este sello quedaría vivo sobre una venta devuelta.
    logger.warn('[LEALTAD] la venta se reembolsó mientras se otorgaba su lealtad: se revierte el sello', { venueId, orderId })
    const falloAlRevertir = await revertirSelloDeVentaDevuelta(venueId, orderId)
    if (falloAlRevertir) return { complete: false, errors: [...errores, falloAlRevertir], reembolsada: true }
    if (!resultado.complete) return { complete: false, errors: errores, reembolsada: true }
    const falloAlCerrar = await cerrarSinLanzar(venueId, orderId, false)
    if (falloAlCerrar) return { complete: false, errors: [...errores, falloAlCerrar], reembolsada: true }
    return { complete: true, errors: errores, reembolsada: true, ...conOtro }
  }

  const conOtorgado = resultado.otorgado ? { otorgado: resultado.otorgado } : {}
  if (!resultado.complete) return { complete: false, errors: errores, reembolsada: false, ...conOtorgado }
  const falloAlCerrar = await cerrarSinLanzar(venueId, orderId, resultado.leyoSinCliente === true)
  if (falloAlCerrar) return { complete: false, errors: [...errores, falloAlCerrar], reembolsada: false, ...conOtorgado }
  return { complete: true, errors: errores, reembolsada: false, ...conOtro }
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

const esVentaCobrada = (paymentStatus: string): boolean => paymentStatus === 'PAID' || paymentStatus === 'REFUNDED'

/**
 * La ÚNICA escritura de `CUSTOMER_ATTACHED_TO_PAID_ORDER` (spec §3.1): quién ligó a quién a una venta YA cobrada, y qué pasó
 * con su lealtad. Fire-and-forget (`logAction` nunca lanza), fuera de toda transacción.
 */
function auditarLigaAVentaCobrada(args: {
  venueId: string
  orderId: string
  customerId: string
  staffId?: string | null
  data: Record<string, unknown>
}): void {
  void logAction({
    action: 'CUSTOMER_ATTACHED_TO_PAID_ORDER',
    entity: 'Order',
    entityId: args.orderId,
    staffId: args.staffId ?? null,
    venueId: args.venueId,
    data: { customerId: args.customerId, ...args.data } as Prisma.InputJsonValue,
  })
}

/**
 * Después de ligar al cliente: si la venta está saldada, dentro de 24 h y el cliente es (o será) su primario, corre la
 * lealtad completa (visita, puntos y sello, todo idempotente) — también si el sello de este cliente ya existe, para completar
 * lo que falte. Siempre por `otorgarLealtadRespetandoReembolsos` (B2). `null` = venta abierta o inexistente o falla: la app
 * no pinta nada.
 *
 * `ligaNueva` — ¿ESTA llamada creó (o promovió a primario) la liga del cliente? Decide la fila de auditoría
 * `CUSTOMER_ATTACHED_TO_PAID_ORDER` (BAJO-3 + F2 de la ronda 1 post-QA, 15-oct-2026):
 *   · `true`: audita SIEMPRE (también si la lealtad truena después de leer la venta: `reason: 'ERROR'`). Una fila por liga.
 *   · `false` (re-liga: la liga ya existía): audita SÓLO si ESTA llamada otorgó — creó el sello, o los puntos de una venta que
 *     no tiene sello (si el sello lo creó otra llamada simultánea, ésa audita): así una carrera deja ≤ 2 filas, las dos ciertas.
 *     Antes, una re-liga nunca auditaba, y la COCINA ligaba sin fila (ruta sin permiso) y el cajero re-ligaba y sellaba: CERO.
 *   · `undefined` (quien llama no lo sabe): la regla de antes — no se audita la re-liga de una venta ya sellada para él.
 * La fila lleva `ligaNueva` y `otorgo` cuando quien llama lo dijo.
 */
export async function awardLoyaltyForLateCustomer(args: {
  venueId: string
  orderId: string
  customerId: string
  staffId?: string | null
  ligaNueva?: boolean
}): Promise<SaleStampOutcome | null> {
  const { venueId, orderId, customerId } = args
  const nowMs = Date.now()
  // Fuera del try: si la lealtad truena DESPUÉS de leer la venta, la liga nueva se audita igual (F2).
  let venta: Venta | null = null
  let antes: SaleStampDecision | null = null
  try {
    const [leida, programa] = await Promise.all([leerVenta(prisma, venueId, orderId), leerPrograma(venueId)])
    venta = leida
    if (!venta) return null
    const foto = fotoPara(venta, customerId)
    antes = decideSaleStamp(foto, nowMs)
    // Cuenta aún sin saldar: quien la salde corre la lealtad, y este cliente ya es su primario. Decir «no suma» sería falso.
    if (antes === 'OPEN') return null

    // Tipo explícito: `antes` ya viene sin 'OPEN' y una relectura puede devolver cualquier decisión.
    let decision: SaleStampDecision = antes
    // F2: ¿ESTA llamada otorgó? (el sello, o los puntos de una venta sin sello).
    let otorgo = false
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
      let ventaConSello = true // sin relectura (reembolso u otro cliente), unos puntos sueltos no cuentan como «otorgó»
      if (resultado.reembolsada) {
        // El reembolso entró entre la lectura y el otorgamiento, o mientras se otorgaba (el envoltorio ya revirtió el sello).
        logger.warn('[LEALTAD TARDÍA] la venta se reembolsó mientras se ligaba: no suma sello', { venueId, orderId, customerId })
        decision = 'NOT_PAID'
      } else if (resultado.otroCliente) {
        // H4: otro cliente recibió el sello o los puntos de esta venta entre la lectura y el otorgamiento.
        decision = 'OTHER_CUSTOMER'
      } else {
        const despues = await leerVenta(prisma, venueId, orderId)
        const fotoDespues = despues ? fotoPara(despues, customerId) : null
        decision = fotoDespues ? decideSaleStamp(fotoDespues, nowMs) : antes
        ventaConSello = fotoDespues ? fotoDespues.stampOwnerCustomerId !== null : true
      }
      otorgo = resultado.otorgado?.sello === true || (resultado.otorgado?.puntos === true && !ventaConSello)
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

    const auditar = args.ligaNueva === undefined ? antes !== 'STAMPED' : args.ligaNueva || otorgo
    if (auditar && esVentaCobrada(venta.paymentStatus)) {
      auditarLigaAVentaCobrada({
        venueId,
        orderId,
        customerId,
        staffId: args.staffId,
        data: {
          orderNumber: venta.orderNumber,
          // La decisión ANTES de otorgar (ELIGIBLE, WINDOW_EXPIRED…): con `stamped` dice qué se pidió y qué pasó.
          decision: antes,
          stamped: outcome.stamped,
          reason: outcome.reason,
          minutosDesdeElCobro: minutosDesde(foto.settledAt, nowMs),
          ...(args.ligaNueva === undefined ? {} : { ligaNueva: args.ligaNueva, otorgo }),
        },
      })
    }
    return outcome
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error)
    logger.error('[LEALTAD TARDÍA] falló; el cliente ya quedó ligado a la venta', { venueId, orderId, customerId, error: mensaje })
    // 🔴 F2: la llamada que CREÓ la liga audita siempre — también cuando su lealtad truena (antes la fila se perdía).
    if (args.ligaNueva === true && venta && esVentaCobrada(venta.paymentStatus)) {
      auditarLigaAVentaCobrada({
        venueId,
        orderId,
        customerId,
        staffId: args.staffId,
        data: {
          orderNumber: venta.orderNumber,
          decision: antes,
          stamped: false,
          reason: 'ERROR',
          error: mensaje.slice(0, 500),
          minutosDesdeElCobro: minutosDesde(fotoPara(venta, customerId).settledAt, nowMs),
          ligaNueva: true,
          otorgo: false,
        },
      })
    }
    return null
  }
}

/**
 * 🔴 F2 (ronda 1 post-QA): la liga de la TPV hecha por alguien SIN `payments:create` a una venta YA cobrada no pasa por el
 * sello tardío (decisión «A»: entra como acompañante y no otorga nada), pero el hecho «X ligó a Y a una venta cobrada» se
 * audita igual — es justo lo que un dueño quiere ver de un rol restringido. La fila dice `lealtad: 'SIN_PERMISO'`. Sólo la
 * llama quien CREÓ la liga. Nunca lanza: corre después de que la liga ya quedó.
 */
export async function auditarLigaSinPermisoDeCobro(args: {
  venueId: string
  orderId: string
  customerId: string
  staffId?: string | null
}): Promise<void> {
  try {
    const venta = await leerVenta(prisma, args.venueId, args.orderId)
    if (!venta || !esVentaCobrada(venta.paymentStatus)) return
    auditarLigaAVentaCobrada({
      ...args,
      data: {
        orderNumber: venta.orderNumber,
        decision: null,
        stamped: false,
        reason: 'SIN_PERMISO',
        lealtad: 'SIN_PERMISO',
        ligaNueva: true,
        otorgo: false,
        minutosDesdeElCobro: minutosDesde(fotoPara(venta, args.customerId).settledAt, Date.now()),
      },
    })
  } catch (error) {
    logger.error('[LEALTAD TARDÍA] no se pudo auditar una liga sin permiso de cobro (la liga ya quedó)', {
      venueId: args.venueId,
      orderId: args.orderId,
      customerId: args.customerId,
      error: error instanceof Error ? error.message : String(error),
    })
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
