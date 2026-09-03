import prisma from '../../utils/prismaClient'
import { ConflictError, NotFoundError } from '../../errors/AppError'
import { INDICE_TURNO_ABIERTO, esChoqueDelUnico } from '../shared/turnoDeCaja'
import { Prisma, Shift, ShiftStatus, OriginSystem } from '@prisma/client'
import logger from '../../config/logger'
import { PosShiftPayload } from '../../types/pos.types'
import { posSyncStaffService } from './posSyncStaff.service' // Import for staff synchronization

/**
 * Finds a Shift by its POS externalId for a specific Venue.
 * If it doesn't exist, it creates it. Returns the Prisma ID.
 */
export async function getOrCreatePosShift(shiftPayload: PosShiftPayload, venueId: string, staffId: string | null): Promise<string | null> {
  if (!shiftPayload || !shiftPayload.externalId || !staffId) return null

  // First, try to find an existing OPEN shift with the same externalId
  // This prevents returning closed shifts when SoftRestaurant reuses WorkspaceId values
  const existingShift = await prisma.shift.findFirst({
    where: {
      venueId,
      externalId: shiftPayload.externalId,
      status: ShiftStatus.OPEN,
    },
  })

  if (existingShift) {
    return existingShift.id
  }

  // No open shift found, create a new one.
  //
  // 🔴 `pos-sync` es la TERCERA puerta que abre turnos, y es la única que no comprueba nada. Desde
  // la Fase 2 hay un índice único parcial `Shift(venueId) WHERE status='OPEN'`: un turno abierto por
  // negocio, garantizado en la base. Sin este `catch`, un negocio con su turno ya abierto haría que
  // esta creación saliera como 500 crudo en el worker de sincronización.
  const newShift = await prisma.shift
    .create({
      data: {
        venueId,
        externalId: shiftPayload.externalId,
        staffId: staffId,
        startTime: shiftPayload.startTime ? new Date(shiftPayload.startTime) : new Date(),
        originSystem: OriginSystem.POS_SOFTRESTAURANT,
      },
    })
    .catch(async (error: unknown) => {
      // SÓLO el índice de abiertos: `Shift` tiene otro único (`venueId, externalId`) que no
      // significa esto y sube tal cual.
      if (!esChoqueDelUnico(error, INDICE_TURNO_ABIERTO)) throw error

      // El turno es del NEGOCIO (decisión del founder, 2-sep-2026), así que «ya hay uno abierto» no
      // es un error: es la respuesta. La orden se ata a ÉSE. Devolver null la dejaría fuera de todo
      // turno, que es exactamente el defecto que este proyecto existe para arreglar.
      const delNegocio = await prisma.shift.findFirst({
        where: { venueId, status: ShiftStatus.OPEN },
        orderBy: { startTime: 'desc' },
        select: { id: true },
      })
      if (!delNegocio) throw error

      logger.warn('[PosSyncService] El turno del POS se pliega al turno abierto del negocio', {
        venueId,
        externalId: shiftPayload.externalId,
        shiftId: delNegocio.id,
      })
      return delNegocio
    })

  return newShift.id
}

/**
 * Creates or updates a Shift in Avoqado based on events from the POS.
 * @param payload The event payload from the Producer.
 * @param event The type of event ('created' or 'updated').
 */
export async function processPosShiftEvent(
  payload: { venueId: string; shiftData: any },
  event: 'created' | 'updated' | 'closed',
): Promise<Shift> {
  const { venueId, shiftData } = payload
  logger.info(`[PosSyncService] Procesando evento '${event}' para Turno con externalId: ${shiftData.externalId}`)
  logger.info(JSON.stringify(shiftData))
  logger.info(`[PosSyncService] Evento: ${event} 🕒`)

  // --- Obtener IDs de Relaciones ---
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError(`Venue con ID ${venueId} no encontrado.`)

  // Obtener el cajero desde posRawData si no está disponible directamente
  const cajeroId = shiftData.staffId || shiftData.posRawData?.cajero || shiftData.cajero

  const staffId = await posSyncStaffService.syncPosStaff({ externalId: cajeroId, name: null, pin: null }, venueId, venue.organizationId)
  if (!staffId) throw new Error(`No se pudo sincronizar el cajero ${cajeroId}.`)

  // --- Calcular Totales si el Turno se Cierra ---
  const summaryData = {
    totalSales: new Prisma.Decimal(0),
    totalTips: new Prisma.Decimal(0),
    totalOrders: 0,
  }

  // Get the externalId from the correct location in the payload (declare outside if block)
  const shiftExternalId = shiftData.externalId || shiftData.WorkspaceId || shiftData.EntityId

  if (event === 'closed') {
    logger.info(`[PosSyncService] El turno ${shiftExternalId} se ha cerrado. Calculando totales...`)

    // First find the current shift to get its actual ID
    const currentShift = await prisma.shift.findUnique({
      where: {
        venueId_externalId: { venueId, externalId: shiftExternalId },
      },
      select: { id: true },
    })

    if (currentShift) {
      // Only aggregate orders from THIS specific shift, not all shifts with same externalId
      const summary = await prisma.order.aggregate({
        where: { shiftId: currentShift.id },
        _sum: { total: true, tipAmount: true },
        _count: { id: true },
      })
      summaryData.totalSales = summary._sum.total || new Prisma.Decimal(0)
      summaryData.totalTips = summary._sum.tipAmount || new Prisma.Decimal(0)
      summaryData.totalOrders = summary._count.id || 0

      logger.info(
        `[PosSyncService] Totales calculados para shift ${currentShift.id}: ${summaryData.totalOrders} órdenes, ventas: ${summaryData.totalSales}`,
      )
    }
  }

  // --- Mapear datos desde la estructura correcta ---
  const rawData = shiftData.posRawData || shiftData
  const externalId = shiftExternalId // Use the already extracted externalId
  const startTime = rawData.apertura || shiftData.startTime
  const endTime = rawData.cierre || shiftData.endTime
  const startingCash = rawData.fondo !== undefined ? rawData.fondo : shiftData.startingCash
  const endingCash = rawData.efectivo !== undefined ? rawData.efectivo : shiftData.endingCash

  // --- Ejecutar el Upsert ---
  //
  // 🔴 Igual que arriba, pero el desenlace es OTRO a propósito: aquí se sincronizan los DATOS de un
  // turno concreto, así que devolver el turno abierto del negocio —que tiene otro `externalId`—
  // sería mis-sincronizar en silencio. Se falla, y el mensaje dice por qué. Ojo: el conflicto puede
  // venir tanto de la rama `create` como de la `update`, que también puede volver a poner en `OPEN`
  // un turno cerrado; por eso el `catch` envuelve el upsert entero.
  const shift = await prisma.shift
    .upsert({
      where: {
        venueId_externalId: { venueId, externalId },
      },
      // ✅ OBJETO DE ACTUALIZACIÓN EXPLÍCITO
      update: {
        startTime: new Date(startTime),
        endTime: endTime ? new Date(endTime) : null,
        startingCash: startingCash || 0,
        endingCash: endingCash,
        status: event === 'closed' ? ShiftStatus.CLOSED : ShiftStatus.OPEN,
        // Only update totals when shift is being closed
        ...(event === 'closed' && {
          totalSales: summaryData.totalSales,
          totalTips: summaryData.totalTips,
          totalOrders: summaryData.totalOrders,
        }),
        posRawData: shiftData as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
      // ✅ OBJETO DE CREACIÓN EXPLÍCITO
      create: {
        externalId,
        startTime: new Date(startTime),
        endTime: endTime ? new Date(endTime) : null,
        startingCash: startingCash || 0,
        endingCash: endingCash,
        status: event === 'closed' ? ShiftStatus.CLOSED : ShiftStatus.OPEN,
        // Only set calculated totals for closed shifts, use zeros for new shifts
        totalSales: event === 'closed' ? summaryData.totalSales : new Prisma.Decimal(0),
        totalTips: event === 'closed' ? summaryData.totalTips : new Prisma.Decimal(0),
        totalOrders: event === 'closed' ? summaryData.totalOrders : 0,
        posRawData: shiftData as Prisma.InputJsonValue,
        originSystem: OriginSystem.POS_SOFTRESTAURANT,
        // Conexiones de relaciones
        venue: { connect: { id: venueId } },
        staff: { connect: { id: staffId } },
      },
    })
    .catch((error: unknown) => {
      if (esChoqueDelUnico(error, INDICE_TURNO_ABIERTO)) {
        throw new ConflictError(
          `El negocio ya tiene un turno de caja abierto: no se puede abrir el turno ${externalId} del POS. Ciérralo antes de sincronizar.`,
          'CASH_SHIFT_ALREADY_OPEN',
        )
      }
      throw error
    })

  logger.info(`[PosSyncService] Turno ${shift.id} sincronizado exitosamente con estado: ${shift.status}.`)
  return shift
}
