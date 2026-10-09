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
import { FLOOR_PLAN_LIMITS, type FloorPlanDto, type PlanTable, type PublishFloorPlanInput } from './floorPlan.types'

export { getFloorPlan }

type Tx = Prisma.TransactionClient

const PLAN_CHANGED = 'Alguien más cambió el plano mientras lo editabas. Recarga para ver sus cambios.'

/**
 * Candado del plano VIVO: todas las mesas y elementos activos del venue, por id, ANTES de leer el plano y su huella.
 * Sin esto, la PAX (que no toma el candado del plano) podía mover una mesa entre la huella y la escritura, y la
 * publicación la pisaba sin haberla visto. Con él, la PAX espera a que se publique y su cambio queda encima (el
 * siguiente guardado del editor verá la huella nueva y recibirá 409). Acotado igual que la lectura (límite + 1).
 * Orden: Venue KEY SHARE → Table → FloorElement, como `assignTable` (Venue → Table).
 */
async function lockLivePlan(tx: Tx, venueId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR KEY SHARE`
  await tx.$queryRaw`SELECT id FROM "Table" WHERE "venueId" = ${venueId} AND active = true ORDER BY id LIMIT ${FLOOR_PLAN_LIMITS.tables + 1} FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM "FloorElement" WHERE "venueId" = ${venueId} AND active = true ORDER BY id LIMIT ${FLOOR_PLAN_LIMITS.elements + 1} FOR UPDATE`
}

interface LockedTable {
  id: string
  number: string
  /** Apunta a una cuenta sin pagar (o a una que no está en el venue: ante la duda, se trata como abierta). */
  unpaidOrder: boolean
}

/**
 * Bloquea (por id) las mesas que se archivan o se reviven y dice cuáles apuntan a una cuenta sin pagar. Las activas ya
 * las tiene `lockLivePlan`; aquí se suman las archivadas que se reviven, a las que un POS pudo colgarle una cuenta.
 */
async function lockTablesWithOrders(tx: Tx, venueId: string, tableIds: string[]): Promise<LockedTable[]> {
  const locked = await tx.$queryRaw<Array<{ id: string; number: string; currentOrderId: string | null }>>(
    Prisma.sql`SELECT id, number, "currentOrderId" FROM "Table" WHERE "venueId" = ${venueId} AND id IN (${Prisma.join(tableIds)}) ORDER BY id FOR UPDATE`,
  )
  if (locked.length !== tableIds.length) throw new ConflictError(PLAN_CHANGED, 'FLOOR_PLAN_CHANGED')
  const orderIds = locked.flatMap(t => (t.currentOrderId ? [t.currentOrderId] : []))
  const paid = orderIds.length
    ? await tx.order.findMany({
        where: { venueId, id: { in: orderIds }, paymentStatus: 'PAID' },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: orderIds.length,
      })
    : []
  const paidIds = new Set(paid.map(o => o.id))
  return locked.map(t => ({ id: t.id, number: t.number, unpaidOrder: !!t.currentOrderId && !paidIds.has(t.currentOrderId) }))
}

/**
 * Libera el número de una mesa archivada que otra mesa conservada va a usar. Nunca elige un número que el mismo
 * guardado trae (`reserved`): chocaría con el índice único al crear o renombrar esa mesa.
 */
async function freeArchivedNumber(tx: Tx, venueId: string, number: string, reserved: ReadonlySet<string>): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${number} (archivada)` : `${number} (archivada ${i})`
    if (reserved.has(candidate)) continue
    const taken = await tx.table.findFirst({ where: { venueId, number: candidate }, select: { id: true } })
    if (!taken) return candidate
  }
  throw new ConflictError('No se pudo liberar el número de mesa', 'TABLE_NUMBER_UNAVAILABLE')
}

const byNumber = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true })

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
 * folio (idempotencia) → candado del plano vivo (mesas y elementos activos) → huella (cambios ajenos) → reglas →
 * mesas con cuenta abierta → áreas → mesas → elementos → publicación. Bitácora y aviso a los POS van DESPUÉS del commit.
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

    await lockLivePlan(tx, venueId)
    const current = await loadFloorPlanState(tx, venueId)
    if (current.overLimit)
      throw new ValidationError('Este plano pasa los límites del editor; escríbenos y lo revisamos contigo', 'FLOOR_PLAN_OVER_LIMIT')
    if (computeFloorPlanFingerprint(current) !== input.baseFingerprint) {
      throw new ConflictError(PLAN_CHANGED, 'FLOOR_PLAN_CHANGED')
    }

    const desiredNumberSet = new Set(input.tables.map(t => t.number.trim()))
    const desiredNumbers = [...desiredNumberSet]
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

    // 1) Mesas que se archivan o se reviven: se bloquean y se ve cuáles tienen una cuenta sin pagar. Archivar una así
    //    se rechaza; revivir una así la deja con su cuenta (un POS se la abrió justo antes de que se archivara).
    const archiveIds = new Set(diff.tables.archive)
    const lockIds = [...diff.tables.archive, ...diff.tables.revive.map(r => r.id)]
    const locked = lockIds.length ? await lockTablesWithOrders(tx, venueId, lockIds) : []
    const withUnpaidOrder = new Set(locked.filter(t => t.unpaidOrder).map(t => t.id))
    const blocked = locked
      .filter(t => archiveIds.has(t.id) && t.unpaidOrder)
      .map(t => t.number)
      .sort(byNumber)
    if (blocked.length) {
      const list = blocked.join(', ')
      throw new ValidationError(
        blocked.length === 1
          ? `No se puede quitar la mesa ${list}: tiene una cuenta abierta. Ciérrala primero.`
          : `No se pueden quitar las mesas ${list}: tienen una cuenta abierta. Ciérralas primero.`,
        'TABLES_WITH_OPEN_ORDERS',
        { numbers: blocked },
      )
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
      await tx.table.update({ where: { id }, data: { number: await freeArchivedNumber(tx, venueId, number, desiredNumberSet) } })
    for (const id of diff.tables.renumber) await tx.table.update({ where: { id }, data: { number: `__tmp_${id}` } })
    for (const u of diff.tables.update) await tx.table.update({ where: { id: u.id }, data: tableData(u.data) })
    for (const r of diff.tables.revive) {
      // Con una cuenta sin pagar conserva su estado y su cuenta; sin cuenta (o ya pagada) vuelve libre.
      const free = withUnpaidOrder.has(r.id) ? {} : { status: 'AVAILABLE' as const, currentOrderId: null }
      await tx.table.update({ where: { id: r.id }, data: { ...tableData(r.data), active: true, ...free } })
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
