import prisma from '../../utils/prismaClient'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import { PaginatedTerminalsResponse, UpdateTpvBody, CreateTpvBody } from '../../schemas/dashboard/tpv.schema'
import { Terminal, TerminalStatus, TerminalType } from '@prisma/client'
import logger from '@/config/logger'
import emailService from '../email.service'

/**
 * Obtiene los datos de las terminales para un venue, con paginación y filtros.
 * @param venueId - El ID del venue.
 * @param page - El número de página actual.
 * @param pageSize - El tamaño de la página.
 * @param filters - Un objeto con filtros opcionales (status, type).
 * @returns Un objeto con la lista de terminales y metadatos de paginación.
 */
export async function getTerminalsData(
  venueId: string,
  page: number,
  pageSize: number,
  filters: { status?: TerminalStatus; type?: TerminalType },
): Promise<PaginatedTerminalsResponse> {
  // 1. Validar parámetros de entrada
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }

  // 2. Calcular valores para la consulta de paginación
  const skip = (page - 1) * pageSize
  const take = pageSize

  // 3. Construir la cláusula 'where' para ser reutilizada
  const whereClause = {
    venueId,
    // Añadir filtros dinámicamente si fueron proporcionados
    ...(filters.status && { status: filters.status }),
    ...(filters.type && { type: filters.type }),
  }

  // 4. Ejecutar las consultas a la base de datos en paralelo
  const [terminals, total] = await prisma.$transaction([
    prisma.terminal.findMany({
      where: whereClause,
      orderBy: {
        name: 'asc', // Ordenar alfabéticamente por nombre
      },
      skip,
      take,
    }),
    prisma.terminal.count({
      where: whereClause,
    }),
  ])

  // 5. Estructurar y devolver la respuesta final
  return {
    data: terminals,
    meta: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    },
  }
}

/**
 * Obtiene una terminal específica por ID y venueId.
 * @param venueId - El ID del venue.
 * @param tpvId - El ID de la terminal.
 * @returns La terminal encontrada.
 */
export async function getTpvById(venueId: string, tpvId: string): Promise<Terminal> {
  // 1. Validar parámetros de entrada
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }
  if (!tpvId) {
    throw new NotFoundError('El ID del TPV es requerido.')
  }

  // 2. Buscar la terminal en la base de datos
  const terminal = await prisma.terminal.findFirst({
    where: {
      id: tpvId,
      venueId: venueId,
    },
  })

  // 3. Verificar si la terminal existe
  if (!terminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada en el venue ${venueId}.`)
  }

  return terminal
}

/**
 * Actualiza una terminal específica.
 * @param venueId - El ID del venue.
 * @param tpvId - El ID de la terminal.
 * @param updateData - Los datos a actualizar.
 * @returns La terminal actualizada.
 */
export async function updateTpv(venueId: string, tpvId: string, updateData: UpdateTpvBody): Promise<Terminal> {
  // 1. Validar parámetros de entrada
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }
  if (!tpvId) {
    throw new NotFoundError('El ID del TPV es requerido.')
  }

  // 2. Verificar que la terminal existe y pertenece al venue
  const existingTerminal = await prisma.terminal.findFirst({
    where: {
      id: tpvId,
      venueId: venueId,
    },
  })

  if (!existingTerminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada en el venue ${venueId}.`)
  }

  // 3. Preparar los datos de actualización
  const updatePayload: any = { ...updateData, updatedAt: new Date() }

  // Si hay configuración como string, intentar parsearla como JSON
  if (updateData.config && typeof updateData.config === 'string') {
    try {
      updatePayload.config = JSON.parse(updateData.config)
    } catch (error) {
      // Si no es JSON válido, guardarlo como string
      logger.error('Error al parsear la configuración:', error)
      updatePayload.config = updateData.config
    }
  }

  // 4. Actualizar la terminal
  const updatedTerminal = await prisma.terminal.update({
    where: {
      id: tpvId,
    },
    data: updatePayload,
  })

  return updatedTerminal
}

/**
 * Crea una nueva terminal (TPV) para un venue.
 */
export async function createTpv(venueId: string, payload: CreateTpvBody): Promise<Terminal> {
  if (!venueId) throw new NotFoundError('El ID del Venue es requerido.')
  const { name, serialNumber, status } = payload
  if (!name) {
    throw new NotFoundError('Nombre es requerido')
  }

  // If serial number is provided, ensure it's unique
  if (serialNumber) {
    const existing = await prisma.terminal.findUnique({ where: { serialNumber } })
    if (existing) {
      throw new NotFoundError(`Ya existe un terminal con número de serie ${serialNumber}`)
    }
  }

  const created = await prisma.terminal.create({
    data: {
      venueId,
      name,
      serialNumber: serialNumber || null,
      type: (payload.type as any) || TerminalType.TPV_ANDROID,
      status: (status as any) || TerminalStatus.INACTIVE,
      config: payload.config as any,
    },
  })

  // Check if this is a purchase order (config contains purchaseOrder data)
  const config = payload.config as any
  if (config?.purchaseOrder) {
    const purchaseOrder = config.purchaseOrder

    // Send purchase confirmation and admin notification emails
    // Only send for the first terminal (sendEmail flag set to true by frontend)
    if (purchaseOrder.sendEmail && purchaseOrder.shipping?.contactEmail) {
      // Get venue info for email
      const venue = await prisma.venue.findUnique({
        where: { id: venueId },
        select: { name: true },
      })

      const emailData = {
        venueName: venue?.name || 'Tu restaurante',
        contactName: purchaseOrder.shipping.contactName || 'Cliente',
        contactEmail: purchaseOrder.shipping.contactEmail || '',
        quantity: purchaseOrder.quantity || 1,
        productName: purchaseOrder.product?.name || 'Terminal PAX A910S',
        productPrice: purchaseOrder.product?.price || 349,
        shippingAddress: purchaseOrder.shipping.address || '',
        shippingCity: purchaseOrder.shipping.city || '',
        shippingState: purchaseOrder.shipping.state || '',
        shippingPostalCode: purchaseOrder.shipping.postalCode || '',
        shippingCountry: purchaseOrder.shipping.country || '',
        shippingSpeed: purchaseOrder.shipping.shippingSpeed || 'standard',
        subtotal: (purchaseOrder.product?.price || 349) * (purchaseOrder.quantity || 1),
        shippingCost:
          purchaseOrder.shipping.shippingSpeed === 'express' ? 15 : purchaseOrder.shipping.shippingSpeed === 'overnight' ? 35 : 0,
        tax: purchaseOrder.totalAmount ? (purchaseOrder.totalAmount * 0.16) / 1.16 : 0,
        totalAmount: purchaseOrder.totalAmount || 0,
        currency: purchaseOrder.currency || 'USD',
        orderDate: purchaseOrder.orderDate || new Date().toISOString(),
      }

      try {
        // Send customer confirmation email
        await emailService.sendTerminalPurchaseEmail(purchaseOrder.shipping.contactEmail, emailData)
        logger.info(`Purchase confirmation email sent to ${purchaseOrder.shipping.contactEmail}`)

        // Send admin notification email
        await emailService.sendTerminalPurchaseAdminNotification(emailData)
        logger.info(`Purchase admin notification sent`)
      } catch (error) {
        logger.error('Failed to send purchase emails:', error)
        // Don't fail the terminal creation if email fails
      }
    }
  }

  return created
}

/**
 * Elimina una terminal específica.
 * IMPORTANT: Solo permite eliminar terminales que NO estén activadas.
 * Terminales activadas deben ser marcadas como RETIRED en lugar de eliminadas.
 *
 * @param venueId - El ID del venue.
 * @param tpvId - El ID de la terminal.
 * @returns void
 */
export async function deleteTpv(venueId: string, tpvId: string): Promise<void> {
  // 1. Validar parámetros de entrada
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }
  if (!tpvId) {
    throw new NotFoundError('El ID del TPV es requerido.')
  }

  // 2. Verificar que la terminal existe y pertenece al venue
  const existingTerminal = await prisma.terminal.findFirst({
    where: {
      id: tpvId,
      venueId: venueId,
    },
  })

  if (!existingTerminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada en el venue ${venueId}.`)
  }

  // 3. SECURITY: No permitir eliminar terminales activadas
  // Square/Toast pattern: Terminales activadas deben ser RETIRED, no eliminadas
  // Esto previene eliminar dispositivos que tienen datos históricos importantes
  if (existingTerminal.activatedAt) {
    throw new BadRequestError(`No se puede eliminar una terminal activada. Use el estado RETIRED para desactivar terminales en uso.`)
  }

  // 4. Eliminar la terminal
  await prisma.terminal.delete({
    where: {
      id: tpvId,
    },
  })

  logger.info(`Terminal ${tpvId} eliminada del venue ${venueId}`)
}

/**
 * Desactiva una terminal (limpia activatedAt para permitir reactivación).
 * SUPERADMIN only: Permite regenerar código de activación para terminales activadas.
 *
 * @param venueId - El ID del venue.
 * @param tpvId - El ID de la terminal.
 * @returns La terminal desactivada.
 */
export async function deactivateTpv(venueId: string, tpvId: string): Promise<Terminal> {
  // 1. Validar parámetros de entrada
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }
  if (!tpvId) {
    throw new NotFoundError('El ID del TPV es requerido.')
  }

  // 2. Verificar que la terminal existe y pertenece al venue
  const existingTerminal = await prisma.terminal.findFirst({
    where: {
      id: tpvId,
      venueId: venueId,
    },
  })

  if (!existingTerminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada en el venue ${venueId}.`)
  }

  // 3. Verificar que la terminal está activada
  if (!existingTerminal.activatedAt) {
    throw new BadRequestError(`La terminal no está activada. No se puede desactivar una terminal que no está activada.`)
  }

  // 4. Limpiar activatedAt para permitir reactivación
  const deactivatedTerminal = await prisma.terminal.update({
    where: {
      id: tpvId,
    },
    data: {
      activatedAt: null,
      updatedAt: new Date(),
    },
  })

  logger.info(`Terminal ${tpvId} desactivada en venue ${venueId}. Se puede generar nuevo código de activación.`)

  return deactivatedTerminal
}

/**
 * TPV Settings interface - Matches frontend TpvSettings type
 */
export interface TpvSettings {
  showReviewScreen: boolean
  showTipScreen: boolean
  showReceiptScreen: boolean
  defaultTipPercentage: number | null
  tipSuggestions: number[]
  requirePinLogin: boolean
  // Step 4: Sale Verification (for retail/telecomunicaciones venues)
  showVerificationScreen: boolean
  requireVerificationPhoto: boolean
  requireVerificationBarcode: boolean
}

/**
 * Default TPV settings - Applied when no custom settings exist
 */
const DEFAULT_TPV_SETTINGS: TpvSettings = {
  showReviewScreen: true,
  showTipScreen: true,
  showReceiptScreen: true,
  defaultTipPercentage: null,
  tipSuggestions: [15, 18, 20, 25],
  requirePinLogin: false,
  // Step 4: Verification disabled by default (only for retail/telecomunicaciones)
  showVerificationScreen: false,
  requireVerificationPhoto: false,
  requireVerificationBarcode: false,
}

/**
 * Get TPV settings for a specific terminal
 * Returns default settings if none exist
 */
export async function getTpvSettings(tpvId: string): Promise<TpvSettings> {
  const terminal = await prisma.terminal.findUnique({
    where: { id: tpvId },
    select: { config: true },
  })

  if (!terminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada.`)
  }

  // If config exists and has settings property, return it merged with defaults
  const savedSettings = (terminal.config as any)?.settings || {}

  return {
    ...DEFAULT_TPV_SETTINGS,
    ...savedSettings,
  }
}

/**
 * Update TPV settings for a specific terminal
 * Performs partial update, merging with existing settings
 */
export async function updateTpvSettings(tpvId: string, settingsUpdate: Partial<TpvSettings>): Promise<TpvSettings> {
  // 1. Get current terminal to access existing config
  const terminal = await prisma.terminal.findUnique({
    where: { id: tpvId },
    select: { config: true },
  })

  if (!terminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada.`)
  }

  // 2. Get current settings (defaults + saved)
  const currentSettings = await getTpvSettings(tpvId)

  // 3. Merge with update
  const newSettings: TpvSettings = {
    ...currentSettings,
    ...settingsUpdate,
  }

  // 4. Update config field with new settings
  const existingConfig = (terminal.config as any) || {}
  const updatedConfig = {
    ...existingConfig,
    settings: newSettings,
  }

  // 5. Save to database
  await prisma.terminal.update({
    where: { id: tpvId },
    data: {
      config: updatedConfig,
      updatedAt: new Date(),
    },
  })

  logger.info(`TPV settings updated for terminal ${tpvId}`, { settings: newSettings })

  return newSettings
}

/**
 * Activate a terminal by registering its hardware serial number
 * @param venueId - The venue ID
 * @param tpvId - The terminal ID
 * @param serialNumber - The hardware serial number
 * @returns The updated terminal
 */
export async function activateTerminal(venueId: string, tpvId: string, serialNumber: string): Promise<Terminal> {
  // 1. Verify terminal exists and belongs to the venue
  const terminal = await prisma.terminal.findFirst({
    where: {
      id: tpvId,
      venueId,
    },
  })

  if (!terminal) {
    throw new NotFoundError(`Terminal ${tpvId} not found in venue ${venueId}`)
  }

  // 2. Check if terminal is already activated
  if (terminal.status === 'ACTIVE' && terminal.serialNumber) {
    throw new BadRequestError(`Terminal ${tpvId} is already activated with serial number ${terminal.serialNumber}`)
  }

  // 3. Check if terminal is in pending activation status
  if (terminal.status !== 'PENDING_ACTIVATION') {
    throw new BadRequestError(`Terminal ${tpvId} is not in PENDING_ACTIVATION status (current status: ${terminal.status})`)
  }

  // 4. Check if serial number already exists (must be unique globally)
  const existingTerminal = await prisma.terminal.findUnique({
    where: { serialNumber },
  })

  if (existingTerminal) {
    throw new BadRequestError(`Serial number ${serialNumber} is already registered to another terminal`)
  }

  // 5. Update terminal with serial number and set status to ACTIVE
  const updatedTerminal = await prisma.terminal.update({
    where: { id: tpvId },
    data: {
      serialNumber,
      status: 'ACTIVE',
      updatedAt: new Date(),
    },
  })

  logger.info(`Terminal ${tpvId} activated with serial number ${serialNumber}`)

  return updatedTerminal
}
