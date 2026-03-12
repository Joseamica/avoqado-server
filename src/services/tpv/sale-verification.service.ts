import { SaleVerificationStatus, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

// ============================================================
// Sale Verification Service
// ============================================================
// Handles Step 4 verification for retail/telecommunications venues
// Captures evidence (photos + barcodes) for audit and inventory deduction

interface ScannedProduct {
  barcode: string
  format: string
  productName?: string | null
  productId?: string | null
  hasInventory: boolean
  quantity: number
}

interface CreateSaleVerificationData {
  paymentId: string
  staffId: string
  photos: string[]
  scannedProducts: ScannedProduct[]
  deviceId?: string | null
  notes?: string | null
  status?: SaleVerificationStatus
}

interface SaleVerificationResponse {
  id: string
  venueId: string
  paymentId: string
  staffId: string
  photos: string[]
  scannedProducts: ScannedProduct[]
  status: SaleVerificationStatus
  inventoryDeducted: boolean
  deviceId: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

interface PendingVerificationResponse {
  id: string
  paymentId: string
  amount: number
  orderNumber: string | null
  date: string
  serialNumbers: string[]
  isPortabilidad: boolean
  photos: string[]
  requiredPhotos: number
}

interface ListSaleVerificationsParams {
  pageSize: number
  pageNumber: number
  status?: SaleVerificationStatus
  staffId?: string
  fromDate?: Date
  toDate?: Date
}

interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    pageSize: number
    pageNumber: number
    totalCount: number
    totalPages: number
  }
}

/**
 * Create a sale verification record
 * Called when TPV completes Step 4 (photo + barcode capture)
 */
export async function createSaleVerification(venueId: string, data: CreateSaleVerificationData): Promise<SaleVerificationResponse> {
  logger.info(`📸 [SALE VERIFICATION SERVICE] Creating verification for payment ${data.paymentId}`)

  // Validate payment exists and belongs to venue
  const payment = await prisma.payment.findFirst({
    where: { id: data.paymentId, venueId },
    include: { saleVerification: true },
  })

  if (!payment) {
    throw new NotFoundError(`Payment ${data.paymentId} not found in venue ${venueId}`)
  }

  // Check if verification already exists
  if (payment.saleVerification) {
    throw new BadRequestError(`Verification already exists for payment ${data.paymentId}`)
  }

  // Validate staff exists
  const staff = await prisma.staffVenue.findFirst({
    where: { staffId: data.staffId, venueId },
  })

  if (!staff) {
    throw new NotFoundError(`Staff ${data.staffId} not found in venue ${venueId}`)
  }

  // Create the verification record
  const verification = await prisma.saleVerification.create({
    data: {
      venueId,
      paymentId: data.paymentId,
      staffId: data.staffId,
      photos: data.photos,
      scannedProducts: data.scannedProducts as unknown as Prisma.InputJsonValue,
      status: data.status ?? 'PENDING',
      deviceId: data.deviceId ?? null,
      notes: data.notes ?? null,
    },
  })

  logger.info(`✅ [SALE VERIFICATION SERVICE] Created verification ${verification.id}`)

  return mapToResponse(verification)
}

/**
 * Get a single sale verification by ID
 */
export async function getSaleVerification(venueId: string, verificationId: string): Promise<SaleVerificationResponse> {
  logger.info(`📸 [SALE VERIFICATION SERVICE] Getting verification ${verificationId}`)

  const verification = await prisma.saleVerification.findFirst({
    where: { id: verificationId, venueId },
  })

  if (!verification) {
    throw new NotFoundError(`Verification ${verificationId} not found in venue ${venueId}`)
  }

  return mapToResponse(verification)
}

/**
 * Get verification by payment ID
 */
export async function getVerificationByPaymentId(venueId: string, paymentId: string): Promise<SaleVerificationResponse | null> {
  logger.info(`📸 [SALE VERIFICATION SERVICE] Getting verification for payment ${paymentId}`)

  const verification = await prisma.saleVerification.findFirst({
    where: { paymentId, venueId },
  })

  if (!verification) {
    return null
  }

  return mapToResponse(verification)
}

/**
 * List sale verifications with pagination and filters
 */
export async function listSaleVerifications(
  venueId: string,
  params: ListSaleVerificationsParams,
): Promise<PaginatedResponse<SaleVerificationResponse>> {
  logger.info(
    `📸 [SALE VERIFICATION SERVICE] Listing verifications for venue ${venueId} | Page ${params.pageNumber}, Size ${params.pageSize}`,
  )

  const where: Prisma.SaleVerificationWhereInput = {
    venueId,
    ...(params.status && { status: params.status }),
    ...(params.staffId && { staffId: params.staffId }),
    ...(params.fromDate && { createdAt: { gte: params.fromDate } }),
    ...(params.toDate && { createdAt: { lte: params.toDate } }),
  }

  // Handle date range properly
  if (params.fromDate && params.toDate) {
    where.createdAt = {
      gte: params.fromDate,
      lte: params.toDate,
    }
  }

  const [verifications, totalCount] = await Promise.all([
    prisma.saleVerification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (params.pageNumber - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.saleVerification.count({ where }),
  ])

  const response = verifications.map(mapToResponse)

  logger.info(`✅ [SALE VERIFICATION SERVICE] Found ${response.length} verifications (total: ${totalCount})`)

  return {
    data: response,
    pagination: {
      pageSize: params.pageSize,
      pageNumber: params.pageNumber,
      totalCount,
      totalPages: Math.ceil(totalCount / params.pageSize),
    },
  }
}

/**
 * Update verification status
 * Used when processing inventory deduction or marking as completed/failed
 */
export async function updateVerificationStatus(
  venueId: string,
  verificationId: string,
  status: SaleVerificationStatus,
  inventoryDeducted?: boolean,
): Promise<SaleVerificationResponse> {
  logger.info(`📸 [SALE VERIFICATION SERVICE] Updating verification ${verificationId} status to ${status}`)

  const verification = await prisma.saleVerification.findFirst({
    where: { id: verificationId, venueId },
  })

  if (!verification) {
    throw new NotFoundError(`Verification ${verificationId} not found in venue ${venueId}`)
  }

  const updated = await prisma.saleVerification.update({
    where: { id: verificationId },
    data: {
      status,
      ...(inventoryDeducted !== undefined && { inventoryDeducted }),
    },
  })

  logger.info(`✅ [SALE VERIFICATION SERVICE] Verification ${verificationId} updated to ${status}`)

  return mapToResponse(updated)
}

/**
 * Create a PENDING sale verification record immediately after payment
 * Called from the fast payment flow for SERIALIZED_INVENTORY orders
 * The staff can upload photos later via the "Pendientes Verificacion" screen
 */
export async function createPendingSaleVerification(data: {
  venueId: string
  paymentId: string
  staffId: string
  isPortabilidad: boolean
  serialNumbers: string[]
  scannedProducts: ScannedProduct[]
  deviceId?: string
}): Promise<SaleVerificationResponse> {
  logger.info(`📸 [SALE VERIFICATION SERVICE] Creating PENDING verification for payment ${data.paymentId}`, {
    isPortabilidad: data.isPortabilidad,
    serialNumbers: data.serialNumbers,
    requiredPhotos: data.isPortabilidad ? 2 : 1,
  })

  const verification = await prisma.saleVerification.create({
    data: {
      venueId: data.venueId,
      paymentId: data.paymentId,
      staffId: data.staffId,
      photos: [],
      scannedProducts: data.scannedProducts as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
      inventoryDeducted: false,
      isPortabilidad: data.isPortabilidad,
      serialNumbers: data.serialNumbers,
      deviceId: data.deviceId ?? null,
    },
  })

  logger.info(`✅ [SALE VERIFICATION SERVICE] Created PENDING verification ${verification.id}`)
  return mapToResponse(verification)
}

/**
 * Get pending verifications for a specific staff member
 * Used by the TPV "Pendientes Verificacion" screen
 */
export async function getPendingVerifications(venueId: string, staffId: string): Promise<PendingVerificationResponse[]> {
  logger.info(`📸 [SALE VERIFICATION SERVICE] Getting pending verifications for staff ${staffId} in venue ${venueId}`)

  const verifications = await prisma.saleVerification.findMany({
    where: {
      venueId,
      staffId,
      status: 'PENDING',
    },
    include: {
      payment: {
        select: {
          id: true,
          amount: true,
          createdAt: true,
          order: {
            select: {
              orderNumber: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  logger.info(`✅ [SALE VERIFICATION SERVICE] Found ${verifications.length} pending verifications`)

  return verifications.map(v => ({
    id: v.id,
    paymentId: v.paymentId,
    amount: v.payment.amount.toNumber(),
    orderNumber: v.payment.order?.orderNumber ?? null,
    date: v.createdAt.toISOString(),
    serialNumbers: v.serialNumbers,
    isPortabilidad: v.isPortabilidad,
    photos: v.photos, // Preserves index positions (may contain empty strings for unfilled slots)
    requiredPhotos: v.isPortabilidad ? 2 : 1,
  }))
}

/**
 * Create or update proof-of-sale photo for a payment
 * Supports both:
 * - Legacy flow: create new record with COMPLETED status (old TPV versions)
 * - Non-blocking flow: find existing PENDING record, append photos, check completion
 *
 * @param verificationId Optional - if provided, update existing PENDING record directly
 */
export async function createOrUpdateProofOfSale(
  venueId: string,
  paymentId: string,
  photoUrls: string[],
  staffId: string,
  verificationId?: string,
  replaceIndex?: number,
  photoLabel?: 'Vinculacion' | 'Portabilidad',
): Promise<SaleVerificationResponse> {
  logger.info(`📸 [SALE VERIFICATION SERVICE] Creating/updating proof-of-sale for payment ${paymentId}`, {
    verificationId: verificationId ?? 'none (legacy flow)',
    photosCount: photoUrls.length,
    replaceIndex: replaceIndex ?? 'none (append)',
    photoLabel: photoLabel ?? 'none',
  })

  // Validate payment exists and belongs to venue
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, venueId },
    include: { saleVerification: true },
  })

  if (!payment) {
    throw new NotFoundError(`Payment ${paymentId} not found in venue ${venueId}`)
  }

  // Validate staff exists
  const staff = await prisma.staffVenue.findFirst({
    where: { staffId, venueId },
  })

  if (!staff) {
    throw new NotFoundError(`Staff ${staffId} not found in venue ${venueId}`)
  }

  let verification

  // Try to find existing verification (by verificationId or paymentId)
  const existing = verificationId
    ? await prisma.saleVerification.findFirst({ where: { id: verificationId, venueId } })
    : payment.saleVerification

  if (existing) {
    let updatedPhotos: string[]

    // Determine the target index from photoLabel (fixed slots: Vinculacion=0, Portabilidad=1)
    const labelIndex = photoLabel === 'Vinculacion' ? 0 : photoLabel === 'Portabilidad' ? 1 : undefined

    if (replaceIndex !== undefined && replaceIndex < existing.photos.length) {
      // Replace mode: swap photo at the given index
      updatedPhotos = [...existing.photos]
      updatedPhotos[replaceIndex] = photoUrls[0]
      logger.info(`📸 [SALE VERIFICATION SERVICE] Replacing photo at index ${replaceIndex} in verification ${existing.id}`)
    } else if (labelIndex !== undefined) {
      // Label-based fixed slot: place photo at the correct index regardless of upload order
      // Pad array with empty strings if needed (e.g., portabilidad uploaded first → pad index 0)
      updatedPhotos = [...existing.photos]
      while (updatedPhotos.length <= labelIndex) {
        updatedPhotos.push('')
      }
      updatedPhotos[labelIndex] = photoUrls[0]
      logger.info(`📸 [SALE VERIFICATION SERVICE] Placing photo at fixed slot ${labelIndex} (${photoLabel}) in verification ${existing.id}`)
    } else {
      // Append mode (default / legacy): add new photos
      updatedPhotos = [...existing.photos, ...photoUrls]
    }

    // Count non-empty photos for completion check
    const nonEmptyPhotos = updatedPhotos.filter(p => p !== '')

    const requiredPhotos = existing.isPortabilidad ? 2 : 1
    const isComplete = nonEmptyPhotos.length >= requiredPhotos

    logger.info(`📸 [SALE VERIFICATION SERVICE] Updated photos for verification ${existing.id}`, {
      totalPhotos: nonEmptyPhotos.length,
      requiredPhotos,
      willComplete: isComplete,
    })

    verification = await prisma.saleVerification.update({
      where: { id: existing.id },
      data: {
        photos: updatedPhotos,
        status: isComplete ? 'COMPLETED' : 'PENDING',
      },
    })
  } else {
    // No existing verification → Create new with COMPLETED status (legacy flow)
    logger.info(`📸 [SALE VERIFICATION SERVICE] Creating new proof-of-sale verification (legacy flow)`)

    verification = await prisma.saleVerification.create({
      data: {
        venueId,
        paymentId,
        staffId,
        photos: photoUrls,
        scannedProducts: [],
        status: 'COMPLETED',
        inventoryDeducted: false,
      },
    })
  }

  logger.info(`✅ [SALE VERIFICATION SERVICE] Proof-of-sale saved: ${verification.id} (status: ${verification.status})`)

  return mapToResponse(verification)
}

/**
 * Map Prisma model to response type
 */
function mapToResponse(verification: {
  id: string
  venueId: string
  paymentId: string
  staffId: string
  photos: string[]
  scannedProducts: Prisma.JsonValue
  status: SaleVerificationStatus
  inventoryDeducted: boolean
  isPortabilidad: boolean
  serialNumbers: string[]
  deviceId: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}): SaleVerificationResponse {
  return {
    id: verification.id,
    venueId: verification.venueId,
    paymentId: verification.paymentId,
    staffId: verification.staffId,
    photos: verification.photos,
    scannedProducts: (verification.scannedProducts as unknown as ScannedProduct[]) ?? [],
    status: verification.status,
    inventoryDeducted: verification.inventoryDeducted,
    deviceId: verification.deviceId,
    notes: verification.notes,
    createdAt: verification.createdAt,
    updatedAt: verification.updatedAt,
  }
}
