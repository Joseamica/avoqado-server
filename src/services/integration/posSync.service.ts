import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { Order, OrderSource, OriginSystem, Prisma, Shift, ShiftStatus, StaffRole } from '@prisma/client'
import logger from '../../config/logger'

// Podrías crear un archivo de tipos para los payloads en: src/types/pos.types.ts
export interface PosOrderPayload {
  externalId: string
  venueId: string // El ID de Avoqado del Venue, que el Producer debe conocer
  // ... resto de los campos mapeados
  orderNumber: string
  subtotal: number
  taxAmount: number
  total: number
  createdAt: string
  posRawData: any
  discountAmount: number
  tipAmount: number
}

interface PosStaffPayload {
  externalId: string | null
  name: string | null
  pin: string | null
}

interface PosTablePayload {
  externalId: string | null
}

interface PosShiftPayload {
  externalId: string | null
  startTime?: string | null
}

interface PosOrderData {
  externalId: string
  orderNumber: string
  status: Order['status']
  paymentStatus: Order['paymentStatus']
  subtotal: number
  taxAmount: number
  discountAmount: number
  tipAmount: number
  total: number
  createdAt: string
  completedAt: string | null
  posRawData: any
}
export interface RichPosPayload {
  venueId: string // Este es el Avoqado Venue ID, no el del POS
  orderData: PosOrderData
  staffData: PosStaffPayload
  tableData: PosTablePayload
  shiftData: PosShiftPayload
}
interface PosAreaData {
  externalId: string
  name: string
  posRawData: any

  // ...
}
// ✅ --- NUEVA FUNCIÓN MAESTRA PARA SINCRONIZAR STAFF ---
/**
 * Sincroniza un registro de Staff desde el POS a la base de datos de Avoqado.
 * Busca por el posStaffId y venueId. Si lo encuentra, actualiza sus datos.
 * Si no lo encuentra, crea un nuevo registro de Staff y su asignación a StaffVenue.
 * @returns El ID de Prisma del Staff sincronizado.
 */
async function syncPosStaff(staffPayload: PosStaffPayload, venueId: string, organizationId: string): Promise<string | null> {
  if (!staffPayload || !staffPayload.externalId) {
    logger.warn(`[PosSyncService] Payload de Staff inválido o sin externalId. No se puede sincronizar.`)
    return null
  }

  // 1. Buscamos la ASIGNACIÓN (StaffVenue) para ver si ya conocemos a este mesero del POS
  const existingStaffVenue = await prisma.staffVenue.findUnique({
    where: {
      venueId_posStaffId: {
        venueId: venueId,
        posStaffId: staffPayload.externalId,
      },
    },
  })

  if (existingStaffVenue) {
    // --- LÓGICA DE ACTUALIZACIÓN ---
    // El mesero ya existe en nuestro sistema. Actualizamos sus datos por si han cambiado.
    logger.info(`[PosSyncService] Actualizando Staff existente con externalId: ${staffPayload.externalId}`)
    const updatedStaff = await prisma.staff.update({
      where: {
        id: existingStaffVenue.staffId,
      },
      data: {
        firstName: staffPayload.name || `Mesero ${staffPayload.externalId}`,
        pin: staffPayload.pin?.toString() || null,
        // No actualizamos el email ni el originSystem, ya que son nuestros.
      },
    })
    return updatedStaff.id
  } else {
    // --- LÓGICA DE CREACIÓN ---
    // El mesero es nuevo para nosotros. Lo creamos con todos sus datos.
    logger.info(`[PosSyncService] Creando nuevo Staff para posStaffId: ${staffPayload.externalId}`)
    const newStaff = await prisma.staff.create({
      data: {
        organizationId: organizationId,
        email: `pos-${venueId}-${staffPayload.externalId}@avoqado.app`, // Email único placeholder
        firstName: staffPayload.name || `Mesero ${staffPayload.externalId}`,
        lastName: `(POS)`,
        pin: staffPayload.pin?.toString() || null,
        originSystem: OriginSystem.POS_SOFTRESTAURANT,
        venues: {
          create: {
            venueId: venueId,
            posStaffId: staffPayload.externalId,
            role: StaffRole.WAITER,
          },
        },
      },
    })
    return newStaff.id
  }
}
/**
 * Manejador para eventos de Staff (creado, actualizado).
 */
async function processPosStaffEvent(payload: { venueId: string; staffData: PosStaffPayload }): Promise<void> {
  const { venueId, staffData } = payload
  logger.info(`[PosSyncService] Procesando evento para Staff con externalId: ${staffData.externalId}`)

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue) {
    throw new NotFoundError(`[PosSyncService] Venue con ID ${venueId} no encontrado.`)
  }

  // Simplemente llamamos a nuestra nueva función maestra
  await syncPosStaff(staffData, venueId, venue.organizationId)
}

/**
 * Busca una Mesa por su número/nombre para un Venue específico.
 * Si no existe, la crea. Devuelve el ID de Prisma.
 */
async function getOrCreatePosTable(tablePayload: PosTablePayload, venueId: string): Promise<string | null> {
  if (!tablePayload || !tablePayload.externalId) return null

  const table = await prisma.table.upsert({
    where: {
      venueId_number: { venueId, number: tablePayload.externalId },
    },
    update: {}, // No necesitamos actualizar nada si ya existe
    create: {
      venueId,
      number: tablePayload.externalId,
      capacity: 0,
      qrCode: `qr-placeholder-${venueId}-${tablePayload.externalId}`,
      originSystem: OriginSystem.POS_SOFTRESTAURANT,
      // posRawData: tablePayload,
    },
  })
  return table.id
}

/**
 * Busca un Turno por su ID del POS para un Venue específico.
 * Si no existe, lo crea. Devuelve el ID de Prisma.
 */
async function getOrCreatePosShift(shiftPayload: PosShiftPayload, venueId: string, staffId: string | null): Promise<string | null> {
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
 * Procesa un evento de creación/actualización de orden proveniente de un POS.
 * @param payload - Los datos de la orden mapeados desde el POS.
 */
async function processPosOrderEvent(payload: RichPosPayload): Promise<Order> {
  logger.info(`[PosSyncService] Procesando orden con externalId: ${payload.orderData.externalId}`)

  const { venueId, orderData, staffData, tableData, shiftData } = payload

  const venue = await prisma.venue.findUnique({ where: { id: venueId } })
  if (!venue) {
    // Si el venue no existe, es un error de configuración fundamental.
    // El mensaje irá a la Dead-Letter Queue para investigación.
    throw new NotFoundError(`[PosSyncService] Venue con ID ${venueId} no encontrado en la base de datos de Avoqado.`)
  }

  // --- PASO 1: Sincronizar y obtener los IDs de Prisma para las relaciones ---
  const staffId = await syncPosStaff(staffData, venue.id, venue.organizationId)
  const tableId = await getOrCreatePosTable(tableData, venue.id)
  const shiftId = await getOrCreatePosShift(shiftData, venue.id, staffId)

  // --- PASO 2: Ejecutar el Upsert final de la Orden ---
  const order = await prisma.order.upsert({
    where: {
      venueId_externalId: {
        venueId: venue.id,
        externalId: orderData.externalId,
      },
    },
    update: {
      // Campos que se actualizan si la orden ya existía
      source: OrderSource.POS,
      status: orderData.status,
      paymentStatus: orderData.paymentStatus,
      subtotal: orderData.subtotal,
      taxAmount: orderData.taxAmount,
      discountAmount: orderData.discountAmount,
      tipAmount: orderData.tipAmount,
      total: orderData.total,
      completedAt: orderData.completedAt ? new Date(orderData.completedAt) : null,
      posRawData: orderData.posRawData as Prisma.InputJsonValue,
      syncedAt: new Date(),
      updatedAt: new Date(),
    },
    create: {
      externalId: orderData.externalId,
      orderNumber: orderData.orderNumber,
      source: OrderSource.POS,
      originSystem: OriginSystem.POS_SOFTRESTAURANT,
      createdAt: new Date(orderData.createdAt),
      syncedAt: new Date(),
      status: orderData.status,
      paymentStatus: orderData.paymentStatus,
      subtotal: orderData.subtotal,
      taxAmount: orderData.taxAmount,
      discountAmount: orderData.discountAmount || 0,
      tipAmount: orderData.tipAmount || 0,
      total: orderData.total || 0,
      posRawData: orderData.posRawData as Prisma.InputJsonValue,
      kitchenStatus: 'PENDING',
      type: 'DINE_IN',

      // --- Relaciones establecidas con 'connect' ---
      venue: {
        connect: { id: venue.id },
      },
      // Hacemos una comprobación para solo conectar si obtuvimos un ID
      ...(staffId && {
        servedBy: { connect: { id: staffId } },
        createdBy: { connect: { id: staffId } },
      }),
      ...(tableId && {
        table: { connect: { id: tableId } },
      }),
      ...(shiftId && {
        shift: { connect: { id: shiftId } },
      }),
    },
  })

  logger.info(`[PosSyncService] Orden ${order.id} guardada/actualizada exitosamente.`)
  return order
}

/**
 * Crea o actualiza un Área en la base de datos de Avoqado.
 */
async function processPosAreaEvent(payload: { venueId: string; areaData: PosAreaData }): Promise<void> {
  const { venueId, areaData } = payload
  logger.info(`[PosSyncService] Procesando evento para Área con externalId: ${areaData.externalId}`)

  await prisma.area.upsert({
    where: {
      venueId_externalId: {
        venueId: venueId,
        externalId: areaData.externalId,
      },
    },
    update: {
      name: areaData.name,
      // ... otros campos que quieras mantener sincronizados
    },
    create: {
      venueId: venueId,
      externalId: areaData.externalId,
      name: areaData.name,
      originSystem: OriginSystem.POS_SOFTRESTAURANT,
      posRawData: areaData.posRawData as Prisma.InputJsonValue,
    },
  })
}

/**
 * Crea o actualiza un Turno (Shift) en Avoqado basado en eventos del POS.
 * @param payload El payload del evento desde el Productor.
 * @param event El tipo de evento ('opened' o 'closed').
 */
async function processPosShiftEvent(payload: { venueId: string; shiftData: any }, event: 'opened' | 'closed'): Promise<Shift> {
  const { venueId, shiftData } = payload
  logger.info(`[PosSyncService] Procesando evento '${event}' para Turno con externalId: ${shiftData.WorkspaceId}`)

  // --- Obtener IDs de Relaciones ---
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError(`Venue con ID ${venueId} no encontrado.`)

  const staffId = await syncPosStaff({ externalId: shiftData.cajero, name: null, pin: null }, venueId, venue.organizationId)
  if (!staffId) throw new Error(`No se pudo sincronizar el cajero ${shiftData.cajero}.`)

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

  // --- Ejecutar el Upsert ---
  const shift = await prisma.shift.upsert({
    where: {
      venueId_externalId: { venueId, externalId: shiftData.WorkspaceId },
    },
    // ✅ OBJETO DE ACTUALIZACIÓN EXPLÍCITO
    update: {
      startTime: new Date(shiftData.apertura),
      endTime: shiftData.cierre ? new Date(shiftData.cierre) : null,
      startingCash: shiftData.fondo,
      endingCash: shiftData.efectivo,
      status: event === 'closed' ? ShiftStatus.CLOSED : ShiftStatus.OPEN,
      totalSales: summaryData.totalSales,
      totalTips: summaryData.totalTips,
      totalOrders: summaryData.totalOrders,
      posRawData: shiftData as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
    // ✅ OBJETO DE CREACIÓN EXPLÍCITO
    create: {
      externalId: shiftData.WorkspaceId,
      startTime: new Date(shiftData.apertura),
      endTime: shiftData.cierre ? new Date(shiftData.cierre) : null,
      startingCash: shiftData.fondo,
      endingCash: shiftData.efectivo,
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

// Exportamos un objeto con todos los manejadores de eventos del POS
export const posSyncService = {
  processPosOrderEvent,
  processPosStaffEvent,
  processPosShiftEvent,
  // aquí irían: processPosShiftEvent, processPosPaymentEvent, etc.
}
