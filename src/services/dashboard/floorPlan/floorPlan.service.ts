import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, ValidationError } from '../../../errors/AppError'
import { logAction } from '../activity-log.service'
import socketManager from '../../../communication/sockets'
import { SocketEventType } from '../../../communication/sockets/types'
import { ORDER_LOCK_WAIT_BUDGET } from '../../shared/paymentShiftClaim'
import { computeFloorPlanFingerprint } from './floorPlanFingerprint'
import {
  computeFloorPlanDiff,
  FloorPlanRuleError,
  type AreaTarget,
  type ElementLayout,
  type FloorPlanDiff,
  type TableLayout,
} from './floorPlanDiff'
import { getFloorPlan, loadFloorPlanState } from './floorPlan.read'
import type { FloorPlanDto, PlanTable, PublishFloorPlanInput } from './floorPlan.types'

export { getFloorPlan }

type Tx = Prisma.TransactionClient

/**
 * Bloquea las mesas que se van a archivar y devuelve los números de las que tienen una cuenta sin pagar.
 * Mismo orden de candados que `assignTable` (Venue KEY SHARE → Table FOR UPDATE, por id): una cuenta que se
 * abre en paralelo sobre esa mesa o termina antes (y aquí se ve) o espera a que esta transacción termine.
 * Una cuenta que no se encuentra en el venue cuenta como abierta: ante la duda, la mesa no se quita.
 */
async function lockTablesWithUnpaidOrders(tx: Tx, venueId: string, tableIds: string[]): Promise<string[]> {
  await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR KEY SHARE`
  const locked = await tx.$queryRaw<Array<{ id: string; number: string; currentOrderId: string | null }>>(
    Prisma.sql`SELECT id, number, "currentOrderId" FROM "Table" WHERE "venueId" = ${venueId} AND id IN (${Prisma.join(tableIds)}) ORDER BY id FOR UPDATE`,
  )
  if (locked.length !== tableIds.length) {
    throw new ConflictError('Alguien más cambió el plano mientras lo editabas. Recarga para ver sus cambios.', 'FLOOR_PLAN_CHANGED')
  }
  const orderIds = locked.flatMap(t => (t.currentOrderId ? [t.currentOrderId] : []))
  if (!orderIds.length) return []
  const paid = await tx.order.findMany({
    where: { venueId, id: { in: orderIds }, paymentStatus: 'PAID' },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: orderIds.length,
  })
  const paidIds = new Set(paid.map(o => o.id))
  return locked.filter(t => t.currentOrderId && !paidIds.has(t.currentOrderId)).map(t => t.number)
}

/** Libera el número de una mesa archivada que otra mesa conservada va a usar. */
async function freeArchivedNumber(tx: Tx, venueId: string, number: string): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${number} (archivada)` : `${number} (archivada ${i})`
    const taken = await tx.table.findFirst({ where: { venueId, number: candidate }, select: { id: true } })
    if (!taken) return candidate
  }
  throw new ConflictError('No se pudo liberar el número de mesa', 'TABLE_NUMBER_UNAVAILABLE')
}

function summarize(diff: FloorPlanDiff, before: PlanTable[]) {
  const numberOf = new Map(before.map(t => [t.id, t.number]))
  return {
    areas: { created: diff.areas.create.length, updated: diff.areas.update.length, removed: diff.areas.remove.length },
    tables: {
      created: diff.tables.create.length,
      revived: diff.tables.revive.length,
      updated: diff.tables.update.length,
      archived: diff.tables.archive.length,
      createdNumbers: [...diff.tables.create.map(c => c.data.number), ...diff.tables.revive.map(r => r.data.number)],
      archivedNumbers: diff.tables.archive.map(id => numberOf.get(id) ?? id),
    },
    elements: { created: diff.elements.create.length, updated: diff.elements.update.length, archived: diff.elements.archive.length },
  }
}

/**
 * Publica el plano COMPLETO que manda el editor, todo o nada (spec §5.2). Orden: candado por venue →
 * folio (idempotencia) → huella (cambios ajenos) → reglas → mesas con cuenta abierta → áreas → mesas →
 * elementos → publicación. Bitácora y aviso a los POS van DESPUÉS del commit.
 */
export async function publishFloorPlan(
  venueId: string,
  input: PublishFloorPlanInput,
  staffId?: string,
): Promise<FloorPlanDto & { publicationId: string; replayed: boolean }> {
  const outcome = await prisma.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`avoqado:floor-plan:v1:${venueId}`}, 0))::text`)

    const prior = await tx.floorPlanPublication.findUnique({
      where: { venueId_saveId: { venueId, saveId: input.saveId } },
      select: { id: true },
    })
    if (prior) return { replayed: true as const, publicationId: prior.id }

    const current = await loadFloorPlanState(tx, venueId)
    if (current.overLimit)
      throw new ValidationError('Este plano pasa los límites del editor; escríbenos y lo revisamos contigo', 'FLOOR_PLAN_OVER_LIMIT')
    if (computeFloorPlanFingerprint(current) !== input.baseFingerprint) {
      throw new ConflictError('Alguien más cambió el plano mientras lo editabas. Recarga para ver sus cambios.', 'FLOOR_PLAN_CHANGED')
    }

    const desiredNumbers = [...new Set(input.tables.map(t => t.number.trim()))]
    const archived = desiredNumbers.length
      ? await tx.table.findMany({
          where: { venueId, active: false, number: { in: desiredNumbers } },
          select: { id: true, number: true },
          orderBy: { id: 'asc' },
          take: desiredNumbers.length,
        })
      : []

    let diff: FloorPlanDiff
    try {
      diff = computeFloorPlanDiff(
        {
          areas: current.areas,
          activeTables: current.tables,
          archivedByNumber: new Map(archived.map(t => [t.number, t.id])),
          elements: current.elements,
        },
        input,
      )
    } catch (error) {
      if (error instanceof FloorPlanRuleError) throw new BadRequestError(error.message, error.code, error.details)
      throw error
    }

    // 1) Mesas por archivar: se bloquea su alcance y se rechazan las que tienen una cuenta sin pagar.
    if (diff.tables.archive.length) {
      const blocked = await lockTablesWithUnpaidOrders(tx, venueId, diff.tables.archive)
      if (blocked.length) {
        const one = blocked.length === 1
        throw new ValidationError(
          `No se puede quitar ${one ? 'la mesa' : 'las mesas'} ${blocked.join(', ')}: ${one ? 'tiene' : 'tienen'} una cuenta abierta. Ciérrala primero.`,
          'TABLES_WITH_OPEN_ORDERS',
          { numbers: blocked },
        )
      }
    }

    // 2) Elementos que el plano ya no trae (incluye los de las áreas que se borran) y áreas. Se archiva por id, no
    //    «todo lo del área»: un elemento que se muda de un área borrada a otra viene en `update` y sigue activo.
    //    Luego se borran las áreas que ya no vienen (libera sus nombres) y se ponen nombres temporales.
    if (diff.elements.archive.length)
      await tx.floorElement.updateMany({ where: { venueId, id: { in: diff.elements.archive } }, data: { active: false } })
    if (diff.areas.remove.length) await tx.area.deleteMany({ where: { venueId, id: { in: diff.areas.remove } } })
    for (const id of diff.areas.rename) await tx.area.update({ where: { id }, data: { name: `__tmp_${id}` } })
    for (const a of diff.areas.update)
      await tx.area.update({ where: { id: a.id }, data: { name: a.name, floorShape: a.floorShape, sortOrder: a.sortOrder } })
    const newAreaIds = new Map<string, string>()
    for (const a of diff.areas.create) {
      const created = await tx.area.create({
        data: { venueId, name: a.name, floorShape: a.floorShape, sortOrder: a.sortOrder },
        select: { id: true },
      })
      newAreaIds.set(a.clientId, created.id)
    }
    const areaId = (t: AreaTarget | null) => (t === null ? null : t.kind === 'existing' ? t.id : (newAreaIds.get(t.clientId) as string))

    // 3) Mesas: archivar → liberar números reclamados → números temporales → valores finales → nuevas.
    const tableData = (d: TableLayout) => ({
      number: d.number,
      capacity: d.capacity,
      shape: d.shape,
      rotation: d.rotation,
      positionX: d.positionX,
      positionY: d.positionY,
      areaId: areaId(d.area),
    })
    if (diff.tables.archive.length)
      await tx.table.updateMany({ where: { venueId, id: { in: diff.tables.archive } }, data: { active: false } })
    for (const { id, number } of diff.tables.freeNumbers)
      await tx.table.update({ where: { id }, data: { number: await freeArchivedNumber(tx, venueId, number) } })
    for (const id of diff.tables.renumber) await tx.table.update({ where: { id }, data: { number: `__tmp_${id}` } })
    for (const u of diff.tables.update) await tx.table.update({ where: { id: u.id }, data: tableData(u.data) })
    for (const r of diff.tables.revive) {
      await tx.table.update({
        where: { id: r.id },
        data: { ...tableData(r.data), active: true, status: 'AVAILABLE', currentOrderId: null },
      })
    }
    for (const c of diff.tables.create) {
      await tx.table.create({
        data: { venueId, ...tableData(c.data), qrCode: `table-${venueId}-${c.data.number}-${randomUUID()}`, status: 'AVAILABLE' },
      })
    }

    // 4) Elementos (los que se quitan ya se archivaron en el paso 2).
    const elementData = (d: ElementLayout) => ({
      type: d.type,
      areaId: areaId(d.area),
      positionX: d.positionX,
      positionY: d.positionY,
      width: d.width,
      height: d.height,
      rotation: d.rotation,
      endX: d.endX,
      endY: d.endY,
      label: d.label,
      color: d.color,
    })
    for (const u of diff.elements.update) await tx.floorElement.update({ where: { id: u.id }, data: elementData(u.data) })
    if (diff.elements.create.length)
      await tx.floorElement.createMany({ data: diff.elements.create.map(d => ({ venueId, ...elementData(d) })) })

    // 5) Publicación (folio + huella resultante).
    const after = await loadFloorPlanState(tx, venueId)
    const resultFingerprint = computeFloorPlanFingerprint(after)
    const summary = summarize(diff, current.tables)
    const publication = await tx.floorPlanPublication.create({
      data: {
        venueId,
        saveId: input.saveId,
        staffId: staffId ?? null,
        baseFingerprint: input.baseFingerprint,
        resultFingerprint,
        summary: summary as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    return { replayed: false as const, publicationId: publication.id, summary, resultFingerprint }
  }, ORDER_LOCK_WAIT_BUDGET)

  if (!outcome.replayed) {
    void logAction({
      staffId: staffId ?? null,
      venueId,
      action: 'FLOOR_PLAN_PUBLISHED',
      entity: 'Venue',
      entityId: venueId,
      data: outcome.summary as Prisma.InputJsonValue,
    })
    socketManager
      .getBroadcastingService()
      ?.broadcastToVenue(venueId, SocketEventType.FLOOR_PLAN_UPDATED, { fingerprint: outcome.resultFingerprint })
  }

  const plan = await getFloorPlan(venueId)
  return { ...plan, publicationId: outcome.publicationId, replayed: outcome.replayed }
}
