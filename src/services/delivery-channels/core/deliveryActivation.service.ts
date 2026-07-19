/**
 * Servicio de solicitud de activación de delivery (DeliveryActivationRequest) — self-serve.
 *
 * Distinto de DeliveryChannelLink (la conexión técnica real con un proveedor): esto es la
 * INTENCIÓN de un venue de activar delivery. El dueño la crea desde el dashboard; ops la
 * avanza manualmente (PENDING → CONTACTED → CONNECTED, o DISMISSED) mientras configura la
 * integración real con Deliverect fuera de este flujo.
 *
 * Reglas clave:
 * - "Viva" = status PENDING o CONTACTED. Solo puede haber una viva por venue a la vez.
 * - `createActivationRequest` es idempotente: si ya hay una viva para el venue, la devuelve
 *   tal cual (NO crea otra, NO vuelve a loguear) — evita que un dueño impaciente genere
 *   solicitudes duplicadas en la cola de ops. Fix A2 (audit, spec §10.2): el find+create vive
 *   DENTRO de la MISMA `prisma.$transaction` — cierra el TOCTOU del check-then-create original
 *   (ver docstring de la función).
 * - `updateActivationStatus` es la transición de ops (fuera del alcance de este service quién
 *   puede llamarla — eso lo gatea el controller/permisos). Sella `contactedAt`/`connectedAt`
 *   automáticamente al entrar a ese status. Fix A2: valida la transición contra
 *   `VALID_ACTIVATION_TRANSITIONS` ANTES de escribir — CONNECTED/DISMISSED son terminales.
 * - Cada mutación escribe ActivityLog vía `logAction` (fire-and-forget, `void`, fuera de
 *   cualquier transacción) — mismo patrón que el resto de `delivery-channels/core/`.
 */
import prisma from '../../../utils/prismaClient'
import { DeliveryActivationRequest, DeliveryActivationStatus, Prisma } from '@prisma/client'
import { logAction } from '../../dashboard/activity-log.service'
import { NotFoundError, ValidationError } from '../../../errors/AppError'

const LIVE_STATUSES: DeliveryActivationStatus[] = [DeliveryActivationStatus.PENDING, DeliveryActivationStatus.CONTACTED]

/**
 * La solicitud "viva" (PENDING o CONTACTED) del venue, o null si no hay ninguna en curso.
 * Acepta un cliente de transacción (`db`) — Fix A2 (audit, spec §10.2) lo usa DENTRO de la tx
 * de `createActivationRequest` para re-chequear con el cliente `tx` (no con el `prisma` de
 * arriba) y así cerrar el race TOCTOU del check-then-create. Mismo patrón que
 * `isPeriodLocked(..., db: Prisma.TransactionClient = prisma)` en accountingPeriodLock.service.ts.
 */
export async function getActivationRequest(
  venueId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<DeliveryActivationRequest | null> {
  return db.deliveryActivationRequest.findFirst({
    where: { venueId, status: { in: LIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
  })
}

export interface CreateActivationRequestInput {
  requestedChannels: string[]
  note?: string
}

/**
 * Crea una solicitud de activación. Idempotente: si el venue ya tiene una viva, la devuelve
 * sin crear otra ni volver a escribir ActivityLog.
 *
 * Fix A2 (audit, spec §10.2): antes esto era check-then-create SIN transacción —
 * `getActivationRequest` corría contra `prisma` y el `create` posterior era una llamada
 * independiente, así que dos POSTs concurrentes podían AMBOS leer "sin viva" antes de que
 * cualquiera insertara la suya → duplicados en la cola de ops. El find+create ahora vive
 * DENTRO de la MISMA `prisma.$transaction` (se re-chequea con el cliente `tx`, no el `prisma`
 * de arriba). Esto reduce la ventana de la carrera pero es best-effort, NO una garantía a nivel
 * de base de datos: sin un índice único, dos transacciones verdaderamente simultáneas bajo el
 * READ COMMITTED default de Postgres aún podrían colar un duplicado (un SELECT sin `FOR UPDATE`
 * no bloquea a otra transacción). No se agrega el índice aquí a propósito — mete drift de
 * migración en un árbol compartido con otras sesiones activas sobre este mismo dominio.
 * TODO staging: índice único parcial WHERE status IN (PENDING,CONTACTED) para defensa DB-level.
 */
export async function createActivationRequest(
  venueId: string,
  requestedById: string,
  input: CreateActivationRequestInput,
): Promise<DeliveryActivationRequest> {
  const { created, existing } = await prisma.$transaction(async tx => {
    const existing = await getActivationRequest(venueId, tx)
    if (existing) return { created: null, existing }

    const created = await tx.deliveryActivationRequest.create({
      data: {
        venueId,
        requestedById,
        requestedChannels: input.requestedChannels,
        note: input.note ?? null,
      },
    })
    return { created, existing: null }
  })

  if (existing) return existing // idempotente: no duplicar una solicitud viva

  void logAction({
    action: 'DELIVERY_ACTIVATION_REQUESTED',
    entity: 'DeliveryActivationRequest',
    entityId: created!.id,
    staffId: requestedById,
    venueId,
    data: { requestedChannels: input.requestedChannels, note: input.note ?? null },
  })

  return created!
}

const STATUS_ACTION: Record<DeliveryActivationStatus, string> = {
  PENDING: 'DELIVERY_ACTIVATION_REQUESTED',
  CONTACTED: 'DELIVERY_ACTIVATION_CONTACTED',
  CONNECTED: 'DELIVERY_ACTIVATION_CONNECTED',
  DISMISSED: 'DELIVERY_ACTIVATION_DISMISSED',
}

/**
 * Fix A2 (audit, spec §10.2) — máquina de transiciones: CONNECTED y DISMISSED son estados
 * TERMINALES (ninguna transición de salida es válida, ni siquiera entre ellos) — antes de la
 * auditoría se podía "revertir" una solicitud ya conectada/descartada de vuelta a
 * PENDING/CONTACTED sin ninguna validación. PENDING/CONTACTED son no-terminales y pueden
 * moverse libremente entre sí y hacia cualquier otro status (incluyendo permanecer en el mismo,
 * un no-op).
 */
const VALID_ACTIVATION_TRANSITIONS: Record<DeliveryActivationStatus, DeliveryActivationStatus[]> = {
  [DeliveryActivationStatus.PENDING]: [
    DeliveryActivationStatus.PENDING,
    DeliveryActivationStatus.CONTACTED,
    DeliveryActivationStatus.CONNECTED,
    DeliveryActivationStatus.DISMISSED,
  ],
  [DeliveryActivationStatus.CONTACTED]: [
    DeliveryActivationStatus.CONTACTED,
    DeliveryActivationStatus.PENDING,
    DeliveryActivationStatus.CONNECTED,
    DeliveryActivationStatus.DISMISSED,
  ],
  [DeliveryActivationStatus.CONNECTED]: [DeliveryActivationStatus.CONNECTED], // terminal — sin transiciones de salida
  [DeliveryActivationStatus.DISMISSED]: [DeliveryActivationStatus.DISMISSED], // terminal — sin transiciones de salida
}

/**
 * Transición de ops sobre una solicitud existente. Sella `contactedAt` al entrar a CONTACTED
 * y `connectedAt` al entrar a CONNECTED; DISMISSED solo cambia el status. Fix A2: lee el status
 * ACTUAL primero y valida la transición contra `VALID_ACTIVATION_TRANSITIONS` antes de escribir.
 */
export async function updateActivationStatus(
  id: string,
  status: DeliveryActivationStatus,
  performedBy: string,
): Promise<DeliveryActivationRequest> {
  const current = await prisma.deliveryActivationRequest.findUnique({ where: { id }, select: { status: true } })
  if (!current) {
    throw new NotFoundError('Solicitud de activación de delivery no encontrada')
  }
  if (!VALID_ACTIVATION_TRANSITIONS[current.status].includes(status)) {
    throw new ValidationError(
      `Transición inválida: no se puede pasar de ${current.status} a ${status} (${current.status} es un estado terminal)`,
    )
  }

  const data: Prisma.DeliveryActivationRequestUpdateInput = { status }
  if (status === DeliveryActivationStatus.CONTACTED) data.contactedAt = new Date()
  if (status === DeliveryActivationStatus.CONNECTED) data.connectedAt = new Date()

  let updated: DeliveryActivationRequest
  try {
    updated = await prisma.deliveryActivationRequest.update({ where: { id }, data })
  } catch (error: any) {
    // Fix 2 (audit, API-CONTRACT): update() by unique id throws P2025 for a missing row —
    // translate to the same NotFoundError contract updateChannelLink/pauseChannelLink use
    // (they go through updateMany+count===0 instead, but the caller-facing contract must match).
    // Defense-in-depth now that the findUnique pre-check above catches the common case: a TOCTOU
    // race where the row is deleted between the pre-check and this update() call.
    if (error?.code === 'P2025') {
      throw new NotFoundError('Solicitud de activación de delivery no encontrada')
    }
    throw error
  }

  void logAction({
    action: STATUS_ACTION[status],
    entity: 'DeliveryActivationRequest',
    entityId: id,
    staffId: performedBy,
    venueId: updated.venueId,
    data: { status },
  })

  return updated
}

export type ActivationRequestWithVenue = Prisma.DeliveryActivationRequestGetPayload<{
  include: { venue: { select: { name: true; slug: true } } }
}>

export interface ListActivationRequestsFilter {
  status?: DeliveryActivationStatus
  /**
   * Fix 5 (audit, API-CONTRACT): scope the query itself to one venue — used by the MCP
   * single-venue path so it never has to fetch the full cross-tenant ops queue just to
   * keep one row's worth via an in-memory filter.
   */
  venueId?: string
  /**
   * Fix 5 (audit): scope the query to a set of venues — defense-in-depth for the MCP
   * all-venues path (bounds the fetch to the caller's allowed scope BEFORE the finer-grained
   * in-memory permission/feature filtering runs; that filtering still runs unchanged).
   */
  venueIds?: string[]
}

/**
 * Cola de ops (superadmin, Task 4): TODAS las solicitudes de activación (cross-venue, sin
 * scoping por venueId — a propósito, es un endpoint de ops), más recientes primero, con
 * `venue.name`/`venue.slug` para mostrar en la UI sin un round-trip extra. `status` es un
 * filtro opcional; sin filtro trae cualquier status. `venueId`/`venueIds` (Fix 5, audit) son
 * opcionales: el REST superadmin los omite (ops ve todo, sin cambios); el MCP customer-facing
 * (`src/mcp/tools/deliveryActivation.ts`) SIEMPRE pasa uno de los dos para que la query quede
 * scopeada en el servidor en vez de traer la cola completa y filtrar en memoria.
 */
export async function listActivationRequests(filter?: ListActivationRequestsFilter): Promise<ActivationRequestWithVenue[]> {
  return prisma.deliveryActivationRequest.findMany({
    where: {
      ...(filter?.status ? { status: filter.status } : {}),
      ...(filter?.venueId ? { venueId: filter.venueId } : {}),
      ...(filter?.venueIds ? { venueId: { in: filter.venueIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: { venue: { select: { name: true, slug: true } } },
  })
}
