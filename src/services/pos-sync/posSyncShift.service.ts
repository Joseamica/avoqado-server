import prisma from '../../utils/prismaClient'
import { ConflictError, NotFoundError } from '../../errors/AppError'
import { UNICO_TURNO_ABIERTO, esChoqueDelUnico, type UnicoParcial } from '../shared/turnoDeCaja'
import { lockShiftLifecycleForVenue } from '../shared/shiftLifecycleLock'
import { Prisma, Shift, ShiftStatus, OriginSystem } from '@prisma/client'
import logger from '../../config/logger'
import { PosShiftPayload } from '../../types/pos.types'
import { posSyncStaffService } from './posSyncStaff.service'
import { aggregateShiftPayments, readShiftPaymentsForClose } from '../tpv/shift.tpv.service'

const UNICO_TURNO_EXTERNO: UnicoParcial = {
  indice: 'Shift_venueId_externalId_key',
  columnas: ['venueId', 'externalId'],
}

type ShiftLifecycleDb = Pick<Prisma.TransactionClient, 'shift'>

function shiftCloseInProgress(externalId: string): ConflictError {
  return new ConflictError(
    `El turno ${externalId} ya está siendo cerrado. Reintenta la sincronización en unos momentos.`,
    'SHIFT_CLOSE_IN_PROGRESS',
  )
}

function shiftConcurrentUpdate(externalId: string): ConflictError {
  return new ConflictError(
    `El turno ${externalId} cambió durante la sincronización. Reintenta con el estado más reciente.`,
    'SHIFT_CONCURRENT_UPDATE',
  )
}

function cashShiftAlreadyOpen(externalId: string): ConflictError {
  return new ConflictError(
    `El negocio ya tiene un turno de caja abierto: no se puede abrir el turno ${externalId} del POS. Ciérralo antes de sincronizar.`,
    'CASH_SHIFT_ALREADY_OPEN',
  )
}

function finiteDateOr(value: unknown, fallback: Date): Date {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return fallback
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value as string | number)
  return Number.isFinite(parsed.getTime()) ? parsed : fallback
}

function moneyOrZero(value: unknown): Prisma.Decimal {
  if (value === null || value === undefined || value === '') return new Prisma.Decimal(0)
  return new Prisma.Decimal(value as Prisma.Decimal.Value)
}

function optionalMoney(value: unknown): Prisma.Decimal | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return new Prisma.Decimal(value as Prisma.Decimal.Value)
}

async function findExactShift(db: ShiftLifecycleDb, venueId: string, externalId: string): Promise<Shift | null> {
  return db.shift.findUnique({ where: { venueId_externalId: { venueId, externalId } } })
}

async function findActiveShiftForVenue(db: ShiftLifecycleDb, venueId: string): Promise<Pick<Shift, 'id' | 'status'> | null> {
  return db.shift.findFirst({
    where: { venueId, endTime: null, status: { in: [ShiftStatus.OPEN, ShiftStatus.CLOSING] } },
    orderBy: { startTime: 'desc' },
    select: { id: true, status: true },
  })
}

function classifyExactWinner(winner: Shift | null, externalId: string): Shift {
  if (winner?.status === ShiftStatus.CLOSING) throw shiftCloseInProgress(externalId)
  if (winner?.status === ShiftStatus.CLOSED) return winner
  throw shiftConcurrentUpdate(externalId)
}

async function shiftAfterLostCas(db: ShiftLifecycleDb, venueId: string, externalId: string): Promise<Shift> {
  return classifyExactWinner(await findExactShift(db, venueId, externalId), externalId)
}

/**
 * Resuelve el Shift candidato de una orden POS.
 *
 * La ausencia, la comprobación del lifecycle y la creación viven bajo el mismo advisory lock
 * tenant-safe. El id que se devuelve sigue siendo PROVISIONAL: la transacción de Order exige el
 * CAS OPEN y deja Order/Payment sin turno si aquí se devolvió un CLOSING/CLOSED.
 */
export async function getOrCreatePosShift(shiftPayload: PosShiftPayload, venueId: string, staffId: string | null): Promise<string | null> {
  if (!shiftPayload || !shiftPayload.externalId || !staffId) return null

  const externalId = shiftPayload.externalId
  const capturedNow = new Date()

  try {
    return await prisma.$transaction(async tx => {
      // Orden global: advisory del venue → fila Shift. Nunca se crea desde un lookup previo al lock.
      await lockShiftLifecycleForVenue(tx, venueId)

      const exact = await findExactShift(tx, venueId, externalId)
      if (exact) return exact.id

      const active = await findActiveShiftForVenue(tx, venueId)
      if (active) return active.id

      const created = await tx.shift.create({
        data: {
          venueId,
          externalId,
          staffId,
          startTime: shiftPayload.startTime ? finiteDateOr(shiftPayload.startTime, capturedNow) : capturedNow,
          originSystem: OriginSystem.POS_SOFTRESTAURANT,
        },
      })
      return created.id
    })
  } catch (error: unknown) {
    const isOpenCollision = esChoqueDelUnico(error, UNICO_TURNO_ABIERTO)
    const isExternalCollision = esChoqueDelUnico(error, UNICO_TURNO_EXTERNO)
    if (!isOpenCollision && !isExternalCollision) throw error

    // PostgreSQL aborta la transacción que recibió P2002. La relectura debe ocurrir en una NUEVA
    // transacción, bajo la misma autoridad, para observar al ganador ya confirmado.
    return prisma.$transaction(async tx => {
      await lockShiftLifecycleForVenue(tx, venueId)

      const exact = await findExactShift(tx, venueId, externalId)
      if (exact) return exact.id

      if (isOpenCollision) {
        const active = await findActiveShiftForVenue(tx, venueId)
        if (active) {
          logger.warn('[PosSyncService] El turno del POS se pliega al turno activo del negocio', {
            venueId,
            externalId,
            shiftId: active.id,
            status: active.status,
          })
          return active.id
        }
      }

      throw error
    })
  }
}

type PreparedShift = { kind: 'done'; shift: Shift } | { kind: 'claimed'; shift: Shift; claimedAt: Date }

interface PosShiftMappedData {
  startTime: unknown
  endTime: unknown
  startingCash: unknown
  endingCash: unknown
}

async function recoverCreateCollision(error: unknown, venueId: string, externalId: string): Promise<PreparedShift> {
  const isOpenCollision = esChoqueDelUnico(error, UNICO_TURNO_ABIERTO)
  const isExternalCollision = esChoqueDelUnico(error, UNICO_TURNO_EXTERNO)
  if (!isOpenCollision && !isExternalCollision) throw error

  return prisma.$transaction(async tx => {
    await lockShiftLifecycleForVenue(tx, venueId)

    const exact = await findExactShift(tx, venueId, externalId)
    if (exact?.status === ShiftStatus.CLOSING) throw shiftCloseInProgress(externalId)
    if (exact?.status === ShiftStatus.CLOSED) return { kind: 'done', shift: exact }
    // Un ganador OPEN exacto no se sobrescribe con datos capturados antes de su commit. El mensaje
    // se reencola y el retry ya partirá de ese snapshot canónico.
    if (exact) throw shiftConcurrentUpdate(externalId)

    if (isOpenCollision) {
      const active = await findActiveShiftForVenue(tx, venueId)
      if (active?.status === ShiftStatus.CLOSING) throw shiftCloseInProgress(externalId)
      if (active) throw cashShiftAlreadyOpen(externalId)
      // La colisión parcial ya prueba que existió un OPEN concurrente. Aunque haya terminado entre
      // el rollback y esta relectura, el evento capturó un snapshot obsoleto y debe reintentarse,
      // nunca reaplicar a ciegas ni degradarse a 500 terminal.
      throw cashShiftAlreadyOpen(externalId)
    }

    throw error
  })
}

async function preparePosShiftLifecycle(
  venueId: string,
  externalId: string,
  staffId: string,
  shiftData: any,
  event: 'created' | 'updated' | 'closed',
  mapped: PosShiftMappedData,
): Promise<PreparedShift> {
  const capturedNow = new Date()

  try {
    return await prisma.$transaction(async tx => {
      await lockShiftLifecycleForVenue(tx, venueId)

      const current = await findExactShift(tx, venueId, externalId)
      if (current?.status === ShiftStatus.CLOSING) throw shiftCloseInProgress(externalId)
      if (current?.status === ShiftStatus.CLOSED) return { kind: 'done', shift: current }

      if (current) {
        if (event === 'closed') {
          // El cutoff nace DESPUÉS de ganar la autoridad DB del venue. El cierre externo se
          // conserva sólo como provenance en posRawData.
          const claimedAt = new Date()
          const claimed = await tx.shift.updateMany({
            where: {
              id: current.id,
              venueId,
              status: ShiftStatus.OPEN,
              endTime: null,
              updatedAt: current.updatedAt,
            },
            data: { status: ShiftStatus.CLOSING, updatedAt: claimedAt },
          })
          if (claimed.count !== 1) return { kind: 'done', shift: await shiftAfterLostCas(tx, venueId, externalId) }
          return { kind: 'claimed', shift: current, claimedAt }
        }

        const wonUpdate = await tx.shift.updateMany({
          where: {
            id: current.id,
            venueId,
            status: ShiftStatus.OPEN,
            endTime: current.endTime,
            updatedAt: current.updatedAt,
          },
          data: {
            startTime: finiteDateOr(mapped.startTime, current.startTime),
            endTime: mapped.endTime ? finiteDateOr(mapped.endTime, current.endTime ?? capturedNow) : null,
            startingCash: moneyOrZero(mapped.startingCash),
            endingCash: optionalMoney(mapped.endingCash),
            status: ShiftStatus.OPEN,
            posRawData: shiftData as Prisma.InputJsonValue,
          },
        })
        if (wonUpdate.count !== 1) return { kind: 'done', shift: await shiftAfterLostCas(tx, venueId, externalId) }

        const saved = await findExactShift(tx, venueId, externalId)
        if (!saved) throw shiftConcurrentUpdate(externalId)
        return { kind: 'done', shift: saved }
      }

      if (event !== 'closed') {
        const active = await findActiveShiftForVenue(tx, venueId)
        if (active?.status === ShiftStatus.CLOSING) throw shiftCloseInProgress(externalId)
        if (active) throw cashShiftAlreadyOpen(externalId)
      }

      const createStartTime = finiteDateOr(mapped.startTime, capturedNow)
      let createEndTime: Date | null = null
      if (event === 'closed') {
        const rawCreateEndTime = finiteDateOr(mapped.endTime, capturedNow)
        createEndTime = rawCreateEndTime < createStartTime || rawCreateEndTime > capturedNow ? capturedNow : rawCreateEndTime
      }

      const created = await tx.shift.create({
        data: {
          externalId,
          startTime: createStartTime,
          endTime: createEndTime,
          startingCash: moneyOrZero(mapped.startingCash),
          endingCash: optionalMoney(mapped.endingCash),
          status: event === 'closed' ? ShiftStatus.CLOSED : ShiftStatus.OPEN,
          totalSales: new Prisma.Decimal(0),
          totalTips: new Prisma.Decimal(0),
          totalOrders: 0,
          posRawData: shiftData as Prisma.InputJsonValue,
          originSystem: OriginSystem.POS_SOFTRESTAURANT,
          venue: { connect: { id: venueId } },
          staff: { connect: { id: staffId } },
        },
      })
      return { kind: 'done', shift: created }
    })
  } catch (error: unknown) {
    return recoverCreateCollision(error, venueId, externalId)
  }
}

async function finalizeClaimedPosShift(
  venueId: string,
  externalId: string,
  shiftData: any,
  mapped: PosShiftMappedData,
  claimedShift: Shift,
  claimedAt: Date,
  totals: ReturnType<typeof aggregateShiftPayments>,
  totalOrders: number,
): Promise<Shift> {
  return prisma.$transaction(async tx => {
    await lockShiftLifecycleForVenue(tx, venueId)

    const finalized = await tx.shift.updateMany({
      where: {
        id: claimedShift.id,
        venueId,
        status: ShiftStatus.CLOSING,
        endTime: null,
        updatedAt: claimedAt,
      },
      data: {
        startingCash: moneyOrZero(mapped.startingCash),
        endingCash: optionalMoney(mapped.endingCash),
        posRawData: shiftData as Prisma.InputJsonValue,
        status: ShiftStatus.CLOSED,
        endTime: claimedAt,
        totalSales: totals.totalSales,
        totalTips: totals.totalTips,
        totalCashPayments: totals.totalCashPayments,
        totalCardPayments: totals.totalCardPayments,
        totalVoucherPayments: totals.totalVoucherPayments,
        totalOtherPayments: totals.totalOtherPayments,
        totalCashTips: totals.totalCashTips,
        totalOrders,
      },
    })
    if (finalized.count !== 1) return shiftAfterLostCas(tx, venueId, externalId)

    // `totalDrawerExtra` es el octavo resultado canónico, pero Shift sólo tiene siete columnas
    // monetarias. El cierre TPV lo usa para caja; pos-sync no hace ese arqueo.
    void totals.totalDrawerExtra

    const signed = await findExactShift(tx, venueId, externalId)
    if (!signed) throw shiftConcurrentUpdate(externalId)
    return signed
  })
}

async function releaseClaimedPosShift(venueId: string, externalId: string, shiftId: string, claimedAt: Date): Promise<void> {
  try {
    await prisma.$transaction(async tx => {
      await lockShiftLifecycleForVenue(tx, venueId)
      await tx.shift.updateMany({
        where: {
          id: shiftId,
          venueId,
          status: ShiftStatus.CLOSING,
          endTime: null,
          updatedAt: claimedAt,
        },
        data: { status: ShiftStatus.OPEN },
      })
    })
  } catch (releaseError) {
    logger.error('[PosSyncService] No se pudo liberar el claim de cierre propio', {
      venueId,
      shiftId,
      claimedAt,
      error: releaseError instanceof Error ? releaseError.message : String(releaseError),
    })
  }
}

/** Creates or updates a Shift in Avoqado based on events from the POS. */
export async function processPosShiftEvent(
  payload: { venueId: string; shiftData: any },
  event: 'created' | 'updated' | 'closed',
): Promise<Shift> {
  const { venueId, shiftData } = payload
  logger.info(`[PosSyncService] Procesando evento '${event}' para Turno con externalId: ${shiftData.externalId}`)
  logger.info(JSON.stringify(shiftData))
  logger.info(`[PosSyncService] Evento: ${event} 🕒`)

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError(`Venue con ID ${venueId} no encontrado.`)

  const externalId = shiftData.externalId || shiftData.WorkspaceId || shiftData.EntityId
  const observedShift = await prisma.shift.findUnique({
    where: { venueId_externalId: { venueId, externalId } },
  })

  // Fast path sin efectos laterales. La ausencia/OPEN sólo son observaciones: toda autorización de
  // escritura vuelve a releerse después de adquirir el advisory lock.
  if (observedShift?.status === ShiftStatus.CLOSING) throw shiftCloseInProgress(externalId)
  if (observedShift?.status === ShiftStatus.CLOSED) return observedShift

  const cajeroId = shiftData.staffId || shiftData.posRawData?.cajero || shiftData.cajero
  const staffId = await posSyncStaffService.syncPosStaff({ externalId: cajeroId, name: null, pin: null }, venueId, venue.organizationId)
  if (!staffId) throw new Error(`No se pudo sincronizar el cajero ${cajeroId}.`)

  const rawData = shiftData.posRawData || shiftData
  const mapped: PosShiftMappedData = {
    startTime: rawData.apertura || shiftData.startTime,
    endTime: rawData.cierre || shiftData.endTime,
    startingCash: rawData.fondo !== undefined ? rawData.fondo : shiftData.startingCash,
    endingCash: rawData.efectivo !== undefined ? rawData.efectivo : shiftData.endingCash,
  }

  const prepared = await preparePosShiftLifecycle(venueId, externalId, staffId, shiftData, event, mapped)
  if (prepared.kind === 'done') {
    logger.info(`[PosSyncService] Turno ${prepared.shift.id} sincronizado exitosamente con estado: ${prepared.shift.status}.`)
    return prepared.shift
  }

  const { shift: claimedShift, claimedAt } = prepared
  try {
    logger.info(`[PosSyncService] El turno ${externalId} fue reclamado. Calculando totales canónicos de Payment...`)
    const payments = await readShiftPaymentsForClose(venueId, claimedShift.id, claimedShift.startTime, claimedAt)
    const totals = aggregateShiftPayments(payments)
    const totalOrders = await prisma.order.count({ where: { shiftId: claimedShift.id } })

    const signed = await finalizeClaimedPosShift(venueId, externalId, shiftData, mapped, claimedShift, claimedAt, totals, totalOrders)
    logger.info(`[PosSyncService] Turno ${signed.id} sincronizado exitosamente con estado: ${signed.status}.`)
    return signed
  } catch (error) {
    // Si el proceso muere no entra aquí: CLOSING queda para el watchdog. Si hay excepción viva,
    // sólo el testigo exacto del claim propio puede liberar, bajo la misma autoridad por venue.
    await releaseClaimedPosShift(venueId, externalId, claimedShift.id, claimedAt)
    throw error
  }
}
