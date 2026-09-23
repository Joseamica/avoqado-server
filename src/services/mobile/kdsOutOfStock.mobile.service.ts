/**
 * «No tengo este artículo» desde la cocina (spec KDS Uber §3.3) y su reintento humano (§3.5).
 *
 * El cajero pide al proveedor retirar UN renglón de un pedido de reparto ya aceptado. El proveedor
 * le avisa al cliente, y eso no se deshace: por eso cada paso deja rastro durable ANTES de hablarle.
 *
 * 🔴 Aquí NO se mueve dinero. Un 2xx sólo marca el renglón (`applyLineRemoval`); el reembolso lo
 * escribe la reconciliación (`reconcileDeliveryOrderFromProvider`) cuando una foto fresca del
 * proveedor ya no trae el renglón. Si esa lectura falla o lanza, el barrido la liquida después.
 *
 * Cómo se evita avisarle DOS veces al cliente:
 *  · un intento a la vez por pedido: la reserva `REMOVE_ITEM` (§3.2) + ninguna otra acción en curso;
 *  · la respuesta se aplica con CAS sobre `attempts`: la de un intento viejo no toca el vigente;
 *  · timeout / 5xx / 408 / 429 / 409 sin causa ⇒ `UNCERTAIN`, NUNCA un reenvío automático. El único
 *    reenvío es el de una persona, 15 min después, y antes se reconcilia por si ya se retiró.
 */
import { OrderType, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import { NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { reconcileDeliveryOrderFromProvider } from '@/services/delivery-channels/core/deliveryReconciliation.service'
import {
  reservaViva,
  soltarReserva,
  tomarReserva,
  withDeliveryOrderLock,
  type OperacionDeReparto,
} from '@/services/delivery-channels/core/deliveryOrderLock'
import { applyLineRemoval } from '@/services/delivery-channels/core/lineRemoval.service'
import { contexto, recuperarAceptacionDesdeProveedor } from '@/services/delivery-channels/core/respondToDeliveryOrder.service'
import type { ActionResult } from '@/services/delivery-channels/core/types'
import prisma from '@/utils/prismaClient'

import { formatKdsOrderConVenta, type KdsOrderResponse } from './kds.mobile.service'

/** Cuánto espera una persona antes de poder reintentar un aviso que el proveedor no confirmó (§3.5). */
export const REINTENTO_TRAS_MS = 15 * 60_000
/** Spec §3.4: un retiro CONFIRMED que Uber sigue sin reflejar a las 24 h es «retiro sin reflejar en Uber». */
export const RETIRO_SIN_REFLEJAR_MS = 24 * 3_600_000
const CUERPO_MAX = 2_000
/** Texto observado el 27-ago y documentado en el adaptador: tras «listo» el proveedor ya no modifica. */
const CAUSA_TERMINAL_409 = /already been marked ready|cannot modify order/i
const COMANDA_ABIERTA = new Set(['NEW', 'PREPARING'])

export type CodigoConflicto =
  | 'LINE_ID_MISSING'
  | 'NOT_DELIVERY'
  | 'LINK_UNRESOLVED'
  | 'UNSUPPORTED_PROVIDER'
  | 'NOT_ACCEPTED'
  | 'ALREADY_READY'
  | 'DELIVERY_OP_IN_PROGRESS'
  | 'LINE_ACTION_IN_PROGRESS'
  | 'RETRY_NOT_ELIGIBLE'

export type ResultadoRetiro =
  | { kind: 'HECHO'; comanda: KdsOrderResponse }
  | { kind: 'EN_CURSO'; state: 'PENDING' | 'UNCERTAIN'; attempts: number; since: string; canRetryAt: string }
  | { kind: 'CONFLICTO'; code: CodigoConflicto; error: string; ocupadaPor?: OperacionDeReparto }
  | { kind: 'RECHAZADO'; reason?: 'ALREADY_READY'; error: string }

const MENSAJES: Record<CodigoConflicto, string> = {
  LINE_ID_MISSING: 'Este renglón no se puede retirar: la app de delivery no nos dio su identificador.',
  NOT_DELIVERY: 'Este pedido no viene de una app de delivery.',
  LINK_UNRESOLVED: 'No encontramos la tienda de delivery que recibió este pedido.',
  UNSUPPORTED_PROVIDER: 'Esta app de delivery no permite retirar artículos desde aquí.',
  NOT_ACCEPTED: 'La app de delivery todavía no confirma que el pedido está aceptado. Acéptalo primero.',
  ALREADY_READY: 'El pedido ya se marcó como listo: la app de delivery ya no deja quitar artículos.',
  DELIVERY_OP_IN_PROGRESS: 'Espera: hay otra operación en curso sobre este pedido. Intenta en un momento.',
  LINE_ACTION_IN_PROGRESS: 'Espera: se está retirando otro artículo de este pedido; intenta en unos segundos.',
  RETRY_NOT_ELIGIBLE: 'Todavía no se puede reintentar, o alguien más ya lo reintentó. Actualiza la comanda.',
}

/**
 * `LINE_ACTION_IN_PROGRESS` tiene tres causas y las apps muestran el texto tal cual: un retiro
 * en vuelo (termina solo, en segundos), uno en duda (NO termina solo: §3.4 lo deja UNCERTAIN
 * mientras el renglón siga) y el respaldo de unicidad sobre el MISMO renglón.
 */
const LINEA_EN_DUDA = 'Otro artículo de este pedido espera confirmación de la app de reparto; reintenta ése primero.'
const MISMO_RENGLON = 'Alguien más acaba de pedir retirar este mismo artículo; actualiza la comanda.'

const conflicto = (code: CodigoConflicto, extra: { ocupadaPor?: OperacionDeReparto; error?: string } = {}): ResultadoRetiro => ({
  kind: 'CONFLICTO',
  code,
  error: extra.error ?? MENSAJES[code],
  ...(extra.ocupadaPor ? { ocupadaPor: extra.ocupadaPor } : {}),
})

/** Paso 5 del spec: qué PRUEBA la respuesta del proveedor. Sólo un 2xx acredita el retiro. */
export function clasificarRespuesta(r: ActionResult | null): 'CONFIRMED' | 'REJECTED' | 'UNCERTAIN' {
  if (!r) return 'UNCERTAIN' // timeout / red: no se sabe si le avisó al cliente
  if (r.status >= 200 && r.status < 300) return 'CONFIRMED'
  if (r.status === 409) return CAUSA_TERMINAL_409.test(r.raw) ? 'REJECTED' : 'UNCERTAIN'
  if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return 'REJECTED'
  return 'UNCERTAIN'
}

type Contexto = NonNullable<Awaited<ReturnType<typeof contexto>>>
type Linea = { venueId: string; kdsOrderId: string; orderId: string; orderItemId: string; lineId: string; ctx: Contexto }
type Propio = { accionId: string; attempt: number; previo: { lastAttemptAt: Date; retriedByStaffId: string | null } }
type Abierta = { kind: 'ABIERTA'; accionId: string; attempt: number; token: string }
type Apertura = ResultadoRetiro | Abierta | { kind: 'SIN_ACEPTAR' }

/** Paso 1: la cadena de pertenencia, en el orden del spec. Todo acotado por el venue autenticado. */
async function resolverLinea(venueId: string, kdsOrderId: string, itemId: string): Promise<Linea | ResultadoRetiro> {
  const item = await prisma.kdsOrderItem.findFirst({
    where: { id: itemId, kdsOrderId, kdsOrder: { venueId } },
    select: { orderItemId: true, kdsOrder: { select: { orderId: true } } },
  })
  if (!item) throw new NotFoundError('Orden KDS no encontrada')
  if (!item.orderItemId) return conflicto('LINE_ID_MISSING')
  const orderId = item.kdsOrder.orderId
  const venta = orderId ? await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { type: true } }) : null
  if (!orderId || venta?.type !== OrderType.DELIVERY) return conflicto('NOT_DELIVERY')
  const ctx = await contexto(venueId, orderId)
  if (!ctx) return conflicto('LINK_UNRESOLVED')
  if (typeof ctx.adapter.resolveFulfillmentIssues !== 'function') return conflicto('UNSUPPORTED_PROVIDER')
  // El id de línea del PROVEEDOR vive en la venta; sin él no hay qué pedirle que retire.
  const renglon = await prisma.orderItem.findFirst({ where: { id: item.orderItemId, orderId }, select: { externalLineId: true } })
  if (!renglon?.externalLineId) return conflicto('LINE_ID_MISSING')
  return { venueId, kdsOrderId, orderId, orderItemId: item.orderItemId, lineId: renglon.externalLineId, ctx }
}

async function leerComanda(db: Prisma.TransactionClient, l: Linea): Promise<KdsOrderResponse> {
  const k = await db.kdsOrder.findFirstOrThrow({ where: { id: l.kdsOrderId, venueId: l.venueId }, include: { items: true } })
  const venta = await db.order.findFirst({ where: { id: l.orderId, venueId: l.venueId }, select: { type: true, status: true } })
  return formatKdsOrderConVenta(k, venta)
}

const enCurso = (a: { status: string; attempts: number; lastAttemptAt: Date }): ResultadoRetiro => ({
  kind: 'EN_CURSO',
  state: a.status as 'PENDING' | 'UNCERTAIN',
  attempts: a.attempts,
  since: a.lastAttemptAt.toISOString(),
  canRetryAt: new Date(a.lastAttemptAt.getTime() + REINTENTO_TRAS_MS).toISOString(),
})

/**
 * Paso 2, «lo ya hecho, primero». `REJECTED` no está en el spec: repetir el pedido devuelve el
 * mismo rechazo (la unicidad por renglón impide abrir otro intento sobre él).
 */
async function loYaHecho(db: Prisma.TransactionClient, l: Linea, propio?: Propio): Promise<ResultadoRetiro | null> {
  const accion = await db.deliveryLineAction.findUnique({
    where: { orderId_lineId_action: { orderId: l.orderId, lineId: l.lineId, action: 'REMOVE_ITEM' } },
    select: { id: true, status: true, attempts: true, lastAttemptAt: true, providerBody: true },
  })
  const renglon = await db.orderItem.findUnique({ where: { id: l.orderItemId }, select: { removedAt: true } })
  if (accion?.status === 'CONFIRMED' || renglon?.removedAt) return { kind: 'HECHO', comanda: await leerComanda(db, l) }
  if (!accion) return null
  if (propio && accion.id === propio.accionId && accion.status === 'PENDING' && accion.attempts === propio.attempt) return null
  if (accion.status === 'PENDING' || accion.status === 'UNCERTAIN') return enCurso(accion)
  const cuerpo = accion.providerBody ?? ''
  return {
    kind: 'RECHAZADO',
    ...(CAUSA_TERMINAL_409.test(cuerpo) ? { reason: 'ALREADY_READY' as const } : {}),
    error: `La app de delivery no aceptó retirar el artículo${cuerpo ? `: ${cuerpo.slice(0, 200)}` : '.'}`,
  }
}

/** Un reintento que no llegó a salir se deshace: nadie le habló al proveedor con él. */
const deshacerReintento = (tx: Prisma.TransactionClient, p: Propio) =>
  tx.deliveryLineAction.updateMany({
    where: { id: p.accionId, status: 'PENDING', attempts: p.attempt },
    data: {
      status: 'UNCERTAIN',
      attempts: p.attempt - 1,
      lastAttemptAt: p.previo.lastAttemptAt,
      retriedByStaffId: p.previo.retriedByStaffId,
    },
  })

/** Pasos 2-4 bajo el candado del pedido: lo ya hecho → precondiciones → acción PENDING + reserva. */
async function abrir(tx: Prisma.TransactionClient, l: Linea, staffId: string, propio?: Propio): Promise<Apertura> {
  const hecho = await loYaHecho(tx, l, propio)
  if (hecho) return hecho

  const o = await tx.order.findUniqueOrThrow({
    where: { id: l.orderId },
    select: { providerAcceptedAt: true, readyReportedAt: true, deliveryOpInFlight: true, deliveryOpInFlightAt: true },
  })
  if (!o.providerAcceptedAt) return { kind: 'SIN_ACEPTAR' }
  const comanda = await tx.kdsOrder.findUniqueOrThrow({ where: { id: l.kdsOrderId }, select: { status: true } })
  let falla: ResultadoRetiro | null = null
  if (o.readyReportedAt || !COMANDA_ABIERTA.has(comanda.status)) falla = conflicto('ALREADY_READY')
  else if (reservaViva(o)) falla = conflicto('DELIVERY_OP_IN_PROGRESS', { ocupadaPor: o.deliveryOpInFlight as OperacionDeReparto })
  else {
    // 'PENDING' < 'UNCERTAIN': si hay uno en vuelo, ése manda (se resuelve solo en segundos).
    const otra = await tx.deliveryLineAction.findFirst({
      where: {
        orderId: l.orderId,
        venueId: l.venueId,
        status: { in: ['PENDING', 'UNCERTAIN'] },
        ...(propio ? { id: { not: propio.accionId } } : {}),
      },
      orderBy: [{ status: 'asc' }, { id: 'asc' }],
      select: { status: true },
    })
    if (otra) falla = conflicto('LINE_ACTION_IN_PROGRESS', otra.status === 'UNCERTAIN' ? { error: LINEA_EN_DUDA } : {})
  }
  if (falla) {
    if (propio) await deshacerReintento(tx, propio)
    return falla
  }

  let accionId = propio?.accionId
  if (!accionId) {
    const accion = await tx.deliveryLineAction.create({
      data: {
        venueId: l.venueId,
        orderId: l.orderId,
        orderItemId: l.orderItemId,
        provider: l.ctx.provider,
        externalOrderId: l.ctx.externalOrderId,
        storeId: l.ctx.storeId,
        lineId: l.lineId,
        action: 'REMOVE_ITEM',
        status: 'PENDING',
        origin: 'STAFF',
        requestedByStaffId: staffId,
        attempts: 1,
        lastAttemptAt: new Date(),
      },
      select: { id: true },
    })
    accionId = accion.id
    await tx.activityLog.create({
      data: {
        venueId: l.venueId,
        staffId,
        action: 'DELIVERY_ITEM_REMOVAL_REQUESTED',
        entity: 'Order',
        entityId: l.orderId,
        data: { orderItemId: l.orderItemId, lineId: l.lineId },
      },
    })
  }
  const reserva = await tomarReserva(l.orderId, 'REMOVE_ITEM', tx)
  // Imposible bajo el mismo candado recién comprobado; si pasara, se revierte TODO (acción incluida).
  if (!reserva.ok) throw new Error(`reserva ocupada por ${reserva.ocupadaPor} tras comprobarla libre`)
  return { kind: 'ABIERTA', accionId, attempt: propio?.attempt ?? 1, token: reserva.token }
}

const esDuplicado = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'

/**
 * Abre el intento. Si falta `providerAcceptedAt`, UNA lectura al proveedor intenta recuperarlo
 * (FUERA del candado: es HTTP) y se vuelve a intentar una sola vez [N-17].
 */
async function abrirConAceptacion(l: Linea, staffId: string, propio?: Propio): Promise<ResultadoRetiro | Abierta> {
  for (let recuperada = false; ; recuperada = true) {
    let paso: Apertura
    try {
      paso = await withDeliveryOrderLock(l.orderId, tx => abrir(tx, l, staffId, propio))
    } catch (e) {
      // La unicidad por renglón rechaza al segundo cajero (respaldo del candado).
      if (esDuplicado(e)) return conflicto('LINE_ACTION_IN_PROGRESS', { error: MISMO_RENGLON })
      throw e
    }
    if (paso.kind !== 'SIN_ACEPTAR') return paso
    if (recuperada || !(await recuperarAceptacionDesdeProveedor(l.venueId, l.orderId))) {
      if (propio) await withDeliveryOrderLock(l.orderId, tx => deshacerReintento(tx, propio))
      return conflicto('NOT_ACCEPTED')
    }
  }
}

/** Paso 6: la liquidación. Puede lanzar (tx vencido, replay…): la ruta contesta igual y el barrido la liquida. */
async function reconciliarSinLanzar(orderId: string): Promise<void> {
  try {
    await reconcileDeliveryOrderFromProvider(orderId, { trigger: 'ROUTE' })
  } catch (e) {
    logger.error('🚨 [Delivery] la reconciliación del retiro lanzó: la liquida el barrido', { orderId, error: String(e) })
  }
}

/** Paso 5: el HTTP fuera de todo candado; el resultado se aplica con CAS sobre ESTE intento. */
async function enviarYAplicar(l: Linea, a: Abierta, staffId: string): Promise<ResultadoRetiro> {
  let r: ActionResult | null = null
  let fallo = ''
  try {
    r = await l.ctx.adapter.resolveFulfillmentIssues!(l.ctx.externalOrderId, l.ctx.storeId, [l.lineId])
  } catch (e) {
    fallo = String(e)
    logger.warn('[Delivery] el retiro de renglón no tuvo respuesta del proveedor: queda en duda, sin reenvío', {
      orderId: l.orderId,
      attempt: a.attempt,
      error: fallo,
    })
  }
  const estado = clasificarRespuesta(r)

  let soltada = false
  try {
    const { mia, aplicado } = await withDeliveryOrderLock(l.orderId, async tx => {
      const mia = await soltarReserva(l.orderId, a.token, tx)
      // 🔴 CAS sobre `attempts` [N-19]: la respuesta tardía de un intento anterior no toca el vigente
      // ni degrada un CONFIRMED.
      const cas = await tx.deliveryLineAction.updateMany({
        where: { id: a.accionId, status: 'PENDING', attempts: a.attempt },
        data: {
          status: estado,
          providerStatus: r?.status ?? null,
          providerBody: (r?.raw ?? fallo).slice(0, CUERPO_MAX),
          resolvedAt: estado === 'UNCERTAIN' ? null : new Date(),
        },
      })
      // §3.2(c): con la reserva ya en manos de otra operación, el resultado no se aplica al PEDIDO;
      // la reconciliación marcará el renglón cuando la foto del proveedor lo confirme.
      if (cas.count === 1 && estado === 'CONFIRMED' && mia) {
        await applyLineRemoval(tx, { orderId: l.orderId, orderItemId: l.orderItemId, origin: 'STAFF', staffId })
      }
      return { mia, aplicado: cas.count === 1 }
    })
    soltada = true
    if (mia && !aplicado) {
      // Nada se descarta en silencio: el intento ya no era el vigente (lo movió el barrido, el webhook o un reintento).
      logger.warn('[Delivery] respuesta del proveedor a un intento que ya no es el vigente: no se aplica', {
        orderId: l.orderId,
        attempt: a.attempt,
        status: r?.status ?? null,
        cuerpo: (r?.raw ?? fallo).slice(0, 200),
      })
    }
    if (!mia) {
      logger.error('🚨 [Delivery] resultado TARDÍO del retiro: la reserva ya era de otra operación', {
        orderId: l.orderId,
        attempt: a.attempt,
        status: r?.status,
        aplicadoALaAccion: aplicado,
      })
      await logAction({
        venueId: l.venueId,
        staffId,
        action: 'DELIVERY_OP_LATE_RESULT',
        entity: 'Order',
        entityId: l.orderId,
        data: { operacion: 'REMOVE_ITEM', attempt: a.attempt, httpStatus: r?.status ?? null, aplicadoALaAccion: aplicado },
      })
    }
    if (aplicado && estado === 'CONFIRMED') await reconciliarSinLanzar(l.orderId)
  } finally {
    if (!soltada) {
      await soltarReserva(l.orderId, a.token).catch(e =>
        logger.error('🚨 [Delivery] no se pudo soltar la reserva del retiro (vence sola en 2 min)', {
          orderId: l.orderId,
          error: String(e),
        }),
      )
    }
  }

  const ahora = await loYaHecho(prisma, l)
  if (!ahora) throw new Error(`el retiro ${a.accionId} desapareció tras aplicar su resultado`)
  return ahora
}

/** POST …/items/:itemId/out-of-stock */
export async function reportOutOfStock(venueId: string, kdsOrderId: string, itemId: string, staffId: string): Promise<ResultadoRetiro> {
  const l = await resolverLinea(venueId, kdsOrderId, itemId)
  if ('kind' in l) return l
  const a = await abrirConAceptacion(l, staffId)
  if (a.kind !== 'ABIERTA') return a
  return enviarYAplicar(l, a, staffId)
}

/** POST …/out-of-stock/retry — consentimiento humano nuevo, no un replay (§3.5). */
export async function retryOutOfStock(
  venueId: string,
  kdsOrderId: string,
  itemId: string,
  staffId: string,
  expectedAttempt: number,
): Promise<ResultadoRetiro> {
  const l = await resolverLinea(venueId, kdsOrderId, itemId)
  if ('kind' in l) return l
  const accion = await prisma.deliveryLineAction.findUnique({
    where: { orderId_lineId_action: { orderId: l.orderId, lineId: l.lineId, action: 'REMOVE_ITEM' } },
    select: { id: true, lastAttemptAt: true, retriedByStaffId: true },
  })
  if (!accion) return conflicto('RETRY_NOT_ELIGIBLE')
  // Dos cajeros pulsan a la vez ⇒ UN intento: el CAS sobre `attempts` deja pasar sólo a uno.
  const cas = await prisma.deliveryLineAction.updateMany({
    where: {
      id: accion.id,
      status: 'UNCERTAIN',
      attempts: expectedAttempt,
      lastAttemptAt: { lte: new Date(Date.now() - REINTENTO_TRAS_MS) },
    },
    data: { status: 'PENDING', attempts: expectedAttempt + 1, retriedByStaffId: staffId, lastAttemptAt: new Date() },
  })
  if (cas.count === 0) return conflicto('RETRY_NOT_ELIGIBLE')
  const propio: Propio = {
    accionId: accion.id,
    attempt: expectedAttempt + 1,
    previo: { lastAttemptAt: accion.lastAttemptAt, retriedByStaffId: accion.retriedByStaffId },
  }

  let a: ResultadoRetiro | Abierta
  try {
    // Antes de reenviar: si el proveedor YA no trae el renglón, queda CONFIRMED sin volver a avisar.
    await reconciliarSinLanzar(l.orderId)
    a = await abrirConAceptacion(l, staffId, propio)
  } catch (e) {
    // Un reintento que no llegó a salir no puede quedar como intento PENDING que nadie envió.
    await withDeliveryOrderLock(l.orderId, tx => deshacerReintento(tx, propio)).catch(err =>
      logger.error('🚨 [Delivery] no se pudo deshacer el reintento fallido (el barrido lo pasa a UNCERTAIN)', {
        orderId: l.orderId,
        error: String(err),
      }),
    )
    throw e
  }
  if (a.kind !== 'ABIERTA') return a
  // Sólo un intento que DE VERDAD se abrió deja rastro de reintento.
  void logAction({
    venueId,
    staffId,
    action: 'DELIVERY_ITEM_REMOVAL_RETRIED',
    entity: 'Order',
    entityId: l.orderId,
    data: { orderItemId: l.orderItemId, lineId: l.lineId, attempt: a.attempt },
  })
  return enviarYAplicar(l, a, staffId)
}

/** Vista de sólo lectura (MCP): los retiros de renglón del venue, más recientes primero. */
export async function listDeliveryLineActions(venueId: string, opts: { orderId?: string; limit?: number } = {}) {
  const take = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 100)
  const filas = await prisma.deliveryLineAction.findMany({
    where: { venueId, ...(opts.orderId ? { orderId: opts.orderId } : {}) },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    select: {
      orderId: true,
      orderItemId: true,
      lineId: true,
      status: true,
      settlement: true,
      origin: true,
      attempts: true,
      lastAttemptAt: true,
      providerStatus: true,
      requestedByStaffId: true,
      retriedByStaffId: true,
      createdAt: true,
      resolvedAt: true,
    },
  })
  return {
    items: filas.slice(0, take).map(f => ({
      ...f,
      canRetryAt: f.status === 'UNCERTAIN' ? new Date(f.lastAttemptAt.getTime() + REINTENTO_TRAS_MS) : null,
      unreflectedInProvider:
        f.status === 'CONFIRMED' &&
        (f.settlement === 'PENDING' || f.settlement === 'ACCREDITED') &&
        Date.now() - (f.resolvedAt ?? f.lastAttemptAt).getTime() >= RETIRO_SIN_REFLEJAR_MS,
    })),
    hasMore: filas.length > take,
  }
}
