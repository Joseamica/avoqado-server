import { OrderTableTopologyChanged } from '@/services/shared/tableOrderLock'
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
import AppError, { ConflictError } from '../../errors/AppError'
import { esErrorTransitorio } from '../shared/erroresTransitorios'
import { hayDineroQueSeGuarda } from '../shared/orderBalance'
import { MAX_TERMINAL_PAYMENT_CENTS } from '../shared/inputCaps'
import { esCobroCompletadoDeLaOrden } from '../shared/cuentaCancelada'
import { hasFeatureAccess } from '../../middlewares/checkFeatureAccess.middleware'
import {
  DEFAULT_OWNERSHIP_OVERRIDES,
  PAYMENT_OWNERSHIP_OVERRIDES,
  isTableOwnershipEnforced,
  staffCanManageAllTables,
} from '../../middlewares/checkTableOwnership.middleware'
import * as tableService from '../tpv/table.tpv.service'
import * as orderTpvService from '../tpv/order.tpv.service'
import * as orderMobileService from './order.mobile.service'
import { logAction } from '../dashboard/activity-log.service'
import { writeLegacyActivityAuditTx } from '../activityAudit.service'
import { markKitchenTicket } from '../kds/kitchenTicketAuthoring.service'
import { FOLIO_VALIDO } from '../kds/kitchenTicketPlanning'
import { applyKitchenPreparation, preparationActionSchema, preparationCommandSchema } from '../kds/kitchenPreparation.service'
import { preparationPermissions } from '../kds/kitchenPreparation'
import { motivoDelDescuento } from '../shared/motivoDelDescuento'
import { horaRealDelAparato, llegadaDeLaPeticion } from '../shared/horaRealDelAparato'

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
  | 'KDS_TICKET_MARK'
  | 'KDS_ITEM_PROGRESS'

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
  /**
   * Datos estructurados del rechazo, cuando el error de dominio los trae (aditivo; auditoría Fable 11-sep, P3-4).
   * P. ej. `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` lleva `{ requestId }` del cobro de terminal que bloquea: sin él,
   * la cola ponía el intent en cuarentena sin decir qué cobro había que esperar.
   */
  details?: unknown
}

/**
 * Una reserva PROCESSING evita que dos replays concurrentes ejecuten el mismo
 * efecto antes de que exista el ACK. Si el proceso muere después del efecto,
 * no se vuelve a ejecutar a ciegas: tras este plazo pasa a conciliación.
 */
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000

// ─── Huella transaccional y retoma (plan docs/superpowers/plans/2026-10-13-sync-retoma-por-llave.md) ──────────────
// Medido en el piloto de 32,000 ventas con dos SIGKILL: la reserva PROCESSING de un proceso muerto terminaba en
// OUTCOME_UNKNOWN aunque el efecto fuera comprobable, y la cuenta abierta absorbía las ventas siguientes de la mesa.
// La reserva lleva una MARCA desde que nace y el efecto deja su HUELLA dentro de su propia transacción: con huella el
// efecto ocurrió; sin huella no ocurrió y ya no puede ocurrir (el ejecutor que perdió su turno revierte).

const PROTOCOLO_HUELLA = 'huella-v1'
/** Tipos con huella transaccional (su efecto principal y la huella commitean juntos). */
const RETOMABLES: ReadonlySet<string> = new Set(['OPEN_TABLE', 'ADD_ITEMS', 'PAY_CASH', 'CANCEL_ORDER'])
/** Con la huella, la retoma decide por evidencia y no por el reloj: 60 s sólo evita competir con un ejecutor sano. */
const RETOMA_MS = 60 * 1000

export interface MarcaDeReserva {
  protocolo: typeof PROTOCOLO_HUELLA
  /**
   * Hoy siempre `true`. Una reserva nacida antes de hz:5bda0b30:D3 (11-nov-2026) con una ronda con promoción trae `false`: esa ronda
   * commiteaba en varias transacciones y no se retoma (queda como antes, `OUTCOME_UNKNOWN`).
   */
  retomable: boolean
  huella?: Record<string, unknown>
}

/** Lo que un reducer recibe para dejar su huella DENTRO de la transacción de su efecto. */
export type DejarHuella = (tx: Prisma.TransactionClient, huella: Record<string, unknown>) => Promise<void>

/** El ejecutor perdió su turno (otro request retomó la reserva): su transacción se revierte y nada suyo commitea. */
export class ReservaPerdida extends Error {
  readonly errorCode = 'RESERVA_PERDIDA'
  constructor(intentId: string) {
    super(`La reserva del intent ${intentId} la retomó otro request`)
  }
}

function marcaInicial(intent: SyncIntentInput): MarcaDeReserva | null {
  if (!RETOMABLES.has(intent.type)) return null
  return { protocolo: PROTOCOLO_HUELLA, retomable: true }
}

function leerMarca(resultJson: unknown): MarcaDeReserva | null {
  const valor = resultJson as Partial<MarcaDeReserva> | null
  return valor && typeof valor === 'object' && valor.protocolo === PROTOCOLO_HUELLA ? (valor as MarcaDeReserva) : null
}

/** Filtro de igualdad exacta sobre la columna Json: SQL NULL se compara con `DbNull`, nunca con `null` ambiguo. */
function filtroJson(valor: unknown): Prisma.JsonNullableFilter<'PosSyncIntent'> {
  return valor === null || valor === undefined ? { equals: Prisma.DbNull } : { equals: valor as Prisma.InputJsonValue }
}

/** Exportada para la prueba de integración del ejecutor lento; en producción sólo la usa processIntents. */
export function dejarHuellaCon(venueId: string, intentId: string, reclamo: Date, marca: MarcaDeReserva): DejarHuella {
  return async (tx, huella) => {
    const { count } = await tx.posSyncIntent.updateMany({
      where: { venueId, idempotencyKey: intentId, status: 'PROCESSING', createdAt: reclamo },
      data: { resultJson: { ...marca, huella } as Prisma.InputJsonValue },
    })
    if (count !== 1) throw new ReservaPerdida(intentId)
  }
}

const enCurso = (intentId: string): SyncIntentAck => ({
  id: intentId,
  status: 'RETRY',
  errorCode: 'INTENT_IN_PROGRESS',
  message: 'La operación sigue procesándose. Reintenta en unos segundos.',
})

/** Relee la reserva y contesta lo que diga, sin escribir. Para quien perdió su turno o su cierre. */
async function contestarVigente(venueId: string, intentId: string): Promise<SyncIntentAck> {
  const vigente = await prisma.posSyncIntent.findUnique({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: intentId } } })
  if (!vigente || vigente.status === 'PROCESSING') return enCurso(intentId)
  return ackDeFilaCerrada(vigente, intentId)
}

/**
 * D20: la tabla no guarda el texto de un rechazo (sólo su código), y el rechazo repetido llegaba sin `message`: la TPV y el POS lo
 * mostraban como «El cobro fue rechazado» sin decir por qué. Se repite con un texto fijo por código: el mismo de la primera vez
 * cuando aquel era fijo, y uno genérico para los de dominio (su texto original no se guardó).
 */
function textoDelRechazoRepetido(errorCode: string | null | undefined, tipo: string | null | undefined): string {
  switch (errorCode) {
    case 'ACTOR_MISMATCH':
      return 'La operación pertenece a otra sesión. Requiere revisión del gerente.'
    case 'PERMISSION_DENIED':
      return `No tienes permiso para reproducir ${tipo ?? 'esta operación'}.`
    case 'OUTCOME_UNKNOWN':
      return 'No se pudo confirmar si la operación terminó. Revisa la cuenta antes de repetirla.'
    case 'UNKNOWN_INTENT_TYPE':
      return `Tipo de intent desconocido: ${tipo ?? ''}`.trimEnd()
    default:
      return 'El servidor ya había rechazado esta operación. Revisa la cuenta antes de repetirla.'
  }
}

/** El acuse de una reserva ya cerrada, tal cual se guardó; el rechazo, con su texto (D20). Aditivo: `status`/`errorCode` no cambian. */
function ackDeFilaCerrada(
  fila: { status: string; errorCode: string | null; resultJson: unknown; type?: string | null },
  intentId: string,
): SyncIntentAck {
  const status = fila.status as 'ACKED' | 'REJECTED'
  return {
    id: intentId,
    status,
    errorCode: fila.errorCode ?? undefined,
    ...(status === 'REJECTED' ? { message: textoDelRechazoRepetido(fila.errorCode, fila.type) } : {}),
    result: (fila.resultJson as Record<string, unknown> | null) ?? undefined,
  }
}

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
  'KDS_TICKET_MARK',
  'KDS_ITEM_PROGRESS',
]

/**
 * Espejo de los permisos de las rutas online equivalentes. El endpoint de
 * replay acepta varios tipos en un mismo batch, por lo que un único
 * `checkPermission('orders:create')` no puede autorizarlo correctamente.
 */
export function requiredPermissionForIntent(type: string): string | null {
  switch (type) {
    // Abrir y liberar mesa son actos de SALA, no de comanda: sus rutas online migraron
    // a `tables:update` (auditoría de permisos de piso, "Forma B"). Meter líneas a una
    // cuenta SÍ es comanda y se queda en `orders:create`. Desalinear estos dos mapas
    // convierte apagar el WiFi en la puerta de atrás.
    case 'OPEN_TABLE':
    case 'CLEAR_TABLE':
      return 'tables:update'
    case 'ADD_ITEMS':
      return 'orders:create'
    case 'PAY_CASH':
      return 'payments:create'
    // Espejo de la ruta online: deshacer una venta SIN cobrar es del mostrador; el
    // servicio rechaza cualquier orden con pagos, así que el permiso acotado no alcanza
    // a anular un cheque ya cobrado ni por la vía offline.
    case 'CANCEL_ORDER':
      return 'orders:cancel-unpaid'
    // Cortesía y descuento tienen permiso PROPIO (/orders/:id/comp → orders:comp,
    // /orders/:id/discount* → discounts:apply). Con un genérico 'orders:update', un
    // WAITER/CASHIER reproduciría offline lo que tiene prohibido — el replay no es
    // puerta trasera.
    //
    // Las cinco puertas de la cortesía piden lo mismo (desde el 25-oct; antes las dos de
    // `/mobile` pedían `orders:update` y eran de mesero — decisión del founder «A», 21-oct):
    //
    //   POST /tpv/venues/:id/orders/:orderId/comp              → orders:comp
    //   POST /mobile/venues/:id/orders/:orderId/comp           → orders:comp
    //   POST /mobile/.../orders/:orderId/items/:itemId/comp    → orders:comp
    //   intent COMP_ORDER  (offline)                           → orders:comp
    //   intent ADD_ITEMS con isCortesia (offline)              → orders:comp
    //
    // De fábrica lo trae MANAGER+; el dueño se lo da a otro rol con `tpv-orders:comp`.
    // Fijado en `tests/unit/routes/mobile.cortesia.permiso.routes.test.ts`.
    case 'COMP_ORDER':
      return 'orders:comp'
    case 'APPLY_DISCOUNT':
      return 'discounts:apply'
    // Mover la cuenta a otra mesa es reubicar gente en el salón: mismo permiso de sala
    // que su ruta online. ASIGNAR MESERO se queda en `orders:update` a propósito (el
    // selector de mesero está gateado con ese permiso; ver mesas.permisos-de-mesa.routes.test.ts).
    case 'MOVE_ORDER':
      return 'tables:update'
    case 'APPLY_SERVICE_CHARGE':
    case 'UPDATE_DETAILS':
    case 'ASSIGN_ORDER':
    case 'SPLIT_ORDER':
    case 'SPLIT_BY_SEAT':
      return 'orders:update'
    // 🔴 Fusionar cuentas tiene permiso PROPIO — el mismo que exige la ruta
    // online. Con el genérico `orders:update` bastaba apagar el WiFi para
    // saltarse el candado: el toque se encolaba y el reducer lo aplicaba al
    // reconectar sin PIN de gerente y sin dejar fila en la bitácora.
    case 'MERGE_ORDERS':
      return 'orders:merge'
    // Etapa 3 del KDS: marcar LISTO o «salió en papel» es un acto de cocina sobre una comanda — mismo permiso que el
    // bump y el status en línea (`/kds/orders/:id/bump`, `orders:update`). El rol KITCHEN lo trae.
    case 'KDS_TICKET_MARK':
    case 'KDS_ITEM_PROGRESS':
      return 'orders:update'
    default:
      return null
  }
}

/**
 * TODOS los permisos que exige un intent — los de su tipo MÁS los que dependen
 * de lo que trae el payload.
 *
 * 🔴 El caso que tapa: la cortesía tiene permiso propio online (`orders:comp`)
 * y `COMP_ORDER` ya lo pedía, pero la MISMA cortesía viaja dentro de un
 * `ADD_ITEMS` (`isCortesia: true` deja la línea en total 0) y ese intent sólo
 * pedía `orders:create`, que tiene cualquier mesero. La puerta estaba cerrada
 * y la ventana abierta.
 *
 * Se agrega el permiso, NO se prohíbe el campo: mandar una línea ya de
 * cortesía sin red es un flujo legítimo, y quitarlo dejaría al local sin poder
 * comp-ear durante un apagón.
 */
export function requiredPermissionsForIntent(intent: SyncIntentInput): string[] {
  const base = requiredPermissionForIntent(intent.type)
  const permissions = base ? [base] : []
  if (intent.type === 'KDS_ITEM_PROGRESS') {
    const action = preparationActionSchema.safeParse(intent.payload?.action)
    return action.success ? preparationPermissions(action.data) : permissions
  }

  if (intent.type === 'ADD_ITEMS') {
    const items = Array.isArray(intent.payload?.items) ? (intent.payload.items as any[]) : []
    if (items.some(item => item?.isCortesia === true)) {
      permissions.push('orders:comp')
    }

    // Aplicar una promoción regala mercancía: mismo permiso que aplicar un
    // descuento online (decisión del founder 2026-08-15 — se reusa
    // `discounts:apply`, no se crea uno nuevo, espejando el gate de
    // APPLY_DISCOUNT). A diferencia de `orders:comp` (que ningún rol trae de
    // fábrica), WAITER y CASHIER YA traen `discounts:apply` por default
    // (permissions.ts:652,695) — con roles de fábrica este guard no le quita
    // nada a un mesero. Protege de verdad a los venues con roles
    // personalizados o recortados: sin esto, quitarle `discounts:apply` a un
    // WAITER se evadiría metiendo la promoción dentro de un ADD_ITEMS, que
    // sólo pedía `orders:create`.
    if (items.some(item => item?.promotionRef)) {
      permissions.push('discounts:apply')
    }
  }

  return permissions
}

/**
 * Valida las líneas de un ADD_ITEMS ANTES de aplicarlas.
 *
 * 🔴 El batch sólo se validaba en `id` y `type`: los items entraban como `any`.
 * Una cantidad no positiva bajaba el total de la cuenta, y peor, la deducción
 * de inventario multiplica por `quantity` (`payment.tpv.service.ts`), así que
 * al cobrar SUMABA mercancía al stock en vez de restarla.
 *
 * Devuelve el motivo del rechazo, o null si las líneas son válidas.
 */
function invalidAddItemsReason(items: any[]): string | null {
  for (const item of items) {
    if (!Number.isInteger(item?.quantity) || item.quantity < 1) {
      return 'La cantidad de cada artículo debe ser un entero mayor a cero'
    }
    if (item.customUnitPriceCents != null && (!Number.isInteger(item.customUnitPriceCents) || item.customUnitPriceCents < 0)) {
      return 'El precio de una línea de monto libre no puede ser negativo'
    }
    // Venta por peso: los kilos alimentan la misma deducción de inventario, así
    // que un peso cero o negativo tiene el mismo efecto que una cantidad mala.
    if (item.weightQuantity != null && (typeof item.weightQuantity !== 'number' || !(item.weightQuantity > 0))) {
      return 'El peso de un artículo vendido por peso debe ser mayor a cero'
    }
  }
  return null
}

/**
 * Valida las líneas de PROMOCIÓN de un ADD_ITEMS — espejo EXACTO de lo que
 * rechaza el camino online (`order.mobile.controller.ts` createOrder).
 *
 * Los dos caminos tienen que decir que NO a lo mismo: Android e iOS se escriben
 * contra un solo modelo mental, y una asimetría aquí significa que el mismo
 * carrito cobra distinto según haya red o no.
 *
 * Ambos casos son SUBCOBRO, y por eso se rechaza en vez de adivinar:
 *  - **Mixto**: `applyAddItems` manda el item ENTERO a la rama de promoción, así
 *    que el `productId` que el cajero capturó se evapora sin cobrarse.
 *  - **Cantidad**: el motor cobra UNA instancia por `promotionRef`, así que
 *    `quantity: 3` cobraba 1 combo de 3. El contrato es una línea (un
 *    `promotionInstanceId`) por combo; `quantity: 1` se tolera porque es lo que
 *    emite un carrito normal y no cambia un centavo.
 */
function invalidPromotionLinesReason(items: any[]): string | null {
  for (const item of items) {
    const traeLineaNormal =
      (typeof item.productId === 'string' && item.productId.length > 0) ||
      (typeof item.name === 'string' && item.name.length > 0) ||
      item.unitPrice != null ||
      item.customUnitPriceCents != null
    if (traeLineaNormal) {
      return 'Un item no puede ser producto y promoción a la vez: manda la promoción en su propia línea'
    }
    if (item.quantity != null && item.quantity !== 1) {
      return 'Una promoción no lleva cantidad: manda una línea por combo, cada una con su propio promotionInstanceId'
    }
  }
  return null
}

async function ackFromExisting(existing: any, intentId: string, intentType?: string): Promise<SyncIntentAck> {
  if (existing.type === 'HTTP_OP_V1') {
    return {
      id: intentId,
      status: 'REJECTED',
      errorCode: 'HTTP_OPERATION_RESERVED',
      message: 'Esta operación se recupera por su identidad HTTP',
    }
  }
  if (existing.status !== 'PROCESSING') return ackDeFilaCerrada(existing, intentId)

  const createdAt = existing.createdAt instanceof Date ? existing.createdAt.getTime() : Date.now()
  const edad = Date.now() - createdAt
  // Una reserva con huella transaccional se RETOMA (paso 1 de processIntents), nunca se da por incierta: ni el tiempo
  // ni una petición de otro tipo con la misma llave la cierran (cerrarla borraría la huella).
  if (leerMarca(existing.resultJson)?.retomable) {
    if (existing.type !== intentType) {
      return {
        id: intentId,
        status: 'REJECTED',
        errorCode: 'INTENT_TYPE_MISMATCH',
        message: 'Esta llave pertenece a otra operación. Requiere revisión.',
      }
    }
    if (edad < RETOMA_MS) return enCurso(intentId)
    return {
      id: intentId,
      status: 'RETRY',
      errorCode: 'INTENT_RECOVERING',
      message: 'La operación se interrumpió; se retoma en el siguiente intento.',
    }
  }
  if (edad < PROCESSING_TIMEOUT_MS) return enCurso(intentId)

  // Resultado incierto: pudo aplicarse el efecto y caer antes del ACK. La
  // alternativa peligrosa sería reejecutarlo y duplicar rondas, splits o caja.
  // Condicionado a lo LEÍDO: una lectura vieja no puede pisar un ACK que otro ya cerró.
  const { count } = await prisma.posSyncIntent.updateMany({
    where: {
      venueId: existing.venueId,
      idempotencyKey: existing.idempotencyKey,
      status: 'PROCESSING',
      createdAt: existing.createdAt,
      resultJson: filtroJson(existing.resultJson),
    },
    data: { status: 'REJECTED', errorCode: 'OUTCOME_UNKNOWN', resultJson: Prisma.DbNull },
  })
  if (count !== 1) return contestarVigente(existing.venueId, intentId)
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
  /** Terminal serial from the authenticated session, never deviceId or payload. */
  terminalSerialNumber?: string
  authorizeIntent: (intent: SyncIntentInput, requiredPermission: string) => boolean
}): Promise<SyncIntentAck[]> {
  const { venueId, staffId, deviceId, authorizeIntent } = params
  const acks: SyncIntentAck[] = []
  /** localRef (UUID del dispositivo) → orderId de server, dentro del batch. */
  const localRefMap = new Map<string, string>()
  // Preparation revisions are independent of financial versions. A retry pauses
  // only its own lane; the financial lane still preserves its original FIFO.
  const blockedLanes = new Set<'preparation' | 'financial'>()

  // 🛡️ Orden FIFO defensivo por seq: el cliente ya manda en orden, pero el
  // server NO debe confiar 100% en eso (cliente viejo/buggy, request a mano).
  // Sin esto, un ADD_ITEMS que llegara antes que su OPEN_TABLE se rechazaría.
  const intents = [...params.intents].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

  logger.info(`🔁 [POS SYNC] Replay de ${intents.length} intents | venue=${venueId} device=${deviceId} staff=${staffId}`)

  for (const intent of intents) {
    const lane = intent.type === 'KDS_ITEM_PROGRESS' ? 'preparation' : 'financial'
    if (blockedLanes.has(lane)) continue
    if (intent.id.startsWith('http:v1:') || String(intent.type) === 'HTTP_OP_V1') {
      acks.push({
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'HTTP_OPERATION_RESERVED',
        message: 'Esta operación se recupera por su identidad HTTP',
      })
      continue
    }
    // 1. Dedup: ¿ya lo procesamos? Devolver el ack guardado tal cual.
    const existing = await prisma.posSyncIntent.findUnique({
      where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
    })
    /** Turno de este request sobre la reserva: su `createdAt`. Todo cierre y toda huella van condicionados a él. */
    let reclamo: Date | null = null
    let marca: MarcaDeReserva | null = null
    let huellaPrevia: Record<string, unknown> | undefined
    if (existing) {
      const retoma = await intentarRetomar({
        existing,
        intent,
        venueId,
        staffId,
        deviceId,
        authorizeIntent,
        terminalSerialNumber: params.terminalSerialNumber,
      })
      if (retoma.tipo === 'contestar') {
        const ack = retoma.ack
        // Reponer el mapa local para intents posteriores del mismo batch.
        if (existing.localRef && ack.result?.orderId) localRefMap.set(existing.localRef, String(ack.result.orderId))
        acks.push(ack)
        if (ack.status === 'RETRY') blockedLanes.add(lane)
        continue
      }
      reclamo = retoma.reclamo
      marca = retoma.marca
      huellaPrevia = retoma.marca.huella
      logger.info(
        `🧭 [POS SYNC] Intent ${intent.type} ${intent.id} retomado tras una caída — ${huellaPrevia ? 'con huella: ya ocurrió' : 'sin huella: no ocurrió'}`,
      )
    }

    if (!reclamo) {
      // Fence monotónico: una reinstalación/bug no puede reutilizar una seq con
      // otro UUID y ejecutar una operación vieja como si fuera nueva. Clientes
      // legacy sin seq siguen soportados.
      if (typeof intent.seq === 'number') {
        const latestForDevice = await prisma.posSyncIntent.findFirst({
          where: {
            venueId,
            deviceId,
            seq: { not: null },
            type: lane === 'preparation' ? 'KDS_ITEM_PROGRESS' : { notIn: ['HTTP_OP_V1', 'KDS_ITEM_PROGRESS'] },
          },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        })
        if (typeof latestForDevice?.seq === 'number' && latestForDevice.seq >= intent.seq) {
          // The same UUID may have been reserved after the first lookup; its result wins over the sequence fence.
          const concurrent = await prisma.posSyncIntent.findUnique({
            where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
          })
          if (concurrent) {
            const ack = await ackFromExisting(concurrent, intent.id, intent.type)
            if (concurrent.localRef && ack.result?.orderId) localRefMap.set(concurrent.localRef, String(ack.result.orderId))
            acks.push(ack)
            if (ack.status === 'RETRY') blockedLanes.add(lane)
            continue
          }
          acks.push({
            id: intent.id,
            status: 'REJECTED',
            errorCode: 'STALE_DEVICE_SEQUENCE',
            message: 'La secuencia del dispositivo ya fue utilizada. Requiere revisión antes de repetir la operación.',
            details: { latestSeq: latestForDevice.seq },
          })
          continue
        }
      }

      // 2. Reservar ANTES del efecto. La unique hace de compare-and-set: sólo
      // un request puede ejecutar; los concurrentes observan PROCESSING.
      marca = marcaInicial(intent)
      const nuevoReclamo = new Date()
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
            createdAt: nuevoReclamo,
            ...(marca ? { resultJson: marca as unknown as Prisma.InputJsonValue } : {}),
          },
        })
        reclamo = nuevoReclamo
      } catch (reserveError: any) {
        if (reserveError?.code === 'P2002') {
          const winner = await prisma.posSyncIntent.findUnique({
            where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
          })
          if (winner) {
            const winnerAck = await ackFromExisting(winner, intent.id, intent.type)
            acks.push(winnerAck)
            if (winnerAck.status === 'RETRY') blockedLanes.add(lane)
            continue
          }
          if (typeof intent.seq === 'number') {
            const sequenceWinner = await prisma.posSyncIntent.findFirst({
              where: { venueId, deviceId, seq: intent.seq, type: { not: 'HTTP_OP_V1' } },
              select: { idempotencyKey: true },
            })
            if (sequenceWinner) {
              const latestForDevice = await prisma.posSyncIntent.findFirst({
                where: { venueId, deviceId, seq: { not: null }, type: { not: 'HTTP_OP_V1' } },
                orderBy: { seq: 'desc' },
                select: { seq: true },
              })
              acks.push({
                id: intent.id,
                status: 'REJECTED',
                errorCode: 'STALE_DEVICE_SEQUENCE',
                message: 'La secuencia del dispositivo pertenece a otra operación. Requiere revisión.',
                details: { latestSeq: latestForDevice?.seq ?? intent.seq },
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
        blockedLanes.add(lane)
        continue
      }
    }
    const turno = reclamo as Date

    // 3. Autorizar + aplicar. El actor persistido evita que una operación
    // encolada por una persona termine atribuida a quien inició sesión después.
    let ack: SyncIntentAck
    // KDS_TICKET_MARK queda exento: la tablet de cocina cambia de persona cada turno y la marca no mueve dinero.
    if (intent.staffId && intent.staffId !== staffId && intent.type !== 'KDS_TICKET_MARK') {
      ack = {
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'ACTOR_MISMATCH',
        message: 'La operación pertenece a otra sesión. Requiere revisión del gerente.',
      }
    } else {
      const requiredPermissions = requiredPermissionsForIntent(intent)
      const missingPermission = requiredPermissions.find(permission => !authorizeIntent(intent, permission))
      if (missingPermission) {
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
          data: { permission: missingPermission, intentType: intent.type, deviceId },
        })
      } else if (huellaPrevia && intent.type !== 'PAY_CASH') {
        ack = await ackDesdeHuella(venueId, intent, huellaPrevia, localRefMap)
      } else {
        const dejarHuella = marca?.retomable ? dejarHuellaCon(venueId, intent.id, turno, marca) : undefined
        ack = await applyIntent({
          venueId,
          staffId,
          deviceId,
          intent,
          localRefMap,
          dejarHuella,
          authorizeIntent,
          terminalSerialNumber: params.terminalSerialNumber,
        })
      }
    }

    // Perdió su turno dentro de la transacción del efecto: nada suyo commiteó; contesta lo que haya.
    if (ack.errorCode === 'RESERVA_PERDIDA') {
      const vigente = await contestarVigente(venueId, intent.id)
      acks.push(vigente)
      if (vigente.status === 'RETRY') blockedLanes.add(lane)
      continue
    }

    // RETRY (transitorio): NO se persiste (para que un próximo replay lo
    // re-drive) y se DETIENE su carril. Los posteriores de ese mismo carril
    // quedan sin procesar y PENDING; preparación no detiene cobros ni viceversa.
    if (ack.status === 'RETRY') {
      // No hubo resultado terminal: liberar la reserva permite el próximo
      // intento. El reducer sólo devuelve RETRY para errores transitorios.
      // Sólo la reserva PROPIA (su turno) y SIN huella: si el efecto ya commiteó (falló algo después, o es una retoma
      // que ya traía huella), la huella se queda y la siguiente retoma decide con ella.
      if (!huellaPrevia) {
        await prisma.posSyncIntent
          .deleteMany({
            where: { venueId, idempotencyKey: intent.id, status: 'PROCESSING', createdAt: turno, resultJson: filtroJson(marca) },
          })
          .catch(error => logger.error(`❌ [POS SYNC] No se pudo liberar reserva RETRY ${intent.id}`, error))
      }
      acks.push(ack)
      logger.info(`🔁 [POS SYNC] Intent ${intent.id} en RETRY — pauso ${lane} para preservar su FIFO`)
      blockedLanes.add(lane)
      continue
    }

    // 4. Cerrar la reserva con el ACK terminal. Si esta escritura cae después
    // del efecto, PROCESSING impide una segunda ejecución y fuerza revisión.
    try {
      const { count } = await prisma.posSyncIntent.updateMany({
        where: { venueId, idempotencyKey: intent.id, status: 'PROCESSING', createdAt: turno },
        data: {
          status: ack.status,
          errorCode: ack.errorCode ?? null,
          resultJson: ack.result ? (ack.result as Prisma.InputJsonValue) : Prisma.DbNull,
        },
      })
      if (count !== 1) {
        // Ya no es su turno (otro la retomó) o un servicio la cerró en su transacción: manda la fila.
        const vigente = await contestarVigente(venueId, intent.id)
        acks.push(vigente)
        if (vigente.status === 'RETRY') blockedLanes.add(lane)
        continue
      }
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

// ─── Retoma de una reserva huérfana ─────────────────────────────────────────

type Retoma = { tipo: 'contestar'; ack: SyncIntentAck } | { tipo: 'retomar'; reclamo: Date; marca: MarcaDeReserva }

/**
 * Decide qué hacer con una reserva que ya existe. Sólo se retoma una fila con huella transaccional (`huella-v1`,
 * retomable), del mismo tipo, con ≥ RETOMA_MS y de SU dueño (mismo aparato, persona y secuencia) con permiso vigente.
 * Una petición ajena o sin permiso NUNCA toca la fila: se le contesta sin persistir y la reserva queda para su dueño.
 */
async function intentarRetomar(p: {
  existing: any
  intent: SyncIntentInput
  venueId: string
  staffId: string
  deviceId: string
  authorizeIntent: (intent: SyncIntentInput, requiredPermission: string) => boolean
  terminalSerialNumber?: string
}): Promise<Retoma> {
  const { existing, intent } = p
  const marca = leerMarca(existing.resultJson)
  const edad = Date.now() - (existing.createdAt instanceof Date ? existing.createdAt.getTime() : Date.now())
  if (existing.status !== 'PROCESSING' || !marca?.retomable || existing.type !== intent.type || edad < RETOMA_MS) {
    logger.info(`🔁 [POS SYNC] Intent ${intent.id} ya procesado (${existing.status}) — ack repetido, sin re-aplicar`)
    return { tipo: 'contestar', ack: await ackFromExisting(existing, intent.id, intent.type) }
  }
  const mismoDueño =
    existing.deviceId === p.deviceId &&
    existing.staffId === p.staffId &&
    (existing.seq ?? null) === (intent.seq ?? null) &&
    (!intent.staffId || intent.staffId === p.staffId)
  const sinPermiso = mismoDueño
    ? requiredPermissionsForIntent(intent).find(permission => !p.authorizeIntent(intent, permission))
    : undefined
  if (!mismoDueño || sinPermiso) {
    // D20: antes de rechazar, ¿la huella ya prueba el cobro? Entonces el dinero está registrado y se contesta con él.
    const delCobro = await ackDelCobroYaRegistrado({ ...p, marca })
    if (delCobro) return { tipo: 'contestar', ack: delCobro }
  }
  if (!mismoDueño) {
    return {
      tipo: 'contestar',
      ack: {
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'ACTOR_MISMATCH',
        message: 'La operación quedó apartada por otra sesión o aparato. Requiere revisión del gerente.',
      },
    }
  }
  if (sinPermiso) {
    return {
      tipo: 'contestar',
      ack: {
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'PERMISSION_DENIED',
        message: `No tienes permiso para reproducir ${intent.type}.`,
      },
    }
  }
  const reclamo = new Date()
  const { count } = await prisma.posSyncIntent.updateMany({
    where: {
      venueId: p.venueId,
      idempotencyKey: intent.id,
      status: 'PROCESSING',
      createdAt: existing.createdAt,
      resultJson: filtroJson(existing.resultJson),
    },
    data: { createdAt: reclamo },
  })
  if (count !== 1) return { tipo: 'contestar', ack: await contestarVigente(p.venueId, intent.id) }
  return { tipo: 'retomar', reclamo, marca }
}

/**
 * D20 (hz:72be07e6:D20): la reserva de un PAY_CASH quedó abierta CON su huella (el cobro commiteó y el servidor cayó antes de cerrarla)
 * y la reenvía el mismo aparato con otra persona en sesión, con otra secuencia o sin el permiso de hoy. Retomarla no toca: no se cobra
 * nada. Pero el cobro YA está en la base, y contestar REJECTED lo mandaba a «Acciones rechazadas» de la TPV y del POS siendo dinero
 * registrado. Se contesta con ESE cobro, SIN escribir la reserva (sigue siendo de su dueño, como hoy):
 *  - la prueba es la huella (commiteó con el pago) Y el pago de la llave: el mismo id, completado, de la cuenta de la huella;
 *  - la respuesta sale de `payCashOrder` en modo «sólo devolver» (`soloDevolverElCobroDeLaLlave`): el mismo reintento idempotente de
 *    siempre (libera la mesa si quedó saldada y repite los avisos idempotentes), que nunca llega al camino del pago nuevo;
 *  - el acuse tiene la forma del cobro (`ackDelCobro`), con la cuenta pedida y la aparte de D7 como la primera vez;
 *  - el recibo digital sólo se le da a quien cobró: a otra persona del aparato le llega sin recibo (`digitalReceipt: null`). Como no se
 *    guarda nada, esa decisión vale sólo para quien pregunta (Codex r2 #1);
 *  - otro aparato (`deviceId` distinto) no entra aquí: recibe el rechazo de siempre.
 * null = no hay prueba del cobro o no aplica: el que llama contesta el rechazo de siempre.
 */
async function ackDelCobroYaRegistrado(p: {
  existing: any
  intent: SyncIntentInput
  venueId: string
  staffId: string
  deviceId: string
  marca: MarcaDeReserva
  terminalSerialNumber?: string
}): Promise<SyncIntentAck | null> {
  const { existing, intent, venueId, marca } = p
  if (intent.type !== 'PAY_CASH' || existing.deviceId !== p.deviceId) return null
  const huella = marca.huella
  const orderId = typeof huella?.orderId === 'string' ? huella.orderId : null
  const paymentId = typeof huella?.paymentId === 'string' ? huella.paymentId : null
  if (!orderId || !paymentId) return null
  const cuentaOriginal = typeof huella?.cuentaOriginal === 'string' ? huella.cuentaOriginal : null

  // Todo va dentro del `try`: un payload ausente o un importe que no se deja convertir (un objeto JSON) no truena el lote (Codex r2
  // #4, r3 #1): sin importe legible no hay acuse por evidencia y queda el rechazo de siempre.
  try {
    // Lo mismo que manda la cola desde la primera vez (la misma llave trae el mismo payload): sólo sirve para el cambio del acuse.
    const payload = (intent.payload ?? {}) as Record<string, unknown>
    // EXACTAMENTE como lo leyó `applyPayCash` al registrarlo (Codex r4 #1: `[5000]` también vale 5000). Si `Number()` lanza (un objeto
    // JSON), `applyPayCash` tampoco pudo registrar nada con ese payload: cae al `catch` y queda el rechazo de siempre.
    const amountCents = Number(payload.amountCents ?? NaN)
    const tipCents = Number(payload.tipCents ?? 0)
    if (!Number.isFinite(amountCents) || amountCents < 0 || !Number.isFinite(tipCents) || tipCents < 0) return null
    const guardado = await prisma.payment.findUnique({
      where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
      select: { id: true, orderId: true, status: true, type: true },
    })
    if (!guardado || guardado.id !== paymentId || !esCobroCompletadoDeLaOrden(guardado, orderId)) return null
    const cobro = await orderMobileService.payCashOrder(venueId, orderId, {
      amount: amountCents,
      tip: tipCents,
      staffId: existing.staffId ?? p.staffId,
      idempotencyKey: intent.id,
      isOfflineReplay: true,
      ...(p.terminalSerialNumber ? { terminalSerialNumber: p.terminalSerialNumber } : {}),
      soloDevolverElCobroDeLaLlave: true,
    })
    const deQuienCobro = existing.staffId === p.staffId
    logger.info(
      `🧾 [POS SYNC] D20: el cobro ${paymentId} de ${intent.id} ya estaba en la base; se contesta con él a otra sesión del aparato ${p.deviceId}`,
      { venueId, cobro: existing.staffId ?? null, sesion: p.staffId },
    )
    return ackDelCobro(
      intent.id,
      cuentaOriginal ?? orderId,
      cuentaOriginal ? orderId : null,
      deQuienCobro ? cobro : { ...cobro, digitalReceipt: null },
    )
  } catch (error: any) {
    if (esErrorTransitorio(error)) {
      return {
        id: intent.id,
        status: 'RETRY',
        errorCode: error?.code ?? 'INTENT_RECOVERING',
        message: 'No se pudo leer el cobro de forma segura. Reintenta.',
      }
    }
    logger.warn(`⚠️ [POS SYNC] D20: el cobro de ${intent.id} no se pudo devolver; queda el rechazo de siempre`, {
      venueId,
      errorCode: error?.errorCode ?? error?.code,
    })
    return null
  }
}

/**
 * El efecto YA ocurrió (su huella commiteó con él): se contesta con ESA cuenta, sin re-ejecutar. Nunca con la cuenta
 * que hoy tenga la mesa ni buscando renglones en la cuenta original (una división los pudo mover).
 */
async function ackDesdeHuella(
  venueId: string,
  intent: SyncIntentInput,
  huella: Record<string, unknown>,
  localRefMap: Map<string, string>,
): Promise<SyncIntentAck> {
  const orderId = typeof huella.orderId === 'string' ? huella.orderId : null
  if (intent.type === 'CANCEL_ORDER' || !orderId) {
    // La cancelación commiteó (y liberó la mesa), pero sus avisos, bitácora y reversa de referidos corren después y
    // pudieron faltar: se deja visible para revisión en vez de inventar que terminó todo.
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'OUTCOME_UNKNOWN',
      message: 'No se pudo confirmar si la operación terminó. Revisa la cuenta antes de repetirla.',
    }
  }
  const orden = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { orderNumber: true, version: true, total: true } })
  if (intent.type === 'OPEN_TABLE') {
    const localOrderId = typeof intent.payload.localOrderId === 'string' ? intent.payload.localOrderId : null
    if (localOrderId) localRefMap.set(localOrderId, orderId)
    return {
      id: intent.id,
      status: 'ACKED',
      result: {
        orderId,
        orderNumber: orden?.orderNumber ?? null,
        version: orden?.version ?? 1,
        isNewOrder: huella.isNewOrder === true,
        ...(localOrderId ? { localOrderId } : {}),
      },
    }
  }
  // D7: la ronda o el cobro cayó en una cuenta aparte; se contesta como la primera vez: la cuenta que el aparato pidió, y la aparte.
  const cuentaOriginal = typeof huella.cuentaOriginal === 'string' ? huella.cuentaOriginal : null
  if (cuentaOriginal) {
    const pedida = await prisma.order.findFirst({ where: { id: cuentaOriginal, venueId }, select: { version: true, total: true } })
    return {
      id: intent.id,
      status: 'ACKED',
      result: {
        orderId: cuentaOriginal,
        version: pedida?.version ?? undefined,
        total: Number(pedida?.total ?? 0),
        cuentaAparte: {
          orderId,
          orderNumber: orden?.orderNumber ?? null,
          version: orden?.version ?? undefined,
          total: Number(orden?.total ?? 0),
        },
      },
    }
  }
  return { id: intent.id, status: 'ACKED', result: { orderId, version: orden?.version ?? undefined, total: Number(orden?.total ?? 0) } }
}

// ─── Reducers por tipo ───────────────────────────────────────────────────────

async function applyIntent(ctx: {
  terminalSerialNumber?: string
  venueId: string
  staffId: string
  deviceId: string
  intent: SyncIntentInput
  localRefMap: Map<string, string>
  dejarHuella?: DejarHuella
  /** El del lote: lo pide UPDATE_DETAILS para saber si quien encoló puede cambiar el cliente de una venta cobrada (R4-2). */
  authorizeIntent?: (intent: SyncIntentInput, requiredPermission: string) => boolean
}): Promise<SyncIntentAck> {
  const { venueId, staffId, intent, localRefMap, dejarHuella, authorizeIntent } = ctx

  if (!KNOWN_TYPES.includes(intent.type)) {
    // Cliente más nuevo que el server: no perdemos el intent, lo rechazamos
    // estructurado para que el cliente lo deje en cuarentena visible.
    return { id: intent.id, status: 'REJECTED', errorCode: 'UNKNOWN_INTENT_TYPE', message: `Tipo de intent desconocido: ${intent.type}` }
  }

  try {
    switch (intent.type) {
      case 'OPEN_TABLE':
        return await applyOpenTable(venueId, staffId, intent, localRefMap, dejarHuella, ctx.deviceId)
      case 'ADD_ITEMS':
        return await applyAddItems(venueId, staffId, intent, localRefMap, dejarHuella, ctx.deviceId)
      case 'PAY_CASH':
        return await applyPayCash(venueId, staffId, intent, localRefMap, dejarHuella, ctx.terminalSerialNumber, ctx.deviceId)
      case 'APPLY_DISCOUNT':
      case 'APPLY_SERVICE_CHARGE':
      case 'COMP_ORDER':
      case 'UPDATE_DETAILS':
      case 'CANCEL_ORDER':
      case 'MOVE_ORDER':
      case 'ASSIGN_ORDER':
        return await applyOrderMutation(venueId, staffId, intent, localRefMap, dejarHuella, authorizeIntent)
      case 'CLEAR_TABLE':
        return await applyClearTable(venueId, staffId, intent, localRefMap, ctx.deviceId)
      case 'SPLIT_ORDER':
        return await applySplitOrder(venueId, staffId, intent, localRefMap)
      case 'SPLIT_BY_SEAT':
        return await applySplitBySeat(venueId, staffId, intent, localRefMap)
      case 'MERGE_ORDERS':
        return await applyMergeOrders(venueId, staffId, intent, localRefMap)
      case 'KDS_TICKET_MARK':
        return await applyKdsTicketMark(venueId, intent)
      case 'KDS_ITEM_PROGRESS': {
        let orderId = await resolveOrderId(venueId, intent.payload, localRefMap)
        if (orderId) orderId = (await cuentaAparteDeLaComanda(venueId, orderId, intent.payload)) ?? orderId
        if (!orderId && typeof intent.payload.sourceKey === 'string') {
          const ticket = await prisma.kdsOrder.findFirst({
            where: { venueId, sourceKey: intent.payload.sourceKey },
            select: { orderId: true },
          })
          orderId = ticket?.orderId ?? null
        }
        if (!orderId) {
          const provisional = preparationCommandSchema.safeParse({
            action: intent.payload.action,
            items: intent.payload.items,
            ...(intent.payload.reason !== undefined ? { reason: intent.payload.reason } : {}),
          })
          if (!provisional.success || provisional.data.items.some(item => item.id)) {
            return invalid(intent, 'La preparación requiere identificar la cuenta')
          }
        }
        const action = preparationActionSchema.safeParse(intent.payload.action)
        if (orderId && action.success && action.data !== 'START' && action.data !== 'READY')
          await assertOwnership(venueId, staffId, orderId)
        const result = await applyKitchenPreparation(
          venueId,
          orderId ?? '',
          {
            action: intent.payload.action,
            items: intent.payload.items,
            ...(intent.payload.reason !== undefined ? { reason: intent.payload.reason } : {}),
          },
          staffId,
          intent.id,
        )
        return { id: intent.id, status: 'ACKED', result }
      }
    }
  } catch (error: any) {
    const errorCode =
      error instanceof OrderTableTopologyChanged ? 'ORDER_TABLE_TOPOLOGY_CHANGED' : (error?.errorCode ?? error?.code ?? 'BUSINESS_RULE')
    // Sólo los errores de dominio (`AppError`) llevan `details` de contrato; el de Prisma no es contrato.
    const details = error instanceof AppError && error.details !== undefined ? { details: error.details } : {}
    // TRANSITORIO (conflicto de versión, etc.) → RETRY: el cliente lo deja
    // PENDING y reintenta; NUNCA se pierde. PERMANENTE (regla de negocio) →
    // REJECTED terminal → cuarentena visible.
    const preparationDependency =
      intent.type === 'KDS_ITEM_PROGRESS' &&
      (errorCode === 'PREPARATION_DEPENDENCY_PENDING' || errorCode === 'PREPARATION_REVISION_PENDING')
    if (error instanceof OrderTableTopologyChanged || esErrorTransitorio(error) || preparationDependency) {
      logger.info(`🔁 [POS SYNC] Intent ${intent.type} ${intent.id} transitorio (${errorCode}) — reintentar`)
      return { id: intent.id, status: 'RETRY', errorCode, message: error?.message ?? 'Condición transitoria — reintentar', ...details }
    }
    logger.warn(`⚠️ [POS SYNC] Intent ${intent.type} ${intent.id} rechazado: ${error?.message}`)
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode,
      message: error?.message ?? 'Regla de negocio rechazó el intent',
      ...details,
    }
  }
}

/**
 * Regla de propiedad de mesa — misma semántica que checkTableOwnership.
 *
 * `overridePermissions` espeja el de la ruta online: PAY_CASH monta el de COBRO
 * (`tables:pay-any`), todo lo demás el default. Desalinearlos significaría que el cajero
 * puede liquidar una mesa ajena con red y no puede sin ella — o al revés, que el replay
 * se salta un candado que el online sí aplica.
 */
async function assertOwnership(
  venueId: string,
  staffId: string,
  orderId: string,
  overridePermissions: readonly string[] = DEFAULT_OWNERSHIP_OVERRIDES,
): Promise<void> {
  const ajena = await mesaAjenaDe(venueId, staffId, orderId, overridePermissions)
  if (ajena) throw errorMesaAjena(ajena)
}

function errorMesaAjena(ajena: { ownerName: string }): Error {
  const err: any = new Error(`Solo ${ajena.ownerName} puede modificar esta mesa`)
  err.errorCode = 'TABLE_OWNED_BY_OTHER'
  return err
}

/** El dueño de la mesa cuando la regla de propiedad le prohíbe a `staffId` tocarla; null si no aplica o puede. */
async function mesaAjenaDe(
  venueId: string,
  staffId: string,
  orderId: string,
  overridePermissions: readonly string[],
): Promise<{ ownerId: string; ownerName: string } | null> {
  if (!(await isTableOwnershipEnforced(venueId))) return null
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { tableId: true, servedById: true, servedBy: { select: { firstName: true, lastName: true } } },
  })
  if (!order || !order.tableId) return null // mostrador — la regla no aplica
  if (!order.servedById || order.servedById === staffId) return null
  if (await staffCanManageAllTables(staffId, venueId, undefined, undefined, overridePermissions)) return null
  const ownerName = order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}`.trim() : 'otro mesero'
  return { ownerId: order.servedById, ownerName }
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
 * El MISMO candado que la ruta online del catálogo (checkFeatureAccess
 * PROMOTIONS en mobile.routes): sincronizar NO es puerta trasera — un venue
 * degradado a FREE no aplica promos por el canal offline aunque su outbox
 * traiga intents con promotionRef.
 */
async function assertPromotionsFeature(venueId: string): Promise<void> {
  const access = await hasFeatureAccess(venueId, 'PROMOTIONS')
  if (!access.hasAccess) {
    const err: any = new Error('Las promociones requieren el plan PRO')
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
  dejarHuella?: DejarHuella,
  deviceId?: string,
): Promise<SyncIntentAck> {
  // D93: la hora del aparato al abrir la mesa, SIN el recorte al futuro de `abiertaSinRedEn` (Codex r2 #1), acotada a 24 h antes de
  // ahora. Sólo para reportes: la cuenta que NACE la guarda en la misma transacción (`huellaYNota`).
  const horaRealDeLaMesa = horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: intent.createdAtLocal }, llegadaDeLaPeticion())
  await assertTableService(venueId)
  const tableId = String(intent.payload.tableId ?? '')
  const covers = Number(intent.payload.covers ?? 1)
  const localOrderId = typeof intent.payload.localOrderId === 'string' ? intent.payload.localOrderId : null
  if (!tableId) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'INVALID_PAYLOAD', message: 'OPEN_TABLE requiere tableId' }
  }
  // S3: la caja en que el aparato abrió la mesa sin red (misma forma que en PAY_CASH).
  const cajaDeLaMesa = intent.payload.cashDrawerSessionId
  if (
    cajaDeLaMesa !== undefined &&
    cajaDeLaMesa !== null &&
    cajaDeLaMesa !== '' &&
    (typeof cajaDeLaMesa !== 'string' || cajaDeLaMesa.length > 64)
  ) {
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'INVALID_PAYLOAD',
      message: 'OPEN_TABLE: cashDrawerSessionId debe ser texto de hasta 64 caracteres',
    }
  }

  // D51 (hz:8024bc1c:D51): la hora en que el aparato abrió la mesa sin red. Con ella, una cuenta que nació DESPUÉS en esa mesa no se
  // adopta: lo de este aparato nace en su propia cuenta junto a ella. Sólo se recorta el futuro (un reloj adelantado = como hoy); el
  // piso de 24 h de `clampSoldAt` NO, porque convertiría en «anterior» una cuenta posterior tras un día sin red (Codex r1 #2).
  const horaLocal = intent.createdAtLocal === undefined || intent.createdAtLocal === null ? NaN : new Date(intent.createdAtLocal).getTime()
  const abiertaSinRedEn = Number.isFinite(horaLocal) ? new Date(Math.min(horaLocal, Date.now())) : undefined
  const caja = typeof cajaDeLaMesa === 'string' && cajaDeLaMesa !== '' ? { cashDrawerSessionId: cajaDeLaMesa } : undefined
  // D8 (hz:033d44ca:D8): el aparato soltó sin red esta mesa tras cobrar su cuenta y abrió otra visita por su cola. Sólo `true` cuenta;
  // cualquier otro valor se ignora (nunca se rechaza: detrás puede haber efectivo ya cobrado). Sólo con la hora sin red (regla D51).
  const visitaNueva = intent.payload.visitaNueva === true && !!abiertaSinRedEn

  // Propiedad de mesa: abrir una mesa ocupada por otro reutilizaría su orden.
  // D71 (hz:8024bc1c:D71, founder 13-nov-2026: «A, cuenta propia»): con la hora de la apertura sin red ya no se rechaza (el efectivo
  // ya cobrado quedaba en cuarentena sin cuenta): assignTable sólo adopta cuentas de este mesero y la suya nace junto a la del otro,
  // con nota. Sin la hora (petición a mano), el rechazo de hoy.
  const propiedadDeMesa = await isTableOwnershipEnforced(venueId)
  const soloCuentasDe = propiedadDeMesa && !(await staffCanManageAllTables(staffId, venueId)) ? staffId : undefined
  if (soloCuentasDe && !abiertaSinRedEn) {
    const foreign = await prisma.order.findFirst({
      where: { venueId, tableId, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] }, servedById: { not: staffId } },
      select: { servedBy: { select: { firstName: true, lastName: true } } },
    })
    if (foreign) {
      const ownerName = foreign.servedBy ? `${foreign.servedBy.firstName} ${foreign.servedBy.lastName}`.trim() : 'otro mesero'
      return {
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'TABLE_OWNED_BY_OTHER',
        message: `Solo ${ownerName} puede modificar esta mesa`,
      }
    }
  }

  // La nota de la cuenta aparte va dentro de la transacción de assignTable (bajo el candado de la mesa; Codex r1 #3): una caída
  // después del commit no la pierde. D71: nombra cuáles de las otras cuentas son de otro mesero (Codex r2 #2 rechazaba aquí; ya no
  // hace falta: assignTable nunca adopta una cuenta ajena con `soloCuentasDe`).
  const huellaYNota: Parameters<typeof tableService.assignTable>[5] = async (tx, admitida) => {
    if (admitida.isNewOrder && horaRealDeLaMesa) {
      await tx.order.update({ where: { id: admitida.orderId }, data: { clientCreatedAt: horaRealDeLaMesa } })
    }
    if (admitida.otrasCuentas?.length) {
      const cuentasDeOtroMesero = soloCuentasDe
        ? (
            await tx.order.findMany({
              where: { venueId, id: { in: admitida.otrasCuentas }, servedById: { not: staffId } },
              select: { id: true },
              take: admitida.otrasCuentas.length,
            })
          ).map(o => o.id)
        : []
      await writeLegacyActivityAuditTx(tx, {
        staffId,
        venueId,
        action: 'MESA_SIN_RED_EN_CUENTA_APARTE',
        entity: 'Order',
        entityId: admitida.orderId,
        data: {
          tableId,
          otrasCuentas: admitida.otrasCuentas,
          localOrderId,
          intentId: intent.id,
          // D75b: con él, el «Liberar mesa» de una app vieja (sólo la mesa) encuentra la cuenta aparte de ESTE aparato.
          deviceId: deviceId ?? null,
          abiertaSinRedEn: abiertaSinRedEn?.toISOString() ?? null,
          // D8: el aparato la abrió como visita nueva tras soltar sin red la cuenta anterior.
          ...(visitaNueva ? { visitaNueva: true } : {}),
          ...(cuentasDeOtroMesero.length ? { cuentasDeOtroMesero } : {}),
        },
      })
    }
    await dejarHuella?.(tx, admitida)
  }
  // Sin caja ni hora, la llamada de hoy byte a byte (sin un séptimo argumento).
  const { order, isNewOrder } = abiertaSinRedEn
    ? await tableService.assignTable(
        venueId,
        tableId,
        staffId,
        covers,
        undefined,
        huellaYNota,
        caja,
        abiertaSinRedEn,
        // D71: sin propiedad de mesa (o con permiso de mesas ajenas), la llamada de D51 (ocho argumentos). D8: la visita nueva, el
        // décimo (con el noveno aunque no haya propiedad de mesa).
        ...((visitaNueva ? [soloCuentasDe, true] : soloCuentasDe ? [soloCuentasDe] : []) as [string?, boolean?]),
      )
    : await tableService.assignTable(
        venueId,
        tableId,
        staffId,
        covers,
        undefined,
        dejarHuella ? (tx, admitida) => dejarHuella(tx, admitida) : undefined,
        ...(caja ? [caja] : []),
      )
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
    // Replay en request separado: buscar el OPEN_TABLE ya ackeado. D75: desde ANDROID D75 un CLEAR_TABLE también lleva la cuenta
    // local, pero su ACK no la nombra (`result` sin `orderId`): si fuera el más reciente taparía la cuenta para lo que llegue después.
    const prior = await prisma.posSyncIntent.findFirst({
      where: { venueId, localRef, status: 'ACKED', type: { notIn: ['HTTP_OP_V1', 'CLEAR_TABLE'] } },
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

const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Cuándo se vendió de verdad, sin dejar que el reloj del cliente mande solo.
 *
 * 🔴 Si el POS vende a las 19:59 sin red y sincroniza a las 20:30, evaluar la
 * vigencia contra "ahora" tumbaría el precio de una venta ya entregada. Pero
 * confiar ciegamente en `createdAtLocal` deja mover el reloj para revivir una
 * promoción vencida. Se acota a `[sync − 24h, sync]`: una venta legítima de
 * más temprano el mismo día se honra, y un reloj movido más no compra nada.
 *
 * Acepta el epoch ms del outbox (`SyncIntentInput.createdAtLocal`) o un ISO
 * string de clientes que manden la fecha en el payload.
 */
export function clampSoldAt(createdAtLocal: string | number | undefined, syncAt: Date): Date {
  const parsed = createdAtLocal !== undefined && createdAtLocal !== null ? new Date(createdAtLocal) : null
  if (!parsed || Number.isNaN(parsed.getTime())) return syncAt

  const floor = syncAt.getTime() - OFFLINE_GRACE_MS
  return new Date(Math.min(Math.max(parsed.getTime(), floor), syncAt.getTime()))
}

/**
 * ADD_ITEMS — payload: { orderId | localOrderId, items: AddOrderItemInput[] }
 * Ronda nueva (asNewRound=true, semántica Square). La versión optimista se lee
 * del server AL APLICAR: el orden lo garantiza el FIFO por dispositivo, no el
 * baseVersion viejo del cliente offline (evitaría 409 fantasma en todo replay).
 *
 * `items[].promotionRef` es OPCIONAL: un item que lo traiga NO pasa por el alta
 * normal — su precio lo resuelve el server desde la definición de la promoción,
 * dentro de la MISMA transacción de la ronda (hz:5bda0b30:D3). Un cliente que no
 * lo mande se comporta EXACTAMENTE igual que hoy.
 */
async function applyAddItems(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
  dejarHuella?: DejarHuella,
  deviceId?: string,
): Promise<SyncIntentAck> {
  await assertTableService(venueId)
  const orderId = await resolveOrderId(venueId, intent.payload, localRefMap)
  const items = Array.isArray(intent.payload.items) ? (intent.payload.items as any[]) : []
  if (!orderId || items.length === 0) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'INVALID_PAYLOAD', message: 'ADD_ITEMS requiere orderId/localOrderId e items' }
  }
  // Las líneas con promotionRef no llevan cantidades propias — las define el
  // server desde la promoción — así que la validación de líneas aplica sólo a
  // las normales.
  const invalidReason = invalidAddItemsReason(items.filter(it => !it.promotionRef))
  if (invalidReason) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'INVALID_PAYLOAD', message: invalidReason }
  }
  // Y las de promoción tienen su propia validación, idéntica a la online. Es
  // rechazo de NEGOCIO permanente (REJECTED → cuarentena visible), nunca RETRY:
  // reintentar el mismo payload malo daría exactamente el mismo resultado.
  const invalidPromoReason = invalidPromotionLinesReason(items.filter(it => it.promotionRef))
  if (invalidPromoReason) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'INVALID_PAYLOAD', message: invalidPromoReason }
  }
  await assertOwnership(venueId, staffId, orderId)

  const current = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { version: true, status: true, total: true, paymentStatus: true, tableId: true, covers: true },
  })
  if (!current) {
    return { id: intent.id, status: 'REJECTED', errorCode: 'ORDER_NOT_FOUND', message: 'La orden ya no existe' }
  }

  // Los items con `promotionRef` NO pasan por el alta normal: su precio lo
  // resuelve el server desde la definición de la promoción (idempotente por
  // instanceId, así que el replay de este intent no duplica). Los demás siguen
  // exactamente el camino de hoy.
  const conPromocion = items.filter(it => it.promotionRef)
  const normales = items.filter(it => !it.promotionRef)

  const soldAt = clampSoldAt(intent.createdAtLocal ?? (intent.payload.createdAtLocal as string | number | undefined), new Date())
  if (conPromocion.length > 0) {
    // Mismo candado que la ruta online del catálogo: el reducer gatea POR
    // INTENT, igual que el resto (regla offline-first del repo).
    await assertPromotionsFeature(venueId)
  }
  // 🛡️ Idempotencia de la RONDA: un externalId determinista por item
  // (intent.id + índice) hace que un replay de este ADD_ITEMS actualice las
  // MISMAS filas en vez de crear duplicados (addItemsToOrder ya deduplica por
  // externalId: findFirst → UPDATE quantity=item.quantity, que es reemplazo).
  // Sin esto, un reintento tras "efecto aplicado pero ack no persistido"
  // duplicaba la ronda en cocina y en la cuenta. Solo se inyecta si el cliente
  // no mandó uno propio.
  const itemsWithKey = normales.map((it, idx) => (it.externalId ? it : { ...it, externalId: `sync:${intent.id}:${idx}` }))
  // El combo viaja sólo con su referencia y el prefijo de sus componentes (`sync:<intent>:<índice>`, el que el aparato predice): su
  // precio y sus renglones los resuelve el server desde la promoción, y un campo suelto del carrito no lo vuelve un producto.
  const combos = conPromocion.map(item => ({
    promotionRef: item.promotionRef,
    externalId: item.externalId && /^sync:[^:]+:\d+$/.test(item.externalId) ? item.externalId : `sync:${intent.id}:${items.indexOf(item)}`,
  }))

  // Reenvío de una ronda con combos que YA está entera en la cuenta (la guardó la ruta con red, o un intento anterior que perdió su
  // respuesta): se contesta sin escribir, como antes contestaba cada combo `created:false`. Sin esto, una cuenta que ya se cobró
  // rechazaría una ronda que sí quedó guardada, y una reembolsada se reabriría (Codex r1 #2 de hz:5bda0b30:D3).
  if (combos.length > 0 && (await rondaYaGuardada(orderId, conPromocion, itemsWithKey))) {
    // La cuenta se relee DESPUÉS de reconocer la ronda: la lectura de arriba pudo ser de antes de que se guardara (Codex r2 #2).
    const ahora = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { version: true, total: true } })
    return {
      id: intent.id,
      status: 'ACKED',
      result: { orderId, version: ahora?.version ?? current.version, total: Number(ahora?.total ?? current.total ?? 0) },
    }
  }

  // D7 (hz:033d44ca:D7, founder 16-nov-2026: «A, cuenta aparte»): la cuenta de MESA ya está cobrada (otra caja la cobró mientras este
  // aparato no tenía red). Antes se rechazaba («Cannot add items to a paid order») y lo servido nunca se cobraba. Ahora la ronda cae
  // en una cuenta aparte de la misma mesa, por cobrar y con nota; la cobrada no se toca. Si la caja cobra ENTRE esta lectura y la
  // transacción de la ronda, la versión ya cambió: VERSION_CONFLICT → RETRY, y el reintento llega aquí.
  if (current.paymentStatus === 'PAID' && current.tableId) {
    return await aplicarRondaTardia({
      venueId,
      staffId,
      deviceId,
      intent,
      original: { id: orderId, version: current.version, total: current.total, tableId: current.tableId, covers: current.covers },
      conPromocion,
      itemsWithKey,
      combos,
      soldAt,
      dejarHuella,
    })
  }

  // 🔴 hz:5bda0b30:D3 (Codex r4 F1–F4 de cocina-avisos-perdidos): la ronda ENTERA —combos y productos— es UNA transacción, la misma
  // de la ronda con red (`addItemsToOrder`): combos idempotentes por instanceId, productos por su llave, totales y versión una vez,
  // la marca de cocina en su CAS (decidida con la cuenta bajo su candado) y la huella adentro. Antes cada combo commiteaba aparte:
  // una caída a la mitad dejaba combos sin aviso a cocina y lo que faltaba nunca llegaba (la ronda no se retomaba), y el barrido
  // podía cocinar un combo que la compensación borraba después. Si falla, la transacción revierte entera y no queda nada que
  // compensar: ni un combo ajeno que borrar (el de un ejecutor que ganó la retoma, Codex r1 #1) ni una comanda de algo borrado.
  // La hora de venta acotada viaja sólo con combos: sin ellos, la llamada de siempre byte a byte.
  const updated = await orderTpvService.addItemsToOrder(
    venueId,
    orderId,
    [...combos, ...itemsWithKey],
    current.version,
    true,
    dejarHuella ? (tx, ronda) => dejarHuella(tx, ronda) : undefined,
    ...(combos.length > 0 ? [soldAt] : []),
  )
  return {
    id: intent.id,
    status: 'ACKED',
    result: { orderId, version: (updated as any).version ?? current.version + 1, total: Number((updated as any).total ?? 0) },
  }
}

/**
 * ¿La ronda ya está ENTERA en la cuenta? Todos sus combos (por instancia) y todas sus llaves tal como las guarda la ronda: después
 * de la MISMA normalización que escribe (`normalizeAddItems`: dos importes libres iguales quedan en un renglón con la llave del
 * primero, Codex r2 #1). Si falta cualquiera —una ronda vieja de varias transacciones que dejó el combo y no todos sus productos, o
 * una llave repetida de otra ronda (Codex r3 #1)— no está guardada: sigue a la transacción de la ronda, que completa lo que falta
 * sin duplicar (combos por instancia, productos por llave).
 */
async function rondaYaGuardada(orderId: string, conPromocion: any[], normales: any[]): Promise<boolean> {
  const instancias = conPromocion.map(it => it.promotionRef?.promotionInstanceId)
  if (!instancias.every((id: unknown) => typeof id === 'string' && id.length > 0)) return false
  const unicas = [...new Set<string>(instancias)]
  const llaves = [...new Set(orderTpvService.normalizeAddItems(normales).map(it => it.externalId ?? ''))]
  if (llaves.some(llave => !llave)) return false
  const [combos, guardadas] = await Promise.all([
    prisma.orderPromotion.count({ where: { orderId, instanceId: { in: unicas } } }),
    llaves.length > 0
      ? prisma.orderItem.findMany({
          where: { orderId, externalId: { in: llaves } },
          select: { externalId: true },
          take: llaves.length * 2,
        })
      : Promise.resolve([]),
  ])
  const presentes = new Set(guardadas.map(r => r.externalId))
  return combos === unicas.length && llaves.every(llave => presentes.has(llave))
}

// ─── D7: la ronda que llega después de que otra caja cobró la mesa ─────────────────────────────────────────────────────────────
// El vínculo «cuenta cobrada → su cuenta aparte de este aparato» vive en la cuenta aparte (`rondaTardiaDeId`, `rondaTardiaAparato`,
// llave única), no en la bitácora: no caduca y tiene índice (Codex r1 #2 y #7). La nota de la bitácora queda para el registro y para
// el «Liberar mesa» de las apps viejas (D75b).

/** Nota de la bitácora de cada cuenta aparte abierta para una ronda tardía. */
const NOTA_RONDA_TARDIA = 'RONDA_TARDIA_EN_CUENTA_APARTE'

/**
 * D7: ¿esta ronda ya está guardada en ALGUNA cuenta del negocio? Puede estar en la cobrada (entró antes del cobro y su respuesta se
 * perdió) o en una cuenta que salió de ella (otra caja la separó o la movió, Codex r0 #1 y r1 #1). Con UNA de sus llaves basta: la
 * ronda se guarda entera en una sola transacción, y sus llaves (`sync:<intent>:<i>` o las del aparato; la instancia de cada combo) no
 * se repiten entre rondas. Las dos búsquedas usan índice (`OrderItem.externalId`, `OrderPromotion.instanceId`). Devuelve la cuenta.
 */
async function rondaYaEnAlgunaCuenta(venueId: string, conPromocion: any[], normales: any[]): Promise<string | null> {
  const llaves = [...new Set(normales.map(it => it.externalId).filter((k: unknown): k is string => typeof k === 'string' && k.length > 0))]
  if (llaves.length) {
    const renglon = await prisma.orderItem.findFirst({
      where: { externalId: { in: llaves }, order: { venueId } },
      select: { orderId: true },
    })
    if (renglon) return renglon.orderId
  }
  const instancias = [
    ...new Set(
      conPromocion
        .map(it => it.promotionRef?.promotionInstanceId)
        .filter((k: unknown): k is string => typeof k === 'string' && k.length > 0),
    ),
  ]
  if (instancias.length) {
    const combo = await prisma.orderPromotion.findFirst({
      where: { instanceId: { in: instancias }, order: { venueId } },
      select: { orderId: true },
    })
    if (combo) return combo.orderId
  }
  return null
}

/** La llave del aparato en la cadena. Sin aparato (petición a mano) se usa el mesero, que es lo más parecido. */
const aparatoDeLaRonda = (deviceId: string | undefined, staffId: string) => deviceId || `staff:${staffId}`

/**
 * D7: la ronda va a la cuenta aparte de este aparato para la cuenta cobrada (la que todavía debe, o una nueva). Si la ronda ya está
 * en alguna cuenta, se reconoce sin escribir: nunca se duplica. El ACK nombra la cuenta que el aparato conoce (las apps viejas
 * confirman su sesión y releen el servidor) y, aparte, la cuenta nueva.
 */
async function aplicarRondaTardia(p: {
  venueId: string
  staffId: string
  deviceId?: string
  intent: SyncIntentInput
  original: { id: string; version: number; total: unknown; tableId: string; covers: number | null }
  conPromocion: any[]
  itemsWithKey: any[]
  combos: any[]
  soldAt: Date
  dejarHuella?: DejarHuella
}): Promise<SyncIntentAck> {
  const { venueId, staffId, intent, original } = p
  const horaRealDeLaRonda = horaRealDelAparato({ isOfflineReplay: true, createdAtLocal: intent.createdAtLocal }, llegadaDeLaPeticion())
  const pedida = { orderId: original.id, version: original.version, total: Number(original.total ?? 0) }
  const yaEn = await rondaYaEnAlgunaCuenta(venueId, p.conPromocion, p.itemsWithKey)
  if (yaEn) {
    return { id: intent.id, status: 'ACKED', result: { ...pedida, ...(yaEn !== original.id ? { cuentaAparte: { orderId: yaEn } } : {}) } }
  }
  const aparte = await tableService.cuentaAparteParaRondaTardia({
    venueId,
    tableId: original.tableId,
    staffId,
    covers: original.covers && original.covers > 0 ? original.covers : 1,
    cuentaPedida: original.id,
    aparato: aparatoDeLaRonda(p.deviceId, staffId),
    // D93: la hora del aparato de la ronda (sólo reportes), validada contra la llegada de este intent; sin ella, la llamada de hoy.
    ...(horaRealDeLaRonda ? { clientCreatedAt: horaRealDeLaRonda } : {}),
    dentroDeLaTx: (tx, nueva) =>
      writeLegacyActivityAuditTx(tx, {
        staffId,
        venueId,
        action: NOTA_RONDA_TARDIA,
        entity: 'Order',
        entityId: nueva.orderId,
        data: {
          tableId: original.tableId,
          cuentaOriginal: original.id,
          deviceId: aparatoDeLaRonda(p.deviceId, staffId),
          intentId: intent.id,
          // Siempre, aunque vacío: el «Liberar mesa» de una app vieja (sólo la mesa) la reconoce como en D75b (Codex r0 #7).
          otrasCuentas: nueva.otrasCuentas,
        },
      }),
  })
  // Propiedad de mesa sobre la cuenta donde SÍ se escribe (Codex r0 #4): si un encargado le pasó la cuenta aparte a otro mesero, es
  // suya. Misma regla (y mismo momento, antes de la escritura) que la ronda de todos los días.
  if (!aparte.isNewOrder) await assertOwnership(venueId, staffId, aparte.orderId)
  logger.info(
    `🪑 [POS SYNC] ADD_ITEMS ${intent.id}: la cuenta ${original.id} ya estaba cobrada; la ronda va a la cuenta aparte ${aparte.orderId}`,
  )
  const updated = await orderTpvService.addItemsToOrder(
    venueId,
    aparte.orderId,
    [...p.combos, ...p.itemsWithKey],
    aparte.version,
    true,
    p.dejarHuella ? (tx, ronda) => p.dejarHuella!(tx, { ...ronda, cuentaOriginal: original.id }) : undefined,
    ...(p.combos.length > 0 ? [p.soldAt] : []),
  )
  return {
    id: intent.id,
    status: 'ACKED',
    result: {
      ...pedida,
      cuentaAparte: {
        orderId: aparte.orderId,
        orderNumber: (updated as any).orderNumber ?? null,
        version: (updated as any).version ?? aparte.version + 1,
        total: Number((updated as any).total ?? 0),
      },
    },
  }
}

/**
 * D7: el cobro sin red de ESTE aparato a una cuenta que otra caja ya cobró, cuando una ronda suya ya cayó en una cuenta aparte: va a
 * la ÚLTIMA de su cadena (lo que la mesera cobró incluye esa ronda; si ya quedó saldada, lo de más se marca como sobrepago ahí, nunca
 * vuelve a la cobrada). Si el cobro de esta llave ya está en una cuenta de la cadena (reintento), ésa: el destino no depende de lo que
 * pasó después (Codex r0 #2, r1 #2). Sin cadena, o de otro aparato, null: el cobro de hoy (S1).
 * Si mientras viajaba la caja reorganizó la cuenta aparte con internet (la separó o la juntó), el cobro se comporta como el de
 * cualquier cuenta hoy: cae en la cuenta que nombra (Codex r3: misma familia que una cuenta normal; ver la promesa).
 */
async function cuentaAparteDelCobroTardio(venueId: string, orderId: string, aparato: string, intentId: string): Promise<string | null> {
  const cuenta = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { paymentStatus: true } })
  if (cuenta?.paymentStatus !== 'PAID') return null
  const cadena = await tableService.cadenaDeRondaTardia(prisma, venueId, orderId, aparato)
  if (!cadena.length) return null
  const pagoDeLaLlave = await prisma.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey: intentId } },
    select: { orderId: true },
  })
  if (pagoDeLaLlave && cadena.some(c => c.id === pagoDeLaLlave.orderId)) return pagoDeLaLlave.orderId
  // Aunque esté anulada (Codex r3 #1: la caja la juntó con otra cuenta que ya traía su propio vínculo): es lo que hoy pasa con el
  // cobro sin red de CUALQUIER cuenta que la caja anuló o juntó mientras viajaba (`reabrirSiRecibeDinero`, founder 3-oct, «como Square
  // y Toast»): el dinero queda en la cuenta que el aparato cobró, con su aviso. Nunca vuelve a la cobrada.
  return cadena.at(-1)?.id ?? null
}

/**
 * D7 (Codex r0 #6, r1 #6, r2 #2): una marca de cocina sobre una ronda que cayó en una cuenta aparte llega con la cuenta cobrada; sus
 * productos viven en la comanda de la aparte y la acción esperaba para siempre (`PREPARATION_DEPENDENCY_PENDING`). La marca puede
 * venir de OTRO aparato (la pantalla de cocina que recibió la ronda por el WiFi del local), así que no se busca por aparato: cada
 * `sourceKey` es UNA comanda del negocio (llave única). Si todas las comandas de la acción son de una sola cuenta que desciende de la
 * cobrada por rondas tardías, la acción va a ella. Si junta productos de la cobrada y de la aparte, se rechaza con su razón (nunca un
 * reintento eterno que frena la fila de cocina del aparato). Si la comanda todavía no llega (la ronda no ha subido), como hoy.
 */
async function cuentaAparteDeLaComanda(venueId: string, orderId: string, payload: Record<string, unknown>): Promise<string | null> {
  const items = Array.isArray(payload.items) ? (payload.items as any[]).slice(0, 101) : []
  const llaves = [
    ...new Set(
      [payload.sourceKey, ...items.map(it => it?.sourceKey)].filter((k: unknown): k is string => typeof k === 'string' && k.length > 0),
    ),
  ]
  if (!llaves.length) return null
  const cuenta = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { paymentStatus: true } })
  if (cuenta?.paymentStatus !== 'PAID') return null
  const comandas = await prisma.kdsOrder.findMany({
    where: { venueId, sourceKey: { in: llaves } },
    select: { orderId: true },
    take: llaves.length,
  })
  const cuentas = [...new Set(comandas.map(c => c.orderId))]
  const ajena = cuentas.find(c => c !== orderId)
  if (!ajena || !(await desciendePorRondaTardia(venueId, ajena, orderId))) return null
  if (cuentas.length > 1) {
    throw new ConflictError(
      'Esta marca de cocina junta productos de dos cuentas (una ronda llegó después de que se cobró la mesa). Márcalos por separado.',
      'PREPARATION_ITEMS_CHANGED',
    )
  }
  return ajena
}

/** ¿`cuenta` nació, por rondas tardías (de cualquier aparato), de `origen`? Sube la cadena por `rondaTardiaDeId`. */
async function desciendePorRondaTardia(venueId: string, cuenta: string, origen: string): Promise<boolean> {
  let actual: string | null = cuenta
  for (let i = 0; actual && i < tableService.ESLABONES_MAX; i++) {
    const fila: { rondaTardiaDeId: string | null } | null = await prisma.order.findFirst({
      where: { id: actual, venueId },
      select: { rondaTardiaDeId: true },
    })
    if (fila?.rondaTardiaDeId === origen) return true
    actual = fila?.rondaTardiaDeId ?? null
  }
  return false
}

/**
 * PAY_CASH — payload: { orderId | localOrderId, amountCents, tipCents?,
 * method?, externalSource?, expectedBalanceBeforeCents? }
 *
 * `expectedBalanceBeforeCents` (D5 · bloque P, opcional): lo que la tablet creía que debía la cuenta ANTES de este cobro, en
 * centavos enteros. Si al aplicarlo el servidor tiene otro saldo (más de 1 centavo), queda `COBRO_SIN_RED_CON_DIFERENCIA` en la
 * bitácora; el cobro no cambia.
 *
 * El nombre dice CASH por historia: el tipo NO se renombra porque los 15 tipos
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
  dejarHuella?: DejarHuella,
  terminalSerialNumber?: string,
  deviceId?: string,
): Promise<SyncIntentAck> {
  // D93: cuándo ENTRÓ la petición del lote (la cota de 24 h de la hora del aparato del cobro, sólo reportes).
  const llegada = llegadaDeLaPeticion()
  let shiftIdDeLaVenta: string | undefined
  const declaredShift = intent.payload.shiftIdDeLaVenta
  // Old POS payloads keep their prior treatment; only an authenticated terminal opts into this reference.
  if (terminalSerialNumber && declaredShift !== undefined && declaredShift !== null && declaredShift !== '') {
    if (typeof declaredShift !== 'string' || !/^c[a-z0-9]{24}$/.test(declaredShift)) {
      return {
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'INVALID_PAYLOAD',
        message: 'PAY_CASH: el turno de la venta debe ser un cuid v1 del servidor',
      }
    }
    const terminal = await prisma.terminal.findFirst({
      where: { venueId, serialNumber: terminalSerialNumber, status: 'ACTIVE' },
      select: { id: true },
    })
    const shift = terminal ? await prisma.shift.findFirst({ where: { id: declaredShift, venueId }, select: { id: true } }) : null
    if (!shift)
      return {
        id: intent.id,
        status: 'REJECTED',
        errorCode: 'INVALID_PAYLOAD',
        message: 'PAY_CASH: el turno o la terminal no pertenecen a este negocio',
      }
    shiftIdDeLaVenta = shift.id
  }
  const cuentaPedida = await resolveOrderId(venueId, intent.payload, localRefMap)
  // D7: si una ronda tardía de este aparato ya cayó en una cuenta aparte de esta cuenta cobrada, su cobro va con ella.
  const cuentaAparte = cuentaPedida
    ? await cuentaAparteDelCobroTardio(venueId, cuentaPedida, aparatoDeLaRonda(deviceId, staffId), intent.id)
    : null
  const orderId = cuentaAparte ?? cuentaPedida
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
  const tenderTypeId = intent.payload.tenderTypeId
  const tenderRevision = intent.payload.tenderRevision
  if (tenderTypeId !== undefined && (typeof tenderTypeId !== 'string' || !Number.isInteger(tenderRevision))) {
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'INVALID_PAYLOAD',
      message: 'PAY_CASH: tenderTypeId requiere tenderRevision entero',
    }
  }
  if (tenderTypeId !== undefined && method !== undefined) {
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'INVALID_PAYLOAD',
      message: 'PAY_CASH: manda method o tenderTypeId, no ambos',
    }
  }
  // S3 «Efectivo sin red en el turno correcto»: la caja que el aparato tenía abierta al cobrar. Misma forma que en HTTP (texto de
  // hasta 64); otra cosa es un rechazo visible en la cola, nunca un valor sin tope que llegue al servicio.
  const cashDrawerSessionId = intent.payload.cashDrawerSessionId
  if (
    cashDrawerSessionId !== undefined &&
    cashDrawerSessionId !== null &&
    cashDrawerSessionId !== '' &&
    (typeof cashDrawerSessionId !== 'string' || cashDrawerSessionId.length > 64)
  ) {
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'INVALID_PAYLOAD',
      message: 'PAY_CASH: cashDrawerSessionId debe ser texto de hasta 64 caracteres',
    }
  }
  // D5 · bloque P (11-nov-2026): el saldo que la tablet creía que debía la cuenta ANTES de este cobro (mesa cobrada sin red). Es
  // sólo un rastro (`COBRO_SIN_RED_CON_DIFERENCIA`): nunca cambia ni rechaza el cobro. Centavos enteros entre 0 y el tope del
  // teclado; otra cosa se ignora, porque el efectivo ya está en el cajón y un dato de diagnóstico no puede dejarlo sin registrar.
  const saldoEsperado = intent.payload.expectedBalanceBeforeCents
  const antesCents =
    typeof saldoEsperado === 'number' &&
    Number.isInteger(saldoEsperado) &&
    saldoEsperado >= 0 &&
    saldoEsperado <= MAX_TERMINAL_PAYMENT_CENTS
      ? saldoEsperado
      : undefined
  if (saldoEsperado !== undefined && saldoEsperado !== null && antesCents === undefined) {
    logger.warn('[POS SYNC] PAY_CASH: expectedBalanceBeforeCents inválido; se ignora y el cobro sigue', { venueId, intentId: intent.id })
  }
  // Espejo del guard HTTP: una propina negativa es un descuento disfrazado e
  // inconciliable. El reducer no lo validaba y era el hueco por donde entraba.
  if (!Number.isFinite(tipCents) || tipCents < 0) {
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'INVALID_PAYLOAD',
      message: 'PAY_CASH: tipCents no puede ser negativo',
    }
  }
  // Only numeric zero without a tip delegates the zero-balance decision to payCashOrder.
  const zeroWithoutTip = intent.payload.amountCents === 0 && (intent.payload.tipCents === undefined || intent.payload.tipCents === 0)
  // 🔴 R4-3 (Codex r3): la propina SOLA ($0 + $50) es dinero que ya está en el cajón; HTTP la registra y aquí se rechazaba. Mismas
  // reglas que el controller: importe numérico 0 y propina numérica que se guarda (> 0 en centavos enteros, R4-4).
  const soloPropina =
    intent.payload.amountCents === 0 && typeof intent.payload.tipCents === 'number' && hayDineroQueSeGuarda(0, intent.payload.tipCents)
  if (!orderId || !Number.isFinite(amountCents) || amountCents < 0 || (amountCents === 0 && !zeroWithoutTip && !soloPropina)) {
    return {
      id: intent.id,
      status: 'REJECTED',
      errorCode: 'INVALID_PAYLOAD',
      message: 'PAY_CASH requiere orderId/localOrderId y amountCents > 0 (o $0 con propina, o $0 sin propina para cerrar una cuenta en $0)',
    }
  }
  // 🔴 R2-6 (founder 3-oct: el dinero capturado nunca se rechaza ni se pierde): el PAY_CASH es dinero que YA está en el cajón. La
  // propiedad de mesa decide quién INICIA un cobro, no quién registra uno capturado: si un encargado pasó la mesa a otro mesero
  // mientras el aparato estaba sin red, se registra con su autor real y deja rastro de la mesa ajena (payCashOrder). Mismo override
  // que la ruta online del cobro. Un cobro que YA existe (misma llave) no deja otro rastro: payCashOrder devuelve ese pago.
  const pagoDeLaLlave = await prisma.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey: intent.id } },
    select: { orderId: true, status: true, type: true },
  })
  // R5-2: «ya cobrado» = un COBRO COMPLETADO de esta orden (no un intento fallido ni una devolución con esa llave).
  const yaCobrado = !!pagoDeLaLlave && esCobroCompletadoDeLaOrden(pagoDeLaLlave, orderId)
  const mesaAjena = await mesaAjenaDe(venueId, staffId, orderId, PAYMENT_OWNERSHIP_OVERRIDES)
  const hayDinero = hayDineroQueSeGuarda(amountCents, tipCents)
  // 🔴 R3-1 (Codex r2, P2): $0 + $0 NO es dinero capturado (cerraría la mesa de otro sin un peso): conserva el rechazo de antes.
  // R4-4: medido como se guarda (centavos enteros): una fracción de centavo es $0.
  if (mesaAjena && !hayDinero && !yaCobrado) throw errorMesaAjena(mesaAjena)
  // 🔴 R5-1 (Codex r4): el $0 sobre mesa ajena pasó SÓLO porque su llave ya tiene ese cobro: payCashOrder lo devuelve, y si lo
  // borraron entre esta lectura y la suya responde TABLE_OWNED_BY_OTHER en vez de crear un pago. Con dinero (> $0) es el registro
  // de efectivo capturado de R2-6, con su rastro; si el pago existe, payCashOrder lo devuelve y el rastro no se usa.
  const marcaDeMesaAjena = mesaAjena ? (hayDinero ? { mesaAjena } : { soloRecuperarPago: mesaAjena }) : {}
  // 🔴 R6-3 (Codex r5 #3): la revisión de arriba va antes del candado del cobro. Con la regla encendida, payCashOrder la repite bajo
  // el candado con la MISMA regla (overrides de cobro): un $0 sobre una cuenta que pasó a otro mesero en esa ventana ⇒
  // TABLE_OWNED_BY_OTHER; el dinero capturado sigue y deja el rastro de mesa ajena.
  const propiedadDeMesa = (await isTableOwnershipEnforced(venueId))
    ? {
        propiedadDeMesa: {
          userId: staffId,
          puedeCobrarAjena: () => staffCanManageAllTables(staffId, venueId, undefined, undefined, PAYMENT_OWNERSHIP_OVERRIDES),
        },
      }
    : {}

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
    // 🔴 El tipo de pago del catálogo viajaba y se TIRABA aquí: una venta con "Uber
    // Eats" cobrada sin red se reproducía como EFECTIVO, en silencio, y la
    // idempotencia impedía repararla después. Ahora se reenvía con la revisión que
    // el cajero tenía enfrente.
    tenderTypeId: typeof intent.payload.tenderTypeId === 'string' ? intent.payload.tenderTypeId : undefined,
    tenderRevision: Number.isInteger(intent.payload.tenderRevision) ? (intent.payload.tenderRevision as number) : undefined,
    // La venta YA ocurrió: se honra su revisión aunque el catálogo haya cambiado
    // mientras el dispositivo estaba sin red.
    isOfflineReplay: true,
    createdAtLocal: clampSoldAt(intent.createdAtLocal, new Date()).getTime(),
    // D93 (Codex r2 #1): para el reporte, la hora del aparato SIN el piso de clampSoldAt (que fabricaría una hora) y sin inventarla
    // si no vino; con la llegada de este intent como cota.
    horaDelAparato: intent.createdAtLocal ?? null,
    llegada,
    // S3: el servicio la convierte en el turno de la venta (liga 1:1 caja↔turno).
    ...(typeof cashDrawerSessionId === 'string' && cashDrawerSessionId !== '' ? { cashDrawerSessionId } : {}),
    ...(shiftIdDeLaVenta ? { shiftIdDeLaVenta } : {}),
    ...(terminalSerialNumber ? { terminalSerialNumber } : {}),
    ...(antesCents !== undefined ? { saldoEsperadoSinRed: { antesCents, deviceId: deviceId ?? null } } : {}),
    ...marcaDeMesaAjena,
    ...propiedadDeMesa,
    ...(dejarHuella
      ? {
          dentroDeLaTx: (tx: Prisma.TransactionClient, cobro: { orderId: string; paymentId: string }) =>
            dejarHuella(tx, cuentaAparte ? { ...cobro, cuentaOriginal: cuentaPedida } : cobro),
        }
      : {}),
  })
  return ackDelCobro(intent.id, cuentaAparte ? (cuentaPedida as string) : orderId, cuentaAparte, payment)
}

/**
 * El acuse de un cobro: la MISMA forma para el que se acaba de registrar y para el que ya estaba en la base (D20). `cuentaPedida` es la
 * cuenta que nombró el aparato; `cuentaAparte`, la de D7 cuando el cobro cayó ahí.
 */
function ackDelCobro(
  intentId: string,
  cuentaPedida: string,
  cuentaAparte: string | null,
  payment: Awaited<ReturnType<typeof orderMobileService.payCashOrder>>,
): SyncIntentAck {
  return {
    id: intentId,
    status: 'ACKED',
    result: {
      // D7: el aparato conoce la cuenta que pidió; la aparte va nombrada y el saldo de abajo es el de ella.
      orderId: cuentaPedida,
      ...(cuentaAparte ? { cuentaAparte: { orderId: cuentaAparte } } : {}),
      paymentId: payment.paymentId,
      orderNumber: payment.orderNumber,
      digitalReceipt: payment.digitalReceipt ?? null,
      // Resultado económico autoritativo del replay. Una orden puede cambiar
      // entre el cobro sin red y su reproducción (otra caja, descuento o
      // abono). El POS necesita lo que el server realmente registró para
      // reconciliar ticket/cambio/cajón; repetir el payload original volvería
      // a presentar dinero que no quedó en la orden.
      ...(payment.amount !== undefined ? { amount: payment.amount } : {}),
      ...(payment.tipAmount !== undefined ? { tipAmount: payment.tipAmount } : {}),
      ...(payment.changeCents !== undefined ? { changeCents: payment.changeCents } : {}),
      // Lo que se queda en el cajón por este cobro; Rappi 2b le sumará su PAY_IN. Aditivo.
      ...(payment.cashRetainedCents !== undefined ? { cashRetainedCents: payment.cashRetainedCents } : {}),
      ...(payment.method !== undefined ? { method: payment.method } : {}),
      // 🔴 El saldo autoritativo TAMBIÉN por aquí. El ack se arma a mano, así
      // que no heredaba los campos nuevos de `payCashOrder` y el contrato nuevo
      // no existía justo en el flujo que más lo necesita: un abono parcial hecho
      // SIN RED se reproduce al reconectar y el POS volvía a deducir el restante
      // con aritmética local del carrito.
      //
      // ADITIVO puro: no cambia la forma del ack ni sus tres estados
      // (`.claude/rules/offline-first-y-hub-lan.md` §2.2), no toca
      // `SyncIntentType`, y un cliente viejo simplemente los ignora.
      //
      // Se omiten (no se ponen en 0) cuando el server no pudo resolver el saldo
      // — mismo criterio que la respuesta en línea: ausente es honesto.
      ...(payment.remainingBalanceCents !== undefined ? { remainingBalanceCents: payment.remainingBalanceCents } : {}),
      ...(payment.orderPaymentStatus !== undefined ? { orderPaymentStatus: payment.orderPaymentStatus } : {}),
      ...(payment.orderTotalCents !== undefined ? { orderTotalCents: payment.orderTotalCents } : {}),
      ...(payment.totalPaidCents !== undefined ? { totalPaidCents: payment.totalPaidCents } : {}),
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
  dejarHuella?: DejarHuella,
  authorizeIntent?: (intent: SyncIntentInput, requiredPermission: string) => boolean,
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
      // D1 (hz:f34960c5:D1): sin red tampoco se regala sin permiso: el servicio rechaza un COMP si quien encoló no trae
      // `orders:comp` (sin `authorizeIntent`, falla cerrado). El tipo sólo se sabe bajo el candado, por eso no va en
      // `requiredPermissionsForIntent`.
      // D4 (hz:f34960c5:D4): lo mismo para un % o fijo con «Requiere aprobación»: entra si la sesión que lo sube tiene
      // `tpv-orders:discount`; si no, 403 PERMISSION_DENIED ⇒ REJECTED visible (sin red no hay PIN). Una caída de base sigue en RETRY.
      await orderMobileService.applyOrderDiscount(
        venueId,
        orderId,
        discountId,
        staffId,
        authorizeIntent?.(intent, 'orders:comp') === true,
        authorizeIntent?.(intent, 'tpv-orders:discount') === true ? {} : undefined,
        // Encargo f998c8: el motivo viaja en el payload (opcional; uno viejo no lo trae y entra «Sin motivo», nunca REJECTED).
        motivoDelDescuento(p.reason, p.reasonComment),
      )
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
      const customerId = typeof p.customerId === 'string' ? p.customerId : undefined
      // 🔴 R4-2 (ronda 4 post-QA de sellos tardíos; decisión «A»): el MISMO servicio que la ruta online decide, bajo el candado de
      // la venta, si se puede cambiar el cliente de una venta COBRADA; aquí sólo se le dice si quien encoló tiene
      // `payments:create` (sin `authorizeIntent`, falla cerrado). Sin red no es puerta trasera.
      const opciones =
        customerId !== undefined
          ? {
              puedeCambiarClienteEnVentaCobrada: authorizeIntent?.(intent, 'payments:create') === true,
              customerAttribution: {
                staffId,
                canAssignHistorical: authorizeIntent?.(intent, 'orders:attach-customer') === true,
                canAttachAtReceipt: authorizeIntent?.(intent, 'payments:create') === true,
              },
            }
          : {}
      await orderMobileService.updateOrderDetails(
        venueId,
        orderId,
        {
          name: typeof p.name === 'string' ? p.name : undefined,
          notes: typeof p.notes === 'string' ? p.notes : undefined,
          covers: typeof p.covers === 'number' ? p.covers : undefined,
          customerId,
          orderType: typeof p.orderType === 'string' ? p.orderType : undefined,
        } as any,
        opciones,
      )
      break
    }
    case 'CANCEL_ORDER': {
      await orderMobileService.cancelOrder(
        venueId,
        orderId,
        typeof p.reason === 'string' ? p.reason : undefined,
        staffId,
        dejarHuella ? (tx, cancelada) => dejarHuella(tx, cancelada) : undefined,
      )
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

/**
 * CLEAR_TABLE — liberar mesa; el server rechaza si tiene cuenta sin pagar.
 *
 * D75 (hz:8024bc1c:D75): el payload puede traer la cuenta que el aparato quiso soltar (`orderId` | `localOrderId`, opcional; iOS, la
 * TPV y las apps viejas sólo mandan la mesa → como hoy). Si esa cuenta ya no debe y lo que debe la mesa es OTRA cuenta (la mesa
 * abierta sin red que terminó en cuenta aparte, D51/D71), no hay nada suyo que liberar: ACK sin tocar la mesa. Antes se rechazaba
 * por la otra cuenta (`BUSINESS_RULE` o `TABLE_OWNED_BY_OTHER`) y quedaba una «operación por revisar» que nadie puede resolver. Va
 * antes de la propiedad de mesa y no escribe nada: no puede liberar ni re-apuntar la cuenta de otro. El ACK no nombra la cuenta: en
 * ANDROID un `orderId` en el resultado confirma la sesión de esa cuenta (`TableSyncCoordinator`).
 *
 * D75b (15-nov-2026, antes de publicar D51/D71): las apps viejas (TPV 2.10–2.20, iOS, ANDROID ≤2.25.44) sólo mandan la mesa. Para
 * ellas, la cuenta que quisieron soltar es la cuenta aparte que ESE aparato abrió en esa mesa (`cuentaAparteDelAparatoSaldada`).
 */
async function applyClearTable(
  venueId: string,
  staffId: string,
  intent: SyncIntentInput,
  localRefMap: Map<string, string>,
  deviceId?: string,
): Promise<SyncIntentAck> {
  await assertTableService(venueId)
  const tableId = typeof intent.payload.tableId === 'string' ? intent.payload.tableId : null
  if (!tableId) return invalid(intent, 'CLEAR_TABLE requiere tableId')

  const suCuenta = await cuentaQueQuisoSoltar(venueId, intent.payload, localRefMap)
  // naf9f31c: ¿la cuenta que nombra es de la sucursal? Si sí, sólo se libera la mesa si sigue en ella (se vuelve a comprobar
  // bajo el candado al liberar, Codex r1 #1). Si no es de nadie, como hoy.
  const cuentaConocida = suCuenta ? await cuentaDeLaSucursal(venueId, suCuenta) : null
  if (cuentaConocida && cuentaConocida.tableId !== tableId) {
    logger.info(
      `🪑 [POS SYNC] CLEAR_TABLE ${intent.id}: la cuenta ${suCuenta} ya no está en la mesa ${tableId} (otro aparato la movió) — sin cambios`,
    )
    return { id: intent.id, status: 'ACKED', result: { tableId, mesaSinCambios: true } }
  }
  if (suCuenta && (await nadaSuyoQueLiberar(venueId, tableId, suCuenta))) {
    logger.info(
      `🪑 [POS SYNC] CLEAR_TABLE ${intent.id}: la cuenta ${suCuenta} ya no debe y la mesa ${tableId} sigue con otra — sin cambios`,
    )
    return { id: intent.id, status: 'ACKED', result: { tableId, mesaSinCambios: true } }
  }
  const traeCuenta = typeof intent.payload.orderId === 'string' || typeof intent.payload.localOrderId === 'string'
  if (!traeCuenta && deviceId) {
    const cuentaAparte = await cuentaAparteDelAparatoSaldada(venueId, tableId, deviceId)
    if (cuentaAparte) {
      logger.info(
        `🪑 [POS SYNC] CLEAR_TABLE ${intent.id} (app vieja): la cuenta aparte ${cuentaAparte} de ${deviceId} ya no debe y la mesa ${tableId} sigue con otra — sin cambios`,
      )
      return { id: intent.id, status: 'ACKED', result: { tableId, mesaSinCambios: true } }
    }
  }

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

  if (cuentaConocida) {
    if (!(await tableService.clearTableDeLaCuenta(venueId, tableId, cuentaConocida.id))) {
      logger.info(
        `🪑 [POS SYNC] CLEAR_TABLE ${intent.id}: la cuenta ${cuentaConocida.id} dejó la mesa ${tableId} mientras se liberaba — sin cambios`,
      )
      return { id: intent.id, status: 'ACKED', result: { tableId, mesaSinCambios: true } }
    }
  } else {
    await tableService.clearTable(venueId, tableId)
  }
  return { id: intent.id, status: 'ACKED', result: { tableId } }
}

/**
 * D75: la cuenta que nombra el `CLEAR_TABLE`. ANDROID elige `orderId` o `localOrderId` con la sesión de ESE momento, que pudo
 * ascender o cerrarse mientras `/clear` esperaba la red (Codex r1 #1): un id local puede llegar como `orderId`. Si no es una cuenta de
 * la sucursal, se busca como id local (mismo camino que las demás operaciones). Sólo decide el ACK sin cambios, que no escribe nada.
 */
async function cuentaQueQuisoSoltar(
  venueId: string,
  payload: Record<string, unknown>,
  localRefMap: Map<string, string>,
): Promise<string | null> {
  const id = await resolveOrderId(venueId, payload, localRefMap)
  if (!id || typeof payload.localOrderId === 'string') return id
  if (await prisma.order.findFirst({ where: { id, venueId }, select: { id: true } })) return id
  return resolveOrderId(venueId, { localOrderId: id }, localRefMap)
}

/**
 * naf9f31c (encargo 64000e): la cuenta que nombra el `CLEAR_TABLE` existe en la sucursal pero hoy está en OTRA mesa (o en
 * ninguna): otro aparato la movió mientras el plano de quien la cobró iba atrasado. No hay nada suyo que liberar en `tableId`:
 * liberarla le borraba el estado a la mesa vieja (una reservación) y dejaba un `TABLE_CLEARED` falso. La mesa nueva la suelta
 * el cobro (`releaseTableIfSettled`). Sólo decide el ACK sin cambios, que no escribe nada.
 */
async function cuentaDeLaSucursal(venueId: string, orderId: string): Promise<{ id: string; tableId: string | null } | null> {
  return prisma.order.findFirst({ where: { id: orderId, venueId }, select: { id: true, tableId: true } })
}

/**
 * D75: la cuenta del aparato ya no debe (cerrada, anulada o pagada) y lo que debe la mesa es OTRA cuenta.
 * ponytail: se decide sin el candado de la mesa. Si la otra cuenta se salda o se anula justo después, la mesa la libera ese cobro o esa
 * anulación (`releaseTableIfSettled`), no este intent; si aparece otra justo antes de liberar, sale el rechazo de hoy.
 */
async function nadaSuyoQueLiberar(venueId: string, tableId: string, orderId: string): Promise<boolean> {
  const suya = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { status: true, paymentStatus: true } })
  if (!suya || !(['COMPLETED', 'CANCELLED', 'DELETED'].includes(suya.status) || suya.paymentStatus === 'PAID')) return false
  const otraQueDebe = await prisma.order.findFirst({
    where: {
      venueId,
      tableId,
      id: { not: orderId },
      status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
      paymentStatus: { not: 'PAID' },
    },
    select: { id: true },
  })
  return otraQueDebe !== null
}

const NOTA_VIGENTE_MS = 24 * 60 * 60 * 1000

/**
 * D75b: la cuenta aparte que ESTE aparato abrió sin red en esta mesa (nota `MESA_SIN_RED_EN_CUENTA_APARTE` con su `deviceId`), si ya
 * no debe, TODO lo que debe la mesa son cuentas que ya estaban cuando nació (`otrasCuentas` de la nota) y ninguna de ellas cambió
 * después de la nota. Si no → null (el rechazo de hoy):
 * - una cuenta nacida después;
 * - una que cambió después (Codex r1 #1: el aparato le cobró un abono a otra cuenta y el CLEAR puede ser de ESA);
 * - otro aparato;
 * - una nota de más de 24 h;
 * - la cuenta aparte todavía debiendo.
 *
 * Sin tope de cuentas (Codex r1 #2). Sólo decide el ACK sin cambios, que no escribe nada.
 */
async function cuentaAparteDelAparatoSaldada(venueId: string, tableId: string, deviceId: string): Promise<string | null> {
  const queDeben: Prisma.OrderWhereInput = {
    venueId,
    tableId,
    status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
    paymentStatus: { not: 'PAID' },
  }
  // Sin nada que deba, el CLEAR_TABLE de hoy libera la mesa: el camino de todos los días no paga la búsqueda de la nota.
  if (!(await prisma.order.findFirst({ where: queDeben, select: { id: true } }))) return null
  const nota = await prisma.activityLog.findFirst({
    where: {
      venueId,
      // D7 (Codex r0 #7): también la cuenta aparte de una ronda tardía (su nota trae `otrasCuentas` y `deviceId` igual).
      action: { in: ['MESA_SIN_RED_EN_CUENTA_APARTE', NOTA_RONDA_TARDIA] },
      entity: 'Order',
      createdAt: { gte: new Date(Date.now() - NOTA_VIGENTE_MS) },
      AND: [{ data: { path: ['tableId'], equals: tableId } }, { data: { path: ['deviceId'], equals: deviceId } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { entityId: true, data: true, createdAt: true },
  })
  const otrasCuentas = (nota?.data as { otrasCuentas?: unknown } | null)?.otrasCuentas
  if (!nota?.entityId || !Array.isArray(otrasCuentas)) return null
  const conocidas = otrasCuentas.filter((id): id is string => typeof id === 'string')
  const nuevaOTocada = await prisma.order.findFirst({
    where: {
      ...queDeben,
      OR: [{ id: { notIn: [...conocidas, nota.entityId] } }, { id: { in: conocidas }, updatedAt: { gt: nota.createdAt } }],
    },
    select: { id: true },
  })
  if (nuevaOTocada) return null
  return (await nadaSuyoQueLiberar(venueId, tableId, nota.entityId)) ? nota.entityId : null
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

/**
 * KDS_TICKET_MARK — payload: { sourceKey, stationId?, action: 'BUMP' | 'FALLBACK_PRINTED', label? }
 * La pantalla marcó LISTO sin red, o la caja imprimió la comanda en papel de respaldo (spec 2026-09-27 §3). Se junta
 * con la comanda por su FOLIO, antes o después de que el servidor la arme.
 *
 * SIEMPRE ACK, salvo un error transitorio de base (RETRY): una marca de cocina jamás va a cuarentena ni detiene los
 * cobros encolados detrás de ella. El servidor la conoce ANTES que las apps (orden de despliegue: backend primero);
 * Android e iOS la agregan en sus fases 3.4 y 3.5.
 */

async function applyKdsTicketMark(venueId: string, intent: SyncIntentInput): Promise<SyncIntentAck> {
  const p = intent.payload ?? {}
  const sourceKey = typeof p.sourceKey === 'string' ? p.sourceKey.trim() : ''
  const action = p.action === 'BUMP' || p.action === 'FALLBACK_PRINTED' ? p.action : null
  if (!FOLIO_VALIDO.test(sourceKey) || !action) {
    logger.warn(`⚠️ [POS SYNC] KDS_TICKET_MARK ilegible — se reconoce y se ignora (intent ${intent.id})`)
    return { id: intent.id, status: 'ACKED', result: { ignored: 'INVALID_PAYLOAD' } }
  }
  try {
    await markKitchenTicket({
      venueId,
      sourceKey,
      stationId: typeof p.stationId === 'string' && p.stationId ? p.stationId : null,
      action,
      label: typeof p.label === 'string' ? p.label : null,
      at: horaDeLaMarca(intent),
    })
    return { id: intent.id, status: 'ACKED', result: { sourceKey, action } }
  } catch (error: any) {
    const errorCode = error?.errorCode ?? error?.code ?? 'KDS_MARK_FAILED'
    if (esErrorTransitorio(error)) throw error // applyIntent lo convierte en RETRY
    logger.error(`[POS SYNC] KDS_TICKET_MARK no se aplicó (${errorCode}); se reconoce para no bloquear la cola (intent ${intent.id})`)
    return { id: intent.id, status: 'ACKED', result: { ignored: errorCode } }
  }
}

/** El reloj del aparato es informativo: se usa sólo si es razonable (no futuro, no más de 24 h atrás). */
function horaDeLaMarca(intent: SyncIntentInput): Date {
  const ahora = Date.now()
  const t = typeof intent.createdAtLocal === 'number' ? intent.createdAtLocal : Number.NaN
  return Number.isFinite(t) && t <= ahora && t >= ahora - 24 * 60 * 60 * 1000 ? new Date(t) : new Date(ahora)
}

// ─── Estado de sync (dashboard/MCP) ─────────────────────────────────────────

/** Últimos intents procesados del venue — visibilidad de replays y rechazos. */
export async function getRecentIntents(venueId: string, limit = 50) {
  return prisma.posSyncIntent.findMany({
    where: { venueId, type: { not: 'HTTP_OP_V1' } },
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
