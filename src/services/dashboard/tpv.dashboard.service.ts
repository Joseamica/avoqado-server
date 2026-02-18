import logger from '@/config/logger'
import { Terminal, TerminalStatus, TerminalType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { CreateTpvBody, PaginatedTerminalsResponse, UpdateTpvBody } from '../../schemas/dashboard/tpv.schema'
import prisma from '../../utils/prismaClient'
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
  // Attendance verification (clock-in/out with photo + GPS)
  requireClockInPhoto: boolean // When true, GPS captured automatically with photo
  requireClockOutPhoto: boolean // When true, GPS captured automatically with photo
  requireClockInToLogin: boolean // When true, staff must have active clock-in to login
  // Kiosk Mode
  kioskModeEnabled: boolean // When true, terminal can enter self-service kiosk mode
  kioskDefaultMerchantId: string | null // Default merchant for kiosk mode (null = show selection)
  // Home screen button visibility
  showQuickPayment: boolean
  showOrderManagement: boolean
  showReports: boolean
  showPayments: boolean
  showSupport: boolean
  showGoals: boolean
  showMessages: boolean
  showTrainings: boolean
  // Evidence rules (PlayTelecom — boolean toggles)
  requireDepositPhoto?: boolean
  requireFacadePhoto?: boolean
  // Module toggles for TPV
  enableCashPayments?: boolean
  enableCardPayments?: boolean
  enableBarcodeScanner?: boolean
  // Venue-level attendance toggle (sets requireClockInPhoto + requireClockInToLogin)
  attendanceTracking?: boolean
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
  // Attendance verification disabled by default
  requireClockInPhoto: false,
  requireClockOutPhoto: false,
  requireClockInToLogin: false,
  // Kiosk Mode disabled by default
  kioskModeEnabled: false,
  kioskDefaultMerchantId: null, // null = show merchant selection screen
  // Home screen buttons enabled by default
  showQuickPayment: true,
  showOrderManagement: true,
  showReports: true,
  showPayments: true,
  showSupport: true,
  showGoals: true,
  showMessages: true,
  showTrainings: true,
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

/**
 * Terminal merchant info for kiosk settings dropdown
 */
export interface TerminalMerchant {
  id: string
  displayName: string
  active: boolean
}

/**
 * Get merchants assigned to a specific terminal
 * Used by Dashboard for kiosk default merchant dropdown
 *
 * @param tpvId - The terminal ID
 * @returns Array of merchants assigned to this terminal (active ones only by default)
 */
export async function getTerminalMerchants(tpvId: string, includeInactive = false): Promise<TerminalMerchant[]> {
  // 1. Get terminal with assigned merchant IDs
  const terminal = await prisma.terminal.findUnique({
    where: { id: tpvId },
    select: { assignedMerchantIds: true },
  })

  if (!terminal) {
    throw new NotFoundError(`Terminal con ID ${tpvId} no encontrada.`)
  }

  // 2. If no merchants assigned, return empty array
  if (!terminal.assignedMerchantIds || terminal.assignedMerchantIds.length === 0) {
    return []
  }

  // 3. Fetch merchant details
  const merchants = await prisma.merchantAccount.findMany({
    where: {
      id: { in: terminal.assignedMerchantIds },
      ...(includeInactive ? {} : { active: true }), // Filter by active unless includeInactive is true
    },
    select: {
      id: true,
      displayName: true,
      active: true,
    },
    orderBy: {
      displayName: 'asc',
    },
  })

  // Transform to ensure displayName is always a string
  return merchants.map(m => ({
    id: m.id,
    displayName: m.displayName || `Merchant ${m.id.slice(-6)}`, // Fallback to partial ID if no name
    active: m.active,
  }))
}

/**
 * Venue-level TPV settings subset (used by TpvConfiguration page)
 * These fields are applied uniformly to ALL terminals in a venue
 */
export interface VenueTpvSettings {
  attendanceTracking: boolean
  enableCashPayments: boolean
  enableCardPayments: boolean
  enableBarcodeScanner: boolean
  requireDepositPhoto: boolean
  requireFacadePhoto: boolean
  // Attendance — lateness detection (stored in VenueSettings, not TpvConfig)
  expectedCheckInTime: string
  latenessThresholdMinutes: number
  geofenceRadiusMeters: number
}

const DEFAULT_VENUE_TPV_SETTINGS: VenueTpvSettings = {
  attendanceTracking: false,
  enableCashPayments: true,
  enableCardPayments: true,
  enableBarcodeScanner: true,
  requireDepositPhoto: false,
  requireFacadePhoto: false,
  expectedCheckInTime: '09:00',
  latenessThresholdMinutes: 30,
  geofenceRadiusMeters: 500,
}

/**
 * Get venue-level TPV settings
 * Reads from the most recently updated terminal in the venue.
 * Since terminals can diverge (edited individually on per-terminal page),
 * we pick the latest-updated one as the "current" venue-level state.
 * Returns defaults if no terminals exist.
 */
export async function getVenueTpvSettings(venueId: string): Promise<VenueTpvSettings> {
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }

  const [terminal, venueSettings, venue] = await Promise.all([
    prisma.terminal.findFirst({
      where: { venueId },
      select: { config: true },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.venueSettings.findFirst({
      where: { venueId },
      select: { expectedCheckInTime: true, latenessThresholdMinutes: true, geofenceRadiusMeters: true },
    }),
    prisma.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    }),
  ])

  // Fetch org config as intermediate fallback (terminal → org → hardcoded)
  const orgConfig = venue?.organizationId
    ? await prisma.organizationAttendanceConfig.findUnique({ where: { organizationId: venue.organizationId } })
    : null

  // Resolve defaults: org config → hardcoded defaults
  const defaults: VenueTpvSettings = {
    attendanceTracking: orgConfig?.attendanceTracking ?? DEFAULT_VENUE_TPV_SETTINGS.attendanceTracking,
    enableCashPayments: orgConfig?.enableCashPayments ?? DEFAULT_VENUE_TPV_SETTINGS.enableCashPayments,
    enableCardPayments: orgConfig?.enableCardPayments ?? DEFAULT_VENUE_TPV_SETTINGS.enableCardPayments,
    enableBarcodeScanner: orgConfig?.enableBarcodeScanner ?? DEFAULT_VENUE_TPV_SETTINGS.enableBarcodeScanner,
    requireDepositPhoto: orgConfig?.requireDepositPhoto ?? DEFAULT_VENUE_TPV_SETTINGS.requireDepositPhoto,
    requireFacadePhoto: orgConfig?.requireFacadePhoto ?? DEFAULT_VENUE_TPV_SETTINGS.requireFacadePhoto,
    expectedCheckInTime:
      venueSettings?.expectedCheckInTime ?? orgConfig?.expectedCheckInTime ?? DEFAULT_VENUE_TPV_SETTINGS.expectedCheckInTime,
    latenessThresholdMinutes:
      venueSettings?.latenessThresholdMinutes ?? orgConfig?.latenessThresholdMinutes ?? DEFAULT_VENUE_TPV_SETTINGS.latenessThresholdMinutes,
    geofenceRadiusMeters:
      venueSettings?.geofenceRadiusMeters ?? orgConfig?.geofenceRadiusMeters ?? DEFAULT_VENUE_TPV_SETTINGS.geofenceRadiusMeters,
  }

  if (!terminal) {
    return defaults
  }

  const savedSettings = (terminal.config as any)?.settings || {}

  // requireClockInPhoto is the source of truth (written by both per-terminal page and TpvConfig).
  // Never read from stored attendanceTracking — it can be stale if the per-terminal page changed requireClockInPhoto.
  const attendanceTracking = savedSettings.requireClockInPhoto ?? defaults.attendanceTracking

  return {
    attendanceTracking,
    enableCashPayments: savedSettings.enableCashPayments ?? defaults.enableCashPayments,
    enableCardPayments: savedSettings.enableCardPayments ?? defaults.enableCardPayments,
    enableBarcodeScanner: savedSettings.enableBarcodeScanner ?? defaults.enableBarcodeScanner,
    requireDepositPhoto: savedSettings.requireDepositPhoto ?? defaults.requireDepositPhoto,
    requireFacadePhoto: savedSettings.requireFacadePhoto ?? defaults.requireFacadePhoto,
    expectedCheckInTime: defaults.expectedCheckInTime,
    latenessThresholdMinutes: defaults.latenessThresholdMinutes,
    geofenceRadiusMeters: defaults.geofenceRadiusMeters,
  }
}

/**
 * Update venue-level TPV settings
 * Bulk updates ALL terminals in the venue atomically
 */
export async function updateVenueTpvSettings(venueId: string, settingsUpdate: Partial<VenueTpvSettings>): Promise<VenueTpvSettings> {
  if (!venueId) {
    throw new NotFoundError('El ID del Venue es requerido.')
  }

  // 1. Find all terminals in the venue
  const terminals = await prisma.terminal.findMany({
    where: { venueId },
    select: { id: true, config: true },
  })

  if (terminals.length === 0) {
    throw new NotFoundError('No hay terminales en este venue.')
  }

  // 2. Separate venue-level VenueSettings fields from TpvConfig fields
  const { expectedCheckInTime, latenessThresholdMinutes, geofenceRadiusMeters, ...tpvFields } = settingsUpdate
  const settingsToMerge: Partial<TpvSettings> = { ...tpvFields }

  // When attendanceTracking changes, set clock-in photo + login requirement
  // Note: requireClockOutPhoto is NOT set here — deposit photo replaces clock-out selfie
  if (tpvFields.attendanceTracking !== undefined) {
    settingsToMerge.requireClockInPhoto = tpvFields.attendanceTracking
    settingsToMerge.requireClockInToLogin = tpvFields.attendanceTracking
    settingsToMerge.attendanceTracking = tpvFields.attendanceTracking
  }

  // 3. Update VenueSettings if attendance config fields are provided
  const venueSettingsData: Record<string, any> = {}
  if (expectedCheckInTime !== undefined) venueSettingsData.expectedCheckInTime = expectedCheckInTime
  if (latenessThresholdMinutes !== undefined) venueSettingsData.latenessThresholdMinutes = latenessThresholdMinutes
  if (geofenceRadiusMeters !== undefined) venueSettingsData.geofenceRadiusMeters = geofenceRadiusMeters

  if (Object.keys(venueSettingsData).length > 0) {
    await prisma.venueSettings.upsert({
      where: { venueId },
      update: venueSettingsData,
      create: { venueId, ...venueSettingsData },
    })
  }

  // 4. Update all terminals in a transaction (only if TpvConfig fields changed)
  if (Object.keys(settingsToMerge).length > 0) {
    await prisma.$transaction(
      terminals.map(terminal => {
        const existingConfig = (terminal.config as any) || {}
        const existingSettings = existingConfig.settings || {}
        const updatedConfig = {
          ...existingConfig,
          settings: {
            ...existingSettings,
            ...settingsToMerge,
          },
        }

        return prisma.terminal.update({
          where: { id: terminal.id },
          data: {
            config: updatedConfig,
            updatedAt: new Date(),
          },
        })
      }),
    )
  }

  logger.info(`Venue-level TPV settings updated for venue ${venueId} (${terminals.length} terminals)`, {
    settings: settingsUpdate,
  })

  // 4. Return the current full settings
  return getVenueTpvSettings(venueId)
}
