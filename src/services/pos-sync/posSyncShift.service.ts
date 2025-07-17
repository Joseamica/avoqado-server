import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
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

  const shift = await prisma.shift.upsert({
    where: {
      venueId_externalId: { venueId, externalId: shiftPayload.externalId },
    },
    update: {},
    create: {
      venueId,
      externalId: shiftPayload.externalId,
      staffId: staffId,
      startTime: shiftPayload.startTime ? new Date(shiftPayload.startTime) : new Date(),
      originSystem: OriginSystem.POS_SOFTRESTAURANT,
    },
  })
  return shift.id
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
  logger.info(`[PosSyncService] Procesando evento '${event}' para Turno con externalId: ${shiftData.WorkspaceId}`)
  logger.info(JSON.stringify(shiftData))
  logger.info(`[PosSyncService] Evento: ${event} 🕒`)

  // --- Obtener IDs de Relaciones ---
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError(`Venue con ID ${venueId} no encontrado.`)

  // Obtener el cajero desde posRawData si no está disponible directamente
  const cajeroId = shiftData.staffId || shiftData.posRawData?.cajero || shiftData.cajero
  
  const staffId = await posSyncStaffService.syncPosStaff(
    { externalId: cajeroId, name: null, pin: null },
    venueId,
    venue.organizationId,
  )
  if (!staffId) throw new Error(`No se pudo sincronizar el cajero ${cajeroId}.`)

  // --- Calcular Totales si el Turno se Cierra ---
  let summaryData = {
    totalSales: new Prisma.Decimal(0),
    totalTips: new Prisma.Decimal(0),
    totalOrders: 0,
  }

  if (event === 'closed') {
    logger.info(`[PosSyncService] El turno ${shiftData.WorkspaceId} se ha cerrado. Calculando totales...`)
    const summary = await prisma.order.aggregate({
      where: { shift: { venueId: venueId, externalId: shiftData.WorkspaceId } },
      _sum: { total: true, tipAmount: true },
      _count: { id: true },
    })
    summaryData.totalSales = summary._sum.total || new Prisma.Decimal(0)
    summaryData.totalTips = summary._sum.tipAmount || new Prisma.Decimal(0)
    summaryData.totalOrders = summary._count.id || 0
  }

  // --- Mapear datos desde la estructura correcta ---
  const rawData = shiftData.posRawData || shiftData
  const externalId = rawData.WorkspaceId || shiftData.externalId
  const startTime = rawData.apertura || shiftData.startTime
  const endTime = rawData.cierre || shiftData.endTime
  const startingCash = rawData.fondo !== undefined ? rawData.fondo : shiftData.startingCash
  const endingCash = rawData.efectivo !== undefined ? rawData.efectivo : shiftData.endingCash

  // --- Ejecutar el Upsert ---
  const shift = await prisma.shift.upsert({
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
      totalSales: summaryData.totalSales,
      totalTips: summaryData.totalTips,
      totalOrders: summaryData.totalOrders,
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
      totalSales: summaryData.totalSales,
      totalTips: summaryData.totalTips,
      totalOrders: summaryData.totalOrders,
      posRawData: shiftData as Prisma.InputJsonValue,
      originSystem: OriginSystem.POS_SOFTRESTAURANT,
      // Conexiones de relaciones
      venue: { connect: { id: venueId } },
      staff: { connect: { id: staffId } },
    },
  })

  logger.info(`[PosSyncService] Turno ${shift.id} sincronizado exitosamente con estado: ${shift.status}.`)
  return shift
}
