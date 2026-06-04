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
import { issueCfdiForOrder, cancelCfdi, getCfdiStatus } from '@/services/fiscal/cfdi.service'
import { upsertEmisor, upsertMerchantFiscalConfig, getFiscalConfig } from '@/services/fiscal/fiscalConfig.service'
import { logAction } from '@/services/dashboard/activity-log.service'

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

    // STAMPED — audit + 201 with minimal public fields
    logAction({
      staffId: (req as any).authContext?.userId,
      venueId,
      action: 'CFDI_ISSUED',
      entity: 'Cfdi',
      entityId: result.cfdi.id,
      data: { orderId, uuid: result.cfdi.uuid, serie: result.cfdi.serie, folio: result.cfdi.folio },
    })

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

/**
 * GET /api/v1/dashboard/venues/:venueId/cfdi/:cfdiId
 *
 * Returns the current CFDI record (including cancel status) for the given venue.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:view').
 */
export async function getCfdiStatusController(req: Request, res: Response): Promise<void> {
  const { cfdiId } = req.params
  const { venueId } = (req as any).authContext ?? {}

  try {
    const cfdi = await getCfdiStatus({ cfdiId, expectedVenueId: venueId })

    res.status(200).json({ cfdi })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] getCfdiStatus failed for cfdi ${cfdiId}: ${message}`)

    if (/not found/i.test(message)) {
      res.status(404).json({ error: 'CFDI no encontrado' })
      return
    }

    res.status(500).json({ error: 'Error interno al consultar el CFDI' })
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/cfdi/:cfdiId/cancel
 *
 * Cancels an issued CFDI (destructive — voids a fiscal document).
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure') (OWNER/ADMIN).
 * Body is validated by validateRequest(cancelCfdiSchema) before this handler runs.
 */
export async function cancelCfdiController(req: Request, res: Response): Promise<void> {
  const { cfdiId } = req.params
  const { motivo, substituteUuid } = req.body
  const { venueId } = (req as any).authContext ?? {}

  // Sandbox stamps in dev/staging; live key in production.
  const sandbox = env.NODE_ENV !== 'production'

  try {
    const result = await cancelCfdi({
      cfdiId,
      motivo,
      substituteUuid,
      sandbox,
      expectedVenueId: venueId,
    })

    logAction({
      staffId: (req as any).authContext?.userId,
      venueId,
      action: 'CFDI_CANCELLED',
      entity: 'Cfdi',
      entityId: cfdiId,
      data: { motivo, substituteUuid: substituteUuid ?? null, cancelStatus: result.cancelStatus },
    })

    res.status(200).json({
      cancelStatus: result.cancelStatus,
      cancelledAt: result.cancelledAt,
      cfdiId: result.cfdi?.id,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] cancelCfdi failed for cfdi ${cfdiId}: ${message}`)

    if (/not found/i.test(message)) {
      res.status(404).json({ error: 'CFDI no encontrado' })
      return
    }

    // Business-rule violations (not STAMPED, motivo 01 without substitute) → 409 Conflict
    if (/timbrad|stamped|motivo|sustituci|substitut/i.test(message)) {
      res.status(409).json({ error: message })
      return
    }

    res.status(500).json({ error: 'Error interno al cancelar el CFDI' })
  }
}

// ─── Fiscal Config controllers ────────────────────────────────────────────────

/**
 * GET /api/v1/dashboard/venues/:venueId/fiscal/config
 *
 * Returns all FiscalEmisores + MerchantFiscalConfigs for the caller's venue.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:view').
 */
export async function getFiscalConfigController(req: Request, res: Response): Promise<void> {
  const { venueId } = (req as any).authContext ?? {}

  try {
    const config = await getFiscalConfig({ venueId })
    res.status(200).json(config)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] getFiscalConfig failed for venue ${venueId}: ${message}`)
    res.status(500).json({ error: 'Error interno al obtener la configuración fiscal' })
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/fiscal/emisores
 * PUT  /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId
 *
 * Creates or updates a FiscalEmisor for the caller's venue.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure').
 * Body validated by validateRequest(upsertEmisorSchema) before this handler runs.
 */
export async function upsertEmisorController(req: Request, res: Response): Promise<void> {
  const { emisorId } = req.params
  const { rfc, legalName, regimenFiscal, lugarExpedicion, serie, defaultUsoCfdi, globalPeriodicity } = req.body
  // Tenant isolation: always use authContext.venueId — never trust the path :venueId.
  const { venueId } = (req as any).authContext ?? {}

  try {
    const emisor = await upsertEmisor({
      venueId,
      emisorId: emisorId ?? undefined,
      rfc,
      legalName,
      regimenFiscal,
      lugarExpedicion,
      serie,
      defaultUsoCfdi,
      globalPeriodicity,
    })

    logAction({
      staffId: (req as any).authContext?.userId,
      venueId,
      action: 'FISCAL_EMISOR_UPSERTED',
      entity: 'FiscalEmisor',
      entityId: emisor.id,
      data: { rfc, legalName, regimenFiscal, lugarExpedicion, isUpdate: !!emisorId },
    })

    res.status(200).json({ emisor })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] upsertEmisor failed for venue ${venueId}: ${message}`)

    if (/not found/i.test(message)) {
      res.status(404).json({ error: 'Emisor no encontrado' })
      return
    }

    res.status(500).json({ error: 'Error interno al guardar el emisor fiscal' })
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/fiscal/merchant-config
 *
 * Creates or updates the MerchantFiscalConfig for one merchant.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure').
 * Body validated by validateRequest(upsertMerchantConfigSchema) before this handler runs.
 */
export async function upsertMerchantFiscalConfigController(req: Request, res: Response): Promise<void> {
  const { merchantAccountId, ecommerceMerchantId, fiscalEmisorId, facturacionEnabled, autofacturaEnabled, includeInGlobal } = req.body
  // Tenant isolation: always use authContext.venueId — never trust the path :venueId.
  const { venueId } = (req as any).authContext ?? {}

  try {
    const config = await upsertMerchantFiscalConfig({
      venueId,
      merchantAccountId,
      ecommerceMerchantId,
      fiscalEmisorId,
      facturacionEnabled,
      autofacturaEnabled,
      includeInGlobal,
    })

    logAction({
      staffId: (req as any).authContext?.userId,
      venueId,
      action: 'MERCHANT_FISCAL_CONFIG_UPSERTED',
      entity: 'MerchantFiscalConfig',
      entityId: config.id,
      data: {
        merchantAccountId: merchantAccountId ?? null,
        ecommerceMerchantId: ecommerceMerchantId ?? null,
        fiscalEmisorId,
        facturacionEnabled,
        autofacturaEnabled,
        includeInGlobal,
      },
    })

    res.status(200).json({ config })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] upsertMerchantFiscalConfig failed for venue ${venueId}: ${message}`)

    if (/not found/i.test(message)) {
      res.status(404).json({ error: 'Comercio o emisor no encontrado' })
      return
    }

    // XOR violation (service throws "Debe especificar exactamente un merchant…")
    if (/merchant/i.test(message)) {
      res.status(409).json({ error: message })
      return
    }

    res.status(500).json({ error: 'Error interno al guardar la configuración de facturación' })
  }
}
