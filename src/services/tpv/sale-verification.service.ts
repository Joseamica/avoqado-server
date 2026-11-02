import { SaleVerificationStatus, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError, ValidationError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { moduleService, MODULE_CODES } from '../modules/module.service'
import {
  canTerminalWriteNumber,
  isNewerCapture,
  isValidTerminalNumber,
  normalizeLinkingNumber,
  withAppliedCapture,
  type AppliedCaptureSeqs,
  type CaptureDestination,
} from '../playtelecom/linkingNumber.rules'
import { isLinkingNumberEnabledForOrg } from '../playtelecom/linkingNumber.flag'
import { isNumberDuplicate } from '../playtelecom/linkingNumber.duplicates'

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

type LockedSaleVerification = Prisma.SaleVerificationGetPayload<{}>

/**
 * Every TPV writer shares the reassignment job's global lock order:
 * Payment first, then its optional SaleVerification. The venue predicates are
 * authority checks, not just lookup filters: after an A→B reassignment commits,
 * a delayed request carrying venue A must observe no Payment and abort.
 */
async function lockPaymentAuthority(tx: Prisma.TransactionClient, venueId: string, paymentId: string): Promise<void> {
  const payments = await tx.$queryRaw<Array<{ id: string; venueId: string }>>(Prisma.sql`
    SELECT p.id, p."venueId"
    FROM "Payment" p
    WHERE p.id = ${paymentId}
      AND p."venueId" = ${venueId}
    FOR UPDATE OF p
  `)

  if (!payments[0]) {
    throw new NotFoundError(`Payment ${paymentId} not found in venue ${venueId}`)
  }
}

async function lockSaleVerificationAuthority(
  tx: Prisma.TransactionClient,
  venueId: string,
  paymentId: string,
  verificationId?: string,
): Promise<LockedSaleVerification | null> {
  const verifications = verificationId
    ? await tx.$queryRaw<LockedSaleVerification[]>(Prisma.sql`
        SELECT sv.*
        FROM "SaleVerification" sv
        WHERE sv.id = ${verificationId}
          AND sv."paymentId" = ${paymentId}
          AND sv."venueId" = ${venueId}
        LIMIT 1
        FOR UPDATE OF sv
      `)
    : await tx.$queryRaw<LockedSaleVerification[]>(Prisma.sql`
        SELECT sv.*
        FROM "SaleVerification" sv
        WHERE sv."paymentId" = ${paymentId}
          AND sv."venueId" = ${venueId}
        LIMIT 1
        FOR UPDATE OF sv
      `)

  return verifications[0] ?? null
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

  // Preserve the public duplicate-create fast-fail. This is only an advisory
  // compatibility check; the same condition is re-resolved under Payment lock
  // below, which is the authority for concurrent requests/reassignment.
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

  // Backend is source of truth: venues with a back-office review step
  // (serialized inventory) can NEVER be auto-completed by the client. If the
  // TPV sends COMPLETED, downgrade to PENDING so the sale enters the queue.
  const requiresBackOfficeReview = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
  const requestedStatus = data.status ?? 'PENDING'
  const effectiveStatus: SaleVerificationStatus = requiresBackOfficeReview && requestedStatus === 'COMPLETED' ? 'PENDING' : requestedStatus

  const verification = await prisma.$transaction(async tx => {
    await lockPaymentAuthority(tx, venueId, data.paymentId)
    const existing = await lockSaleVerificationAuthority(tx, venueId, data.paymentId)
    if (existing) {
      throw new BadRequestError(`Verification already exists for payment ${data.paymentId}`)
    }

    return tx.saleVerification.create({
      data: {
        venueId,
        paymentId: data.paymentId,
        staffId: data.staffId,
        photos: data.photos,
        scannedProducts: data.scannedProducts as unknown as Prisma.InputJsonValue,
        status: effectiveStatus,
        deviceId: data.deviceId ?? null,
        notes: data.notes ?? null,
      },
    })
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
      // `id` is the TIEBREAK — SaleVerification carries ties up to 25 in prod (585 of 5,550 rows share
      // a timestamp) because a manual upload backdates a whole day's sales to one instant. Same root
      // cause as the dashboard sale lists (Asana 1217127206664238).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

  const updated = await prisma.$transaction(async tx => {
    await lockPaymentAuthority(tx, venueId, verification.paymentId)
    const lockedVerification = await lockSaleVerificationAuthority(tx, venueId, verification.paymentId, verificationId)
    if (!lockedVerification) {
      throw new NotFoundError(`Verification ${verificationId} not found in venue ${venueId}`)
    }

    return tx.saleVerification.update({
      where: { id: verificationId, paymentId: verification.paymentId, venueId },
      data: {
        status,
        ...(inventoryDeducted !== undefined && { inventoryDeducted }),
      },
    })
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

  const verification = await prisma.$transaction(async tx => {
    await lockPaymentAuthority(tx, data.venueId, data.paymentId)
    const existing = await lockSaleVerificationAuthority(tx, data.venueId, data.paymentId)
    if (existing) {
      throw new BadRequestError(`Verification already exists for payment ${data.paymentId}`)
    }

    return tx.saleVerification.create({
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

interface VerificationDetailResponse extends PendingVerificationResponse {
  status: SaleVerificationStatus
  rejectionReasons: string[]
  reviewNotes: string | null
}

/**
 * Get a single verification owned by a staff member, in the same shape the
 * "Pendientes" screen consumes, plus the back-office review verdict.
 * Used by the TPV sale-correction flow (Mis Ventas → "Revisar documentación"):
 * the promoter taps a rejected sale and re-uploads the documentation photos.
 */
export async function getVerificationForCorrection(
  venueId: string,
  staffId: string,
  verificationId: string,
): Promise<VerificationDetailResponse> {
  logger.info(`📸 [SALE VERIFICATION SERVICE] Getting verification ${verificationId} for correction (staff ${staffId})`)

  const v = await prisma.saleVerification.findFirst({
    where: { id: verificationId, venueId, staffId },
    include: {
      payment: {
        select: {
          id: true,
          amount: true,
          createdAt: true,
          order: { select: { orderNumber: true } },
        },
      },
    },
  })

  if (!v) {
    throw new NotFoundError(`Verification ${verificationId} not found for staff ${staffId} in venue ${venueId}`)
  }

  return {
    id: v.id,
    paymentId: v.paymentId,
    amount: v.payment.amount.toNumber(),
    orderNumber: v.payment.order?.orderNumber ?? null,
    date: v.createdAt.toISOString(),
    serialNumbers: v.serialNumbers,
    isPortabilidad: v.isPortabilidad,
    photos: v.photos, // Preserves index positions (may contain empty strings for unfilled slots)
    requiredPhotos: v.isPortabilidad ? 2 : 1,
    status: v.status,
    rejectionReasons: v.rejectionReasons,
    reviewNotes: v.reviewNotes,
  }
}

// ============================================================
// Proof-of-sale y número de vinculación desde la terminal (spec §5.3.2)
// ============================================================

/** Una captura de la terminal nueva (cola durable). Las terminales publicadas no la mandan. */
export interface TerminalCapture {
  seq: number
  deviceId: string
  idempotencyKey: string
  capturedAt: Date
}
export type CaptureOutcome = 'APPLIED' | 'SUPERSEDED_BY_NEWER' | 'SALE_ALREADY_APPROVED'
export type NumberOutcome = 'APPLIED' | 'UNCHANGED' | 'SUPERSEDED_BY_NEWER' | 'LOCKED_BY_BACKOFFICE' | 'DISABLED'
export interface ProofOfSaleResult {
  verificationId: string
  status: SaleVerificationStatus
  outcome?: CaptureOutcome
  photoOutcome?: 'APPLIED' | 'SUPERSEDED_BY_NEWER'
  linkingNumberOutcome?: NumberOutcome
  portedNumberOutcome?: NumberOutcome
  linkingDuplicate?: boolean
  portedDuplicate?: boolean
}

type NumberField = 'linking' | 'ported'
type NumberOutcomes = Partial<Record<NumberField, NumberOutcome>>
type NumberWrite = Partial<
  Pick<
    Prisma.SaleVerificationUncheckedCreateInput,
    'linkingNumber' | 'linkingNumberSource' | 'linkingNumberSetAt' | 'portedNumber' | 'portedNumberSource' | 'portedNumberSetAt'
  >
>
type ProofTxResult = {
  verification: LockedSaleVerification
  outcome: CaptureOutcome
  photoOutcome?: 'APPLIED' | 'SUPERSEDED_BY_NEWER'
  outcomes: NumberOutcomes
  postCommitLogs: Array<{ message: string; meta?: Record<string, unknown> }>
}
type NumberState = Pick<
  LockedSaleVerification,
  'id' | 'venueId' | 'linkingNumber' | 'linkingNumberSource' | 'portedNumber' | 'portedNumberSource'
>

const NUMBER_FIELDS: NumberField[] = ['linking', 'ported']
const SALE_REJECTED_MESSAGE = 'Esta venta fue rechazada y no puede modificarse desde el TPV'

/** Lo que la terminal nueva todavía puede cambiar: lo pendiente y lo que el back-office regresó («Revisar»). */
const isTerminalWritable = (status: SaleVerificationStatus) => status === 'PENDING' || status === 'FAILED'
const isAccepted = (o: NumberOutcome | undefined) => o === 'APPLIED' || o === 'UNCHANGED'

/** 9 o 10 dígitos, quitando sólo espacios, guiones, puntos y paréntesis; lo demás es 400 (spec §5.3.2). */
function toTerminalDigits(field: NumberField, raw: string): string {
  const digits = normalizeLinkingNumber(raw)
  if (!isValidTerminalNumber(digits)) {
    throw new BadRequestError(
      field === 'linking' ? 'El número de vinculación debe tener 9 o 10 dígitos' : 'El número portado debe tener 9 o 10 dígitos',
      'INVALID_LINKING_NUMBER',
    )
  }
  return digits
}

/** El job de SIM de evento movió la venta entre la búsqueda y el candado: la terminal reintenta y la encuentra en su tienda nueva. */
function saleMoved(error: unknown): never {
  if (error instanceof NotFoundError) {
    throw new ConflictError('La venta cambió de tienda mientras se guardaba; vuelve a intentarlo', 'VERIFICATION_MOVED')
  }
  throw error
}

/** Escribe quien vendió (el promotor de la venta) o quien tiene StaffVenue activo en la tienda de la venta. */
async function assertTerminalStaffCanWrite(staffId: string, saleVenueId: string, promoterId: string | null | undefined): Promise<void> {
  if (promoterId === staffId) return
  const staffVenue = await prisma.staffVenue.findFirst({ where: { staffId, venueId: saleVenueId, active: true }, select: { id: true } })
  if (!staffVenue) throw new NotFoundError(`Staff ${staffId} not found in venue ${saleVenueId}`)
}

/**
 * Coloca la foto como hoy: reemplazo por índice, ranura fija por etiqueta (Vinculacion=0, Portabilidad=1, rellenando
 * con '') o al final. `slot` es la ranura que tocó, si fue una sola.
 */
function placePhotos(
  current: string[],
  photoUrls: string[],
  replaceIndex: number | undefined,
  photoLabel: 'Vinculacion' | 'Portabilidad' | undefined,
): { photos: string[]; slot?: number } {
  if (replaceIndex !== undefined && replaceIndex < current.length) {
    const photos = [...current]
    photos[replaceIndex] = photoUrls[0]
    return { photos, slot: replaceIndex }
  }
  const labelIndex = photoLabel === 'Vinculacion' ? 0 : photoLabel === 'Portabilidad' ? 1 : undefined
  if (labelIndex !== undefined) {
    const photos = [...current]
    while (photos.length <= labelIndex) photos.push('')
    photos[labelIndex] = photoUrls[0]
    return { photos, slot: labelIndex }
  }
  return { photos: [...current, ...photoUrls], slot: photoUrls.length === 1 ? current.length : undefined }
}

const photoDestination = (slot: number | undefined): CaptureDestination | undefined =>
  slot === 0 ? 'PHOTO_VINCULACION' : slot === 1 ? 'PHOTO_PORTABILIDAD' : undefined

/**
 * El paso del número, bajo el candado de la venta (lo comparten proof-of-sale y la ruta del número; nunca toca fotos).
 * La terminal sólo escribe si el campo está vacío o lo escribió ella (`…Source = TPV`), y nunca con una captura
 * menor o igual a la mayor ya aplicada de ese aparato en ese destino. Cambiar uno que ya había deja bitácora.
 */
async function applyTerminalNumberInTx(
  tx: Prisma.TransactionClient,
  sv: NumberState,
  applied: AppliedCaptureSeqs,
  field: NumberField,
  digits: string,
  capture: TerminalCapture,
  actor: { staffId: string; orgId: string },
): Promise<{ outcome: NumberOutcome; applied: AppliedCaptureSeqs; data: NumberWrite }> {
  const [before, source] = field === 'linking' ? [sv.linkingNumber, sv.linkingNumberSource] : [sv.portedNumber, sv.portedNumberSource]
  const destination: CaptureDestination = field === 'linking' ? 'LINKING' : 'PORTED'
  if (!canTerminalWriteNumber(source)) return { outcome: 'LOCKED_BY_BACKOFFICE', applied, data: {} }
  if (!isNewerCapture(applied, destination, capture.deviceId, capture.seq)) return { outcome: 'SUPERSEDED_BY_NEWER', applied, data: {} }

  const next = withAppliedCapture(applied, destination, capture.deviceId, capture.seq)
  if (before === digits) return { outcome: 'UNCHANGED', applied: next, data: {} }

  const valueField = field === 'linking' ? 'linkingNumber' : 'portedNumber'
  if (before !== null) {
    await tx.activityLog.create({
      data: {
        staffId: actor.staffId,
        venueId: sv.venueId,
        organizationId: actor.orgId,
        action: 'SALE_VERIFICATION_NUMBER_SET',
        entity: 'SaleVerification',
        entityId: sv.id,
        data: {
          field: valueField,
          before,
          after: digits,
          source: 'TPV',
          idempotencyKey: capture.idempotencyKey,
          capturedAt: capture.capturedAt.toISOString(),
          captureSeq: capture.seq,
          captureDeviceId: capture.deviceId,
        },
      },
    })
  }
  const now = new Date()
  const data: NumberWrite =
    field === 'linking'
      ? { linkingNumber: digits, linkingNumberSource: 'TPV', linkingNumberSetAt: now }
      : { portedNumber: digits, portedNumberSource: 'TPV', portedNumberSetAt: now }
  return { outcome: 'APPLIED', applied: next, data }
}

/** Aplica los números de proof-of-sale en orden (vinculación, portado) sobre el mismo `appliedCaptureSeqs`. */
async function applyTerminalNumbersInTx(
  tx: Prisma.TransactionClient,
  sv: NumberState,
  applied: AppliedCaptureSeqs,
  numbers: Partial<Record<NumberField, string>>,
  capture: TerminalCapture | undefined,
  actor: { staffId: string; orgId: string },
): Promise<{ outcomes: NumberOutcomes; applied: AppliedCaptureSeqs; data: NumberWrite }> {
  const outcomes: NumberOutcomes = {}
  const data: NumberWrite = {}
  for (const field of NUMBER_FIELDS) {
    const digits = numbers[field]
    if (digits === undefined || !capture) continue
    const r = await applyTerminalNumberInTx(tx, sv, applied, field, digits, capture, actor)
    outcomes[field] = r.outcome
    applied = r.applied
    Object.assign(data, r.data)
  }
  return { outcomes, applied, data }
}

/** ¿El número que quedó guardado está repetido en la organización? Sólo de los números que se aceptaron. */
async function duplicatesOf(
  orgId: string,
  v: { id: string; serialNumbers: string[]; linkingNumber: string | null; portedNumber: string | null },
  outcomes: NumberOutcomes,
): Promise<Pick<ProofOfSaleResult, 'linkingDuplicate' | 'portedDuplicate'>> {
  const check = (field: NumberField, n: string | null) =>
    isAccepted(outcomes[field]) && n
      ? isNumberDuplicate(orgId, n, { verificationId: v.id, iccid: v.serialNumbers[0] })
      : Promise.resolve(undefined)
  const [linkingDuplicate, portedDuplicate] = await Promise.all([check('linking', v.linkingNumber), check('ported', v.portedNumber)])
  return {
    ...(linkingDuplicate !== undefined && { linkingDuplicate }),
    ...(portedDuplicate !== undefined && { portedDuplicate }),
  }
}

const numberOutcomeFields = (o: NumberOutcomes): Pick<ProofOfSaleResult, 'linkingNumberOutcome' | 'portedNumberOutcome'> => ({
  ...(o.linking && { linkingNumberOutcome: o.linking }),
  ...(o.ported && { portedNumberOutcome: o.ported }),
})

/**
 * Create or update proof-of-sale photo for a payment
 * Supports both:
 * - Legacy flow: create new record (old TPV versions, or a paid sale whose verification was never created)
 * - Non-blocking flow: find existing PENDING record, place photos, check completion
 *
 * Terminales publicadas (sin `opts.capture`): exactamente lo de hoy. Terminal nueva (con `captureSeq`): sólo escribe
 * en PENDING/FAILED, una captura vieja del mismo aparato no pisa a una nueva y el número del back-office no se toca.
 * La venta se busca por `paymentId` dentro de la organización del token (el job de SIM de evento la mueve de tienda).
 */
export async function createOrUpdateProofOfSale(
  venueId: string,
  paymentId: string,
  photoUrls: string[],
  staffId: string,
  verificationId: string | undefined,
  replaceIndex: number | undefined,
  photoLabel: 'Vinculacion' | 'Portabilidad' | undefined,
  opts: { orgId: string; capture?: TerminalCapture; linkingNumber?: string; portedNumber?: string },
): Promise<ProofOfSaleResult> {
  const { orgId, capture } = opts
  logger.info(`📸 [SALE VERIFICATION SERVICE] Creating/updating proof-of-sale for payment ${paymentId}`, {
    tokenVenueId: venueId,
    verificationId: verificationId ?? 'none (legacy flow)',
    photosCount: photoUrls.length,
    replaceIndex: replaceIndex ?? 'none (append)',
    photoLabel: photoLabel ?? 'none',
    ...(capture && { captureSeq: capture.seq, captureDeviceId: capture.deviceId, idempotencyKey: capture.idempotencyKey }),
  })

  // Números: sin captureSeq no se aceptan; con el interruptor apagado se ignoran (la foto no se pierde) y se contestan DISABLED.
  const sentNumbers = NUMBER_FIELDS.filter(f => (f === 'linking' ? opts.linkingNumber : opts.portedNumber) !== undefined)
  if (sentNumbers.length && !capture) {
    throw new BadRequestError('El número sólo se acepta junto con captureSeq (terminal actualizada)', 'CAPTURE_REQUIRED')
  }
  const numbersEnabled = sentNumbers.length > 0 && (await isLinkingNumberEnabledForOrg(orgId))
  const numbers: Partial<Record<NumberField, string>> = {}
  const disabled: NumberOutcomes = {}
  for (const field of sentNumbers) {
    if (!numbersEnabled) disabled[field] = 'DISABLED'
    else numbers[field] = toTerminalDigits(field, (field === 'linking' ? opts.linkingNumber : opts.portedNumber)!)
  }

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, venue: { organizationId: orgId } },
    select: {
      venueId: true,
      processedById: true,
      saleVerification: { select: { staffId: true } },
      // Para la venta cobrada cuya verificación no se creó: portabilidad e ICCIDs salen de la orden.
      order: {
        select: { tags: true, items: { where: { serializedItem: { isNot: null } }, select: { productSku: true }, take: 50 } },
      },
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment ${paymentId} not found in organization ${orgId}`)
  }

  const saleVenueId = payment.venueId
  await assertTerminalStaffCanWrite(staffId, saleVenueId, payment.saleVerification?.staffId ?? payment.processedById)

  // Venues running serialized inventory (e.g. SIM promoters) require the
  // back-office to review EVERY sale — uploading the proof photos must NOT
  // auto-complete the verification. Restaurants without the module keep the
  // legacy auto-complete behavior (no back-office review step exists for them).
  // Config-driven per .claude/rules: never hardcode client slugs.
  const requiresBackOfficeReview = await moduleService.isModuleEnabled(saleVenueId, MODULE_CODES.SERIALIZED_INVENTORY)
  const actor = { staffId, orgId }

  const { verification, outcome, photoOutcome, outcomes, postCommitLogs } = await prisma.$transaction(
    async (tx): Promise<ProofTxResult> => {
      await lockPaymentAuthority(tx, saleVenueId, paymentId).catch(saleMoved)
      const existing = await lockSaleVerificationAuthority(tx, saleVenueId, paymentId, verificationId)
      const logs: ProofTxResult['postCommitLogs'] = []

      if (!existing) {
        // No existing verification → legacy flow (también la venta cobrada cuya verificación no se creó).
        // Restaurants (no review step) auto-complete; venues requiring back-office
        // review stay PENDING until someone accepts or sends the sale back.
        const legacyStatus: SaleVerificationStatus = requiresBackOfficeReview ? 'PENDING' : 'COMPLETED'
        const placed = placePhotos([], photoUrls, replaceIndex, photoLabel)
        const photoDest = photoDestination(placed.slot)
        const seqs: AppliedCaptureSeqs = capture && photoDest ? withAppliedCapture({}, photoDest, capture.deviceId, capture.seq) : {}
        const empty: NumberState = {
          id: '',
          venueId: saleVenueId,
          linkingNumber: null,
          linkingNumberSource: null,
          portedNumber: null,
          portedNumberSource: null,
        }
        const n = await applyTerminalNumbersInTx(tx, empty, seqs, numbers, capture, actor)
        const created = await tx.saleVerification.create({
          data: {
            venueId: saleVenueId,
            paymentId,
            staffId: payment.processedById ?? staffId,
            photos: placed.photos,
            scannedProducts: [],
            status: legacyStatus,
            inventoryDeducted: false,
            isPortabilidad: payment.order.tags.includes('portabilidad'),
            serialNumbers: payment.order.items.map(i => i.productSku).filter((s): s is string => !!s),
            ...n.data,
            ...(capture && { appliedCaptureSeqs: n.applied as Prisma.InputJsonValue }),
          },
        })
        logs.push({
          message: `📸 [SALE VERIFICATION SERVICE] Creating new proof-of-sale verification (legacy flow), status=${legacyStatus}`,
        })
        return { verification: created, outcome: 'APPLIED', photoOutcome: 'APPLIED', outcomes: n.outcomes, postCommitLogs: logs }
      }

      // Terminal guard: a REJECTED ("Rechazada") sale is a lost sale — the promoter
      // cannot revive it by re-uploading evidence (unlike FAILED/"Revisar"). Only an
      // admin can reopen it via the dashboard edit. Enforced server-side so it holds
      // regardless of TPV app version. (Asana 1215725049493387)
      if (existing.status === 'REJECTED') {
        throw new BadRequestError(SALE_REJECTED_MESSAGE, 'SALE_REJECTED')
      }

      // La terminal nueva no reabre una venta aprobada (spec §5.3.2): no cambia fotos, número ni estado.
      if (capture && !isTerminalWritable(existing.status)) {
        return { verification: existing, outcome: 'SALE_ALREADY_APPROVED', outcomes: {}, postCommitLogs: logs }
      }

      let applied = (existing.appliedCaptureSeqs ?? {}) as AppliedCaptureSeqs
      const placed = placePhotos(existing.photos, photoUrls, replaceIndex, photoLabel)
      const photoDest = photoDestination(placed.slot)
      const photoApplied = !capture || !photoDest || isNewerCapture(applied, photoDest, capture.deviceId, capture.seq)
      if (capture && photoDest && photoApplied) applied = withAppliedCapture(applied, photoDest, capture.deviceId, capture.seq)

      const n = await applyTerminalNumbersInTx(tx, existing, applied, numbers, capture, actor)
      const numberAccepted = Object.values(n.outcomes).some(isAccepted)
      if (!photoApplied && !numberAccepted) {
        return {
          verification: existing,
          outcome: 'SUPERSEDED_BY_NEWER',
          photoOutcome: 'SUPERSEDED_BY_NEWER',
          outcomes: n.outcomes,
          postCommitLogs: logs,
        }
      }

      const isCorrectingRejection = existing.status === 'FAILED'
      let status: SaleVerificationStatus = isCorrectingRejection ? 'PENDING' : existing.status
      if (photoApplied) {
        // Count non-empty photos for completion check
        const nonEmptyPhotos = placed.photos.filter(p => p !== '')
        const requiredPhotos = existing.isPortabilidad ? 2 : 1
        const isComplete = nonEmptyPhotos.length >= requiredPhotos

        // Correction flow (Asana: Administración de Ventas):
        // Once the back-office has reviewed this verification at least once
        // (reviewedAt set), ANY re-upload must return it to the review queue
        // (PENDING) — never auto-complete — so the back-office re-checks the
        // corrected docs. `reviewedAt` is kept as the "has been reviewed" marker
        // so a multi-photo correction (portabilidad) doesn't auto-complete on the
        // second upload after the first one flipped FAILED → PENDING.
        const wasReviewed = existing.reviewedAt !== null

        // Auto-complete only when the venue has NO back-office review step.
        // With review required (serialized inventory), a completed photo set keeps
        // the verification PENDING so the back-office accepts or sends it back.
        const willAutoComplete = !requiresBackOfficeReview && !wasReviewed && isComplete
        status = willAutoComplete ? 'COMPLETED' : 'PENDING'

        logs.push({
          message: `📸 [SALE VERIFICATION SERVICE] Updated photos for verification ${existing.id}`,
          meta: {
            slot: placed.slot ?? 'append',
            totalPhotos: nonEmptyPhotos.length,
            requiredPhotos,
            willComplete: willAutoComplete,
            requiresBackOfficeReview,
            wasReviewed,
            isCorrectingRejection,
          },
        })
      }

      const updated = await tx.saleVerification.update({
        where: { id: existing.id, paymentId, venueId: saleVenueId },
        data: {
          ...(photoApplied && { photos: placed.photos }),
          status,
          // Clear the stale rejection verdict so the back-office sees a fresh
          // submission. Keep reviewedAt/reviewedById as the "reviewed" marker.
          ...(isCorrectingRejection && {
            rejectionReasons: [],
            reviewNotes: null,
          }),
          ...n.data,
          ...(capture && { appliedCaptureSeqs: n.applied as Prisma.InputJsonValue }),
        },
      })
      return {
        verification: updated,
        outcome: 'APPLIED',
        photoOutcome: photoApplied ? 'APPLIED' : 'SUPERSEDED_BY_NEWER',
        outcomes: n.outcomes,
        postCommitLogs: logs,
      }
    },
  )

  for (const log of postCommitLogs) {
    logger.info(log.message, log.meta)
  }

  logger.info(`✅ [SALE VERIFICATION SERVICE] Proof-of-sale saved: ${verification.id} (status: ${verification.status})`, {
    ...(capture && { outcome, photoOutcome, ...outcomes }),
  })

  return {
    verificationId: verification.id,
    status: verification.status,
    ...(capture && { outcome, ...(photoOutcome && { photoOutcome }) }),
    ...numberOutcomeFields({ ...disabled, ...outcomes }),
    ...(await duplicatesOf(orgId, verification, outcomes)),
  }
}

/**
 * POST tpv/verification/:id/number — corregir sólo el número desde la terminal (spec §5.3.2). Mismas reglas que el
 * número de proof-of-sale; nunca toca las fotos. Una venta FAILED vuelve a PENDING para que el back-office la vea.
 */
export async function setNumberFromTerminal(p: {
  orgId: string
  staffId: string
  verificationId: string
  slot: 'VINCULACION' | 'PORTABILIDAD'
  number: string
  capture: TerminalCapture
}): Promise<ProofOfSaleResult> {
  const field: NumberField = p.slot === 'VINCULACION' ? 'linking' : 'ported'
  const digits = toTerminalDigits(field, p.number)
  if (!(await isLinkingNumberEnabledForOrg(p.orgId))) {
    throw new ValidationError('El número de vinculación no está activo en esta organización', 'LINKING_NUMBER_DISABLED')
  }

  const found = await prisma.saleVerification.findFirst({
    where: { id: p.verificationId, venue: { organizationId: p.orgId } },
    select: { venueId: true, paymentId: true, staffId: true },
  })
  if (!found) throw new NotFoundError(`Verification ${p.verificationId} not found in organization ${p.orgId}`)
  await assertTerminalStaffCanWrite(p.staffId, found.venueId, found.staffId)

  type NumberTxResult = { verification: LockedSaleVerification; outcome: CaptureOutcome; numberOutcome?: NumberOutcome }
  const { verification, outcome, numberOutcome } = await prisma.$transaction(async (tx): Promise<NumberTxResult> => {
    await lockPaymentAuthority(tx, found.venueId, found.paymentId).catch(saleMoved)
    const sv = await lockSaleVerificationAuthority(tx, found.venueId, found.paymentId, p.verificationId)
    if (!sv) throw new NotFoundError(`Verification ${p.verificationId} not found in venue ${found.venueId}`)
    if (sv.status === 'REJECTED') throw new BadRequestError(SALE_REJECTED_MESSAGE, 'SALE_REJECTED')
    if (!isTerminalWritable(sv.status)) return { verification: sv, outcome: 'SALE_ALREADY_APPROVED' }

    const r = await applyTerminalNumberInTx(tx, sv, (sv.appliedCaptureSeqs ?? {}) as AppliedCaptureSeqs, field, digits, p.capture, p)
    if (!isAccepted(r.outcome)) return { verification: sv, outcome: 'SUPERSEDED_BY_NEWER', numberOutcome: r.outcome }

    const reopen = sv.status === 'FAILED'
    const updated = await tx.saleVerification.update({
      where: { id: sv.id, paymentId: sv.paymentId, venueId: found.venueId },
      data: {
        ...r.data,
        appliedCaptureSeqs: r.applied as Prisma.InputJsonValue,
        ...(reopen && { status: 'PENDING', rejectionReasons: [], reviewNotes: null }),
      },
    })
    return { verification: updated, outcome: 'APPLIED', numberOutcome: r.outcome }
  })

  const outcomes: NumberOutcomes = !numberOutcome ? {} : field === 'linking' ? { linking: numberOutcome } : { ported: numberOutcome }
  logger.info(`✅ [SALE VERIFICATION SERVICE] Terminal number for ${verification.id}: ${outcome}`, {
    field,
    numberOutcome,
    captureSeq: p.capture.seq,
    captureDeviceId: p.capture.deviceId,
    idempotencyKey: p.capture.idempotencyKey,
  })
  return {
    verificationId: verification.id,
    status: verification.status,
    outcome,
    ...numberOutcomeFields(outcomes),
    ...(await duplicatesOf(p.orgId, verification, outcomes)),
  }
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
