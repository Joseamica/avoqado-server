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
import { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { hasFeatureAccess } from '../../middlewares/checkFeatureAccess.middleware'
import { isTableOwnershipEnforced, staffCanManageAllTables } from '../../middlewares/checkTableOwnership.middleware'
import * as tableService from '../tpv/table.tpv.service'
import * as orderTpvService from '../tpv/order.tpv.service'
import * as orderMobileService from './order.mobile.service'
import { logAction } from '../dashboard/activity-log.service'

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
  | 'SPLIT_ORDER'
  | 'SPLIT_BY_SEAT'
  | 'MERGE_ORDERS'

export interface SyncIntentInput {
  /** UUID del intent generado en el dispositivo (= idempotencyKey). */
  id: string
  /** Secuencia monotónica por dispositivo (orden de replay). */
  seq?: number
  type: SyncIntentType
  /** Payload específico del tipo — ver reducers abajo. */
  payload: Record<string, unknown>
  /** Actor que originó el intent. Clientes anteriores pueden omitirlo. */
  staffId?: string
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
const RETRYABLE_ERROR_CODES = new Set([
  'VERSION_CONFLICT',
  // Prisma / PostgreSQL transitorios: nunca deben convertirse en cuarentena.
  'P1001', // database unreachable
  'P1002', // connection timeout
  'P1008', // operation timeout
  'P1017', // connection closed
  'P2024', // connection pool timeout
  'P2034', // transaction conflict / deadlock
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
])

/**
 * Una reserva PROCESSING evita que dos replays concurrentes ejecuten el mismo
 * efecto antes de que exista el ACK. Si el proceso muere después del efecto,
 * no se vuelve a ejecutar a ciegas: tras este plazo pasa a conciliación.
 */
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000

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
  'SPLIT_ORDER',
  'SPLIT_BY_SEAT',
  'MERGE_ORDERS',
]

/**
 * Espejo de los permisos de las rutas online equivalentes. El endpoint de
 * replay acepta varios tipos en un mismo batch, por lo que un único
 * `checkPermission('orders:create')` no puede autorizarlo correctamente.
 */
export function requiredPermissionForIntent(type: string): string | null {
  switch (type) {
    case 'OPEN_TABLE':
    case 'ADD_ITEMS':
    case 'CLEAR_TABLE':
      return 'orders:create'
    case 'PAY_CASH':
      return 'payments:create'
    case 'CANCEL_ORDER':
      return 'orders:cancel'
    case 'APPLY_DISCOUNT':
    case 'APPLY_SERVICE_CHARGE':
    case 'COMP_ORDER':
    case 'UPDATE_DETAILS':
    case 'MOVE_ORDER':
    case 'ASSIGN_ORDER':
    case 'SPLIT_ORDER':
    case 'SPLIT_BY_SEAT':
    case 'MERGE_ORDERS':
      return 'orders:update'
    default:
      return null
  }
}

async function ackFromExisting(existing: any, intentId: string): Promise<SyncIntentAck> {
  if (existing.status !== 'PROCESSING') {
    return {
      id: intentId,
      status: existing.status as 'ACKED' | 'REJECTED',
      errorCode: existing.errorCode ?? undefined,
      result: (existing.resultJson as Record<string, unknown> | null) ?? undefined,
    }
  }

  const createdAt = existing.createdAt instanceof Date ? existing.createdAt.getTime() : Date.now()
  if (Date.now() - createdAt < PROCESSING_TIMEOUT_MS) {
    return {
      id: intentId,
      status: 'RETRY',
      errorCode: 'INTENT_IN_PROGRESS',
      message: 'La operación sigue procesándose. Reintenta en unos segundos.',
    }
  }

  // Resultado incierto: pudo aplicarse el efecto y caer antes del ACK. La
  // alternativa peligrosa sería reejecutarlo y duplicar rondas, splits o caja.
  await prisma.posSyncIntent.update({
    where: { venueId_idempotencyKey: { venueId: existing.venueId, idempotencyKey: existing.idempotencyKey } },
    data: { status: 'REJECTED', errorCode: 'OUTCOME_UNKNOWN' },
  })
  return {
    id: intentId,
    status: 'REJECTED',
    errorCode: 'OUTCOME_UNKNOWN',
    message: 'No se pudo confirmar si la operación terminó. Revisa la cuenta antes de repetirla.',
  }
}

// ─── Entrada principal ───────────────────────────────────────────────────────

export async function processIntents(params: {
  venueId: string
  staffId: string
  deviceId: string
  intents: SyncIntentInput[]
  authorizeIntent: (intent: SyncIntentInput, requiredPermission: string) => boolean
}): Promise<SyncIntentAck[]> {
  const { venueId, staffId, deviceId, authorizeIntent } = params
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
      const ack = await ackFromExisting(existing, intent.id)
      const result = ack.result
      // Reponer el mapa local para intents posteriores del mismo batch.
      if (existing.localRef && result?.orderId) localRefMap.set(existing.localRef, String(result.orderId))
      acks.push(ack)
      if (ack.status === 'RETRY') break
      continue
    }

    // Fence monotónico: una reinstalación/bug no puede reutilizar una seq con
    // otro UUID y ejecutar una operación vieja como si fuera nueva. Clientes
    // legacy sin seq siguen soportados.
    if (typeof intent.seq === 'number') {
      const latestForDevice = await prisma.posSyncIntent.findFirst({
        where: { venueId, deviceId, seq: { not: null } },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      })
      if (typeof latestForDevice?.seq === 'number' && latestForDevice.seq >= intent.seq) {
        acks.push({
          id: intent.id,
          status: 'REJECTED',
          errorCode: 'STALE_DEVICE_SEQUENCE',
          message: 'La secuencia del dispositivo ya fue utilizada. Requiere revisión antes de repetir la operación.',
        })
        continue
      }
    }

    // 2. Reservar ANTES del efecto. La unique hace de compare-and-set: sólo
    // un request puede ejecutar; los concurrentes observan PROCESSING.
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
          status: 'PROCESSING',
        },
      })
    } catch (reserveError: any) {
      if (reserveError?.code === 'P2002') {
        const winner = await prisma.posSyncIntent.findUnique({
          where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
        })
        if (winner) {
          const winnerAck = await ackFromExisting(winner, intent.id)
          acks.push(winnerAck)
          if (winnerAck.status === 'RETRY') break
          continue
        }
        if (typeof intent.seq === 'number') {
          const sequenceWinner = await prisma.posSyncIntent.findFirst({
            where: { venueId, deviceId, seq: intent.seq },
            select: { idempotencyKey: true },
          })
          if (sequenceWinner) {
            acks.push({
              id: intent.id,
              status: 'REJECTED',
              errorCode: 'STALE_DEVICE_SEQUENCE',
              message: 'La secuencia del dispositivo pertenece a otra operación. Requiere revisión.',
            })
            continue
          }
        }
      }
      logger.error(`❌ [POS SYNC] No se pudo reservar el intent ${intent.id}`, reserveError)
      acks.push({
        id: intent.id,
        status: 'RETRY',
        errorCode: reserveError?.code ?? 'INTENT_RESERVATION_FAILED',
        message: 'No se pudo reservar la operación de forma segura. Reintenta.',
      })
      break
    }

    // 3. Autorizar + aplicar. El actor persistido evita que una operación
    // encolada por una persona termine atribuida a quien inició sesión después.
    let ack: SyncIntentAck
    if (intent.staffId && intent.staffId !== staffId) {
      ack = {
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'ACTOR_MISMATCH',
        message: 'La operación pertenece a otra sesión. Requiere revisión del gerente.',
      }
    } else {
      const requiredPermission = requiredPermissionForIntent(intent.type)
      if (requiredPermission && !authorizeIntent(intent, requiredPermission)) {
        ack = {
          id: intent.id,
          status: 'REJECTED',
          errorCode: 'PERMISSION_DENIED',
          message: `No tienes permiso para reproducir ${intent.type}.`,
        }
        void logAction({
          staffId,
          venueId,
          action: 'PERMISSION_DENIED',
          entity: 'pos-sync-intent',
          entityId: intent.id,
          data: { permission: requiredPermission, intentType: intent.type, deviceId },
        })
      } else {
        ack = await applyIntent({ venueId, staffId, deviceId, intent, localRefMap })
      }
    }

    // RETRY (transitorio): NO se persiste (para que un próximo replay lo
    // re-drive) y se DETIENE el batch — los intents posteriores dependen de
    // este por FIFO, así que se dejan sin procesar (el cliente los mantiene
    // PENDING). Nunca se pierde nada.
    if (ack.status === 'RETRY') {
      // No hubo resultado terminal: liberar la reserva permite el próximo
      // intento. El reducer sólo devuelve RETRY para errores transitorios.
      await prisma.posSyncIntent
        .delete({
          where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
        })
        .catch(error => logger.error(`❌ [POS SYNC] No se pudo liberar reserva RETRY ${intent.id}`, error))
      acks.push(ack)
      logger.info(`🔁 [POS SYNC] Intent ${intent.id} en RETRY — corto el batch para preservar FIFO`)
      break
    }

    // 4. Cerrar la reserva con el ACK terminal. Si esta escritura cae después
    // del efecto, PROCESSING impide una segunda ejecución y fuerza revisión.
    try {
      await prisma.posSyncIntent.update({
        where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
        data: {
          status: ack.status,
          errorCode: ack.errorCode ?? null,
          resultJson: ack.result ? (ack.result as Prisma.InputJsonValue) : Prisma.DbNull,
        },
      })
    } catch (persistError: any) {
      logger.error(`❌ [POS SYNC] No se pudo persistir el ack del intent ${intent.id}`, persistError)
      // El efecto ya corrió: devolvemos el resultado a este request, pero el
      // registro queda PROCESSING. Si se perdió también la respuesta, el
      // próximo replay NO re-aplica; termina en conciliación OUTCOME_UNKNOWN.
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
      case 'SPLIT_ORDER':
        return await applySplitOrder(venueId, staffId, intent, localRefMap)
      case 'SPLIT_BY_SEAT':
        return await applySplitBySeat(venueId, staffId, intent, localRefMap)
      case 'MERGE_ORDERS':
        return await applyMergeOrders(venueId, staffId, intent, localRefMap)
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
      return {
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'TABLE_OWNED_BY_OTHER',
        message: `Solo ${ownerName} puede modificar esta mesa`,
      }
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
async function resolveOrderId(venueId: string, payload: Record<string, unknown>, localRefMap: Map<string, string>): Promise<string | null> {
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

    // 🔴 Cheques NACIDOS de un split (bug encontrado en pruebas E2E 2026-07-25).
    // `PosSyncIntent.localRef` guarda SOLO el localOrderId del payload — o sea la
    // orden ORIGEN. El id local del cheque NUEVO vive dentro del resultJson, así
    // que un cobro que llegue en OTRA petición no lo encontraba y se rechazaba
    // con INVALID_PAYLOAD: efectivo cobrado sin dónde registrarlo.
    // Se busca por contención de JSON, que cubre las dos formas:
    //   SPLIT_ORDER   → { newLocalOrderId, createdOrderId }
    //   SPLIT_BY_SEAT → { created: [{ seat, orderId, localOrderId }] }
    const fromSplit = await resolveFromSplitResult(venueId, localRef)
    if (fromSplit) {
      localRefMap.set(localRef, fromSplit)
      return fromSplit
    }

    return direct // último recurso: el id directo si venía
  }
  return null
}

/**
 * Busca un cheque creado por un split cuyo id LOCAL sea [localRef].
 *
 * Va por SQL crudo a propósito: el filtro de JSON de Prisma no sabe mirar dentro
 * de objetos anidados en un array (el caso de SPLIT_BY_SEAT), y el operador de
 * contención `@>` de Postgres sí, con la misma consulta para ambas formas.
 */
async function resolveFromSplitResult(venueId: string, localRef: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ resultJson: unknown }>>`
    SELECT "resultJson"
    FROM "PosSyncIntent"
    WHERE "venueId" = ${venueId}
      AND status = 'ACKED'
      AND type IN ('SPLIT_ORDER', 'SPLIT_BY_SEAT')
      AND (
        "resultJson" ->> 'newLocalOrderId' = ${localRef}
        OR "resultJson" -> 'created' @> ${JSON.stringify([{ localOrderId: localRef }])}::jsonb
      )
    ORDER BY "createdAt" DESC
    LIMIT 1
  `
  const result = rows[0]?.resultJson as Record<string, unknown> | undefined
  if (!result) return null

  // SPLIT_ORDER: un solo cheque nuevo.
  if (result.newLocalOrderId === localRef && typeof result.createdOrderId === 'string') {
    return result.createdOrderId
  }
  // SPLIT_BY_SEAT: hay que sacar el del asiento que corresponde.
  const created = Array.isArray(result.created) ? (result.created as Array<Record<string, unknown>>) : []
  const match = created.find(c => c.localOrderId === localRef)
  return typeof match?.orderId === 'string' ? match.orderId : null
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
 * PAY_CASH — payload: { orderId | localOrderId, amountCents, tipCents?,
 * method?, externalSource? }
 *
 * El nombre dice CASH por historia: el tipo NO se renombra porque los 14 tipos
 * se espejan por nombre exacto entre server, Android e iOS y cambiarlo rompería
 * los intents ya encolados en dispositivos allá afuera. Desde 2026-07-28
 * transporta CUALQUIER cobro registrado a mano (tarjeta de una terminal ajena,
 * transferencia). Sin `method` sigue siendo efectivo.
 * Reutiliza payCashOrder. Regla "Backgrounded": si el server rechaza (p.ej.
 * la orden cambió), el intent queda REJECTED y el CLIENTE reabre la cuenta —
 * jamás se cierra en silencio una venta no registrada.
 */
/** Métodos que un POS puede declarar a mano; espejo exacto del controller. */
const MANUAL_PAY_METHODS = ['CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'OTHER'] as const
type PayCashMethod = (typeof MANUAL_PAY_METHODS)[number]

async function applyPayCash(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
): Promise<SyncIntentAck> {
  const orderId = await resolveOrderId(venueId, intent.payload, localRefMap)
  const amountCents = Number(intent.payload.amountCents ?? NaN)
  const tipCents = Number(intent.payload.tipCents ?? 0)
  const method = intent.payload.method as PayCashMethod | undefined
  if (method !== undefined && !MANUAL_PAY_METHODS.includes(method)) {
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'INVALID_PAYLOAD',
      message: `PAY_CASH: method inválido (${String(method)})`,
    }
  }
  if (!orderId || !Number.isFinite(amountCents) || amountCents <= 0) {
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'INVALID_PAYLOAD',
      message: 'PAY_CASH requiere orderId/localOrderId y amountCents > 0',
    }
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
    method,
    externalSource: typeof intent.payload.externalSource === 'string' ? intent.payload.externalSource : undefined,
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
      return {
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'TABLE_OWNED_BY_OTHER',
        message: `Solo ${ownerName} puede modificar esta mesa`,
      }
    }
  }

  await tableService.clearTable(venueId, tableId)
  return { id: intent.id, status: 'ACKED', result: { tableId } }
}

/**
 * Resuelve items del cheque cuando el cliente estaba offline.
 *
 * 🔑 Por qué no bastan los itemIds: una ronda enviada sin red entra por
 * ADD_ITEMS, que inyecta el externalId determinista `sync:<intentId>:<idx>`
 * (el ÚNICO identificador que el dispositivo conoce antes de sincronizar —
 * el id de server todavía no existe). El FIFO por dispositivo garantiza que
 * ese ADD_ITEMS ya corrió cuando llega el SPLIT, así que aquí aceptamos ambas
 * formas y las traducimos a ids reales.
 *
 * 🔴 MONEY: resolución TODO-O-NADA. Si una sola referencia no resuelve,
 * rechazamos en vez de separar el subconjunto que sí resolvió — un cheque
 * partido a medias cobra de menos a un cliente y de más al otro, y el mesero
 * no tiene forma de notarlo. Mejor un rechazo visible en cuarentena.
 */
async function resolveItemIds(orderId: string, refs: unknown): Promise<{ ids: string[]; missing: number } | null> {
  if (!Array.isArray(refs) || refs.length === 0) return null

  const directIds: string[] = []
  const externalIds: string[] = []
  for (const raw of refs) {
    if (typeof raw === 'string') {
      directIds.push(raw) // forma corta: itemRefs: ["id1", "id2"]
      continue
    }
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>
      if (typeof r.id === 'string' && r.id.length > 0) directIds.push(r.id)
      else if (typeof r.externalId === 'string' && r.externalId.length > 0) externalIds.push(r.externalId)
    }
  }
  if (directIds.length === 0 && externalIds.length === 0) return null

  const rows = await prisma.orderItem.findMany({
    where: {
      orderId,
      OR: [...(directIds.length ? [{ id: { in: directIds } }] : []), ...(externalIds.length ? [{ externalId: { in: externalIds } }] : [])],
    },
    select: { id: true },
  })
  const ids = [...new Set(rows.map(r => r.id))]
  return { ids, missing: directIds.length + externalIds.length - ids.length }
}

/**
 * SPLIT_ORDER — payload: {
 *   orderId | localOrderId,                              // cheque origen
 *   itemRefs: [{ id? } | { externalId? } | "itemId"],    // qué se separa
 *   newLocalOrderId?                                     // id local del cheque nuevo
 * }
 *
 * Delega en el MISMO splitOrderItems que la ruta online, así que hereda sus
 * guards de dinero (no separar cuentas pagadas, ni con descuento/cargo manual
 * aplicado sobre el total completo). Esos rechazos son permanentes → cuarentena.
 *
 * El id del cheque NUEVO se mapea a newLocalOrderId: así un PAY_CASH posterior
 * sobre el cheque separado resuelve sin que el dispositivo haya visto jamás el
 * id real (mismo mecanismo que OPEN_TABLE).
 */
async function applySplitOrder(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
): Promise<SyncIntentAck> {
  await assertTableService(venueId)
  const orderId = await resolveOrderId(venueId, intent.payload, localRefMap)
  if (!orderId) return invalid(intent, 'SPLIT_ORDER requiere orderId/localOrderId')
  await assertOwnership(venueId, staffId, orderId)

  const resolved = await resolveItemIds(orderId, intent.payload.itemRefs)
  if (!resolved) return invalid(intent, 'SPLIT_ORDER requiere itemRefs')
  if (resolved.missing > 0 || resolved.ids.length === 0) {
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'ITEMS_NOT_RESOLVED',
      message:
        'No se pudieron identificar todos los artículos a separar (pudieron eliminarse o moverse). ' +
        'Revisa la cuenta y vuelve a separarla manualmente.',
    }
  }

  const newLocalOrderId = typeof intent.payload.newLocalOrderId === 'string' ? intent.payload.newLocalOrderId : null
  const result = await orderMobileService.splitOrderItems(venueId, orderId, resolved.ids, staffId)
  if (newLocalOrderId) localRefMap.set(newLocalOrderId, result.created.id)

  return {
    id: intent.id,
    status: 'ACKED',
    result: {
      orderId,
      sourceVersion: result.source.version,
      createdOrderId: result.created.id,
      createdOrderNumber: result.created.orderNumber,
      createdVersion: result.created.version,
      ...(newLocalOrderId ? { newLocalOrderId } : {}),
    },
  }
}

/**
 * SPLIT_BY_SEAT — payload: {
 *   orderId | localOrderId,
 *   seatLocalOrderIds?: { "<asiento>": "<uuid local>" }   // asiento → id local
 * }
 *
 * Divide en un cheque POR ASIENTO, atómico (o se parte completa, o no se parte).
 * El asiento más bajo se queda en la cuenta original.
 *
 * 🔑 Por qué el mapa asiento→id local: esto crea N cheques de golpe, y cada uno
 * puede recibir un cobro después. Con un solo id local no alcanzaría para saber
 * a cuál aterriza cada pago. El dispositivo genera un uuid por asiento ANTES de
 * enviar; aquí mapeamos cada cheque creado al uuid de SU asiento. Los uuids de
 * asientos que el server no llegó a crear (p.ej. el más bajo, que se queda)
 * simplemente no se mapean — sobrar es inofensivo, faltar no.
 */
async function applySplitBySeat(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
): Promise<SyncIntentAck> {
  await assertTableService(venueId)
  const orderId = await resolveOrderId(venueId, intent.payload, localRefMap)
  if (!orderId) return invalid(intent, 'SPLIT_BY_SEAT requiere orderId/localOrderId')
  await assertOwnership(venueId, staffId, orderId)

  const seatMapRaw = intent.payload.seatLocalOrderIds
  const seatMap: Record<string, string> =
    seatMapRaw && typeof seatMapRaw === 'object' && !Array.isArray(seatMapRaw) ? (seatMapRaw as Record<string, string>) : {}

  const result = await orderMobileService.splitOrderBySeat(venueId, orderId, staffId)

  const mapped: Array<{ seat: number; orderId: string; localOrderId?: string }> = []
  for (const created of result.created) {
    const localOrderId = seatMap[String(created.seat)]
    if (typeof localOrderId === 'string' && localOrderId.length > 0) {
      localRefMap.set(localOrderId, created.id)
      mapped.push({ seat: created.seat, orderId: created.id, localOrderId })
    } else {
      mapped.push({ seat: created.seat, orderId: created.id })
    }
  }

  return {
    id: intent.id,
    status: 'ACKED',
    result: { orderId, sourceSeat: result.source.seat, created: mapped },
  }
}

/**
 * MERGE_ORDERS — payload: {
 *   orderId | localOrderId,                    // cheque DESTINO (sobrevive)
 *   sourceOrderId | sourceLocalOrderId,        // cheque ORIGEN (se absorbe)
 * }
 *
 * Ambos lados aceptan id local porque offline se pueden fusionar dos cheques
 * que nacieron sin red (p.ej. abrir mesa + separar, y luego juntarlos otra vez).
 * Propiedad de mesa se valida en AMBOS: absorber el cheque de otro mesero es
 * modificar el suyo.
 */
async function applyMergeOrders(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
): Promise<SyncIntentAck> {
  await assertTableService(venueId)
  const targetOrderId = await resolveOrderId(venueId, intent.payload, localRefMap)
  const sourceOrderId = await resolveOrderId(
    venueId,
    { orderId: intent.payload.sourceOrderId, localOrderId: intent.payload.sourceLocalOrderId },
    localRefMap,
  )
  if (!targetOrderId || !sourceOrderId) {
    return invalid(intent, 'MERGE_ORDERS requiere el cheque destino y el origen (orderId/localOrderId)')
  }
  await assertOwnership(venueId, staffId, targetOrderId)
  await assertOwnership(venueId, staffId, sourceOrderId)

  await orderMobileService.mergeOrders(venueId, targetOrderId, sourceOrderId, staffId)
  const current = await prisma.order.findFirst({ where: { id: targetOrderId, venueId }, select: { version: true } })
  return {
    id: intent.id,
    status: 'ACKED',
    result: { orderId: targetOrderId, mergedFromOrderId: sourceOrderId, version: current?.version ?? undefined },
  }
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
