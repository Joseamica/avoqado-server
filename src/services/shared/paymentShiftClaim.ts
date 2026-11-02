import type { PrismaClient } from '@prisma/client'
import { Prisma, ShiftStatus } from '@prisma/client'

import logger from '../../config/logger'
import { ConflictError } from '../../errors/AppError'
import { WHERE_RENGLON_DE_TARJETA } from '../giftCards/giftCardMarks'
import { turnoVivoWhere } from './turnoDeCaja'

// `payGiftCardBalanceOnOrder` (tarjetas de regalo, A8): el cobro con saldo comparte el núcleo de `payCashOrder` pero su
// auditoría no se atribuye al efectivo.
export type CapturedPaymentChannel = 'recordOrderPayment' | 'recordFastPayment' | 'payCashOrder' | 'payGiftCardBalanceOnOrder' | 'exchange'
export type RefundPaymentChannel = 'recordRefund' | 'issueRefund' | 'createRefund'
export type PaymentShiftReconciliationChannel =
  | CapturedPaymentChannel
  | RefundPaymentChannel
  | 'b4bitWebhook'
  | 'manualPayment'
  | 'posSyncOrder'
  | 'settleOrder'
  | 'settleCustomerBalance'
/**
 * `SALE_SHIFT_CLOSED` («Cobrar sin red», D4): la cola de la terminal subió una venta de un turno que ya no es el vivo (lo cerró
 * otro aparato mientras ésta no tenía red). No entra al turno nuevo; su corte firmado tampoco se recalcula aquí.
 */
export type PendingPaymentShiftReason =
  | 'NO_SHIFT'
  | 'SHIFT_NOT_OPEN'
  | 'CLAIM_LOST'
  | 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY'
  | 'SALE_SHIFT_CLOSED'
  /**
   * S3 «Efectivo sin red en el turno correcto»: el POS subió una venta de una caja que ya se cerró y que NO tiene turno ligado
   * (negocio sin turnos o caja anterior a la liga). No entra al turno vivo; se concilia contra el corte de esa caja (`saleDrawerId`).
   */
  | 'SALE_DRAWER_CLOSED'

type PaymentShiftTransaction = Pick<Prisma.TransactionClient, 'shift' | 'activityLog' | 'orderItem' | 'order' | 'cashDrawerSession'>
type PaymentShiftSettingsReader = Pick<PrismaClient, 'venueSettings'> | Pick<Prisma.TransactionClient, 'venueSettings'>
type ExistingOrderLockTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>
type ActivityLogReader = Pick<PrismaClient, 'activityLog'> | Pick<Prisma.TransactionClient, 'activityLog'>

export interface CapturedPaymentShiftClaim {
  shiftId: string | null
  candidateShiftId: string | null
  observedStatus: string | null
  pendingReason: PendingPaymentShiftReason | null
  /** Sólo con `SALE_SHIFT_CLOSED`: el turno en que se vendió, para conciliarlo contra SU corte. */
  saleShiftId?: string
  /** Sólo con `SALE_DRAWER_CLOSED`: la caja en que se vendió, ya cerrada (sin turno ligado o con su turno todavía vivo, Codex r4 #1). */
  saleDrawerId?: string
}

interface ClaimCapturedPaymentShiftInput {
  venueId: string
  amountPesos: Prisma.Decimal
  tipPesos: Prisma.Decimal
  /** Los carriles cuya Order ya contó el turno (B4Bit/manual) no vuelven a incrementarla. */
  incrementTotalOrders: boolean
  /**
   * La Order del cobro, o `null` si todavía no existe (venta rápida, sombra del pago manual). OBLIGATORIO a propósito: una cuenta
   * de tarjetas de regalo no suma una orden al turno, y un llamador que lo olvide debe enterarse en el compilador.
   */
  orderId: string | null
  /**
   * El turno en que se VENDIÓ (`shiftIdDeLaVenta`), sólo de la cola de la terminal. Nunca se estampa: si no es el turno vivo
   * OPEN, el cobro queda sin turno (`SALE_SHIFT_CLOSED`) sin tocar totales; si lo es, todo como hoy. Ausente/vacío, o un id que no
   * es turno de este negocio = como hoy. Si la orden ya tiene turno del servidor, manda el de la orden (`turnoDeLaVentaQueSeRespeta`).
   */
  expectedShiftId?: string | null
  /**
   * S3: `expectedShiftId` salió de la CAJA que el POS capturó al cobrar (`cashDrawerSessionId`), no de la cola de la terminal. Con
   * caja capturada NO se aplica «si la orden ya tiene turno del servidor, manda el de la orden»: la cuenta que el replay materializa
   * al reconectar (OPEN_TABLE, crear orden) nace en el turno vivo y no puede reemplazar dónde quedó el billete (Codex plan r3 #1).
   */
  cajaCapturada?: boolean
  /**
   * S3: la caja capturada ya se cerró y NO tiene turno ligado. «Vino una caja cerrada» no es «no vino nada» (Codex plan r3 #2): el
   * cobro queda sin turno (`SALE_DRAWER_CLOSED`) y nunca se busca el vivo.
   */
  apartePorCajaCerrada?: { cajaId: string }
  /**
   * S3 (Codex r4 código #2): la caja capturada estaba ABIERTA y SIN turno al leerla. Tras el claim se relee: si otro aparato la cerró o
   * la ligó a otro turno a media transacción, el claim se deshace y la venta queda aparte (nunca en el turno nuevo).
   */
  cajaSinTurno?: string
  /**
   * S3 (Codex r6 código #2): la caja capturada estaba ABIERTA y LIGADA a su turno al leerla. Tras el claim se relee: si otro aparato la
   * cerró CONTANDO a media transacción (con su turno todavía abierto), se deshace la suma y la venta queda aparte. Si la cerró el sistema
   * sin conteo, vale: nadie firmó un corte.
   */
  cajaLigadaAbierta?: string
}

/**
 * 🔴 «Cobrar sin red» (D4, revisión de S5 #1): el efectivo de una venta tardía ya lo contó el cajón de SU turno, que está cerrado.
 * Esta marca va en `Payment.posRawData` (la MISMA fila, sin migración y sin depender de `enableShifts`) y le dice al cajón —el
 * posting en línea y el barrido de respaldo (`cash-drawer-reconciler.job.ts`, que la filtra en SQL con este mismo nombre)— que no
 * lo sume a la caja abierta de hoy (su cierre firmaría un faltante falso) ni a la cerrada (recalcularía su corte firmado).
 */
const MARCA_VENTA_DE_TURNO_CERRADO = 'ventaDeTurnoCerrado'

export function marcaDeVentaDeTurnoCerrado(saleShiftId: string | undefined): { ventaDeTurnoCerrado: string } | undefined {
  return saleShiftId ? { [MARCA_VENTA_DE_TURNO_CERRADO]: saleShiftId } : undefined
}

export function esVentaDeTurnoCerrado(posRawData: Prisma.JsonValue | undefined): boolean {
  return typeof posRawData === 'object' && posRawData !== null && !Array.isArray(posRawData) && MARCA_VENTA_DE_TURNO_CERRADO in posRawData
}

/**
 * S3: la hermana de `ventaDeTurnoCerrado` para la caja cerrada SIN turno ligado (`SALE_DRAWER_CLOSED`). Mismo trato: la venta no entra
 * a la caja abierta de hoy (ni en línea ni por el barrido) y ningún corte la adopta por su orden.
 */
const MARCA_CAJA_DE_LA_VENTA_CERRADA = 'cajaDeLaVentaCerrada'

export function marcaDeCajaDeLaVentaCerrada(saleDrawerId: string | undefined): { cajaDeLaVentaCerrada: string } | undefined {
  return saleDrawerId ? { [MARCA_CAJA_DE_LA_VENTA_CERRADA]: saleDrawerId } : undefined
}

export function esVentaDeCajaCerrada(posRawData: Prisma.JsonValue | undefined): boolean {
  return typeof posRawData === 'object' && posRawData !== null && !Array.isArray(posRawData) && MARCA_CAJA_DE_LA_VENTA_CERRADA in posRawData
}

/**
 * S3 (Codex r6 código #1): la caja que el POS capturó al cobrar, en la venta de la cola que NO quedó aparte. El barrido del cajón la usa
 * para reponer el movimiento perdido en ESA caja aunque la hora del cobro quede fuera de su ventana (la cerró el sistema antes de que
 * subiera la venta), en vez de adivinar por la hora la caja que estaba abierta al llegar.
 */
const MARCA_CAJA_DE_LA_VENTA = 'cajaDeLaVenta'

export function marcaDeCajaDeLaVenta(cajaId: string | undefined): { cajaDeLaVenta: string } | undefined {
  return cajaId ? { [MARCA_CAJA_DE_LA_VENTA]: cajaId } : undefined
}

export function cajaDeLaVentaDe(posRawData: Prisma.JsonValue | undefined): string | null {
  if (typeof posRawData !== 'object' || posRawData === null || Array.isArray(posRawData)) return null
  const caja = posRawData[MARCA_CAJA_DE_LA_VENTA]
  return typeof caja === 'string' && caja.length > 0 ? caja : null
}

/** S3: las marcas durables de una venta apartada (por su turno o por su caja cerrada sin turno), para `Payment.posRawData`. */
export function marcasDeVentaApartada(
  claim: Pick<CapturedPaymentShiftClaim, 'saleShiftId' | 'saleDrawerId'>,
): Prisma.InputJsonObject | undefined {
  const marcas = { ...marcaDeVentaDeTurnoCerrado(claim.saleShiftId), ...marcaDeCajaDeLaVentaCerrada(claim.saleDrawerId) }
  return Object.keys(marcas).length > 0 ? marcas : undefined
}

/**
 * S3: la caja que el POS capturó al cobrar, si es de ESTE negocio (una de otro negocio o inexistente se ignora, como un turno
 * inventado). Su `shiftId` (liga 1:1, fase 2 del turno del negocio) es el turno de la venta; puede ser nulo.
 */
export async function laCajaDeLaVenta(
  tx: Pick<Prisma.TransactionClient, 'cashDrawerSession'>,
  venueId: string,
  cashDrawerSessionId: string | null | undefined,
): Promise<{ id: string; status: string; shiftId: string | null; cerradaSinConteo: boolean } | null> {
  if (!cashDrawerSessionId) return null
  // Lectura simple, sin candado (Codex r3 código #3): el cobro no aparta la caja. Las transacciones que tocan caja y turno no van en un
  // solo orden (la apertura del día siguiente va turno → caja; la del mismo día y las reparaciones del barrido, caja → turno), así que
  // cualquier candado de caja dentro del cobro se cruzaba con alguna (40P01, medido). Lo que cambie a media transacción lo cubre la
  // relectura tras el claim (`cajaSinTurno`, Codex r4 código #2). Ver `docs/audit/2026-10-21-efectivo-sin-red-turno/opus-r4-codigo.md`.
  const caja = await tx.cashDrawerSession.findFirst({
    where: { id: cashDrawerSessionId, venueId },
    select: { id: true, status: true, shiftId: true, actualAmount: true, closedByStaffId: true },
  })
  if (!caja) return null
  // Codex r5 código #3: la cerró el SISTEMA (sin conteo ni persona, `isAutoClosedSession`), no un corte firmado.
  const cerradaSinConteo = caja.status === 'CLOSED' && caja.actualAmount == null && caja.closedByStaffId == null
  return { id: caja.id, status: caja.status, shiftId: caja.shiftId, cerradaSinConteo }
}

/** S3: lo que la cola de un aparato dice de la venta —su turno y si su caja ya cerró sin turno—, resuelto UNA vez dentro de la tx. */
export interface VentaDeLaCola {
  /** El turno en que se vendió: `shiftIdDeLaVenta` (TPV) o el ligado a la caja capturada (POS). `null` = como hoy. */
  expectedShiftId: string | null
  /** El turno salió de la caja capturada: la cuenta materializada al reconectar no lo reemplaza (`turnoDeLaVentaQueSeRespeta`). */
  cajaCapturada: boolean
  /** La caja capturada ya se cerró y no tiene turno ligado: la venta queda aparte (`SALE_DRAWER_CLOSED`). */
  apartePorCajaCerrada?: { cajaId: string }
  /** La caja capturada (de este negocio), para que el efectivo del replay vaya a ESA caja y no a la que esté abierta al subir. */
  cajaId?: string
  /** La caja capturada estaba ABIERTA y sin turno: el claim la relee (Codex r4 código #2). */
  cajaSinTurno?: string
  /** La caja capturada estaba ABIERTA y ligada a su turno: el claim la relee (Codex r6 código #2). */
  cajaLigadaAbierta?: string
}

/**
 * S3: un solo lugar para la regla que comparten crear la orden, `registrarAbonoEnTx`, la venta rápida y abrir mesa (OPEN_TABLE).
 * Sólo se llama con un replay de la cola (el llamador ya filtró `isOfflineReplay`). Manda `shiftIdDeLaVenta` cuando viene (la cola de
 * la TPV, que no manda caja); si además vino una caja ligada a OTRO turno, queda rastro en el log, nunca en silencio.
 */
export async function ventaDeLaColaEnTx(
  tx: Pick<Prisma.TransactionClient, 'cashDrawerSession'>,
  venueId: string,
  venta: { shiftIdDeLaVenta?: string | null; cashDrawerSessionId?: string | null },
): Promise<VentaDeLaCola> {
  const caja = await laCajaDeLaVenta(tx, venueId, venta.cashDrawerSessionId)
  if (venta.shiftIdDeLaVenta) {
    if (caja?.shiftId && caja.shiftId !== venta.shiftIdDeLaVenta) {
      logger.warn('[TURNO DE LA VENTA] La caja y el turno de la venta no coinciden', {
        venueId,
        shiftIdDeLaVenta: venta.shiftIdDeLaVenta,
        cashDrawerSessionId: caja.id,
        turnoDeLaCaja: caja.shiftId,
      })
    }
    return { expectedShiftId: venta.shiftIdDeLaVenta, cajaCapturada: false }
  }
  if (!caja) return { expectedShiftId: null, cajaCapturada: false }
  // 🔴 Codex r4 código #1: una caja CERRADA aparta la venta aunque conserve su turno ligado y ese turno siga abierto (el cierre va en dos
  // pasos, caja y luego turno; si el segundo falla, abrir otra caja ese día reutiliza el turno). Su turno viaja para el D4: si ya cerró,
  // el claim la deja como `SALE_SHIFT_CLOSED`, como antes; si sigue vivo, `SALE_DRAWER_CLOSED`.
  // Codex r5 código #3: la que cerró el SISTEMA sola (sin conteo; `cashDrawerAutoClose` no toca el turno) con su turno ligado no aparta:
  // nadie firmó un corte. La venta va a su turno (o `SALE_SHIFT_CLOSED` si ya cerró) y su efectivo sólo a ESA caja (cerrada ⇒ el barrido).
  if (caja.status !== 'OPEN' && caja.shiftId && caja.cerradaSinConteo) {
    return { expectedShiftId: caja.shiftId, cajaCapturada: true, cajaId: caja.id }
  }
  if (caja.status !== 'OPEN') {
    return { expectedShiftId: caja.shiftId, cajaCapturada: true, apartePorCajaCerrada: { cajaId: caja.id }, cajaId: caja.id }
  }
  if (caja.shiftId) return { expectedShiftId: caja.shiftId, cajaCapturada: true, cajaId: caja.id, cajaLigadaAbierta: caja.id }
  return { expectedShiftId: null, cajaCapturada: true, cajaId: caja.id, cajaSinTurno: caja.id }
}

/**
 * S3 (Codex r5 código #1): lo que la venta de la cola le pasa al claim, en UN solo lugar. Los llamadores (`/pay` vía `registrarAbonoEnTx` y
 * `/fast`) usan esto en vez de copiar campo por campo: así ninguno se queda sin la relectura de la caja sin turno.
 */
export function entradaDelClaim(
  venta: VentaDeLaCola,
): Pick<
  ClaimCapturedPaymentShiftInput,
  'expectedShiftId' | 'cajaCapturada' | 'apartePorCajaCerrada' | 'cajaSinTurno' | 'cajaLigadaAbierta'
> {
  return {
    expectedShiftId: venta.expectedShiftId,
    cajaCapturada: venta.cajaCapturada,
    apartePorCajaCerrada: venta.apartePorCajaCerrada,
    cajaSinTurno: venta.cajaSinTurno,
    cajaLigadaAbierta: venta.cajaLigadaAbierta,
  }
}

/**
 * S3: el turno de una orden que NACE en el replay (crear orden, abrir mesa). Misma regla que el pago: venta aparte por caja cerrada, o
 * turno de la venta que no es el vivo (y es de este negocio) ⇒ la orden nace sin turno; si no, el vivo, como hoy.
 */
export async function turnoDeLaOrdenQueNace<T extends { id: string }>(
  tx: Pick<Prisma.TransactionClient, 'shift' | 'cashDrawerSession'>,
  venueId: string,
  venta: VentaDeLaCola,
  turnoVivo: T | null,
): Promise<T | null> {
  if (venta.apartePorCajaCerrada) return null
  // Codex r4 código #2: la caja sin turno se relee DESPUÉS de leer el turno vivo; si cambió, la orden no nace en el turno nuevo.
  if (venta.cajaSinTurno) {
    const ahora = await laCajaDeLaVenta(tx, venueId, venta.cajaSinTurno)
    if (!ahora || ahora.status !== 'OPEN') return null
    if (ahora.shiftId) return ahora.shiftId === turnoVivo?.id ? turnoVivo : null
  }
  const pedido = venta.expectedShiftId
  if (!pedido || pedido === turnoVivo?.id) return turnoVivo
  // Codex r7 código #1: el turno de una caja ya validada no se pone en duda (ver `turnoDeLaVentaQueSeRespeta`).
  if (venta.cajaCapturada) return null
  return (await esTurnoDelNegocio(tx, venueId, pedido)) ? null : turnoVivo
}

/**
 * 🔴 Codex servidor r1 #2: el cobro SIN la marca. Lo usan las consultas que adoptan un cobro sin turno por el turno de su orden
 * (`shift.tpv.service.ts`: el cierre y la lista de turnos): una venta tardía marcada nunca se suma a ningún corte por esa vía.
 * `equals: AnyNull` con `path` es lo único que deja pasar la columna nula, el JSON `null`, los objetos SIN la llave y lo que no es
 * objeto (medido contra Postgres el 21-oct); un `NOT` sobre la llave excluiría en silencio todo eso (`NOT (NULL)` es NULL).
 */
export const COBRO_SIN_MARCA_DE_TURNO_CERRADO: Prisma.PaymentWhereInput = {
  // S3 (Codex plan r4 #2): las DOS marcas de venta apartada. Se usa con spread dentro de un `where` que no trae su propio `AND`.
  AND: [
    { posRawData: { path: [MARCA_VENTA_DE_TURNO_CERRADO], equals: Prisma.AnyNull } },
    { posRawData: { path: [MARCA_CAJA_DE_LA_VENTA_CERRADA], equals: Prisma.AnyNull } },
  ],
}

/** 🔴 Codex servidor r1 #1: ¿es un turno REAL de ESTE negocio? Un id inventado o ajeno no puede sacar una venta del turno vivo. */
export async function esTurnoDelNegocio(db: Pick<Prisma.TransactionClient, 'shift'>, venueId: string, shiftId: string): Promise<boolean> {
  return (await db.shift.findFirst({ where: { id: shiftId, venueId }, select: { id: true } })) !== null
}

/**
 * El turno en que se vendió, el que el cobro respeta (D4), o `null` = como si no viniera (el vivo, como hoy):
 *  · el que mandó la terminal es el vivo OPEN ⇒ ése (aunque la orden sea de un turno anterior: una cuenta abierta que se cobra hoy);
 *  · no es un turno de este negocio ⇒ `null` (Codex servidor r1 #1: un id inventado sacaba el efectivo del arqueo);
 *  · la orden ya tiene turno del servidor ⇒ el de la orden (Codex servidor r1 #2: la terminal la creó EN LÍNEA, el servidor la puso
 *    en su turno vivo y la respuesta se perdió; el turno que la terminal tenía guardado estaba viejo). Sin turno en la orden, el suyo.
 */
async function turnoDeLaVentaQueSeRespeta(
  tx: PaymentShiftTransaction,
  input: ClaimCapturedPaymentShiftInput,
  vivoOpenId: string | null,
): Promise<string | null> {
  const pedido = input.expectedShiftId
  if (!pedido) return null
  if (pedido === vivoOpenId) return pedido
  // 🔴 S3 (Codex r7 código #1): el turno que salió de la caja capturada (`ventaDeLaColaEnTx`, ya validada contra este negocio) no es un id
  // del cliente: si ya no se encuentra es que un ADMIN lo borró desde el panel a media subida (`deleteShift` sólo borra turnos cerrados y
  // suelta la liga de la caja). Se respeta igual ⇒ la venta queda aparte por ese turno; nunca vuelve al vivo.
  if (input.cajaCapturada) return pedido
  if (!(await esTurnoDelNegocio(tx, input.venueId, pedido))) return null
  if (!input.orderId) return pedido
  const orden = await tx.order.findFirst({ where: { id: input.orderId, venueId: input.venueId }, select: { shiftId: true } })
  return orden?.shiftId ?? pedido
}

/**
 * UN solo presupuesto de espera para toda transacción que toma `lockExistingOrderForPayment` (Ruling T8-R2): la espera
 * de un candado cuenta contra el timeout de la transacción interactiva, y con el default de Prisma (5 s / 2 s) un
 * escritor moría con P2028 detrás de un titular al que se le permiten 15 s (la captura fiscal, los escritores TPV).
 * Lo pasa la función que ABRE la transacción; `orderFiscalWriters.test.ts` lo exige en cada una.
 */
export const ORDER_LOCK_WAIT_BUDGET = { timeout: 15_000, maxWait: 5_000 } as const
// Una cadena de cambios de IQ ocupa pocas ventas; 50 permite holgura sin reclamar un historial ilimitado en cada cobro/reembolso.
export const MAX_ORDER_LOCK_SCOPE = 50

/**
 * Lock order global para dinero ligado a una Order durable:
 *
 *   Venue (KEY SHARE) → Orders (createdAt DESC, id DESC; incluye raíces de crédito) → Payment → Shift
 *
 * Un carril de orden nueva/sombra puede reclamar Shift antes de insertar la
 * Order porque todavía no existe una fila Order que otro writer pueda poseer.
 * Toda ruta de orden EXISTENTE llama este helper antes de esperar Payment/Shift.
 */
export async function lockExistingOrderForPayment(
  tx: ExistingOrderLockTransaction,
  input: { venueId: string; orderId: string; additionalOrderIds?: string[] },
): Promise<boolean> {
  // `false` significa «la orden ya no es de este venue» y decide dinero: un
  // doble sin `$queryRaw` no puede contestar eso en silencio. El Prisma
  // TransactionClient real siempre lo expone; un test que llega aquí sin él
  // está mal armado y debe enterarse en esta línea, no tres capas más abajo.
  if (typeof tx.$queryRaw !== 'function') {
    throw new Error('lockExistingOrderForPayment requiere una transacción con $queryRaw')
  }
  const extras = [...new Set(input.additionalOrderIds ?? [])].filter(id => id !== input.orderId)
  // El fence materializado frena el borrado de demos ANTES de poseer sus Orders/Payments.
  const rows = await tx.$queryRaw<Array<{ id: string | null; scopeTooLarge?: boolean }>>`
    WITH RECURSIVE input AS (
      SELECT ${input.orderId}::text AS order_id, ${input.venueId}::text AS venue_id
      ${extras.length ? Prisma.sql`UNION SELECT unnest(${extras}::text[]), ${input.venueId}::text` : Prisma.empty}
    ), ancestors(id) AS (
      SELECT o.id FROM "Order" o JOIN input i ON o.id = i.order_id AND o."venueId" = i.venue_id
      UNION
      SELECT parent.id
      FROM ancestors child
      JOIN "Payment" credit ON credit."orderId" = child.id
      JOIN (SELECT DISTINCT venue_id FROM input) i ON credit."venueId" = i.venue_id
      JOIN "ExchangeCreditLink" link ON link."creditPaymentId" = credit.id AND link."venueId" = credit."venueId"
      JOIN "Payment" root ON root.id = link."originPaymentId" AND root."venueId" = credit."venueId"
      JOIN "Order" parent ON parent.id = root."orderId" AND parent."venueId" = credit."venueId"
    ), scope AS MATERIALIZED (
      SELECT id FROM ancestors LIMIT ${Prisma.raw(String(MAX_ORDER_LOCK_SCOPE + 1))}
    ), size AS MATERIALIZED (
      SELECT COUNT(*) AS n FROM scope
    ), fence AS MATERIALIZED (
      SELECT v.id FROM "Venue" v JOIN (SELECT DISTINCT venue_id FROM input) i ON v.id = i.venue_id
      WHERE (SELECT n FROM size) <= ${Prisma.raw(String(MAX_ORDER_LOCK_SCOPE))}
      FOR KEY SHARE OF v
    ), locked AS MATERIALIZED (
      SELECT o.id
      FROM "Order" o JOIN scope a ON a.id = o.id
      JOIN fence v ON v.id = o."venueId"
      WHERE (SELECT n FROM size) <= ${Prisma.raw(String(MAX_ORDER_LOCK_SCOPE))}
      ORDER BY o."createdAt" DESC, o.id DESC
      FOR UPDATE OF o
    )
    SELECT id, false AS "scopeTooLarge" FROM locked
    UNION ALL
    SELECT NULL::text AS id, true AS "scopeTooLarge" FROM size WHERE n > ${Prisma.raw(String(MAX_ORDER_LOCK_SCOPE))}
  `
  if (Array.isArray(rows) && rows.some(row => row.scopeTooLarge))
    throw new ConflictError(
      'Esta venta tiene demasiados cambios enlazados para procesarla con seguridad. Pide ayuda a soporte con el folio de la venta.',
      'ORDER_LOCK_SCOPE_TOO_LARGE',
    )
  if (input.additionalOrderIds?.length) {
    const current = await tx.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE ancestors(id) AS (
        SELECT id FROM "Order" WHERE "venueId"=${input.venueId}
          AND id=ANY(${[input.orderId, ...input.additionalOrderIds]}::text[])
        UNION
        SELECT parent.id FROM ancestors child
        JOIN "Payment" credit ON credit."orderId"=child.id AND credit."venueId"=${input.venueId}
        JOIN "ExchangeCreditLink" link ON link."creditPaymentId"=credit.id AND link."venueId"=credit."venueId"
        JOIN "Payment" root ON root.id=link."originPaymentId" AND root."venueId"=credit."venueId"
        JOIN "Order" parent ON parent.id=root."orderId" AND parent."venueId"=credit."venueId"
      ) SELECT id FROM ancestors LIMIT ${Prisma.raw(String(MAX_ORDER_LOCK_SCOPE + 1))}`
    const lockedIds = new Set(rows.map(row => row.id))
    if (current.length !== lockedIds.size || current.some(row => !lockedIds.has(row.id)))
      throw new ConflictError('Las ventas enlazadas cambiaron. Intenta de nuevo.', 'ORDER_LOCK_SCOPE_CHANGED')
  }
  return Array.isArray(rows) && rows.some(row => row.id === input.orderId)
}

interface RefundAuthorityReconciliationInput {
  venueId: string
  paymentId: string
  expectedOrderId: string | null
  staffId: string | null
  channel: Extract<RefundPaymentChannel, 'recordRefund' | 'issueRefund'>
}

/**
 * Durable, server-owned signal for the requesting venue when refund authority
 * changes between the tenant-scoped pre-read and the transaction locks.
 *
 * ActivityLog has no unique/idempotency key, so this deliberately does not
 * pretend to offer concurrency deduplication. A rare retry can create a second
 * actionable signal; that is safer than suppressing the only evidence of money
 * already returned by a terminal/operator. The payload contains only ids the
 * requester already supplied or observed — never the replacement tenant.
 */
export async function recordRefundAuthorityReconciliation(
  db: Pick<PrismaClient, 'activityLog'>,
  input: RefundAuthorityReconciliationInput,
): Promise<void> {
  await db.activityLog.create({
    data: {
      action: 'REFUND_AUTHORITY_CHANGED',
      entity: 'Payment',
      entityId: input.paymentId,
      staffId: input.staffId,
      venueId: input.venueId,
      data: {
        status: 'PENDING',
        reason: 'TENANT_AUTHORITY_CHANGED',
        channel: input.channel,
        originalPaymentId: input.paymentId,
        expectedOrderId: input.expectedOrderId,
        resolution: 'Verificar la asignación vigente del cobro antes de registrar manualmente el reembolso.',
      },
    },
  })
}

/**
 * Confirma, sin leer el tenant nuevo, que el job server-owned movió
 * exactamente la generación de Order que observó el flujo de refund.
 *
 * La fila origen `ORDER_VENUE_REASSIGNED` se escribe atómicamente junto con
 * Order+Payment. La generación es el `updatedAt` PREVIO al move, no el reloj
 * de creación del marker: bajo MVCC el job puede construir T1 sin commit, la
 * refund iniciar T2>T1 y aun leer la versión anterior. Filtrar por requester,
 * Order y generación exacta evita tanto ese falso negativo como hacer match
 * con una reasignación histórica distinta, sin revelar el destino.
 */
export async function refundAuthorityReassignmentWasRecorded(
  db: ActivityLogReader,
  input: { venueId: string; orderId: string | null; sourceOrderUpdatedAt: Date | null },
): Promise<boolean> {
  if (!input.orderId || !input.sourceOrderUpdatedAt) return false
  const marker = await db.activityLog.findFirst({
    where: {
      action: 'ORDER_VENUE_REASSIGNED',
      entity: 'Order',
      entityId: input.orderId,
      venueId: input.venueId,
      data: { path: ['sourceOrderUpdatedAt'], equals: input.sourceOrderUpdatedAt.toISOString() },
    },
    select: { id: true },
  })
  return marker !== null
}

/**
 * El procesador puede haber capturado dinero antes de que el servidor descubra
 * que la Order ya no pertenece al requester. No se inventa un Payment contra
 * otro tenant: queda una conciliación durable en el venue que hizo la petición.
 * Reusa la acción owner-facing canónica `PAYMENT_WITHOUT_SHIFT`.
 */
export async function recordCapturedPaymentOrderReconciliation(
  db: Pick<PrismaClient, 'activityLog'>,
  input: {
    venueId: string
    orderId: string
    staffId: string | null
    amountPesos: Prisma.Decimal
    tipPesos: Prisma.Decimal
  },
): Promise<void> {
  await db.activityLog.create({
    data: {
      action: 'PAYMENT_WITHOUT_SHIFT',
      entity: 'Order',
      entityId: input.orderId,
      staffId: input.staffId,
      venueId: input.venueId,
      data: {
        status: 'PENDING',
        reason: 'ORDER_AUTHORITY_UNAVAILABLE',
        channel: 'recordOrderPayment',
        paymentId: null,
        orderId: input.orderId,
        amountPesos: input.amountPesos.toFixed(2),
        tipPesos: input.tipPesos.toFixed(2),
        totalPesos: input.amountPesos.plus(input.tipPesos).toFixed(2),
        resolution: 'Verificar la asignación vigente de la orden y registrar manualmente el cobro capturado.',
      },
    },
  })
}

/**
 * Resuelve el gate ANTES de abrir la transacción de dinero. Una lectura fallida
 * nunca puede deshacer un Payment real: conserva el default habilitado que ya
 * usaba B4Bit y deja el fallo observable en logs.
 */
export async function resolvePaymentShiftReconciliationEnabled(db: PaymentShiftSettingsReader, venueId: string): Promise<boolean> {
  try {
    const settings = await db.venueSettings.findUnique({
      where: { venueId },
      select: { enableShifts: true },
    })
    return settings?.enableShifts ?? true
  } catch (error) {
    logger.warn('⚠️ No se pudo leer `enableShifts`; el cobro fuera de turno se registra igual', {
      venueId,
      error: error instanceof Error ? error.message : error,
    })
    return true
  }
}

/**
 * Resuelve y reclama el turno dentro de la transacción que registra el cobro.
 *
 * El `updateMany` ES el incremento: su filtro toma el candado sólo si la fila
 * todavía pertenece al venue y sigue OPEN/sin fin. Por eso el id devuelto es
 * seguro para estamparse en Order/Payment; un candidato que perdió contra el
 * cierre se conserva únicamente como evidencia de conciliación.
 */
/** La salida «aparte» de una venta de la cola: por su caja cerrada (`SALE_DRAWER_CLOSED`) o por su turno ya cerrado (`SALE_SHIFT_CLOSED`). */
function aparteSinTurno(
  candidate: { id: string; status: ShiftStatus } | null,
  por: { cajaId: string } | { turnoId: string },
): CapturedPaymentShiftClaim {
  const base = { shiftId: null, candidateShiftId: candidate?.id ?? null, observedStatus: candidate?.status ?? null }
  return 'cajaId' in por
    ? { ...base, pendingReason: 'SALE_DRAWER_CLOSED', saleDrawerId: por.cajaId }
    : { ...base, pendingReason: 'SALE_SHIFT_CLOSED', saleShiftId: por.turnoId }
}

/**
 * S3: ¿la caja que se leyó ABIERTA cambió a media transacción? `null` = no (sigue abierta, o la ligaron a `turnoReclamado`).
 *  · sin turno (Codex r4 código #2): cerrada ⇒ aparte por su caja; ligada a OTRO turno ⇒ aparte por ese turno;
 *  · ligada (Codex r6 código #2): cerrada CONTANDO ⇒ aparte por su caja (su corte ya está firmado); cerrada por el sistema sin conteo ⇒
 *    vale (nadie firmó: su efectivo se anota ahí, `admiteCerradaSinConteo`).
 */
async function laCajaAbiertaCambio(
  tx: PaymentShiftTransaction,
  venueId: string,
  caja: { id: string; ligada: boolean },
  turnoReclamado: string | null,
): Promise<{ cajaId: string } | { turnoId: string } | null> {
  const ahora = await laCajaDeLaVenta(tx, venueId, caja.id)
  if (!ahora) return { cajaId: caja.id }
  if (ahora.status !== 'OPEN') return caja.ligada && ahora.cerradaSinConteo ? null : { cajaId: caja.id }
  if (ahora.shiftId && ahora.shiftId !== turnoReclamado) return { turnoId: ahora.shiftId }
  return null
}

export async function claimShiftForCapturedPayment(
  tx: PaymentShiftTransaction,
  input: ClaimCapturedPaymentShiftInput,
): Promise<CapturedPaymentShiftClaim> {
  // 🔴 El candidato es el turno VIVO de la casa (`turnoVivoWhere`: `endTime` nulo Y estado OPEN o
  // CLOSING), no cualquier fila con `endTime` nulo. Con el predicado a secas (hasta el 5-sep-2026)
  // un CLOSED con `endTime` nulo más reciente que el OPEN —anomalía que sólo se sana al ABRIR caja—
  // ganaba el `orderBy` y este claim devolvía SHIFT_NOT_OPEN: el Payment nacía sin turno mientras
  // la Order sí lo recibía por `turnoAbiertoDelNegocio`, y nadie re-estampa ese `shiftId` después.
  const candidate = await tx.shift.findFirst({
    where: turnoVivoWhere(input.venueId),
    orderBy: { startTime: 'desc' },
    select: { id: true, status: true },
  })

  // 🔴 «Cobrar sin red» (D4): una venta tardía de un turno que ya no es el vivo nunca se mezcla en silencio con el nuevo.
  const vivoOpenId = candidate?.status === ShiftStatus.OPEN ? candidate.id : null
  const turnoDeLaVenta = await turnoDeLaVentaQueSeRespeta(tx, input, vivoOpenId)
  if (turnoDeLaVenta && turnoDeLaVenta !== vivoOpenId) {
    return {
      shiftId: null,
      candidateShiftId: candidate?.id ?? null,
      observedStatus: candidate?.status ?? null,
      pendingReason: 'SALE_SHIFT_CLOSED',
      saleShiftId: turnoDeLaVenta,
    }
  }

  // 🔴 S3: la venta de una caja ya cerrada queda aparte; nunca se busca el vivo (Codex plan r3 #2). Va DESPUÉS del D4 para que una caja
  // cerrada con su turno ya cerrado siga siendo `SALE_SHIFT_CLOSED`; aquí llegan la caja sin turno y la de turno todavía vivo (r4 #1).
  if (input.apartePorCajaCerrada) return aparteSinTurno(candidate, { cajaId: input.apartePorCajaCerrada.cajaId })

  // S3: la caja capturada que se leyó ABIERTA (sin turno, o ligada: Codex r6 código #2) se relee antes de dar la venta por buena.
  const cajaAbierta = input.cajaSinTurno
    ? { id: input.cajaSinTurno, ligada: false }
    : input.cajaLigadaAbierta
      ? { id: input.cajaLigadaAbierta, ligada: true }
      : null

  // 🔴 Codex r5 código #2: sin turno vivo OPEN, la caja se relee aquí también (antes de estas salidas no había relectura y la venta
  // perdía su marca y su aviso si la caja cerró a media transacción). La ligada no llega aquí: sin su turno vivo, sale por el D4.
  if ((!candidate || candidate.status !== ShiftStatus.OPEN) && cajaAbierta) {
    const cambio = await laCajaAbiertaCambio(tx, input.venueId, cajaAbierta, null)
    if (cambio) return aparteSinTurno(candidate, cambio)
  }

  if (!candidate) {
    return { shiftId: null, candidateShiftId: null, observedStatus: null, pendingReason: 'NO_SHIFT' }
  }

  if (candidate.status !== ShiftStatus.OPEN) {
    return {
      shiftId: null,
      candidateShiftId: candidate.id,
      observedStatus: candidate.status,
      pendingReason: 'SHIFT_NOT_OPEN',
    }
  }

  // 🔴 Tarjetas de regalo (R3, pendientes 1a): la cuenta de tarjetas suma su dinero a `totalSales` —el turno sí lo cobró; su
  // arreglo de ventas vive en lectura (`ventasDelTurno.ts`)— pero NO es una orden de venta del turno. Basta un renglón con
  // `giftCardId`: las cuentas de tarjetas no se mezclan con mercancía (A5, `giftCardMarks.ts`). Sólo se lee si se iba a contar.
  const esCuentaDeTarjetas =
    input.incrementTotalOrders &&
    input.orderId !== null &&
    Boolean(await tx.orderItem.findFirst({ where: { orderId: input.orderId, ...WHERE_RENGLON_DE_TARJETA }, select: { id: true } }))

  const sumaOrden = input.incrementTotalOrders && !esCuentaDeTarjetas
  const claimed = await tx.shift.updateMany({
    where: {
      id: candidate.id,
      venueId: input.venueId,
      status: ShiftStatus.OPEN,
      endTime: null,
    },
    data: {
      totalSales: { increment: input.amountPesos },
      totalTips: { increment: input.tipPesos },
      ...(sumaOrden ? { totalOrders: { increment: 1 } } : {}),
    },
  })

  // 🔴 S3 (Codex r4 código #2): la caja capturada estaba abierta y sin turno. Con la fila del turno ya apartada por el CAS, se relee: si
  // otro aparato la cerró o la ligó a otro turno a media transacción, la decisión «sin turno ⇒ el vivo» ya no vale; se deshace la suma
  // (mismo turno, misma transacción) y la venta queda aparte, con su aviso. Sigue abierta sin turno, o ligada a ESTE turno ⇒ vale.
  // Codex r6 código #2: lo mismo con la caja LIGADA que otro aparato cerró contando mientras su turno sigue abierto (dos pasos a medias).
  const cambio = cajaAbierta ? await laCajaAbiertaCambio(tx, input.venueId, cajaAbierta, candidate.id) : null
  if (cambio) {
    if (claimed.count === 1) {
      await tx.shift.updateMany({
        where: { id: candidate.id, venueId: input.venueId },
        data: {
          totalSales: { decrement: input.amountPesos },
          totalTips: { decrement: input.tipPesos },
          ...(sumaOrden ? { totalOrders: { decrement: 1 } } : {}),
        },
      })
    }
    return aparteSinTurno(candidate, cambio)
  }

  if (claimed.count === 1) {
    return {
      shiftId: candidate.id,
      candidateShiftId: candidate.id,
      observedStatus: candidate.status,
      pendingReason: null,
    }
  }

  // El cierre ganó el CAS: si era el turno de la venta, ya lo cerró otro aparato (D4), con el mismo motivo que arriba.
  if (turnoDeLaVenta) {
    return {
      shiftId: null,
      candidateShiftId: candidate.id,
      observedStatus: candidate.status,
      pendingReason: 'SALE_SHIFT_CLOSED',
      saleShiftId: turnoDeLaVenta,
    }
  }

  return {
    shiftId: null,
    candidateShiftId: candidate.id,
    observedStatus: candidate.status,
    pendingReason: 'CLAIM_LOST',
  }
}

/**
 * Status-aware entry point for rails that also persist non-terminal Payment
 * attempts. Keeping this branch inside a tested wrapper lets callers bind the
 * result directly to one canonical call: a compound/conditional initializer
 * can no longer make the structural audit claim provenance it did not execute.
 */
export async function claimShiftForCompletedPayment(
  tx: PaymentShiftTransaction,
  input: ClaimCapturedPaymentShiftInput & { paymentStatus: string },
): Promise<CapturedPaymentShiftClaim | null> {
  if (input.paymentStatus !== 'COMPLETED') return null
  const { paymentStatus: _paymentStatus, ...claimInput } = input
  return claimShiftForCapturedPayment(tx, claimInput)
}

interface ClaimRefundShiftInput {
  venueId: string
  salesRefundPesos: Prisma.Decimal
  tipRefundPesos: Prisma.Decimal
  /** Fuerza no atribuir cuando el total previo no puede clasificarse con seguridad entre venta/propina. */
  forcePendingReason?: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY'
  /**
   * El reembolso HEREDA el turno del cobro original y no toca ningún turno (ajuste de reparto,
   * spec KDS Uber §3.1): la venta nació fuera del corte, y descontarla del turno vivo le restaría
   * al cajero de hoy dinero que nunca pasó por su caja. Sin lectura ni CAS ni pendiente.
   */
  inherit?: { shiftId: string | null }
}

/**
 * Reclama el turno para un reembolso sin cruzar el corte temporal `claimedAt`.
 *
 * El candidato incluye `CLOSING` para poder explicar por qué el dinero quedó
 * fuera del corte. Sólo un CAS ganador sobre OPEN autoriza el `shiftId`; el
 * decremento ocurre en ese mismo CAS y nunca reescribe un turno firmado.
 */
export async function claimShiftForRefund(tx: PaymentShiftTransaction, input: ClaimRefundShiftInput): Promise<CapturedPaymentShiftClaim> {
  if (input.inherit) {
    // El turno HEREDADO sale de la fila del cobro original, leída bajo candado por `writeRefundInTx`
    // — nunca del cuerpo de la petición (la guarda «nadie toma el turno del input del cliente»).
    const delCobroOriginal = input.inherit
    return { shiftId: delCobroOriginal.shiftId, candidateShiftId: null, observedStatus: null, pendingReason: null }
  }

  // Mismo predicado que el cobro: el turno VIVO (OPEN o CLOSING, `endTime` nulo). CLOSING sigue
  // entrando a propósito para poder explicar por qué el dinero quedó fuera del corte; CLOSED no.
  const candidate = await tx.shift.findFirst({
    where: turnoVivoWhere(input.venueId),
    orderBy: { startTime: 'desc' },
    select: { id: true, status: true },
  })

  if (input.forcePendingReason) {
    return {
      shiftId: null,
      candidateShiftId: candidate?.id ?? null,
      observedStatus: candidate?.status ?? null,
      pendingReason: input.forcePendingReason,
    }
  }

  if (!candidate) {
    return { shiftId: null, candidateShiftId: null, observedStatus: null, pendingReason: 'NO_SHIFT' }
  }

  if (candidate.status !== ShiftStatus.OPEN) {
    return {
      shiftId: null,
      candidateShiftId: candidate.id,
      observedStatus: candidate.status,
      pendingReason: 'SHIFT_NOT_OPEN',
    }
  }

  const claimed = await tx.shift.updateMany({
    where: {
      id: candidate.id,
      venueId: input.venueId,
      status: ShiftStatus.OPEN,
      endTime: null,
    },
    data: {
      totalSales: { decrement: input.salesRefundPesos },
      ...(input.tipRefundPesos.isZero() ? {} : { totalTips: { decrement: input.tipRefundPesos } }),
    },
  })

  if (claimed.count === 1) {
    return {
      shiftId: candidate.id,
      candidateShiftId: candidate.id,
      observedStatus: candidate.status,
      pendingReason: null,
    }
  }

  return {
    shiftId: null,
    candidateShiftId: candidate.id,
    observedStatus: candidate.status,
    pendingReason: 'CLAIM_LOST',
  }
}

interface RecordPendingPaymentShiftReconciliationInput {
  claim: CapturedPaymentShiftClaim
  venueId: string
  paymentId: string
  orderId: string | null
  staffId: string | null
  channel: PaymentShiftReconciliationChannel
  amountPesos: Prisma.Decimal
  tipPesos: Prisma.Decimal
  /** Parte del total histórico autorizado que no tiene filas clasificables venta/propina. */
  unclassifiedPriorRefundPesos?: Prisma.Decimal
  reconciliationEnabled: boolean
}

/**
 * Hace visible un Payment que no pudo reclamar turno. Se llama después de crear
 * el Payment, usando el mismo `tx`: un rollback/P2002 borra claim y bitácora
 * juntos, y un reintento idempotente que devuelve el ganador nunca llega aquí.
 */
export async function recordPendingPaymentShiftReconciliation(
  tx: PaymentShiftTransaction,
  input: RecordPendingPaymentShiftReconciliationInput,
): Promise<void> {
  if (!input.claim.pendingReason) return

  if (!input.reconciliationEnabled) return

  await tx.activityLog.create({
    data: {
      action: 'PAYMENT_WITHOUT_SHIFT',
      entity: 'Payment',
      entityId: input.paymentId,
      staffId: input.staffId,
      venueId: input.venueId,
      data: {
        status: 'PENDING',
        reason: input.claim.pendingReason,
        paymentId: input.paymentId,
        orderId: input.orderId,
        channel: input.channel,
        amountPesos: input.amountPesos.toFixed(2),
        tipPesos: input.tipPesos.toFixed(2),
        totalPesos: input.amountPesos.add(input.tipPesos).toFixed(2),
        ...(input.claim.candidateShiftId ? { candidateShiftId: input.claim.candidateShiftId } : {}),
        ...(input.claim.observedStatus ? { observedShiftStatus: input.claim.observedStatus } : {}),
        ...(input.claim.saleShiftId ? { saleShiftId: input.claim.saleShiftId } : {}),
        ...(input.claim.saleDrawerId ? { saleDrawerId: input.claim.saleDrawerId } : {}),
        ...(input.unclassifiedPriorRefundPesos
          ? {
              shiftAttributionStatus: 'PENDING',
              unclassifiedPriorRefundPesos: input.unclassifiedPriorRefundPesos.toFixed(2),
            }
          : {}),
      },
    },
  })
}
