/**
 * CFDI Dashboard Controller
 *
 * Thin controller — extracts HTTP params, delegates to issueCfdiForOrder service.
 * Contains NO business logic, only request/response handling and error mapping.
 *
 * Flow B: Staff issues a CFDI for a closed bill.
 *
 * @see src/services/fiscal/cfdi.service.ts — business logic
 * @see docs/plans/2026-06-03-facturacion-phase1-flowB-route.md — spec §7.3
 */

import { Request, Response } from 'express'
import { env } from '@/config/env'
import logger from '@/config/logger'
import { issueCfdiForOrder } from '@/services/fiscal/cfdi.service'

/**
 * POST /api/v1/dashboard/venues/:venueId/orders/:orderId/cfdi
 *
 * Issues a CFDI 4.0 for a closed bill (Flow B — staff-initiated).
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:issue').
 * Body is validated by validateRequest(issueCfdiSchema) before this handler runs.
 */
export async function issueCfdiForOrderController(req: Request, res: Response): Promise<void> {
  const { orderId } = req.params
  const { rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email } = req.body
  // Tenant isolation: the order must belong to the caller's venue (critical-warnings rule).
  const { venueId } = (req as any).authContext ?? {}

  // Sandbox stamps in dev/staging (free, no SAT effect); live key in production.
  const sandbox = env.NODE_ENV !== 'production'

  try {
    const result = await issueCfdiForOrder({
      orderId,
      receptor: { rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email },
      sandbox,
      flow: 'STAFF_B',
      expectedVenueId: venueId,
    })

    if (result.status === 'VALIDATION_FAILED') {
      res.status(422).json({
        error: 'No se pudo facturar',
        reasons: result.reasons,
        cfdiId: result.cfdi?.id,
      })
      return
    }

    if (result.status === 'STAMP_FAILED') {
      res.status(502).json({
        error: 'El PAC rechazó el timbrado',
        message: result.cfdi?.lastError,
        cfdiId: result.cfdi?.id,
      })
      return
    }

    // STAMPED — 201 with minimal public fields
    res.status(201).json({
      cfdi: {
        id: result.cfdi.id,
        uuid: result.cfdi.uuid,
        serie: result.cfdi.serie,
        folio: result.cfdi.folio,
        status: result.cfdi.status,
        xmlUrl: result.cfdi.xmlUrl,
        pdfUrl: result.cfdi.pdfUrl,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] issue failed for order ${orderId}: ${message}`)

    if (/not found|no fiscal emisor/i.test(message)) {
      res.status(404).json({ error: 'Orden no encontrada o sin emisor fiscal configurado' })
      return
    }

    res.status(500).json({ error: 'Error interno al facturar' })
  }
}
