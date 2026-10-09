import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, ServiceUnavailableError, ValidationError } from '../../../errors/AppError'
import { logAction } from '../activity-log.service'
import socketManager from '../../../communication/sockets'
import { SocketEventType } from '../../../communication/sockets/types'
import { ORDER_LOCK_WAIT_BUDGET } from '../../shared/paymentShiftClaim'
import { CUENTA_VIVA_SIN_PAGAR_SQL } from '../../shared/cuentaEnLaMesa'
import logger from '../../../config/logger'
import { isDeadlockError, isRetryableDbError } from '../../../utils/serializableRetry'
import { computeFloorPlanFingerprint } from './floorPlanFingerprint'
import {
  archivedNumberLabel,
  computeFloorPlanDiff,
  FloorPlanRuleError,
  type AreaTarget,
  type ElementLayout,
  type FloorPlanDiff,
  type TableLayout,
} from './floorPlanDiff'
import { getFloorPlan, loadFloorPlanState, pointerIsOpen } from './floorPlan.read'
import { FLOOR_PLAN_LIMITS, type FloorPlanDto, type PlanTable, type PublishFloorPlanInput } from './floorPlan.types'

export { getFloorPlan }

type Tx = Prisma.TransactionClient

const PLAN_CHANGED = 'Alguien más cambió el plano mientras lo editabas. Recarga para ver sus cambios.'
const BUSY = 'El servidor está ocupado y no pudo guardar. Intenta de nuevo; tus cambios siguen en pantalla.'

/**
 * Candado del plano VIVO: todas las mesas y elementos activos del venue, por id, ANTES de leer el plano y su huella.
 * Sin esto, la PAX (que no toma el candado del plano) podía mover una mesa entre la huella y la escritura, y la
 * publicación la pisaba sin haberla visto. Con él, la PAX espera a que se publique y su cambio queda encima (el
 * siguiente guardado del editor verá la huella nueva y recibirá 409). Acotado igual que la lectura (límite + 1).
 * Orden: Venue KEY SHARE → Table → FloorElement, como `assignTable` (Venue → Table).
 *
 * `FOR NO KEY UPDATE`, no `FOR UPDATE`: sigue formando fila con cualquier UPDATE de esas filas (la PAX que mueve una
 * mesa, `assignTable` que cuelga una cuenta), pero NO con las inserciones que sólo apuntan a la mesa por llave foránea
 * (una orden nueva o una cuenta dividida en otra mesa toman `FOR KEY SHARE`): esas ya no esperan a que se publique.
 */
async function lockLivePlan(tx: Tx, venueId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR KEY SHARE`
  await tx.$queryRaw`SELECT id FROM "Table" WHERE "venueId" = ${venueId} AND active = true ORDER BY id LIMIT ${FLOOR_PLAN_LIMITS.tables + 1} FOR NO KEY UPDATE`
  await tx.$queryRaw`SELECT id FROM "FloorElement" WHERE "venueId" = ${venueId} AND active = true ORDER BY id LIMIT ${FLOOR_PLAN_LIMITS.elements + 1} FOR NO KEY UPDATE`
}

interface LockedTable {
  id: string
  number: string
  /** El puntero apunta a una cuenta abierta, o a una que no está en el venue: ante la duda, se trata como abierta. */
  pointerOpen: boolean
  /** La cuenta viva y sin pagar más vieja ligada a la mesa por `Order.tableId` (cuenta dividida, alta del POS), o null. */
  liveOrderId: string | null
}

/** La mesa tiene una cuenta abierta: por su puntero o por una cuenta viva sin pagar ligada por tableId. */
const hasOpenOrder = (t: LockedTable) => t.pointerOpen || t.liveOrderId !== null

/**
 * Bloquea (por id) las mesas que se archivan o se reviven y dice cuáles tienen una cuenta abierta. Las activas ya
 * las tiene `lockLivePlan`; aquí se suman las archivadas que se reviven, a las que un POS pudo colgarle una cuenta.
 *
 * El puntero `Table.currentOrderId` no basta: cobrar la cuenta apuntada de una cuenta dividida NO mueve el puntero a la
 * que sigue viva, y una orden dada de alta en el POS se liga sólo por `tableId`. Por eso también se busca, en UNA
 * consulta acotada por las mesas en juego (índice venueId+tableId+paymentStatus), la cuenta viva sin pagar de cada una,
 * con el mismo criterio que la vista de mesas del POS (`shared/cuentaEnLaMesa`).
 */
async function lockTablesWithOrders(tx: Tx, venueId: string, tableIds: string[]): Promise<LockedTable[]> {
  const locked = await tx.$queryRaw<Array<{ id: string; number: string; currentOrderId: string | null }>>(
    Prisma.sql`SELECT id, number, "currentOrderId" FROM "Table" WHERE "venueId" = ${venueId} AND id IN (${Prisma.join(tableIds)}) ORDER BY id FOR NO KEY UPDATE`,
  )
  if (locked.length !== tableIds.length) throw new ConflictError(PLAN_CHANGED, 'FLOOR_PLAN_CHANGED')
  const orderIds = locked.flatMap(t => (t.currentOrderId ? [t.currentOrderId] : []))
  const pointed = orderIds.length
    ? await tx.order.findMany({
        where: { venueId, id: { in: orderIds } },
        select: { id: true, status: true, paymentStatus: true },
        orderBy: { id: 'asc' },
        take: orderIds.length,
      })
    : []
  const pointedById = new Map(pointed.map(o => [o.id, o]))
  const live = await tx.$queryRaw<Array<{ tableId: string; id: string }>>(
    Prisma.sql`SELECT DISTINCT ON (o."tableId") o."tableId", o.id FROM "Order" o
      WHERE o."venueId" = ${venueId} AND o."tableId" IN (${Prisma.join(tableIds)}) AND ${CUENTA_VIVA_SIN_PAGAR_SQL}
      ORDER BY o."tableId", o."createdAt", o.id`,
  )
  const liveByTable = new Map(live.map(o => [o.tableId, o.id]))
  return locked.map(t => ({
    id: t.id,
    number: t.number,
    pointerOpen: !!t.currentOrderId && pointerIsOpen(pointedById.get(t.currentOrderId)),
    liveOrderId: liveByTable.get(t.id) ?? null,
  }))
}

/**
 * Libera el número de una mesa archivada que otra mesa conservada va a usar. Nunca elige un número que el mismo
 * guardado trae (`reserved`): chocaría con el índice único al crear o renombrar esa mesa.
 */
async function freeArchivedNumber(tx: Tx, venueId: string, number: string, reserved: ReadonlySet<string>): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const candidate = archivedNumberLabel(number, i)
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
 * Choque de concurrencia que no dice nada del plano pedido: bloqueo mutuo (40P01, p. ej. contra `moveOrderToTable`),
 * conflicto de escritura o de serialización (P2034 / 40001, crudos o envueltos en P2010) y un número o nombre único que
 * alguien escribió a la vez (P2002: las reglas del plano ya evitan los choques del propio guardado, así que sólo queda
 * el de otro escritor, p. ej. la PAX creando una mesa con ese número).
 */
function isConcurrencyClash(error: unknown): boolean {
  if (isRetryableDbError(error) || isDeadlockError(error)) return true
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002'
}

const errorCode = (error: unknown) => (error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined)

/**
 * P2028: la transacción no pudo empezar a tiempo (pool lleno) o se pasó de su presupuesto. No es un choque ni un error del
 * plano: se responde 503 para que el editor vuelva a intentar (es seguro: el folio `saveId` hace idempotente la publicación).
 */
const isTransactionTimeout = (error: unknown) => errorCode(error) === 'P2028'
function busy(saveId: string, error: unknown): ServiceUnavailableError {
  logger.warn('Plano de mesas: la transacción se pasó de tiempo; se responde 503', { saveId, code: errorCode(error) })
  return new ServiceUnavailableError(BUSY, 'FLOOR_PLAN_BUSY')
}

/** Una pasada de la publicación, dentro de su transacción. */
async function applyPublication(tx: Tx, venueId: string, input: PublishFloorPlanInput, staffId: string | undefined) {
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

  // 1) Mesas que se archivan o se reviven: se bloquean y se ve cuáles tienen una cuenta abierta. Archivar una así
  //    se rechaza; revivir una así la deja con su cuenta (un POS se la abrió justo antes de que se archivara).
  const archiveIds = new Set(diff.tables.archive)
  const lockIds = [...diff.tables.archive, ...diff.tables.revive.map(r => r.id)]
  const locked = lockIds.length ? await lockTablesWithOrders(tx, venueId, lockIds) : []
  const lockedById = new Map(locked.map(t => [t.id, t]))
  const blocked = locked
    .filter(t => archiveIds.has(t.id) && hasOpenOrder(t))
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
    // Con su puntero en una cuenta abierta conserva su estado y su cuenta. Si el puntero no está abierto pero hay una
    // cuenta viva sin pagar ligada por tableId, queda OCUPADA apuntándola (como `reconcileTableAfterOrderRemoved`).
    // Sin ninguna (o ya pagada, cancelada…) vuelve libre.
    const t = lockedById.get(r.id)
    const occupancy = t?.pointerOpen
      ? {}
      : t?.liveOrderId
        ? { status: 'OCCUPIED' as const, currentOrderId: t.liveOrderId }
        : { status: 'AVAILABLE' as const, currentOrderId: null }
    await tx.table.update({ where: { id: r.id }, data: { ...tableData(r.data), active: true, ...occupancy } })
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
}

/**
 * Publica el plano COMPLETO que manda el editor, todo o nada (spec §5.2). Orden: candado por venue →
 * folio (idempotencia) → candado del plano vivo (mesas y elementos activos) → huella (cambios ajenos) → reglas →
 * mesas con cuenta abierta → áreas → mesas → elementos → publicación. Bitácora y aviso a los POS van DESPUÉS del commit.
 *
 * Un choque de concurrencia (`isConcurrencyClash`) repite la transacción UNA vez: es seguro porque el folio (`saveId`)
 * hace idempotente la publicación (si la primera alcanzó a guardarse, la segunda la reconoce). Si vuelve a chocar, el
 * editor recibe el 409 FLOOR_PLAN_CHANGED de siempre y recarga; nunca un 500.
 */
export async function publishFloorPlan(
  venueId: string,
  input: PublishFloorPlanInput,
  staffId?: string,
): Promise<FloorPlanDto & { publicationId: string; replayed: boolean }> {
  const once = () => prisma.$transaction(tx => applyPublication(tx, venueId, input, staffId), ORDER_LOCK_WAIT_BUDGET)
  let outcome: Awaited<ReturnType<typeof once>>
  try {
    outcome = await once()
  } catch (error) {
    if (isTransactionTimeout(error)) throw busy(input.saveId, error)
    if (!isConcurrencyClash(error)) throw error
    logger.warn('Plano de mesas: choque de concurrencia al publicar; se repite una vez', { saveId: input.saveId, code: errorCode(error) })
    // Un respiro corto y al azar, para no volver a chocar con el mismo escritor en el mismo instante.
    await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 60)))
    try {
      outcome = await once()
    } catch (retryError) {
      if (isTransactionTimeout(retryError)) throw busy(input.saveId, retryError)
      if (!isConcurrencyClash(retryError)) throw retryError
      if (errorCode(retryError) === 'P2002') {
        // Un único repetido DOS veces ya no huele a escritor concurrente: puede ser un hueco en las reglas del plano.
        // Se responde 409 igual, pero a nivel error y con el índice que chocó, para que no se esconda como aviso.
        const target = (retryError as { meta?: { target?: unknown } }).meta?.target
        logger.error('Plano de mesas: el mismo choque de único se repitió al reintentar; se responde 409', {
          saveId: input.saveId,
          code: 'P2002',
          target,
        })
      } else {
        logger.warn('Plano de mesas: volvió a chocar; se responde 409', { saveId: input.saveId, code: errorCode(retryError) })
      }
      throw new ConflictError(PLAN_CHANGED, 'FLOOR_PLAN_CHANGED')
    }
  }

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
