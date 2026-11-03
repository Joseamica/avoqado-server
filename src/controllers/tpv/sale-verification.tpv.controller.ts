import { Request, Response } from 'express'
import * as saleVerificationService from '../../services/tpv/sale-verification.service'
import logger from '../../config/logger'
import { SaleVerificationStatus } from '@prisma/client'
import AppError from '../../errors/AppError'

/** Como el controlador de organización: sólo el `code` de un AppError viaja (nunca el de Prisma, p. ej. P2002). */
function sendError(res: Response, what: string, error: any): void {
  logger.error(`[SALE VERIFICATION CONTROLLER] Error ${what}: ${error?.message}`)
  res.status(error?.statusCode || 500).json({
    success: false,
    message: error?.message || 'Internal server error',
    ...(error instanceof AppError && error.code ? { code: error.code } : {}),
  })
}

// ============================================================
// Sale Verification Controller
// ============================================================
// Handles HTTP requests for Step 4 verification in retail/telecom venues

/**
 * POST /tpv/venues/:venueId/verificaciones
 * Create a sale verification record
 */
export async function createSaleVerification(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { paymentId, staffId, photos, scannedProducts, deviceId, notes, status } = req.body

    logger.info(`[SALE VERIFICATION CONTROLLER] POST /tpv/venues/${venueId}/verificaciones - PaymentId: ${paymentId}`)

    const verification = await saleVerificationService.createSaleVerification(venueId, {
      paymentId,
      staffId,
      photos,
      scannedProducts,
      deviceId,
      notes,
      status,
    })

    res.status(201).json({
      success: true,
      data: verification,
      message: 'Sale verification created successfully',
    })
  } catch (error: any) {
    sendError(res, 'creating verification', error)
  }
}

/**
 * GET /tpv/venues/:venueId/verificaciones
 * List sale verifications with pagination
 */
export async function listSaleVerifications(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const { pageSize = '20', pageNumber = '1', status, staffId, fromDate, toDate } = req.query

    logger.info(`[SALE VERIFICATION CONTROLLER] GET /tpv/venues/${venueId}/verificaciones - Page ${pageNumber}, Size ${pageSize}`)

    const result = await saleVerificationService.listSaleVerifications(venueId, {
      pageSize: parseInt(pageSize as string, 10),
      pageNumber: parseInt(pageNumber as string, 10),
      status: status as SaleVerificationStatus | undefined,
      staffId: staffId as string | undefined,
      fromDate: fromDate ? new Date(fromDate as string) : undefined,
      toDate: toDate ? new Date(toDate as string) : undefined,
    })

    res.status(200).json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    })
  } catch (error: any) {
    sendError(res, 'listing verifications', error)
  }
}

/**
 * GET /tpv/venues/:venueId/verificaciones/:verificationId
 * Get a single sale verification
 */
export async function getSaleVerification(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, verificationId } = req.params

    logger.info(`[SALE VERIFICATION CONTROLLER] GET /tpv/venues/${venueId}/verificaciones/${verificationId}`)

    const verification = await saleVerificationService.getSaleVerification(venueId, verificationId)

    res.status(200).json({
      success: true,
      data: verification,
    })
  } catch (error: any) {
    sendError(res, 'getting verification', error)
  }
}

/**
 * GET /tpv/venues/:venueId/payments/:paymentId/verificacion
 * Get verification by payment ID
 */
export async function getVerificationByPaymentId(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, paymentId } = req.params

    logger.info(`[SALE VERIFICATION CONTROLLER] GET /tpv/venues/${venueId}/payments/${paymentId}/verificacion`)

    const verification = await saleVerificationService.getVerificationByPaymentId(venueId, paymentId)

    if (!verification) {
      res.status(404).json({
        success: false,
        message: `No verification found for payment ${paymentId}`,
      })
      return
    }

    res.status(200).json({
      success: true,
      data: verification,
    })
  } catch (error: any) {
    sendError(res, 'getting verification by payment', error)
  }
}

/**
 * PATCH /tpv/venues/:venueId/verificaciones/:verificationId/status
 * Update verification status
 */
export async function updateVerificationStatus(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, verificationId } = req.params
    const { status, inventoryDeducted } = req.body

    logger.info(`[SALE VERIFICATION CONTROLLER] PATCH /tpv/venues/${venueId}/verificaciones/${verificationId}/status -> ${status}`)

    const verification = await saleVerificationService.updateVerificationStatus(
      venueId,
      verificationId,
      status as SaleVerificationStatus,
      inventoryDeducted,
    )

    res.status(200).json({
      success: true,
      data: verification,
      message: 'Verification status updated successfully',
    })
  } catch (error: any) {
    sendError(res, 'updating verification status', error)
  }
}

/**
 * GET /tpv/verification/pending
 * Get pending verifications for the authenticated staff member
 * Used by the "Pendientes Verificacion" screen on WelcomeScreen
 */
export async function getPendingVerifications(req: Request, res: Response): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const staffId = req.authContext?.userId

    if (!orgId || !staffId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized - Missing authentication context',
      })
      return
    }

    logger.info(`[SALE VERIFICATION CONTROLLER] GET /tpv/verification/pending - Staff: ${staffId}`)

    const page = await saleVerificationService.getPendingVerifications(orgId, staffId, req.query.cursor as string | undefined)

    // `data` como hoy (la terminal vieja sólo lee la primera página) + `total` y `nextCursor`.
    res.status(200).json({
      success: true,
      ...page,
    })
  } catch (error: any) {
    sendError(res, 'getting pending verifications', error)
  }
}

/**
 * GET /tpv/verification/:verificationId
 * Get a single verification owned by the authenticated staff member.
 * Used by the TPV sale-correction flow to re-upload rejected documentation.
 */
export async function getVerificationDetail(req: Request, res: Response): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const staffId = req.authContext?.userId
    const { verificationId } = req.params

    if (!orgId || !staffId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized - Missing authentication context',
      })
      return
    }

    logger.info(`[SALE VERIFICATION CONTROLLER] GET /tpv/verification/${verificationId} - Staff: ${staffId}`)

    const verification = await saleVerificationService.getVerificationForCorrection(orgId, staffId, verificationId)

    res.status(200).json({
      success: true,
      data: verification,
    })
  } catch (error: any) {
    sendError(res, 'getting verification detail', error)
  }
}

/** El token de la TPV nueva: tienda, organización y promotor; si falta algo, 401 como las demás rutas. */
function terminalAuth(req: Request, res: Response): { venueId: string; orgId: string; staffId: string } | null {
  const venueId = req.authContext?.venueId
  const orgId = req.authContext?.orgId
  const staffId = req.authContext?.userId
  if (venueId && orgId && staffId) return { venueId, orgId, staffId }
  res.status(401).json({ success: false, message: 'Unauthorized - Missing authentication context' })
  return null
}

/**
 * GET /tpv/verification/actionable?cursor=
 * Las PENDING y FAILED del promotor, en el formato del detalle: lo que la TPV nueva guarda para trabajar sin señal.
 */
export async function getActionableVerifications(req: Request, res: Response): Promise<void> {
  try {
    const auth = terminalAuth(req, res)
    if (!auth) return
    const page = await saleVerificationService.getActionableVerifications(
      auth.venueId,
      auth.orgId,
      auth.staffId,
      req.query.cursor as string | undefined,
    )
    res.status(200).json({ success: true, ...page })
  } catch (error: any) {
    sendError(res, 'getting actionable verifications', error)
  }
}

/**
 * GET /tpv/verification/number-check?number=&kind=linking|ported&verificationId=
 * Sólo dice si está repetido; nunca con qué venta.
 */
export async function checkLinkingNumber(req: Request, res: Response): Promise<void> {
  try {
    const auth = terminalAuth(req, res)
    if (!auth) return
    const { number, kind, verificationId } = req.query as { number: string; kind: 'linking' | 'ported'; verificationId?: string }
    const { duplicate } = await saleVerificationService.checkTerminalNumber({ ...auth, number, kind, verificationId })
    res.status(200).json({ success: true, duplicate })
  } catch (error: any) {
    sendError(res, 'checking linking number', error)
  }
}

/**
 * GET /tpv/verification/status?paymentIds=a,b,c
 * El estado de la verificación de cada pago (NONE si no hay o es de otra organización).
 */
export async function getVerificationStatuses(req: Request, res: Response): Promise<void> {
  try {
    const auth = terminalAuth(req, res)
    if (!auth) return
    const paymentIds = req.query.paymentIds as unknown as string[] // el schema ya lo separó, sin repetidos y con tope de 100
    const data = await saleVerificationService.getVerificationStatuses(auth.venueId, auth.orgId, paymentIds)
    res.status(200).json({ success: true, data })
  } catch (error: any) {
    sendError(res, 'getting verification statuses', error)
  }
}

/**
 * POST /tpv/verification/proof-of-sale
 * Create or update proof-of-sale photo for a payment
 * Supports:
 * - Legacy flow (old TPV): paymentId + photoUrls → creates COMPLETED record
 * - Non-blocking flow (new TPV): verificationId + paymentId + photoUrls → updates PENDING record
 */
export async function createProofOfSale(req: Request, res: Response): Promise<void> {
  try {
    const { paymentId, photoUrls, verificationId, replaceIndex, photoLabel, linkingNumber, portedNumber } = req.body
    const venueId = req.authContext?.venueId
    const staffId = req.authContext?.userId
    const orgId = req.authContext?.orgId

    if (!venueId || !staffId || !orgId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized - Missing authentication context',
      })
      return
    }

    logger.info(`[SALE VERIFICATION CONTROLLER] POST /tpv/verification/proof-of-sale - PaymentId: ${paymentId}`, {
      verificationId: verificationId ?? 'none (legacy flow)',
      replaceIndex: replaceIndex ?? 'none (append)',
      photoLabel: photoLabel ?? 'none',
    })

    const result = await saleVerificationService.createOrUpdateProofOfSale(
      venueId,
      paymentId,
      photoUrls,
      staffId,
      verificationId,
      replaceIndex,
      photoLabel,
      { orgId, capture: terminalCaptureFrom(req.body), linkingNumber, portedNumber },
    )

    res.status(200).json({
      success: true,
      message: 'Proof-of-sale photo uploaded successfully',
      ...result, // verificationId y status (como hoy) + los desenlaces de la terminal nueva
    })
  } catch (error: any) {
    sendError(res, 'creating proof-of-sale', error)
  }
}

/** La terminal nueva se reconoce porque manda `captureSeq` (el schema exige que venga con lo demás). */
function terminalCaptureFrom(body: {
  captureSeq?: number
  captureDeviceId?: string
  idempotencyKey?: string
  capturedAt?: string
}): saleVerificationService.TerminalCapture | undefined {
  if (body.captureSeq === undefined || !body.captureDeviceId || !body.idempotencyKey || !body.capturedAt) return undefined
  return {
    seq: body.captureSeq,
    deviceId: body.captureDeviceId,
    idempotencyKey: body.idempotencyKey,
    capturedAt: new Date(body.capturedAt),
  }
}

/**
 * POST /tpv/verification/:verificationId/number
 * Corregir sólo el número (sin foto) desde la terminal nueva. Mismas reglas que proof-of-sale; nunca toca fotos.
 */
export async function setVerificationNumber(req: Request, res: Response): Promise<void> {
  try {
    const venueId = req.authContext?.venueId
    const staffId = req.authContext?.userId
    const orgId = req.authContext?.orgId

    if (!venueId || !staffId || !orgId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized - Missing authentication context',
      })
      return
    }

    const { slot, number } = req.body
    const result = await saleVerificationService.setNumberFromTerminal({
      venueId,
      orgId,
      staffId,
      verificationId: req.params.verificationId,
      slot,
      number,
      capture: terminalCaptureFrom(req.body)!,
    })

    res.status(200).json({
      success: true,
      message: 'Número guardado',
      ...result,
    })
  } catch (error: any) {
    sendError(res, 'setting verification number', error)
  }
}
