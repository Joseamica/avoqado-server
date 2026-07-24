// src/services/mobile/sync.mobile.service.ts

/**
 * Offline-first Fase 1, Corte D — el REDUCER autoritativo de intents.
 * Spec: Avoqado workspace docs/plans/offline-first-pos-fase1.md
 *
 * Los POS (iOS/Android/desktop) escriben cada mutación como intent append-only
 * en su outbox local y la reproducen aquí al reconectar: FIFO por dispositivo,
 * viejo→nuevo, un batch por request. Garantías:
 *
 * 1. IDEMPOTENCIA — [venueId, idempotencyKey] único: un intent ya procesado
 *    devuelve el MISMO ack guardado sin re-aplicar efectos (patrón Stripe).
 * 2. DETERMINISMO — el server nunca responde "no sé": cada intent termina
 *    ACKED o REJECTED con errorCode estructurado; el batch NUNCA truena a
 *    medias (cada intent se resuelve independiente, en orden).
 * 3. IDENTIDAD LOCAL — el dispositivo genera UUIDs (localRef); OPEN_TABLE los
 *    mapea a ids de server y los intents posteriores los resuelven vía el
 *    mapa del batch o PosSyncIntent.localRef (replay en requests separados).
 * 4. MISMAS REGLAS QUE ONLINE — feature gating (TABLE_SERVICE) y propiedad de
 *    mesa (enforceTableOwnership + tables:manage-all) se evalúan por intent:
 *    sincronizar no es una puerta trasera.
 *
 * Delegación: cada tipo reutiliza el MISMO servicio que la ruta online (los
 * broadcasts Socket.IO TABLE_STATUS_CHANGE salen de ahí — todos los clientes
 * del venue ven el estado reconciliado sin código extra aquí).
 */

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { hasFeatureAccess } from '../../middlewares/checkFeatureAccess.middleware'
import { isTableOwnershipEnforced, staffCanManageAllTables } from '../../middlewares/checkTableOwnership.middleware'
import * as tableService from '../tpv/table.tpv.service'
import * as orderTpvService from '../tpv/order.tpv.service'
import * as orderMobileService from './order.mobile.service'

// ─── Contrato (espejo EXACTO por nombre en iOS/Android) ─────────────────────

export type SyncIntentType =
  | 'OPEN_TABLE'
  | 'ADD_ITEMS'
  | 'PAY_CASH'
  | 'APPLY_DISCOUNT'
  | 'APPLY_SERVICE_CHARGE'
  | 'COMP_ORDER'
  | 'UPDATE_DETAILS'
  | 'CANCEL_ORDER'
  | 'MOVE_ORDER'
  | 'ASSIGN_ORDER'
  | 'CLEAR_TABLE'

export interface SyncIntentInput {
  /** UUID del intent generado en el dispositivo (= idempotencyKey). */
  id: string
  /** Secuencia monotónica por dispositivo (orden de replay). */
  seq?: number
  type: SyncIntentType
  /** Payload específico del tipo — ver reducers abajo. */
  payload: Record<string, unknown>
  /** Epoch ms del reloj local al crear el intent (informativo, NUNCA ordena). */
  createdAtLocal?: number
}

export interface SyncIntentAck {
  id: string
  /**
   * ACKED = aplicado (terminal). REJECTED = rechazo de NEGOCIO permanente
   * (terminal — el cliente lo manda a cuarentena). RETRY = condición
   * TRANSITORIA (conflicto de versión, feature-access momentáneo, error de
   * infraestructura): el cliente DEJA el intent en PENDING y reintenta — NO se
   * pierde. Esto arregla el P1 "rechazo transitorio = pérdida permanente".
   */
  status: 'ACKED' | 'REJECTED' | 'RETRY'
  /** Código estructurado cuando REJECTED/RETRY (p.ej. TABLE_OWNED_BY_OTHER, VERSION_CONFLICT). */
  errorCode?: string
  /** Mensaje humano en español para mostrar tal cual. */
  message?: string
  /** Resultado del efecto (ids de server, versión) cuando ACKED. */
  result?: Record<string, unknown>
}

/** Códigos que son TRANSITORIOS → el intent se reintenta, nunca se pierde. */
const RETRYABLE_ERROR_CODES = new Set(['VERSION_CONFLICT'])

const KNOWN_TYPES: SyncIntentType[] = [
  'OPEN_TABLE',
  'ADD_ITEMS',
  'PAY_CASH',
  'APPLY_DISCOUNT',
  'APPLY_SERVICE_CHARGE',
  'COMP_ORDER',
  'UPDATE_DETAILS',
  'CANCEL_ORDER',
  'MOVE_ORDER',
  'ASSIGN_ORDER',
  'CLEAR_TABLE',
]

// ─── Entrada principal ───────────────────────────────────────────────────────

export async function processIntents(params: {
  venueId: string
  staffId: string
  deviceId: string
  intents: SyncIntentInput[]
}): Promise<SyncIntentAck[]> {
  const { venueId, staffId, deviceId } = params
  const acks: SyncIntentAck[] = []
  /** localRef (UUID del dispositivo) → orderId de server, dentro del batch. */
  const localRefMap = new Map<string, string>()

  // 🛡️ Orden FIFO defensivo por seq: el cliente ya manda en orden, pero el
  // server NO debe confiar 100% en eso (cliente viejo/buggy, request a mano).
  // Sin esto, un ADD_ITEMS que llegara antes que su OPEN_TABLE se rechazaría.
  const intents = [...params.intents].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

  logger.info(`🔁 [POS SYNC] Replay de ${intents.length} intents | venue=${venueId} device=${deviceId} staff=${staffId}`)

  for (const intent of intents) {
    // 1. Dedup: ¿ya lo procesamos? Devolver el ack guardado tal cual.
    const existing = await prisma.posSyncIntent.findUnique({
      where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
    })
    if (existing) {
      logger.info(`🔁 [POS SYNC] Intent ${intent.id} ya procesado (${existing.status}) — ack repetido, sin re-aplicar`)
      const result = (existing.resultJson as Record<string, unknown> | null) ?? undefined
      // Reponer el mapa local para intents posteriores del mismo batch.
      if (existing.localRef && result?.orderId) localRefMap.set(existing.localRef, String(result.orderId))
      acks.push({
        id: intent.id,
        status: existing.status as 'ACKED' | 'REJECTED',
        errorCode: existing.errorCode ?? undefined,
        result,
      })
      continue
    }

    // 2. Aplicar — cada intent se resuelve solo; un rechazo NO tumba el batch.
    const ack = await applyIntent({ venueId, staffId, deviceId, intent, localRefMap })

    // RETRY (transitorio): NO se persiste (para que un próximo replay lo
    // re-drive) y se DETIENE el batch — los intents posteriores dependen de
    // este por FIFO, así que se dejan sin procesar (el cliente los mantiene
    // PENDING). Nunca se pierde nada.
    if (ack.status === 'RETRY') {
      acks.push(ack)
      logger.info(`🔁 [POS SYNC] Intent ${intent.id} en RETRY — corto el batch para preservar FIFO`)
      break
    }

    // 3. Persistir el ack (carrera-segura: si otro request ganó la unique,
    //    releemos y devolvemos lo que quedó grabado).
    try {
      await prisma.posSyncIntent.create({
        data: {
          venueId,
          deviceId,
          staffId,
          seq: intent.seq ?? null,
          type: intent.type,
          idempotencyKey: intent.id,
          localRef: typeof intent.payload?.localOrderId === 'string' ? (intent.payload.localOrderId as string) : null,
          status: ack.status,
          errorCode: ack.errorCode ?? null,
          resultJson: ack.result ? (ack.result as import('@prisma/client').Prisma.InputJsonValue) : undefined,
        },
      })
    } catch (persistError: any) {
      if (persistError?.code === 'P2002') {
        const winner = await prisma.posSyncIntent.findUnique({
          where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
        })
        if (winner) {
          acks.push({
            id: intent.id,
            status: winner.status as 'ACKED' | 'REJECTED' | 'RETRY',
            errorCode: winner.errorCode ?? undefined,
            result: (winner.resultJson as Record<string, unknown> | null) ?? undefined,
          })
          continue
        }
      }
      logger.error(`❌ [POS SYNC] No se pudo persistir el ack del intent ${intent.id}`, persistError)
      // El efecto ya corrió: devolvemos el ack real aunque el registro fallara
      // (el reintento del cliente re-aplicará idempotente vía los servicios).
    }

    acks.push(ack)
  }

  const rejected = acks.filter(a => a.status === 'REJECTED').length
  logger.info(`🔁 [POS SYNC] Batch listo: ${acks.length - rejected} ACKED, ${rejected} REJECTED`)
  return acks
}

// ─── Reducers por tipo ───────────────────────────────────────────────────────

async function applyIntent(ctx: {
  venueId: string
  staffId: string
  deviceId: string
  intent: SyncIntentInput
  localRefMap: Map<string, string>
}): Promise<SyncIntentAck> {
  const { venueId, staffId, intent, localRefMap } = ctx

  if (!KNOWN_TYPES.includes(intent.type)) {
    // Cliente más nuevo que el server: no perdemos el intent, lo rechazamos
    // estructurado para que el cliente lo deje en cuarentena visible.
    return { id: intent.id, status: 'REJECTED', errorCode: 'UNKNOWN_INTENT_TYPE', message: `Tipo de intent desconocido: ${intent.type}` }
  }

  try {
    switch (intent.type) {
      case 'OPEN_TABLE':
        return await applyOpenTable(venueId, staffId, intent, localRefMap)
      case 'ADD_ITEMS':
        return await applyAddItems(venueId, staffId, intent, localRefMap)
      case 'PAY_CASH':
        return await applyPayCash(venueId, staffId, intent, localRefMap)
      case 'APPLY_DISCOUNT':
      case 'APPLY_SERVICE_CHARGE':
      case 'COMP_ORDER':
      case 'UPDATE_DETAILS':
      case 'CANCEL_ORDER':
      case 'MOVE_ORDER':
      case 'ASSIGN_ORDER':
        return await applyOrderMutation(venueId, staffId, intent, localRefMap)
      case 'CLEAR_TABLE':
        return await applyClearTable(venueId, staffId, intent)
    }
  } catch (error: any) {
    const errorCode = error?.errorCode ?? error?.code ?? 'BUSINESS_RULE'
    // TRANSITORIO (conflicto de versión, etc.) → RETRY: el cliente lo deja
    // PENDING y reintenta; NUNCA se pierde. PERMANENTE (regla de negocio) →
    // REJECTED terminal → cuarentena visible.
    if (RETRYABLE_ERROR_CODES.has(errorCode)) {
      logger.info(`🔁 [POS SYNC] Intent ${intent.type} ${intent.id} transitorio (${errorCode}) — reintentar`)
      return { id: intent.id, status: 'RETRY', errorCode, message: error?.message ?? 'Condición transitoria — reintentar' }
    }
    logger.warn(`⚠️ [POS SYNC] Intent ${intent.type} ${intent.id} rechazado: ${error?.message}`)
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode,
      message: error?.message ?? 'Regla de negocio rechazó el intent',
    }
  }
}

/** Regla de propiedad de mesa — misma semántica que checkTableOwnership. */
async function assertOwnership(venueId: string, staffId: string, orderId: string): Promise<void> {
  if (!(await isTableOwnershipEnforced(venueId))) return
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { tableId: true, servedById: true, servedBy: { select: { firstName: true, lastName: true } } },
  })
  if (!order || !order.tableId) return // mostrador — la regla no aplica
  if (!order.servedById || order.servedById === staffId) return
  if (await staffCanManageAllTables(staffId, venueId)) return
  const ownerName = order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}`.trim() : 'otro mesero'
  const err: any = new Error(`Solo ${ownerName} puede modificar esta mesa`)
  err.errorCode = 'TABLE_OWNED_BY_OTHER'
  throw err
}

async function assertTableService(venueId: string): Promise<void> {
  const access = await hasFeatureAccess(venueId, 'TABLE_SERVICE')
  if (!access.hasAccess) {
    const err: any = new Error('El servicio de mesas requiere el plan PRO')
    err.errorCode = 'FEATURE_LOCKED'
    throw err
  }
}

/**
 * OPEN_TABLE — payload: { tableId, covers?, localOrderId }
 * Reutiliza assignTable (misma función que la ruta online): reusa la orden
 * activa de la mesa o crea una nueva. El ack mapea localOrderId → orderId.
 */
async function applyOpenTable(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
): Promise<SyncIntentAck> {
  await assertTableService(venueId)
  const tableId = String(intent.payload.tableId ?? '')
  const covers = Number(intent.payload.covers ?? 1)
  const localOrderId = typeof intent.payload.localOrderId === 'string' ? intent.payload.localOrderId : null
  if (!tableId) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'INVALID_PAYLOAD', message: 'OPEN_TABLE requiere tableId' }
  }

  // Propiedad de mesa: abrir una mesa ocupada por otro reutilizaría su orden.
  if (await isTableOwnershipEnforced(venueId)) {
    const foreign = await prisma.order.findFirst({
      where: { venueId, tableId, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] }, servedById: { not: staffId } },
      select: { servedBy: { select: { firstName: true, lastName: true } } },
    })
    if (foreign && !(await staffCanManageAllTables(staffId, venueId))) {
      const ownerName = foreign.servedBy ? `${foreign.servedBy.firstName} ${foreign.servedBy.lastName}`.trim() : 'otro mesero'
      return { id: intent.id, status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER', message: `Solo ${ownerName} puede modificar esta mesa` }
    }
  }

  const { order, isNewOrder } = await tableService.assignTable(venueId, tableId, staffId, covers)
  if (localOrderId) localRefMap.set(localOrderId, order.id)
  return {
    id: intent.id,
    status: 'ACKED',
    result: {
      orderId: order.id,
      orderNumber: (order as any).orderNumber ?? null,
      version: (order as any).version ?? 1,
      isNewOrder,
      ...(localOrderId ? { localOrderId } : {}),
    },
  }
}

/** Resuelve el orderId real: id de server directo, o localOrderId vía mapa/BD. */
async function resolveOrderId(
  venueId: string,
  payload: Record<string, unknown>,
  localRefMap: Map<string, string>,
): Promise<string | null> {
  const direct = typeof payload.orderId === 'string' && payload.orderId.length > 0 ? payload.orderId : null
  const localRef = typeof payload.localOrderId === 'string' && payload.localOrderId.length > 0 ? payload.localOrderId : null
  if (direct && !localRef) return direct
  if (localRef) {
    const mapped = localRefMap.get(localRef)
    if (mapped) return mapped
    // Replay en request separado: buscar el OPEN_TABLE ya ackeado.
    const prior = await prisma.posSyncIntent.findFirst({
      where: { venueId, localRef, status: 'ACKED' },
      orderBy: { createdAt: 'desc' },
      select: { resultJson: true },
    })
    const orderId = (prior?.resultJson as Record<string, unknown> | null)?.orderId
    if (typeof orderId === 'string') {
      localRefMap.set(localRef, orderId)
      return orderId
    }
    return direct // último recurso: el id directo si venía
  }
  return null
}

/**
 * ADD_ITEMS — payload: { orderId | localOrderId, items: AddOrderItemInput[] }
 * Ronda nueva (asNewRound=true, semántica Square). La versión optimista se lee
 * del server AL APLICAR: el orden lo garantiza el FIFO por dispositivo, no el
 * baseVersion viejo del cliente offline (evitaría 409 fantasma en todo replay).
 */
async function applyAddItems(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
): Promise<SyncIntentAck> {
  await assertTableService(venueId)
  const orderId = await resolveOrderId(venueId, intent.payload, localRefMap)
  const items = Array.isArray(intent.payload.items) ? (intent.payload.items as any[]) : []
  if (!orderId || items.length === 0) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'INVALID_PAYLOAD', message: 'ADD_ITEMS requiere orderId/localOrderId e items' }
  }
  await assertOwnership(venueId, staffId, orderId)

  const current = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { version: true, status: true } })
  if (!current) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'ORDER_NOT_FOUND', message: 'La orden ya no existe' }
  }

  // 🛡️ Idempotencia de la RONDA: un externalId determinista por item
  // (intent.id + índice) hace que un replay de este ADD_ITEMS actualice las
  // MISMAS filas en vez de crear duplicados (addItemsToOrder ya deduplica por
  // externalId: findFirst → UPDATE quantity=item.quantity, que es reemplazo).
  // Sin esto, un reintento tras "efecto aplicado pero ack no persistido"
  // duplicaba la ronda en cocina y en la cuenta. Solo se inyecta si el cliente
  // no mandó uno propio.
  const itemsWithKey = items.map((it, idx) => (it.externalId ? it : { ...it, externalId: `sync:${intent.id}:${idx}` }))

  const updated = await orderTpvService.addItemsToOrder(venueId, orderId, itemsWithKey, current.version, true)
  return {
    id: intent.id,
    status: 'ACKED',
    result: { orderId, version: (updated as any).version ?? current.version + 1, total: Number((updated as any).total ?? 0) },
  }
}

/**
 * PAY_CASH — payload: { orderId | localOrderId, amountCents, tipCents? }
 * Reutiliza payCashOrder. Regla "Backgrounded": si el server rechaza (p.ej.
 * la orden cambió), el intent queda REJECTED y el CLIENTE reabre la cuenta —
 * jamás se cierra en silencio una venta no registrada.
 */
async function applyPayCash(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
): Promise<SyncIntentAck> {
  const orderId = await resolveOrderId(venueId, intent.payload, localRefMap)
  const amountCents = Number(intent.payload.amountCents ?? NaN)
  const tipCents = Number(intent.payload.tipCents ?? 0)
  if (!orderId || !Number.isFinite(amountCents) || amountCents <= 0) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'INVALID_PAYLOAD', message: 'PAY_CASH requiere orderId/localOrderId y amountCents > 0' }
  }
  await assertOwnership(venueId, staffId, orderId)

  const payment = await orderMobileService.payCashOrder(venueId, orderId, {
    amount: amountCents,
    tip: tipCents,
    staffId,
    // 🛡️ El id del intent ES la llave de idempotencia: si este PAY_CASH se
    // reproduce (incluso concurrentemente antes de que se escriba el registro
    // PosSyncIntent), payCashOrder deduplica y jamás crea un segundo pago.
    idempotencyKey: intent.id,
  })
  return {
    id: intent.id,
    status: 'ACKED',
    result: {
      orderId,
      paymentId: payment.paymentId,
      orderNumber: payment.orderNumber,
      digitalReceipt: payment.digitalReceipt ?? null,
    },
  }
}

/**
 * Mutaciones de UNA orden (descuentos, cargos por servicio, cortesía de
 * cuenta, detalles, cancelar, mover, asignar) — todas comparten el patrón:
 * TABLE_SERVICE gating + resolver orderId (local o real) + regla de propiedad
 * + delegar en el MISMO servicio que la ruta online. Riesgo aceptado y
 * acotado: p.ej. MOVE_ORDER a una mesa que se ocupó mientras tanto → el
 * servicio lo rechaza → REJECTED en cuarentena visible (jamás pisa al otro).
 */
async function applyOrderMutation(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
): Promise<SyncIntentAck> {
  await assertTableService(venueId)
  const orderId = await resolveOrderId(venueId, intent.payload, localRefMap)
  if (!orderId) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'INVALID_PAYLOAD', message: `${intent.type} requiere orderId/localOrderId` }
  }
  await assertOwnership(venueId, staffId, orderId)
  const p = intent.payload

  switch (intent.type) {
    case 'APPLY_DISCOUNT': {
      const discountId = typeof p.discountId === 'string' ? p.discountId : null
      if (!discountId) return invalid(intent, 'APPLY_DISCOUNT requiere discountId')
      await orderMobileService.applyOrderDiscount(venueId, orderId, discountId, staffId)
      break
    }
    case 'APPLY_SERVICE_CHARGE': {
      const serviceChargeId = typeof p.serviceChargeId === 'string' ? p.serviceChargeId : null
      if (!serviceChargeId) return invalid(intent, 'APPLY_SERVICE_CHARGE requiere serviceChargeId')
      const { applyServiceCharge } = await import('./service-charge.mobile.service')
      await applyServiceCharge(venueId, orderId, serviceChargeId, staffId)
      break
    }
    case 'COMP_ORDER': {
      const reason = typeof p.reason === 'string' && p.reason.trim().length > 0 ? p.reason : null
      if (!reason) return invalid(intent, 'COMP_ORDER requiere reason')
      const { compWholeOrder } = await import('./comp-item.mobile.service')
      await compWholeOrder({ venueId, orderId, reason, staffId })
      break
    }
    case 'UPDATE_DETAILS': {
      await orderMobileService.updateOrderDetails(venueId, orderId, {
        name: typeof p.name === 'string' ? p.name : undefined,
        notes: typeof p.notes === 'string' ? p.notes : undefined,
        covers: typeof p.covers === 'number' ? p.covers : undefined,
        customerId: typeof p.customerId === 'string' ? p.customerId : undefined,
        orderType: typeof p.orderType === 'string' ? p.orderType : undefined,
      } as any)
      break
    }
    case 'CANCEL_ORDER': {
      await orderMobileService.cancelOrder(venueId, orderId, typeof p.reason === 'string' ? p.reason : undefined, staffId)
      break
    }
    case 'MOVE_ORDER': {
      const targetTableId = typeof p.targetTableId === 'string' ? p.targetTableId : null
      if (!targetTableId) return invalid(intent, 'MOVE_ORDER requiere targetTableId')
      await tableService.moveOrderToTable(venueId, orderId, targetTableId)
      break
    }
    case 'ASSIGN_ORDER': {
      const newStaffId = typeof p.staffId === 'string' ? p.staffId : null
      if (!newStaffId) return invalid(intent, 'ASSIGN_ORDER requiere staffId')
      await tableService.assignOrderWaiter(venueId, orderId, newStaffId)
      break
    }
  }

  const current = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { version: true } })
  return { id: intent.id, status: 'ACKED', result: { orderId, version: current?.version ?? undefined } }
}

/** CLEAR_TABLE — liberar mesa; el server rechaza si tiene cuenta sin pagar. */
async function applyClearTable(venueId: string, staffId: string, intent: SyncIntentInput): Promise<SyncIntentAck> {
  await assertTableService(venueId)
  const tableId = typeof intent.payload.tableId === 'string' ? intent.payload.tableId : null
  if (!tableId) return invalid(intent, 'CLEAR_TABLE requiere tableId')

  // Propiedad de mesa: liberar la mesa de otro requiere override (misma regla
  // que el middleware con source='table').
  if (await isTableOwnershipEnforced(venueId)) {
    const foreign = await prisma.order.findFirst({
      where: { venueId, tableId, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] }, servedById: { not: staffId } },
      select: { servedBy: { select: { firstName: true, lastName: true } } },
    })
    if (foreign && !(await staffCanManageAllTables(staffId, venueId))) {
      const ownerName = foreign.servedBy ? `${foreign.servedBy.firstName} ${foreign.servedBy.lastName}`.trim() : 'otro mesero'
      return { id: intent.id, status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER', message: `Solo ${ownerName} puede modificar esta mesa` }
    }
  }

  await tableService.clearTable(venueId, tableId)
  return { id: intent.id, status: 'ACKED', result: { tableId } }
}

function invalid(intent: SyncIntentInput, message: string): SyncIntentAck {
  return { id: intent.id, status: 'REJECTED', errorCode: 'INVALID_PAYLOAD', message }
}

// ─── Estado de sync (dashboard/MCP) ─────────────────────────────────────────

/** Últimos intents procesados del venue — visibilidad de replays y rechazos. */
export async function getRecentIntents(venueId: string, limit = 50) {
  return prisma.posSyncIntent.findMany({
    where: { venueId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
    select: {
      id: true,
      deviceId: true,
      staffId: true,
      seq: true,
      type: true,
      status: true,
      errorCode: true,
      createdAt: true,
    },
  })
}
