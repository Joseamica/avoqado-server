import { LoyaltyTransactionType, PaymentType, Prisma, StampEventType, StampRewardStatus, TransactionStatus } from '@prisma/client'
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
import { esVentaYaCobrada, ventaTieneReembolso } from './ligaDeClienteEnVenta'
import { SELECT_MARCA_DE_CUENTA_DE_TARJETAS, esCuentaDeTarjetasSeleccionada } from '@/services/giftCards/giftCardMarks'
import { esVentaNuevaDeCambio } from '@/services/exchanges/exchangeMarks'

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
  /**
   * La cartilla donde cayó el sello de ESTA venta, para la tarjetita de «Cobro exitoso» (21-oct). Campo nuevo y opcional
   * para las apps: las viejas lo ignoran. null si la venta no sumó (la app deja el renglón de texto). Los campos de arriba
   * describen la cartilla ABIERTA hoy; éste, la de la venta (Codex r1 #1-#3).
   */
  saleCard: SaleStampCard | null
}

export interface SaleStampCard {
  /** Sellos de esa cartilla (llena = `stampsRequired`). */
  stampsEarned: number
  /** La meta de ESA cartilla, aunque el negocio la haya cambiado después. */
  stampsRequired: number
  /** Esa cartilla ya está llena (por esta venta o por una posterior: no se atribuye). */
  completed: boolean
  /** Llena: el premio GANADO (como quedó guardado). Sin llenar: el que ofrece hoy la configuración. */
  rewardLabel: string
  /** Llena y su premio sigue sin cobrar. */
  rewardPending: boolean
}

/**
 * Lo que la regla concluye antes de traducirlo al contrato. `OPEN` = cuenta aún no saldada: el sello se decide al saldarla.
 * `NOT_APPLICABLE` (cierre de tarjetas 1a): venta de tarjetas de regalo — comprarlas no suma sellos (R1/B6), usarlas sí.
 */
export type SaleStampDecision =
  | 'OPEN'
  | 'NOT_PAID'
  | 'STAMPED'
  | 'OTHER_CUSTOMER'
  | 'NO_ANCHOR'
  | 'WINDOW_EXPIRED'
  | 'ELIGIBLE'
  | 'NOT_APPLICABLE'

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
  /** La cuenta es de tarjetas de regalo (marca completa R11): el otorgamiento ya no da sello (B6); la regla tampoco lo promete. */
  esVentaDeTarjetas: boolean
  /**
   * La venta nueva de un cambio de producto (spec 2026-10-20 §7.7): no es una visita nueva, así que el otorgamiento no da sello y la
   * regla tampoco lo promete; la diferencia cobrada sí da puntos (`esElegibleParaLealtad`).
   */
  esVentaNuevaDeCambio: boolean
}

const SIN_VENTA = new Set(['CANCELLED', 'DELETED'])

/**
 * La regla, pura. El orden de las preguntas importa: lo devuelto/cancelado gana a todo; lo de otro cliente gana al plazo.
 * `ignorarPlazo` existe SÓLO para la reparación de datos (S9, spec §3.6): ni el plazo de 24 h ni el ancla cuentan; todo lo
 * demás (saldada, no cancelada, sin reembolso, sin otro dueño) sí.
 */
export function decideSaleStamp(s: SaleStampSnapshot, nowMs: number, opciones: { ignorarPlazo?: boolean } = {}): SaleStampDecision {
  // Cierre (punto 15): primero que todo. Abierta o pagada, una venta de tarjetas nunca va a sumar sello: no se promete uno.
  if (s.esVentaDeTarjetas) return 'NOT_APPLICABLE'
  // Cambio de producto: la venta nueva no es una visita nueva y nunca suma sello. No se promete ni se reporta uno (sin motivo:
  // las apps no pintan nada); sus puntos van por `esElegibleParaLealtad`.
  if (s.esVentaNuevaDeCambio) return 'NOT_APPLICABLE'
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
 *
 * La venta nueva de un cambio se evalúa como una venta más: no da sello (lo omite el otorgamiento), pero la diferencia cobrada
 * sí da puntos por la liga tardía y por el reconciliador.
 */
export function esElegibleParaLealtad(s: SaleStampSnapshot, nowMs: number, opciones: { ignorarPlazo?: boolean } = {}): boolean {
  const comoVenta = {
    ...s,
    esVentaNuevaDeCambio: false,
    ...(s.stampOwnerCustomerId === s.customerId ? { stampOwnerCustomerId: null } : {}),
  }
  return decideSaleStamp(comoVenta, nowMs, opciones) === 'ELIGIBLE'
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
  // Cierre (punto 15): la marca COMPLETA de cuenta de tarjetas, en esta MISMA lectura (la de giftCardMarks).
  ...SELECT_MARCA_DE_CUENTA_DE_TARJETAS,
} satisfies Prisma.OrderSelect

type Venta = Prisma.OrderGetPayload<{ select: typeof VENTA_SELECT }> & { reembolsada: boolean; esVentaNuevaDeCambio: boolean }

/** El cliente global o el de una transacción (la reapertura lee DENTRO de la transacción de la liga). */
type LectorDeVenta = Pick<Prisma.TransactionClient, 'order' | 'payment' | 'exchange'>

interface Programa {
  stampsEnabled: boolean
  maxStampsPerDay: number
}

async function leerVenta(db: LectorDeVenta, venueId: string, orderId: string): Promise<Venta | null> {
  const venta = await db.order.findFirst({ where: { id: orderId, venueId }, select: VENTA_SELECT })
  if (!venta) return null
  // 🔴 Reembolso EXACTO (auditoría A #2): un `count` por la orden, sin tope de lista que esconda nada. Decide `NOT_PAID`, no
  // «ya cobrada» (R7-2: eso es `esVentaYaCobrada`, sólo el estado).
  return {
    ...venta,
    reembolsada: await ventaTieneReembolso(db, { venueId, orderId }),
    // Cambio de producto: una lectura por el índice único de `Exchange.newOrderId` (no hay relación con la orden).
    esVentaNuevaDeCambio: await esVentaNuevaDeCambio(db, orderId),
  }
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
    esVentaDeTarjetas: esCuentaDeTarjetasSeleccionada(venta),
    esVentaNuevaDeCambio: venta.esVentaNuevaDeCambio,
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

/** R3-1: quien llama se entera de lo otorgado en cuanto ocurre (ver `otorgarLealtadRespetandoReembolsos`). */
export interface ObservadorDeOtorgamiento {
  alOtorgar?: (otorgado: { sello: boolean; puntos: boolean }) => void
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
  observador: ObservadorDeOtorgamiento = {},
): Promise<ResultadoDeLealtadRespetandoReembolsos> {
  const { venueId, orderId } = args
  if (await ventaTieneReembolso(prisma, { venueId, orderId })) {
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
  // 🔴 R3-1 (ronda 3): lo otorgado se avisa EN CUANTO ocurre, antes de cualquier lectura posterior que pueda tronar (el 2.º
  // conteo de reembolsos, la reversión, el cierre): quien audita no puede perder un sello o unos puntos que sí se dieron.
  if (resultado.otorgado) observador.alOtorgar?.(resultado.otorgado)
  const errores = [...resultado.errors]
  // H4, tercera ola: otro intento ganó la venta para OTRO cliente mientras ésta acreditaba; se cierra como OTHER_CUSTOMER.
  // F2 (ronda 1): y lo que ESTA corrida creó, para la auditoría de una re-liga.
  const conOtro = {
    ...(resultado.otroCliente ? { otroCliente: true as const } : {}),
    ...(resultado.otorgado ? { otorgado: resultado.otorgado } : {}),
  }

  if (await ventaTieneReembolso(prisma, { venueId, orderId })) {
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
    case 'NOT_APPLICABLE':
      // Venta de tarjetas: no es «no suma por X»; no aplica. Quien llama no le pinta nada a la app (devuelve null).
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

/**
 * La cartilla del sello EARN de esta venta para este cliente; null si no hay sello (o se revirtió). 🔴 NO dice qué venta la
 * llenó (Codex r2 #2 y r3 #1): ordenar sellos por hora o por id falla con transacciones que esperan el candado o con un
 * script en otra máquina con el reloj movido. Sólo describe ESA cartilla: su meta, si ya está llena y su premio.
 */
async function cartillaDeLaVenta(venueId: string, customerId: string, orderId: string, premioDeHoy: string): Promise<SaleStampCard | null> {
  const earn = await prisma.stampEvent.findFirst({
    where: { venueId, orderId, type: StampEventType.EARN, stampCard: { customerId } },
    select: {
      stampCard: {
        select: {
          stampsEarned: true,
          stampsRequired: true,
          completedAt: true,
          rewards: { select: { rewardLabel: true, status: true }, take: 1 },
        },
      },
    },
  })
  if (!earn) return null
  const card = earn.stampCard
  if (!card.completedAt) {
    return {
      stampsEarned: card.stampsEarned,
      stampsRequired: card.stampsRequired,
      completed: false,
      rewardLabel: premioDeHoy,
      rewardPending: false,
    }
  }
  // Reabierta por una devolución después de cobrar el premio (Codex r4 #1): conserva `completedAt` con menos sellos. No se
  // dibuja «7 de 7» con 6 ni se promete llenarla otra vez: sin tarjetita, la app deja el renglón de texto.
  if (card.stampsEarned < card.stampsRequired) return null
  const premio = card.rewards[0]
  return {
    stampsEarned: card.stampsRequired,
    stampsRequired: card.stampsRequired,
    completed: true,
    rewardLabel: premio?.rewardLabel ?? premioDeHoy,
    rewardPending: premio?.status === StampRewardStatus.PENDING,
  }
}

async function armarResultado(
  venueId: string,
  customerId: string,
  programa: Programa,
  stamped: boolean,
  reason: SaleStampReason | null,
  orderId?: string,
): Promise<SaleStampOutcome> {
  const tarjeta = await getStampCardStatus(venueId, customerId)
  const saleCard =
    programa.stampsEnabled && stamped && orderId ? await cartillaDeLaVenta(venueId, customerId, orderId, tarjeta.rewardLabel) : null
  return {
    stampsEnabled: programa.stampsEnabled,
    stamped,
    reason: programa.stampsEnabled && !stamped ? reason : null,
    stampsEarned: tarjeta.stampsEarned,
    stampsRequired: tarjeta.stampsRequired,
    rewardReady: tarjeta.pendingRewards > 0,
    saleCard,
  }
}

const minutosDesde = (settledAt: Date | null, nowMs: number): number | null =>
  settledAt ? Math.floor((nowMs - settledAt.getTime()) / 60_000) : null

async function describir(venueId: string, customerId: string, venta: Venta, programa: Programa, nowMs: number): Promise<SaleStampOutcome> {
  const decision = decideSaleStamp(fotoPara(venta, customerId), nowMs)
  const stamped = decision === 'STAMPED'
  return armarResultado(venueId, customerId, programa, stamped, await motivo(decision, venueId, customerId, programa, nowMs), venta.id)
}

/** Sólo LEE: describe el sello de una venta para un cliente. No otorga nada. */
export async function describeSaleStamp(args: { venueId: string; orderId: string; customerId: string }): Promise<SaleStampOutcome> {
  const nowMs = Date.now()
  const [venta, programa] = await Promise.all([leerVenta(prisma, args.venueId, args.orderId), leerPrograma(args.venueId)])
  if (!venta) return armarResultado(args.venueId, args.customerId, programa, false, 'ERROR')
  return describir(args.venueId, args.customerId, venta, programa, nowMs)
}

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
 * `CUSTOMER_ATTACHED_TO_PAID_ORDER` (BAJO-3 + F2 de la ronda 1 post-QA; R3-1 de la ronda 3, 15-oct-2026):
 *   · `true`: audita SIEMPRE, pase lo que pase después (también si una lectura truena). Una fila por liga.
 *   · `false` (re-liga: la liga ya existía): audita SÓLO si ESTA llamada otorgó algo — el sello o los puntos (recuperar los
 *     puntos de una venta que ya tenía sello también cuenta). En una carrera puede haber hasta 3 filas (la del creador y la de
 *     cada re-liga que otorgó una pieza distinta): todas ciertas, ninguna silenciada.
 *   · `undefined` (quien llama no lo sabe): la regla de antes — no se audita la re-liga de una venta ya sellada para él.
 *
 * 🔴 R3-1 (Codex recheck-7 P2-1 + N4): la fila se arma con los HECHOS de esta llamada (`ligaNueva`, `otorgoSello`,
 * `otorgoPuntos`), anotados en cuanto ocurren y fuera del alcance de las lecturas que sólo arman la respuesta (la cartilla, la
 * relectura, el programa). Si una de ésas truena, la fila sale igual y dice la verdad: lo otorgado no se reporta como «sin
 * sello». `ventaCobrada` = lo que quien llama leyó bajo SU candado; sólo se usa si la lectura de la venta aquí falla.
 */
export async function awardLoyaltyForLateCustomer(args: {
  venueId: string
  orderId: string
  customerId: string
  staffId?: string | null
  ligaNueva?: boolean
  ventaCobrada?: boolean
}): Promise<SaleStampOutcome | null> {
  const { venueId, orderId, customerId } = args
  const nowMs = Date.now()
  // R3-1: lo que esta llamada SABE y HIZO vive fuera del try: el catch audita con ello.
  let venta: Venta | null = null
  let antes: SaleStampDecision | null = null
  /** La decisión después de otorgar y releer; null mientras no se conozca. */
  let despuesDeOtorgar: SaleStampDecision | null = null
  const hechos = { otorgoSello: false, otorgoPuntos: false }
  const anotar = (otorgado?: { sello: boolean; puntos: boolean }) => {
    if (otorgado?.sello) hechos.otorgoSello = true
    if (otorgado?.puntos) hechos.otorgoPuntos = true
  }
  const otorgo = () => hechos.otorgoSello || hechos.otorgoPuntos
  const datosDeLaLiga = () =>
    args.ligaNueva === undefined
      ? {}
      : { ligaNueva: args.ligaNueva, otorgo: otorgo(), otorgoSello: hechos.otorgoSello, otorgoPuntos: hechos.otorgoPuntos }
  try {
    // `allSettled`: si sólo falla el programa, la venta leída sigue sirviendo a la auditoría (antes se perdía con el `all`).
    const [leida, programaLeido] = await Promise.allSettled([leerVenta(prisma, venueId, orderId), leerPrograma(venueId)])
    if (leida.status === 'rejected') throw leida.reason
    venta = leida.value
    if (!venta) return null
    const foto = fotoPara(venta, customerId)
    antes = decideSaleStamp(foto, nowMs)
    // Cuenta aún sin saldar: quien la salde corre la lealtad, y este cliente ya es su primario. Decir «no suma» sería falso.
    if (antes === 'OPEN') return null
    if (programaLeido.status === 'rejected') throw programaLeido.reason
    const programa = programaLeido.value

    // Tipo explícito: `antes` ya viene sin 'OPEN' y una relectura puede devolver cualquier decisión.
    let decision: SaleStampDecision = antes
    // 🔴 SIEMPRE que sea elegible, aunque el sello de ESTE cliente ya exista (auditoría A #1): la llamada es idempotente y
    // completa los puntos o la visita que una caída entre el sello y los puntos hubiera dejado pendientes.
    if (esElegibleParaLealtad(foto, nowMs)) {
      // Base: venta y cargos sin propina — la misma que el cobro y el reconciliador (la propina es del personal).
      const resultado = await otorgarLealtadRespetandoReembolsos(
        {
          venueId,
          orderId,
          orderTotal: Math.max(0, Number(venta.total) - Number(venta.tipAmount ?? 0)),
          staffId: args.staffId ?? null,
          legacyCustomer: null,
        },
        { alOtorgar: anotar },
      )
      anotar(resultado.otorgado)
      if (!resultado.complete) {
        // No se pierde: la liga reabrió la venta en su transacción y el reconciliador la reintenta.
        logger.warn('[LEALTAD TARDÍA] la lealtad de la venta quedó incompleta', { venueId, orderId, customerId, errors: resultado.errors })
      }
      if (resultado.reembolsada) {
        // El reembolso entró entre la lectura y el otorgamiento, o mientras se otorgaba (el envoltorio ya revirtió el sello).
        logger.warn('[LEALTAD TARDÍA] la venta se reembolsó mientras se ligaba: no suma sello', { venueId, orderId, customerId })
        decision = 'NOT_PAID'
      } else if (resultado.otroCliente) {
        // H4: otro cliente recibió el sello o los puntos de esta venta entre la lectura y el otorgamiento.
        decision = 'OTHER_CUSTOMER'
      } else {
        const despues = await leerVenta(prisma, venueId, orderId)
        decision = despues ? decideSaleStamp(fotoPara(despues, customerId), nowMs) : antes
      }
      despuesDeOtorgar = decision
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
      orderId,
    )

    const auditar = args.ligaNueva === undefined ? antes !== 'STAMPED' : args.ligaNueva || otorgo()
    // «Cobrada» por la regla compartida de la decisión A (PAID/REFUNDED).
    if (auditar && esVentaYaCobrada(venta)) {
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
          ...datosDeLaLiga(),
        },
      })
    }
    // Cierre (punto 15): la liga a una venta de tarjetas —o a la venta nueva de un cambio— queda auditada (arriba), pero la app no
    // pinta nada: no aplica.
    return antes === 'NOT_APPLICABLE' ? null : outcome
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error)
    logger.error('[LEALTAD TARDÍA] falló; el cliente ya quedó ligado a la venta', { venueId, orderId, customerId, error: mensaje })
    // 🔴 R3-1: la llamada que CREÓ la liga audita siempre; una re-liga, si otorgó algo. Con los hechos, no con lo que faltó leer.
    const auditar = args.ligaNueva === true || (args.ligaNueva === false && otorgo())
    // La venta leída aquí manda; si su lectura fue la que tronó, lo que quien llama leyó bajo su candado.
    const cobrada = venta ? esVentaYaCobrada(venta) : args.ventaCobrada === true
    if (auditar && cobrada) {
      // N4: si se otorgó el sello (y no se supo después que se revirtió), la fila lo dice: nada de un falso «sin sello».
      const stamped = despuesDeOtorgar !== null ? despuesDeOtorgar === 'STAMPED' : hechos.otorgoSello || antes === 'STAMPED'
      auditarLigaAVentaCobrada({
        venueId,
        orderId,
        customerId,
        staffId: args.staffId,
        data: {
          orderNumber: venta?.orderNumber ?? null,
          decision: antes,
          stamped,
          reason: stamped ? null : 'ERROR',
          error: mensaje.slice(0, 500),
          minutosDesdeElCobro: venta ? minutosDesde(fotoPara(venta, customerId).settledAt, nowMs) : null,
          ...datosDeLaLiga(),
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
 *
 * R3-1 (ronda 3): `orderNumber` = la venta que quien llama ya leyó COBRADA bajo su candado. Con él, si la relectura de aquí
 * truena, la fila sale igual con lo que se sabe (sin minutos). Sin él, como antes: sin lectura no hay fila.
 */
export async function auditarLigaSinPermisoDeCobro(args: {
  venueId: string
  orderId: string
  customerId: string
  staffId?: string | null
  orderNumber?: string
}): Promise<void> {
  const { orderNumber, ...liga } = args
  const fila = (numero: string, minutos: number | null) =>
    auditarLigaAVentaCobrada({
      ...liga,
      data: {
        orderNumber: numero,
        decision: null,
        stamped: false,
        reason: 'SIN_PERMISO',
        lealtad: 'SIN_PERMISO',
        ligaNueva: true,
        otorgo: false,
        minutosDesdeElCobro: minutos,
      },
    })
  let venta: Venta | null
  try {
    venta = await leerVenta(prisma, args.venueId, args.orderId)
  } catch (error) {
    logger.error('[LEALTAD TARDÍA] no se pudo releer la venta para auditar una liga sin permiso de cobro (la liga ya quedó)', {
      venueId: args.venueId,
      orderId: args.orderId,
      customerId: args.customerId,
      error: error instanceof Error ? error.message : String(error),
    })
    if (orderNumber) fila(orderNumber, null)
    return
  }
  if (!venta || !esVentaYaCobrada(venta)) return
  fila(venta.orderNumber, minutosDesde(fotoPara(venta, args.customerId).settledAt, Date.now()))
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
  if (decision === 'OPEN' || decision === 'NOT_APPLICABLE') return null
  const sinProcesar = venta.paymentStatus === 'PAID' && venta.loyaltyEligibleAt !== null && venta.loyaltyProcessedAt === null
  if (sinProcesar && decision !== 'STAMPED' && decision !== 'NOT_PAID') {
    return armarResultado(args.venueId, customerId, programa, false, 'PENDING')
  }
  return describir(args.venueId, customerId, venta, programa, nowMs)
}

export interface SaleStampPreview {
  orderNumber: string
  decision: SaleStampDecision
  /** Con `NOT_APPLICABLE`: la venta nueva de un cambio (si no, la cuenta de tarjetas de regalo). Lo explica el MCP. */
  esVentaNuevaDeCambio: boolean
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
    esVentaNuevaDeCambio: foto.esVentaNuevaDeCambio,
    stampsEnabled: programa.stampsEnabled,
    dailyLimitReached: decision === 'ELIGIBLE' ? await topeDelDiaAlcanzado(args.venueId, args.customerId, programa, nowMs) : false,
    minutosDesdeElCobro: minutosDesde(foto.settledAt, nowMs),
  }
}
