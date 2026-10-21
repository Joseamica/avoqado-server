import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../errors/AppError'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { tomarCandadoDeComandas } from './kitchenTicketAuthoring.service'
import { ORDER_LOCK_WAIT_BUDGET } from '../shared/paymentShiftClaim'
import {
  parsePreparation,
  preparationTicketStatus,
  transitionPreparation,
  PREPARATION_VERSION,
  PREPARATION_STATES,
} from './kitchenPreparation'

export const preparationActionSchema = z.enum(
  ['RELEASE', 'START', 'READY', 'DELIVER', 'CANCEL', 'REOPEN', 'URGENT', 'ACK_URGENT', 'CLEAR_URGENT'],
  {
    errorMap: () => ({ message: 'Selecciona una acción de preparación válida' }),
  },
)
export const preparationCommandSchema = z
  .object({
    action: preparationActionSchema,
    reason: z.string().trim().max(500, 'El motivo admite hasta 500 caracteres').optional(),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128).optional(),
            externalId: z.string().min(1).max(256).optional(),
            sourceKey: z.string().min(1).max(256).optional(),
            stationId: z.string().min(1).max(128).nullable().optional(),
            expectedRevision: z.number().int().nonnegative(),
            quantity: z.number().int().positive(),
            from: z.enum(PREPARATION_STATES).optional(),
          })
          .strict()
          .refine(i => Boolean(i.id || (i.externalId && i.sourceKey)), 'Identifica cada producto por su comanda y renglón'),
      )
      .min(1, 'Selecciona al menos un producto')
      .max(100, 'Selecciona hasta 100 productos por operación'),
  })
  .strict()

export async function preparationCapabilities(venueId: string) {
  return {
    version: PREPARATION_VERSION,
    intentType: 'KDS_ITEM_PROGRESS',
    replayLaneVersion: 1,
    urgencyVersion: 1,
    enabled: await venueHasFeatureAccess(venueId, 'KITCHEN_DISPLAY'),
    maxItems: 100,
  }
}

async function assertEnabled(venueId: string) {
  if (!(await venueHasFeatureAccess(venueId, 'KITCHEN_DISPLAY'))) {
    throw new ForbiddenError('El seguimiento de preparación requiere Pro y Pantalla de cocina.', 'FEATURE_ACCESS_REQUIRED')
  }
}

/** Same reducer for every client. Exact selections, revision CAS, and audit are one atomic operation. */
export async function applyKitchenPreparation(venueId: string, orderId: string, value: unknown, staffId: string, intentId?: string) {
  const parsed = preparationCommandSchema.safeParse(value)
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message, 'PREPARATION_PAYLOAD_INVALID')
  const command = parsed.data
  await assertEnabled(venueId)
  if (!orderId) {
    if (intentId && command.items.every(item => !item.id && item.externalId && item.sourceKey)) {
      throw new ConflictError(
        'La cuenta y su comanda todavía están por sincronizar. La preparación sigue pendiente.',
        'PREPARATION_DEPENDENCY_PENDING',
      )
    }
    throw new NotFoundError('No encontramos esta cuenta')
  }
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Venue" WHERE id=${venueId} FOR KEY SHARE`
    await tomarCandadoDeComandas(tx, orderId)
    const order = await tx.order.findFirst({ where: { id: orderId, venueId }, select: { id: true, status: true } })
    if (!order) {
      if (intentId && command.items.every(item => !item.id && item.externalId && item.sourceKey)) {
        throw new ConflictError(
          'La cuenta y su comanda todavía están por sincronizar. La preparación sigue pendiente.',
          'PREPARATION_DEPENDENCY_PENDING',
        )
      }
      throw new NotFoundError('No encontramos esta cuenta')
    }
    if (order.status === 'CANCELLED' || order.status === 'DELETED') {
      throw new ConflictError('La cuenta fue anulada. Revisa la reposición antes de continuar.', 'PREPARATION_ORDER_CANCELLED')
    }
    const selectors = command.items.map(i =>
      i.id
        ? { id: i.id }
        : {
            externalLineId: i.externalId!,
            kdsOrder: { sourceKey: i.sourceKey!, ...(i.stationId !== undefined ? { printStationId: i.stationId } : {}) },
          },
    )
    const selected = await tx.kdsOrderItem.findMany({
      where: { kdsOrder: { venueId, orderId }, OR: selectors },
      include: { kdsOrder: true },
      orderBy: { id: 'asc' },
      take: 101,
    })
    const matches = command.items.map(i =>
      selected.filter(r =>
        i.id
          ? r.id === i.id
          : r.externalLineId === i.externalId &&
            r.kdsOrder.sourceKey === i.sourceKey &&
            (i.stationId === undefined || r.kdsOrder.printStationId === i.stationId),
      ),
    )
    const ids = matches.flatMap(m => m.map(r => r.id))
    if (selected.length !== command.items.length || matches.some(m => m.length !== 1) || new Set(ids).size !== ids.length) {
      const waitingForAuthoring =
        intentId &&
        matches.some(m => m.length === 0) &&
        matches.every((m, index) => m.length === 1 || (m.length === 0 && !command.items[index].id)) &&
        new Set(ids).size === ids.length
      if (waitingForAuthoring) {
        const missingExternalIds = [
          ...new Set(command.items.filter((_, index) => matches[index].length === 0).map(item => item.externalId!)),
        ]
        const alreadyAuthored = await tx.kdsOrderItem.count({
          where: { externalLineId: { in: missingExternalIds }, kdsOrder: { venueId, orderId } },
        })
        if (alreadyAuthored === 0) {
          throw new ConflictError(
            'La comanda todavía está por sincronizar. La acción de preparación sigue pendiente.',
            'PREPARATION_DEPENDENCY_PENDING',
          )
        }
      }
      throw new ConflictError('Los productos de la selección cambiaron. Recarga la comanda.', 'PREPARATION_ITEMS_CHANGED')
    }
    if (selected.some(r => r.kdsOrder.preparationVersion !== PREPARATION_VERSION || r.preparation == null)) {
      throw new ConflictError(
        'Esta comanda usa el flujo anterior. Actualiza las apps antes de operar por producto.',
        'PREPARATION_VERSION_REQUIRED',
      )
    }
    // Priority targets only selected unfinished stations. A station that already
    // completed its work must not be released again to prioritize another station.
    const priority = ['URGENT', 'ACK_URGENT', 'CLEAR_URGENT'].includes(command.action)
    const allStations = !priority && command.action !== 'START' && command.action !== 'READY'
    if (allStations) {
      const amounts = new Map<string, string>()
      matches.forEach(([row], index) => {
        const item = command.items[index]
        const key = row.orderItemId ?? row.id
        const selection = `${item.quantity}:${command.action === 'CANCEL' || command.action === 'REOPEN' ? '' : (item.from ?? '')}`
        if (amounts.has(key) && amounts.get(key) !== selection) {
          throw new ConflictError('Usa la misma cantidad y estado en todas las estaciones del producto.', 'PREPARATION_STATION_QUANTITY')
        }
        amounts.set(key, selection)
      })
      const sourceIds = [...new Set(selected.map(r => r.orderItemId).filter((id): id is string => Boolean(id)))]
      // Bounded exact-id batch, max 100 products × 50 stations. No venue-wide preload.
      const related = await tx.kdsOrderItem.findMany({
        where: { orderItemId: { in: sourceIds }, kdsOrder: { venueId, orderId, preparationVersion: PREPARATION_VERSION } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 5001,
      })
      const chosen = new Set(ids)
      if (related.some(r => !chosen.has(r.id))) {
        throw new ConflictError(
          'Selecciona todas las estaciones del producto para liberar, entregar o corregir su preparación.',
          'PREPARATION_STATIONS_REQUIRED',
        )
      }
    }
    // Validate the ENTIRE selection before the first write. Future rounds never enter this set.
    const urgencyRequestId = command.action === 'URGENT' ? (intentId ?? randomUUID()) : undefined
    const updates = matches.map(([row], index) => {
      const item = command.items[index]
      if (row.preparationRevision !== item.expectedRevision) {
        if (intentId && row.preparationRevision < item.expectedRevision) {
          throw new ConflictError('Una acción anterior de este producto todavía está por sincronizar.', 'PREPARATION_REVISION_PENDING')
        }
        throw new ConflictError('Otro compañero cambió este producto. Revisa su estado.', 'PREPARATION_CONFLICT', {
          id: row.id,
          preparationRevision: row.preparationRevision,
          preparation: row.preparation,
        })
      }
      const before = parsePreparation(row.preparation, row.quantity)
      return {
        row,
        before,
        after: transitionPreparation(before, command.action, item.quantity, item.from, command.reason, urgencyRequestId),
      }
    })
    for (const { row, after } of updates) {
      const cas = await tx.kdsOrderItem.updateMany({
        where: { id: row.id, preparationRevision: row.preparationRevision, kdsOrder: { venueId, orderId } },
        data: { preparation: after as Prisma.InputJsonValue, preparationRevision: { increment: 1 } },
      })
      if (cas.count !== 1) throw new ConflictError('Otro compañero cambió el producto. Revisa su estado.', 'PREPARATION_CONFLICT')
    }
    const ticketIds = [...new Set(selected.map(r => r.kdsOrderId))]
    const current = await tx.kdsOrderItem.findMany({
      where: { kdsOrderId: { in: ticketIds }, kdsOrder: { venueId, orderId } },
      select: { id: true, kdsOrderId: true, quantity: true, preparation: true },
      orderBy: { id: 'asc' },
      take: 5001,
    })
    if (current.length > 5000)
      throw new ConflictError('Divide esta comanda antes de actualizar su preparación.', 'PREPARATION_TICKET_TOO_LARGE')
    const afterById = new Map(updates.map(u => [u.row.id, u.after]))
    for (const ticketId of ticketIds) {
      const counts = current
        .filter(r => r.kdsOrderId === ticketId)
        .map(r => afterById.get(r.id) ?? parsePreparation(r.preparation, r.quantity))
      const status = preparationTicketStatus(counts)
      await tx.kdsOrder.updateMany({
        where: { id: ticketId, venueId, preparationVersion: PREPARATION_VERSION },
        data: { status, completedAt: status === 'COMPLETED' ? new Date() : null },
      })
    }
    await tx.activityLog.create({
      data: {
        venueId,
        staffId,
        action: `KITCHEN_${command.action}`,
        entity: 'KdsOrderItem',
        entityId: orderId,
        data: {
          orderId,
          reason: command.reason ?? null,
          items: updates.map(u => ({
            id: u.row.id,
            orderItemId: u.row.orderItemId,
            stationId: u.row.kdsOrder.printStationId,
            revision: u.row.preparationRevision + 1,
            before: u.before,
            after: u.after,
          })),
        },
      },
    })
    const result = {
      orderId,
      items: updates.map(u => ({ id: u.row.id, preparation: u.after, preparationRevision: u.row.preparationRevision + 1 })),
    }
    if (intentId) {
      // A lost response or a killed server after COMMIT must return the original outcome,
      // not leave PROCESSING while the kitchen quantities already changed.
      const confirmed = await tx.posSyncIntent.updateMany({
        where: { venueId, idempotencyKey: intentId, staffId, type: 'KDS_ITEM_PROGRESS', status: 'PROCESSING' },
        data: { status: 'ACKED', errorCode: null, resultJson: result as Prisma.InputJsonValue },
      })
      if (confirmed.count !== 1)
        throw new ConflictError('No se pudo confirmar esta acción. Actualiza su estado.', 'PREPARATION_INTENT_MISSING')
    }
    return result
  }, ORDER_LOCK_WAIT_BUDGET)
}

function modifierNames(value: string | null): string[] | null {
  if (value == null) return null
  try {
    const names: unknown = JSON.parse(value)
    if (Array.isArray(names) && names.every(name => typeof name === 'string')) return names
  } catch {
    /* Kept visible below instead of presenting an incomplete kitchen ticket. */
  }
  throw new ConflictError('Los modificadores de esta comanda requieren revisión.', 'PREPARATION_MODIFIERS_INVALID')
}

export async function listKitchenPreparation(
  venueId: string,
  options: { orderId?: string; limit?: number; cursor?: string; history?: boolean } = {},
) {
  await assertEnabled(venueId)
  const limit = Math.min(100, Math.max(1, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 50))
  const where: Prisma.KdsOrderItemWhereInput = {
    kdsOrder: {
      venueId,
      preparationVersion: PREPARATION_VERSION,
      ...(options.orderId ? { orderId: options.orderId } : { status: options.history ? 'COMPLETED' : { not: 'COMPLETED' } }),
    },
  }
  const [rows, total] = await Promise.all([
    prisma.kdsOrderItem.findMany({
      where,
      include: { kdsOrder: true },
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    }),
    prisma.kdsOrderItem.count({ where }),
  ])
  const productIds = [
    ...new Set(
      rows
        .slice(0, limit)
        .map(r => r.orderItemId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const stations = productIds.length
    ? await prisma.kdsOrderItem.groupBy({
        by: ['orderItemId'],
        where: { orderItemId: { in: productIds }, kdsOrder: { venueId, preparationVersion: PREPARATION_VERSION } },
        _count: { _all: true },
        orderBy: { orderItemId: 'asc' },
        take: 101,
      })
    : []
  const stationCounts = new Map(stations.map(r => [r.orderItemId, r._count._all]))
  const items = rows.slice(0, limit).map(r => ({
    id: r.id,
    orderId: r.kdsOrder.orderId,
    orderItemId: r.orderItemId,
    externalId: r.externalLineId,
    sourceKey: r.kdsOrder.sourceKey,
    stationId: r.kdsOrder.printStationId,
    stationCount: r.orderItemId ? (stationCounts.get(r.orderItemId) ?? 1) : 1,
    orderNumber: r.kdsOrder.orderNumber,
    productName: r.productName,
    quantity: r.quantity,
    modifiers: modifierNames(r.modifiers ?? null),
    notes: r.notes,
    serviceCourse: r.serviceCourse,
    orderPromotionId: r.orderPromotionId,
    preparation: r.preparation,
    preparationRevision: r.preparationRevision,
  }))
  return {
    version: PREPARATION_VERSION,
    items,
    total,
    limit,
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit ? items[items.length - 1].id : null,
  }
}
