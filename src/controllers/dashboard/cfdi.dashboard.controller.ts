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
import prisma from '@/utils/prismaClient'
import { issueCfdiForOrder, cancelCfdi, getCfdiStatus, listCfdisForVenue } from '@/services/fiscal/cfdi.service'
import { searchSatCatalog } from '@/services/fiscal/satCatalogLookup.service'
import { issueGlobalForEmisor } from '@/services/fiscal/cfdiGlobal.service'
import { upsertEmisor, upsertMerchantFiscalConfig, getFiscalConfig } from '@/services/fiscal/fiscalConfig.service'
import { provisionEmisor, uploadEmisorCsd } from '@/services/fiscal/fiscalOnboarding.service'
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

    // Merchant gating: facturacionEnabled or autofacturaEnabled is false → 403 (feature disabled, not missing)
    if (/no habilitada/i.test(message)) {
      res.status(403).json({ error: message })
      return
    }

    // Concurrent in-flight reservation — surface as 409 so the client can retry after the first request resolves
    if (/en proceso/i.test(message)) {
      res.status(409).json({ error: message })
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
 * GET /api/v1/dashboard/venues/:venueId/cfdi
 *
 * Returns a paginated list of CFDIs for the caller's venue.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:view').
 * Query params are validated by validateRequest(listCfdisSchema) before this handler runs.
 *
 * This is a READ — no ActivityLog (critical-warnings rule: do not log reads).
 */
export async function listCfdisController(req: Request, res: Response): Promise<void> {
  // Tenant isolation: always from authContext, never from the path :venueId.
  const { venueId } = (req as any).authContext ?? {}
  const { status, flow, isGlobal, receptorRfc, from, to, page, pageSize } = req.query as any

  try {
    // Fetch venue timezone so date range boundaries are correct (critical-warnings rule).
    // This is a lightweight select — only one extra round-trip, shared by all filter paths.
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
    const venueTimezone = venue?.timezone ?? 'America/Mexico_City'

    const result = await listCfdisForVenue({
      venueId,
      status: status as any,
      flow: flow as any,
      isGlobal: isGlobal as boolean | undefined,
      receptorRfc: receptorRfc as string | undefined,
      from: from as string | undefined,
      to: to as string | undefined,
      page: Number(page ?? 1),
      pageSize: Number(pageSize ?? 20),
      venueTimezone,
    })

    res.status(200).json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] listCfdis failed for venue ${venueId}: ${message}`)
    res.status(500).json({ error: 'Error interno al listar los CFDIs' })
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

// ─── Emisor Onboarding controllers ────────────────────────────────────────────

/**
 * POST /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/provision
 *
 * Provisions the FiscalEmisor in facturapi: createOrganization → updateOrgLegal
 * → stores providerOrgId + encrypted live key in our DB.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure').
 * No body required.
 */
export async function provisionEmisorController(req: Request, res: Response): Promise<void> {
  const { emisorId } = req.params
  // Tenant isolation: always use authContext.venueId — never trust the path :venueId.
  const { venueId, userId } = (req as any).authContext ?? {}

  try {
    const emisor = await provisionEmisor({ emisorId, expectedVenueId: venueId })

    // ActivityLog: FISCAL_EMISOR_PROVISIONED — do NOT include any key material.
    logAction({
      staffId: userId,
      venueId,
      action: 'FISCAL_EMISOR_PROVISIONED',
      entity: 'FiscalEmisor',
      entityId: emisor.id,
      data: { providerOrgId: emisor.providerOrgId },
    })

    res.status(200).json({ emisor })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] provisionEmisor failed for emisor ${emisorId}: ${message}`)

    if (/not found/i.test(message)) {
      res.status(404).json({ error: 'Emisor no encontrado' })
      return
    }

    res.status(500).json({ error: 'Error interno al provisionar el emisor fiscal' })
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/csd
 *
 * Uploads the CSD (.cer/.key/password) to facturapi and marks the emisor ACTIVE.
 * The CSD material is forwarded to facturapi and NEVER persisted or logged by us.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure').
 * Body validated by validateRequest(uploadCsdSchema) before this handler runs.
 */
export async function uploadEmisorCsdController(req: Request, res: Response): Promise<void> {
  const { emisorId } = req.params
  const { cerBase64, keyBase64, password } = req.body
  // Tenant isolation: always use authContext.venueId — never trust the path :venueId.
  const { venueId, userId } = (req as any).authContext ?? {}

  try {
    // NOTE: cerBase64, keyBase64, password flow straight to facturapi and are NEVER
    // logged or persisted by us (security requirement from spec §7.2).
    const emisor = await uploadEmisorCsd({
      emisorId,
      cerBase64,
      keyBase64,
      csdPassword: password,
      expectedVenueId: venueId,
    })

    // ActivityLog: FISCAL_CSD_UPLOADED — only non-sensitive fields.
    logAction({
      staffId: userId,
      venueId,
      action: 'FISCAL_CSD_UPLOADED',
      entity: 'FiscalEmisor',
      entityId: emisor.id,
      data: { csdStatus: emisor.csdStatus, csdExpiresAt: emisor.csdExpiresAt ?? null },
    })

    res.status(200).json({ emisor })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] uploadEmisorCsd failed for emisor ${emisorId}: ${message}`)

    if (/not found/i.test(message)) {
      res.status(404).json({ error: 'Emisor no encontrado' })
      return
    }

    // provisión required before CSD upload
    if (/provision/i.test(message)) {
      res.status(409).json({ error: message })
      return
    }

    res.status(500).json({ error: 'Error interno al subir el CSD del emisor fiscal' })
  }
}

// ─── SAT Catalog lookup ───────────────────────────────────────────────────────

/**
 * GET /api/v1/dashboard/venues/:venueId/fiscal/sat-catalog?type=product|unit&q=<texto>
 *
 * Proxies facturapi's SAT catalog search so the dashboard product-key picker can
 * resolve ClaveProdServ (type=product) and ClaveUnidad (type=unit) by text query.
 *
 * Read-only — NO ActivityLog (critical-warnings rule: do not log reads).
 * The catalog is SAT reference data; no per-venue or per-tenant scope needed.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:view') — reuses existing
 * permission, no new permission required (spec §20.3 add-on #2).
 */
export async function searchSatCatalogController(req: Request, res: Response): Promise<void> {
  const { type, q } = req.query as { type: 'product' | 'unit'; q: string }

  try {
    const result = await searchSatCatalog({ type, q })
    res.status(200).json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] searchSatCatalog failed type=${type} q="${q}": ${message}`)

    // Surface facturapi / catalog provider errors as 502 so the client knows it's upstream
    if (/facturapi|catalog/i.test(message)) {
      res.status(502).json({ error: 'No se pudo consultar el catálogo SAT' })
      return
    }

    res.status(500).json({ error: 'Error interno al consultar el catálogo SAT' })
  }
}

// ─── Flow C: Manual global CFDI trigger ──────────────────────────────────────

/**
 * POST /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/global
 *
 * Admin manual trigger for Flow C: issues the most-recent closed-period factura global for the
 * given FiscalEmisor. Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure').
 *
 * Status mapping:
 *   STAMPED           → 201 { cfdi: { id, uuid, serie, folio, globalPeriod, pdfUrl } }
 *   NOTHING_TO_INVOICE → 200 { status, message }
 *   SKIPPED           → 409 (inactive CSD)
 *   VALIDATION_FAILED → 422 { error, reasons }
 *   STAMP_FAILED      → 502 { error, message }
 */
export async function triggerGlobalCfdiController(req: Request, res: Response): Promise<void> {
  const { emisorId } = req.params
  // Tenant isolation: always use authContext.venueId — never trust the path :venueId.
  const { venueId, userId } = (req as any).authContext ?? {}

  // Sandbox in dev/staging; live key in production.
  const sandbox = env.NODE_ENV !== 'production'

  try {
    // Tenant guard: emisor must belong to the caller's venue
    const emisor = await prisma.fiscalEmisor.findFirst({
      where: { id: emisorId, venueId },
      select: { id: true },
    })
    if (!emisor) {
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }

    const result = await issueGlobalForEmisor({ emisorId, now: new Date(), sandbox })

    switch (result.status) {
      case 'NOTHING_TO_INVOICE':
        res.status(200).json({ status: 'NOTHING_TO_INVOICE', message: 'No hay tickets por facturar en el periodo.' })
        return

      case 'SKIPPED':
        res.status(409).json({ error: 'El sello digital (CSD) del emisor no está activo.', reason: result.reason })
        return

      case 'VALIDATION_FAILED':
        res.status(422).json({ error: 'No se pudo generar la factura global', reasons: result.reasons })
        return

      case 'STAMP_FAILED':
        res.status(502).json({ error: 'El PAC rechazó el timbrado de la factura global', message: result.cfdi?.lastError })
        return

      case 'STAMPED': {
        // ActivityLog: CFDI_GLOBAL_ISSUED — audit mutation (critical-warnings rule)
        logAction({
          staffId: userId,
          venueId,
          action: 'CFDI_GLOBAL_ISSUED',
          entity: 'Cfdi',
          entityId: result.cfdi.id,
          data: {
            emisorId,
            period: result.period ? `${result.period.meses}/${result.period.anio}` : null,
            count: result.candidateCount ?? 0,
            uuid: result.cfdi.uuid,
          },
        })

        res.status(201).json({
          cfdi: {
            id: result.cfdi.id,
            uuid: result.cfdi.uuid,
            serie: result.cfdi.serie,
            folio: result.cfdi.folio,
            globalPeriod: result.cfdi.globalPeriod,
            pdfUrl: result.cfdi.pdfUrl,
          },
        })
        return
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] triggerGlobalCfdi failed for emisor ${emisorId}: ${message}`)

    if (/not found/i.test(message)) {
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }

    // Concurrent in-flight reservation — surface as 409 so the client can retry
    if (/en proceso/i.test(message)) {
      res.status(409).json({ error: message })
      return
    }

    res.status(500).json({ error: 'Error interno al generar la factura global' })
  }
}
