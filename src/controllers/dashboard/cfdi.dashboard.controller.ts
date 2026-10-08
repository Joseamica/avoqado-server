import AppError, { BadRequestError, ConflictError } from '../../errors/AppError'
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
import {
  issueCfdiForOrder,
  cancelCfdi,
  getCfdiStatus,
  listCfdisForVenue,
  MOTIVO_CONTRATO_DESCONOCIDO,
  PROCESANDO,
} from '@/services/fiscal/cfdi.service'
import { vistaPreviaContrato, confirmarContratoIvaIncluido, VistaPreviaContrato } from '@/services/fiscal/confirmarContratoDePrecio.service'
import { replaceCfdi } from '@/services/fiscal/cfdiReplacement.service'
import { emitRefundCreditNote, getRefundCreditNoteStatus } from '@/services/fiscal/cfdiCreditNote.service'
import { searchSatCatalog } from '@/services/fiscal/satCatalogLookup.service'
import { SatCatalogUnavailableError } from '@/errors/AppError'
import {
  emitirGlobalComplementaria,
  issueGlobalForEmisor,
  listarExcluidasDeLaGlobal,
  periodosDeLaGlobal,
  vistaPreviaComplementaria,
  type IssueGlobalResult,
} from '@/services/fiscal/cfdiGlobal.service'
import { MOTIVO_ANIO_FUERA } from '@/services/fiscal/globalPeriod'
import { upsertEmisor, upsertMerchantFiscalConfig, getFiscalConfig } from '@/services/fiscal/fiscalConfig.service'
import { provisionEmisor, uploadEmisorCsd, syncEmisorLogo, getEmisorProviderStatus } from '@/services/fiscal/fiscalOnboarding.service'
import { emisorSeguro } from '@/services/fiscal/emisorSeguro'
import { logAction } from '@/services/dashboard/activity-log.service'
import { sendCfdiByEmail } from '@/services/fiscal/cfdiEmail.service'
import { fetchStorageObject } from '@/services/storage.service'
import { resolveRequestVenueId } from '@/middlewares/checkPermission.middleware'

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
  // Tenant isolation: venue resolved via resolveRequestVenueId (URL → x-venue-id → token),
  // consistent with checkPermission. checkPermission already verified the caller holds
  // cfdi:issue in this venue, so using the URL venue here is safe.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

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
      // B3b: si el único camino es confirmar el contrato de precio (venta MIXTA sin contrato), el 422 trae la
      // vista previa para que el diálogo ofrezca confirmarlo sin otra ida y vuelta. Es un enriquecimiento
      // OPCIONAL: si leerla falla, el 422 sale igual que siempre (nunca un 500 por esto). Sólo se AGREGA
      // `priceContract`: `error`, `reasons` y `cfdiId` no cambian de nombre ni de forma.
      let reasons = result.reasons
      let priceContract: VistaPreviaContrato | null = null
      if (reasons?.includes(MOTIVO_CONTRATO_DESCONOCIDO)) {
        try {
          priceContract = await vistaPreviaContrato(venueId, orderId)
        } catch (error) {
          logger.warn('[cfdi] no se pudo leer la vista previa del contrato de precio; el 422 sale sin ella', { venueId, orderId, error })
        }
        // Una venta vieja que no se puede confirmar (separó el impuesto, ajuste del motor de descuentos viejo,
        // cotización, cancelada…) no debe decir «confírmalo»: su motivo toma ese lugar, los demás quedan igual.
        if (priceContract && !priceContract.confirmable && priceContract.motivo) {
          const motivo = priceContract.motivo
          reasons = reasons.map(m => (m === MOTIVO_CONTRATO_DESCONOCIDO ? motivo : m))
        }
      }
      res.status(422).json({
        error: 'No se pudo facturar',
        reasons,
        cfdiId: result.cfdi?.id,
        ...(priceContract ? { priceContract } : {}),
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

    // 🔴 La venta YA tenía esta factura vigente: no se timbró nada. Antes esto salía como 201 y la pantalla
    // decía «éxito» (Testarudo 24-sep: a otra razón social y tras cancelar). 409 para que ningún cliente
    // —tampoco el dashboard ya desplegado— pueda leerlo como una factura nueva.
    if (result.alreadyIssued) {
      const folio = [result.cfdi?.serie, result.cfdi?.folio].filter(Boolean).join('-') || result.cfdi?.uuid || 'anterior'
      res.status(409).json({
        code: 'CFDI_ALREADY_ISSUED',
        error: `Esta venta ya tiene la factura ${folio} vigente. Para facturarla a otra razón social, primero cancela la ${folio} en Facturación; si sólo el importe está mal, usa «Corregir importe».`,
        cfdi: {
          id: result.cfdi.id,
          uuid: result.cfdi.uuid,
          serie: result.cfdi.serie,
          folio: result.cfdi.folio,
          status: result.cfdi.status,
          receptorNombre: result.cfdi.receptorNombre,
        },
      })
      return
    }

    // STAMPED — audit + 201 with minimal public fields
    logAction({
      staffId: authContext.userId,
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
    if (err instanceof ConflictError) {
      res.status(409).json({ error: err.message })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] issue failed for order ${orderId}: ${message}`

    // La venta no es de este negocio (aislamiento) o no existe: no es un problema de configuración fiscal,
    // y el texto no debe mandar a revisar emisores.
    if (/^Order \S+ not found$/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ code: 'ORDER_NOT_FOUND', error: 'Esta venta no existe o no es de este negocio.' })
      return
    }

    if (/not found|no fiscal emisor/i.test(message)) {
      // Testarudo 24-sep: el texto viejo («sin emisor fiscal configurado») mandaba a revisar una configuración
      // que estaba bien. Éste dice qué revisar y qué caso todavía no se puede facturar.
      logger.warn(aviso)
      res.status(404).json({
        code: 'CFDI_NO_EMISOR',
        error:
          'No se pudo determinar quién factura esta venta. Revisa en Facturación › Configuración que el comercio con el que se cobró tenga la facturación encendida. Una venta cobrada sin terminal (efectivo o transferencia) sólo se puede facturar si el negocio tiene un solo RFC; con más de un RFC todavía no.',
      })
      return
    }

    // Merchant gating: facturacionEnabled or autofacturaEnabled is false → 403 (feature disabled, not missing)
    if (/no habilitada/i.test(message)) {
      logger.warn(aviso)
      res.status(403).json({ error: message })
      return
    }

    // La cancelación de la factura anterior sigue en trámite ante el SAT: todavía no se puede refacturar.
    if (/en trámite/i.test(message)) {
      logger.warn(aviso)
      res.status(409).json({ code: 'CFDI_CANCEL_PENDING', error: message })
      return
    }

    // Concurrent in-flight reservation — surface as 409 so the client can retry after the first request resolves
    if (/en proceso/i.test(message)) {
      logger.warn(aviso)
      res.status(409).json({ error: message })
      return
    }

    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al facturar' })
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/orders/:orderId/price-contract/confirm
 *
 * B3b: confirmar que una venta VIEJA (contrato desconocido) se cobró con el IVA incluido, desde el diálogo de
 * «Facturar». Llama al MISMO servicio que el MCP `confirm_order_price_contract`, ligado a la versión y la huella
 * que la persona vio en la vista previa del 422. Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure').
 * El cuerpo ya lo validó validateRequest(confirmPriceContractSchema). La bitácora (ORDER_PRICE_CONTRACT_CONFIRMED) la
 * escribe el servicio dentro de su transacción: aquí no se agrega otro registro.
 */
export async function confirmOrderPriceContractController(req: Request, res: Response): Promise<void> {
  const { orderId } = req.params
  const { version, huella } = req.body
  // Mismo negocio que validó checkPermission (URL → x-venue-id → token).
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  try {
    const result = await confirmarContratoIvaIncluido({
      venueId,
      orderId,
      versionVista: version,
      huellaVista: huella,
      staffId: authContext.userId ?? null,
      motivo: 'Confirmado desde el dashboard al facturar',
    })
    if (result.ok) {
      res.status(200).json({ ok: true })
      return
    }
    res.status(result.code === 'NO_ENCONTRADA' ? 404 : 409).json({ error: result.message, code: result.code })
  } catch (err: unknown) {
    logger.error(`[cfdi.controller] confirmar el contrato de precio falló para la venta ${orderId}`, {
      venueId,
      orderId,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).json({ error: 'No se pudo confirmar el contrato de precio de esta venta. Intenta de nuevo.' })
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
  // Venue resolved via resolveRequestVenueId (URL → x-venue-id → token), consistent with checkPermission.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  try {
    const cfdi = await getCfdiStatus({ cfdiId, expectedVenueId: venueId })

    res.status(200).json({ cfdi })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] getCfdiStatus failed for cfdi ${cfdiId}: ${message}`

    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'CFDI no encontrado' })
      return
    }

    logger.error(aviso)
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
  // Venue resolved via resolveRequestVenueId (URL → x-venue-id → token), consistent with checkPermission.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }
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
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] listCfdis failed for venue ${venueId}: ${message}`
    logger.error(aviso)
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
/**
 * POST /api/v1/dashboard/venues/:venueId/cfdi/:cfdiId/email
 *
 * Reenvía por correo una factura timbrada (H24): sin `email`, al registrado del receptor; con uno, a ése.
 * La bitácora (CFDI_EMAIL_SENT/FAILED) la escribe el servicio.
 */
export async function sendCfdiEmailController(req: Request, res: Response): Promise<void> {
  const { cfdiId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  try {
    const result = await sendCfdiByEmail({
      cfdiId,
      venueId,
      sandbox: env.NODE_ENV !== 'production',
      origin: 'REENVIO',
      staffId: authContext.userId ?? null,
      email: req.body?.email,
    })
    res.status(200).json(result)
  } catch (err: unknown) {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    logger.error(`[cfdi.controller] sendCfdiEmail failed for cfdi ${cfdiId}`, { error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'No se pudo enviar la factura por correo' })
  }
}

export async function cancelCfdiController(req: Request, res: Response): Promise<void> {
  const { cfdiId } = req.params
  const { motivo, substituteUuid } = req.body
  // Venue resolved via resolveRequestVenueId (URL → x-venue-id → token), consistent with checkPermission.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

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

    if (result.applied !== false)
      await logAction({
        staffId: authContext.userId,
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
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] cancelCfdi failed for cfdi ${cfdiId}: ${message}`

    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'CFDI no encontrado' })
      return
    }

    // Business-rule violations (not STAMPED, motivo 01 without substitute) → 409 Conflict
    if (/timbrad|stamped|motivo|sustituci|substitut/i.test(message)) {
      logger.warn(aviso)
      res.status(409).json({ error: message })
      return
    }

    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al cancelar el CFDI' })
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/cfdi/:cfdiId/replace
 *
 * Sustituye una factura equivocada: timbra la CORREGIDA relacionada a la original
 * (TipoRelacion 04) y pide cancelar la original con motivo 01 apuntando a la nueva.
 *
 * 🔴 La respuesta NUNCA afirma que la original quedó cancelada: el PAC puede dejarla
 * `pending` (esperando al receptor) o `rejected`, y en ambos casos SIGUE VIGENTE ante el SAT.
 * `cancelPendiente` es lo que la pantalla tiene que mostrar.
 *
 * Mismo candado que cancelar (`cfdi:configure`, OWNER/ADMIN): emite un documento fiscal nuevo
 * y pide cancelar uno existente.
 */
export async function replaceCfdiController(req: Request, res: Response): Promise<void> {
  const { cfdiId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  const sandbox = env.NODE_ENV !== 'production'

  try {
    const result = await replaceCfdi({ cfdiId, sandbox, expectedVenueId: venueId })

    if (result.status === 'VALIDATION_FAILED') {
      logAction({
        staffId: authContext.userId,
        venueId,
        action: 'CFDI_REPLACE_REJECTED',
        entity: 'Cfdi',
        entityId: cfdiId,
        data: { reasons: result.reasons ?? [] },
      })
      res.status(422).json({ status: result.status, reasons: result.reasons ?? [] })
      return
    }

    logAction({
      staffId: authContext.userId,
      venueId,
      action: 'CFDI_REPLACED',
      entity: 'Cfdi',
      entityId: cfdiId,
      data: {
        status: result.status,
        sustitutaId: result.sustituta?.id ?? null,
        sustitutaUuid: result.sustituta?.uuid ?? null,
        cancelStatus: result.cancelStatus,
        cancelPendiente: result.cancelPendiente,
      },
    })

    res.status(result.status === 'REPLACED' ? 200 : 502).json({
      status: result.status,
      sustituta: result.sustituta
        ? {
            id: result.sustituta.id,
            uuid: result.sustituta.uuid ?? null,
            serie: result.sustituta.serie ?? null,
            folio: result.sustituta.folio ?? null,
            totalCents: result.sustituta.totalCents ?? null,
            xmlUrl: result.sustituta.xmlUrl ?? null,
            pdfUrl: result.sustituta.pdfUrl ?? null,
          }
        : null,
      original: { id: cfdiId, uuid: result.original?.uuid ?? null },
      cancelStatus: result.cancelStatus,
      cancelPendiente: result.cancelPendiente,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] replaceCfdi failed for cfdi ${cfdiId}: ${message}`

    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'CFDI no encontrado' })
      return
    }
    // Reglas de negocio y carreras → 409 (mismo criterio que cancelar)
    if (err instanceof ConflictError || /en proceso|timbrada|global|emisor|folio fiscal/i.test(message)) {
      logger.warn(aviso)
      res.status(409).json({ error: message })
      return
    }
    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al sustituir el CFDI' })
  }
}

// ─── Nota de crédito (CFDI de EGRESO) por un reembolso ────────────────────────

/**
 * POST /api/v1/dashboard/venues/:venueId/refunds/:refundId/credit-note
 *
 * Emite MANUALMENTE un CFDI de EGRESO (nota de crédito) que ampara un reembolso ya hecho.
 * La venta original NO se toca y el CFDI de ingreso NO se cancela — el egreso va RELACIONADO
 * (TipoRelacion 01, uso G02). Nunca automático: timbrar es irreversible.
 *
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:issue').
 * El ActivityLog lo escribe el SERVICIO (así el MCP y cualquier otro llamador auditan igual).
 */
export async function emitRefundCreditNoteController(req: Request, res: Response): Promise<void> {
  const { refundId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  // Sandbox stamps in dev/staging (free, no SAT effect); live key in production.
  const sandbox = env.NODE_ENV !== 'production'

  try {
    const result = await emitRefundCreditNote({
      venueId,
      refundPaymentId: refundId,
      sandbox,
      requestedByStaffId: authContext.userId ?? null,
    })

    if (result.status === 'VALIDATION_FAILED') {
      res.status(422).json({ error: 'No se pudo emitir la nota de crédito', reasons: result.reasons, cfdiId: result.cfdi?.id })
      return
    }
    if (result.status === 'STAMP_FAILED') {
      res.status(502).json({ error: 'El PAC rechazó el timbrado', message: result.cfdi?.lastError, cfdiId: result.cfdi?.id })
      return
    }

    res.status(201).json({
      creditNote: {
        id: result.cfdi.id,
        uuid: result.cfdi.uuid,
        serie: result.cfdi.serie,
        folio: result.cfdi.folio,
        status: result.cfdi.status,
        totalCents: result.cfdi.totalCents,
        xmlUrl: result.cfdi.xmlUrl,
        pdfUrl: result.cfdi.pdfUrl,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] credit note failed for refund ${refundId}: ${message}`

    if (/no encontrado/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: message })
      return
    }
    if (err instanceof ConflictError || /en proceso/i.test(message)) {
      logger.warn(aviso)
      res.status(409).json({ error: message })
      return
    }
    // Reglas de negocio fiscales: sin factura original, cancelada, sólo propina, importe excedido,
    // pago que no es reembolso, PAC sin soporte → 409 con el texto EXACTO para que la UI lo pinte.
    if (/no es un reembolso|no está completado|no tiene una factura|cancelada|propina|excede|no soporta/i.test(message)) {
      logger.warn(aviso)
      res.status(409).json({ error: message })
      return
    }

    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al emitir la nota de crédito' })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/refunds/:refundId/credit-note
 *
 * Devuelve `{ creditNote, eligibility, preview }`: la nota de crédito ya emitida (o `null`),
 * si se puede emitir y —cuando NO— el porqué en español, listo para pintarse.
 * Apagado se VE y se EXPLICA: nunca un booleano pelón.
 * READ — sin ActivityLog (regla critical-warnings: no se auditan lecturas).
 */
export async function getRefundCreditNoteController(req: Request, res: Response): Promise<void> {
  const { refundId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }
  try {
    const status = await getRefundCreditNoteStatus(venueId, refundId)
    if (!status) {
      res.status(404).json({ error: 'Reembolso no encontrado' })
      return
    }
    res.status(200).json(status)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] getRefundCreditNote failed for refund ${refundId}: ${message}`
    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al consultar la nota de crédito' })
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
  // Venue resolved via resolveRequestVenueId (URL → x-venue-id → token), consistent with checkPermission.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  try {
    const config = await getFiscalConfig({ venueId })
    res.status(200).json(config)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] getFiscalConfig failed for venue ${venueId}: ${message}`
    logger.error(aviso)
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
  const {
    rfc,
    legalName,
    regimenFiscal,
    lugarExpedicion,
    serie,
    defaultUsoCfdi,
    globalPeriodicity,
    invoiceCashSales,
    includeOffTerminalSalesInGlobal,
    includeCashInAccounting,
    isnRate,
  } = req.body
  // Venue resolved via resolveRequestVenueId (URL → x-venue-id → token), consistent with checkPermission.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

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
      invoiceCashSales,
      includeOffTerminalSalesInGlobal,
      includeCashInAccounting,
      isnRate,
    })

    logAction({
      staffId: authContext.userId,
      venueId,
      action: 'FISCAL_EMISOR_UPSERTED',
      entity: 'FiscalEmisor',
      entityId: emisor.id,
      data: {
        rfc,
        legalName,
        regimenFiscal,
        lugarExpedicion,
        invoiceCashSales,
        includeOffTerminalSalesInGlobal,
        includeCashInAccounting,
        isnRate,
        isUpdate: !!emisorId,
      },
    })

    // I1 (ola final C1): nunca la fila entera — sin la llave del PAC ni el secreto del webhook.
    res.status(200).json({ emisor: emisorSeguro(emisor) })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] upsertEmisor failed for venue ${venueId}: ${message}`

    // C1 · Tarea 9: una regla de negocio del servicio (p. ej. la bimestral sólo con el régimen 621) llega con su código y su texto.
    if (err instanceof AppError && err.statusCode < 500) {
      logger.warn(aviso)
      res.status(err.statusCode).json({ error: err.message })
      return
    }

    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Emisor no encontrado' })
      return
    }

    logger.error(aviso)
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
  const {
    merchantAccountId,
    ecommerceMerchantId,
    fiscalEmisorId,
    facturacionEnabled,
    autofacturaEnabled,
    includeInGlobal,
    includeInAccounting,
  } = req.body
  // Venue resolved via resolveRequestVenueId (URL → x-venue-id → token), consistent with checkPermission.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  try {
    const config = await upsertMerchantFiscalConfig({
      venueId,
      merchantAccountId,
      ecommerceMerchantId,
      fiscalEmisorId,
      facturacionEnabled,
      autofacturaEnabled,
      includeInGlobal,
      includeInAccounting,
    })

    logAction({
      staffId: authContext.userId,
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
        includeInAccounting,
      },
    })

    res.status(200).json({ config })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] upsertMerchantFiscalConfig failed for venue ${venueId}: ${message}`

    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Comercio o emisor no encontrado' })
      return
    }

    // XOR violation (service throws "Debe especificar exactamente un merchant…")
    if (/merchant/i.test(message)) {
      logger.warn(aviso)
      res.status(409).json({ error: message })
      return
    }

    logger.error(aviso)
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
  // Venue resolved via resolveRequestVenueId (URL → x-venue-id → token), consistent with checkPermission.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }
  const { userId } = authContext

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

    // I1 (ola final C1): nunca la fila entera — sin la llave del PAC ni el secreto del webhook.
    res.status(200).json({ emisor: emisorSeguro(emisor) })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] provisionEmisor failed for emisor ${emisorId}: ${message}`

    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Emisor no encontrado' })
      return
    }

    logger.error(aviso)
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
  // Venue resolved via resolveRequestVenueId (URL → x-venue-id → token), consistent with checkPermission.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }
  const { userId } = authContext

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

    // I1 (ola final C1): nunca la fila entera — sin la llave del PAC ni el secreto del webhook.
    res.status(200).json({ emisor: emisorSeguro(emisor) })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] uploadEmisorCsd failed for emisor ${emisorId}: ${message}`

    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Emisor no encontrado' })
      return
    }

    // provisión required before CSD upload
    if (/provision/i.test(message)) {
      logger.warn(aviso)
      res.status(409).json({ error: message })
      return
    }

    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al subir el CSD del emisor fiscal' })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/provider-status
 *
 * Onboarding status of the emisor's org at the PAC: provisioned?, production
 * ready?, and which steps are still pending ('manifiesto' is the one the
 * dashboard acts on). Read-only — NO ActivityLog.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:view').
 */
export async function getEmisorProviderStatusController(req: Request, res: Response): Promise<void> {
  const { emisorId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  try {
    const status = await getEmisorProviderStatus({ emisorId, expectedVenueId: venueId })
    res.status(200).json({ status })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] getEmisorProviderStatus failed for emisor ${emisorId}: ${message}`

    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Emisor no encontrado' })
      return
    }

    logger.error(aviso)
    res.status(502).json({ error: 'No se pudo consultar el estado del emisor con el proveedor fiscal' })
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
  const { venueId } = req.params as { venueId: string }
  const { type, q = '' } = req.query as { type: 'product' | 'unit'; q?: string }

  try {
    // `q` vacía = el picker recién abierto, no una búsqueda por cadena vacía: se manda
    // `undefined` para que el servicio pida la primera página del catálogo.
    const result = await searchSatCatalog({ type, q: q || undefined, venueId })
    res.status(200).json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] searchSatCatalog failed venue=${venueId} type=${type} q="${q}": ${message}`

    // La clasificación la hace el SERVICIO, que es quien sabe a quién llamó y con qué llave.
    // El status viene del error (400 falta configuración · 502 falló el proveedor); el texto
    // que ve el usuario lo pone aquí, para no filtrarle el mensaje crudo de Facturapi.
    if (err instanceof SatCatalogUnavailableError) {
      const mensaje =
        err.reason === 'NO_KEY'
          ? err.message // ya está escrito para el usuario y dice qué configurar
          : 'No se pudo consultar el catálogo del SAT. Vuelve a intentarlo en unos minutos.'
      if (err.statusCode >= 500) logger.error(aviso)
      else logger.warn(aviso)
      res.status(err.statusCode).json({ error: mensaje, code: err.code })
      return
    }

    // Red heredada: sólo puede SUBIR un 500 a 502, nunca al revés. Clasificar por el texto del
    // error es justo lo que produjo el incidente del 2026-09-07 («La API key proporcionada no es
    // válida» no casa /facturapi|catalog/i y salía como 500) — lo nuevo va por el error tipado.
    if (/facturapi|catalog/i.test(message)) {
      logger.error(aviso)
      res.status(502).json({ error: 'No se pudo consultar el catálogo SAT' })
      return
    }

    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al consultar el catálogo SAT' })
  }
}

// ─── Flow C: Manual global CFDI trigger ──────────────────────────────────────

/**
 * POST /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/global
 *
 * Admin manual trigger for Flow C: issues the most-recent closed-period factura global for the
 * given FiscalEmisor. Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure').
 * C1 (Tarea 8, C1-P16 = B): body `{ desde? }` = the ISO start of one of the RECENT closed periods the job reviews; an older period
 * (or a date that is not a period start) → 400 «pídelo a soporte».
 *
 * Status mapping (every body also carries `excluidasPorIvaMixto` and, C1 · T10, `excluidas` by motive):
 *   STAMPED (emitted now)   → 201 { excluidasPorIvaMixto, excluidas, cfdi: { id, uuid, serie, folio, globalPeriod, pdfUrl } } + CFDI_GLOBAL_ISSUED
 *   STAMPED (already was)   → 200 { status: 'YA_TIMBRADA', yaTimbrada: true, message, excluidasPorIvaMixto, excluidas, cfdi } (T11 r1 m4; no audit)
 *   NOTHING_TO_INVOICE      → 200 { status, message, excluidasPorIvaMixto, excluidas }
 *   SKIPPED (inactive CSD)  → 409 { error, reason }
 *   SKIPPED (year, C1-33)   → 400 { error: MOTIVO_ANIO_FUERA }
 *   VALIDATION_FAILED       → 422 { error, reasons, excluidasPorIvaMixto, excluidas } (also the C1 guards: bimestral/621, period covered by
 *                             another pending global of another periodicity — MOTIVO_PERIODO_CUBIERTO)
 *   STAMP_FAILED            → 502 { error, message, excluidasPorIvaMixto, excluidas }
 *   `desde` not a recent period start → 400 { error: MOTIVO_PERIODO_VIEJO }; emisor of another venue → 404; in progress / other conflict → 409
 */
export async function triggerGlobalCfdiController(req: Request, res: Response): Promise<void> {
  const { emisorId } = req.params
  // Venue resolved via resolveRequestVenueId (URL → x-venue-id → token), consistent with checkPermission.
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }
  const { userId } = authContext

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

    // C1 (Tarea 8): `desde` (opcional, ya validado por triggerGlobalCfdiSchema) elige un periodo reciente; sin él, el último cerrado.
    const desde: string | undefined = req.body?.desde
    const result = await issueGlobalForEmisor({ emisorId, now: new Date(), sandbox, ...(desde !== undefined ? { desde } : {}) })
    // C1 (Tarea 10): cada respuesta que lleva `excluidasPorIvaMixto` (se conserva) lleva además `excluidas` por motivo (nuevo; v1 ⇒ `{}`).
    const excluidas = result.excluidas ?? {}

    switch (result.status) {
      case 'NOTHING_TO_INVOICE':
        res.status(200).json({
          status: 'NOTHING_TO_INVOICE',
          message: 'No hay tickets por facturar en el periodo.',
          excluidasPorIvaMixto: result.excluidasPorIvaMixto,
          excluidas,
        })
        return

      case 'SKIPPED':
        // C1 (Tarea 11): un periodo cuyo año ya no admite el SAT (C1-33) no es un CSD inactivo: 400 con su motivo («pídela a soporte»).
        if (result.reason === MOTIVO_ANIO_FUERA) {
          res.status(400).json({ error: result.reason })
          return
        }
        res.status(409).json({ error: 'El sello digital (CSD) del emisor no está activo.', reason: result.reason })
        return

      case 'VALIDATION_FAILED':
        res.status(422).json({
          error: 'No se pudo generar la factura global',
          reasons: result.reasons,
          excluidasPorIvaMixto: result.excluidasPorIvaMixto,
          excluidas,
        })
        return

      case 'STAMP_FAILED':
        res.status(502).json({
          error: 'El PAC rechazó el timbrado de la factura global',
          message: result.cfdi?.lastError,
          excluidasPorIvaMixto: result.excluidasPorIvaMixto,
          excluidas,
        })
        return

      case 'STAMPED': {
        // Ronda 1 de la T11 (m4): ya estaba timbrada; no se emitió nada ahora ⇒ 200 sin auditoría.
        if (result.yaTimbrada) {
          res.status(200).json({
            status: 'YA_TIMBRADA',
            yaTimbrada: true,
            message: 'La factura global de este periodo ya estaba timbrada; no se emitió otra.',
            excluidasPorIvaMixto: result.excluidasPorIvaMixto,
            excluidas,
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
            // C1 (Tarea 10): lo que quedó fuera (por motivo), los centavos que puso la regla del PAC y, si aplica, su principal (Tarea 11).
            excluidas,
            ajustes: result.cfdi.entrada?.ajustes ?? [],
            complementariaDe: result.cfdi.entrada?.complementariaDe ?? null,
          },
        })

        res.status(201).json({
          excluidasPorIvaMixto: result.excluidasPorIvaMixto,
          excluidas,
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
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] triggerGlobalCfdi failed for emisor ${emisorId}: ${message}`

    // C1 (Tarea 8): un periodo fuera de la ventana reciente (MOTIVO_PERIODO_VIEJO, «pídelo a soporte»).
    if (err instanceof BadRequestError) {
      logger.warn(aviso)
      res.status(400).json({ error: message })
      return
    }

    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }

    // Concurrent in-flight reservation — surface as 409 so the client can retry
    if (err instanceof ConflictError || /en proceso/i.test(message)) {
      logger.warn(aviso)
      res.status(409).json({ error: message })
      return
    }

    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al generar la factura global' })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/global/periodos
 *
 * C1 (Tarea 8, C1-P16 = B): los periodos cerrados RECIENTES del emisor (los que revisa el job) con el estado de su global principal.
 * Sin paginación hacia atrás: un periodo más viejo se pide a soporte. Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:view').
 */
export async function listGlobalPeriodosController(req: Request, res: Response): Promise<void> {
  const { emisorId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }
  try {
    // Tenant guard: el emisor tiene que ser del negocio de quien pregunta.
    const emisor = await prisma.fiscalEmisor.findFirst({ where: { id: emisorId, venueId }, select: { id: true } })
    if (!emisor) {
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }
    res.status(200).json(await periodosDeLaGlobal({ venueId, emisorId, now: new Date() }))
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (/not found/i.test(message)) {
      logger.warn(`[cfdi.controller] listGlobalPeriodos: ${message}`)
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }
    logger.error(`[cfdi.controller] listGlobalPeriodos failed for emisor ${emisorId}: ${message}`)
    res.status(500).json({ error: 'Error interno al consultar los periodos de la factura global' })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/global/excluidas?principalId=&desde=&cursor=&limite=
 *
 * C1 (Tarea 12): las ventas de un periodo que no entraron a la global, y por qué. Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:view').
 */
export async function listGlobalExcluidasController(req: Request, res: Response): Promise<void> {
  const { emisorId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }
  // Ya validada por `listGlobalExcluidasSchema` (`limite` llega como número).
  const { principalId, desde, cursor, limite } = req.query as { principalId?: string; desde?: string; cursor?: string; limite?: number }
  try {
    // Tenant guard: el emisor tiene que ser del negocio de quien pregunta.
    const emisor = await prisma.fiscalEmisor.findFirst({ where: { id: emisorId, venueId }, select: { id: true } })
    if (!emisor) {
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }
    const listado = await listarExcluidasDeLaGlobal({
      venueId,
      emisorId,
      now: new Date(),
      ...(principalId ? { principalId } : {}),
      ...(desde ? { desde } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limite !== undefined ? { limite } : {}),
    })
    res.status(200).json(listado)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const aviso = `[cfdi.controller] listGlobalExcluidas failed for emisor ${emisorId}: ${message}`
    // Un periodo viejo, una global que no es principal de este emisor, una heredada timbrada: 400 con su texto (dicen qué hacer).
    if (err instanceof BadRequestError) {
      logger.warn(aviso)
      res.status(400).json({ error: message })
      return
    }
    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }
    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al consultar las ventas que no entraron a la factura global' })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/global/:principalId/complementaria
 *
 * C1 (Tarea 11): la vista previa de la complementaria de una global principal. Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:view').
 */
export async function previewGlobalComplementariaController(req: Request, res: Response): Promise<void> {
  const { emisorId, principalId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }
  try {
    // Tenant guard: el emisor tiene que ser del negocio de quien pregunta.
    const emisor = await prisma.fiscalEmisor.findFirst({ where: { id: emisorId, venueId }, select: { id: true } })
    if (!emisor) {
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }
    res.status(200).json(await vistaPreviaComplementaria({ venueId, emisorId, principalId, now: new Date() }))
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const aviso = `[cfdi.controller] previewGlobalComplementaria failed for emisor ${emisorId}, principal ${principalId}: ${message}`
    // No es una principal de este emisor, todavía no está timbrada, o su periodo no se puede demostrar: 400 con su texto.
    if (err instanceof BadRequestError) {
      logger.warn(aviso)
      res.status(400).json({ error: message })
      return
    }
    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }
    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al consultar la complementaria de la factura global' })
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/global/:principalId/complementaria
 *
 * C1 (Tarea 11): emite (o retoma) la complementaria de una global principal. Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure').
 *
 * Status mapping (every body also carries `excluidasPorIvaMixto`, `excluidas` and `complementariaDe`):
 *   STAMPED (emitted now)   → 201 { excluidasPorIvaMixto, excluidas, complementariaDe, cfdi } + CFDI_GLOBAL_ISSUED (data.complementariaDe)
 *   STAMPED (already was)   → 200 { status: 'YA_TIMBRADA', yaTimbrada: true, message, …, cfdi } (no audit)
 *   NOTHING_TO_INVOICE      → 200 { status, message, excluidasPorIvaMixto, excluidas, complementariaDe }
 *   SKIPPED (inactive CSD)  → 409 { error, reason }; SKIPPED (year) → 400 { error: MOTIVO_ANIO_FUERA }
 *   VALIDATION_FAILED       → 422 { error, reasons, … } (also the C1 guards, e.g. MOTIVO_PERIODO_CUBIERTO)
 *   STAMP_FAILED            → 502 { error, message, … }
 *   400 { error }: not a principal of this emisor, MOTIVO_SIN_PRINCIPAL, principal in cancellation, inherited principal, period not
 *   demonstrable, the cap of 20 complementarias; 404 emisor; 409 «Se está emitiendo…» (in progress) or the conflict's own text.
 */
export async function emitGlobalComplementariaController(req: Request, res: Response): Promise<void> {
  const { emisorId, principalId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }
  const { userId } = authContext
  // Sandbox in dev/staging; live key in production.
  const sandbox = env.NODE_ENV !== 'production'
  try {
    const emisor = await prisma.fiscalEmisor.findFirst({ where: { id: emisorId, venueId }, select: { id: true } })
    if (!emisor) {
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }
    const result: IssueGlobalResult = await emitirGlobalComplementaria({ venueId, emisorId, principalId, now: new Date(), sandbox })
    const excluidas = result.excluidas ?? {}
    const complementariaDe = result.complementariaDe ?? principalId
    switch (result.status) {
      case 'NOTHING_TO_INVOICE':
        res.status(200).json({
          status: 'NOTHING_TO_INVOICE',
          message: 'No hay ventas de este periodo por facturar en una global complementaria.',
          excluidasPorIvaMixto: result.excluidasPorIvaMixto,
          excluidas,
          complementariaDe,
        })
        return
      case 'SKIPPED':
        // El año del periodo ya no lo admite el SAT (C1-33): 400 con su motivo. Un CSD inactivo, como el disparo de la principal.
        if (result.reason === 'CSD inactivo') {
          res.status(409).json({ error: 'El sello digital (CSD) del emisor no está activo.', reason: result.reason })
          return
        }
        res.status(400).json({ error: result.reason })
        return
      case 'VALIDATION_FAILED':
        res.status(422).json({
          error: 'No se pudo generar la factura global complementaria',
          reasons: result.reasons,
          excluidasPorIvaMixto: result.excluidasPorIvaMixto,
          excluidas,
          complementariaDe,
        })
        return
      case 'STAMP_FAILED':
        res.status(502).json({
          error: 'El PAC rechazó el timbrado de la factura global complementaria',
          message: result.cfdi?.lastError,
          excluidasPorIvaMixto: result.excluidasPorIvaMixto,
          excluidas,
          complementariaDe,
        })
        return
      case 'STAMPED': {
        // Ronda 1 (m4): ya estaba timbrada (otro clic llegó antes); no se emitió nada ahora ⇒ 200 sin auditoría.
        if (result.yaTimbrada) {
          res.status(200).json({
            status: 'YA_TIMBRADA',
            yaTimbrada: true,
            message: 'Esta factura global complementaria ya estaba timbrada; no se emitió otra.',
            excluidasPorIvaMixto: result.excluidasPorIvaMixto,
            excluidas,
            complementariaDe,
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
        // ActivityLog: CFDI_GLOBAL_ISSUED — audit mutation (critical-warnings rule), con la principal que complementa.
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
            excluidas,
            ajustes: result.cfdi.entrada?.ajustes ?? [],
            complementariaDe: result.cfdi.entrada?.complementariaDe ?? complementariaDe,
          },
        })
        res.status(201).json({
          excluidasPorIvaMixto: result.excluidasPorIvaMixto,
          excluidas,
          complementariaDe,
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
      default:
        logger.error(`[cfdi.controller] emitGlobalComplementaria: estado inesperado ${result.status}`)
        res.status(500).json({ error: 'Error interno al emitir la factura global complementaria' })
        return
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const aviso = `[cfdi.controller] emitGlobalComplementaria failed for emisor ${emisorId}, principal ${principalId}: ${message}`
    // No es una principal timbrada/cancelada de este emisor, periodo sin demostrar o el tope de 20: 400 con su texto.
    if (err instanceof BadRequestError) {
      logger.warn(aviso)
      res.status(400).json({ error: message })
      return
    }
    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Emisor fiscal no encontrado' })
      return
    }
    // M9 (revisión de la T13): sólo «en proceso» (el texto EXACTO del motor) es «se está emitiendo»; cualquier otro conflicto («revisión de
    // soporte», «cancelada en el PAC») dice el suyo.
    if (err instanceof ConflictError) {
      logger.warn(aviso)
      res.status(409).json({ error: message === PROCESANDO ? 'Se está emitiendo; intenta en un minuto' : message })
      return
    }
    logger.error(aviso)
    res.status(500).json({ error: 'Error interno al emitir la factura global complementaria' })
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/logo
 *
 * Sube el logo del venue a la organización del PAC (es lo que imprime en el PDF de cada factura).
 * Idempotente. Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:configure').
 */
export async function syncEmisorLogoController(req: Request, res: Response): Promise<void> {
  const { emisorId } = req.params
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  try {
    const result = await syncEmisorLogo({ emisorId, expectedVenueId: venueId })
    if (result.synced) {
      logAction({ staffId: authContext.userId, venueId, action: 'FISCAL_LOGO_SYNCED', entity: 'FiscalEmisor', entityId: emisorId })
    }
    res.status(200).json(result)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] syncEmisorLogo failed for emisor ${emisorId}: ${message}`
    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'Emisor no encontrado' })
      return
    }
    logger.error(aviso)
    res.status(502).json({ error: 'No se pudo subir el logo al PAC', message })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/cfdi/:cfdiId/file?type=pdf|xml
 *
 * Entrega el PDF/XML como ADJUNTO (`Content-Disposition: attachment; filename="A-14.pdf"`), que es lo
 * que hace que el navegador lo guarde en Descargas en vez de abrirlo en una pestaña. El archivo vive
 * en Storage; el servidor lo baja y lo reenvía para poder poner el nombre y el encabezado, y para que
 * la liga que usa el dashboard sea la del API (con sesión) y no la pública permanente de Storage.
 * Gated by checkFeatureAccess('CFDI') + checkPermission('cfdi:view').
 */
export async function downloadCfdiFileController(
  req: Request,
  res: Response,
  fetchBytes: (url: string) => Promise<Buffer> = defaultFetchBytes,
): Promise<void> {
  const { cfdiId } = req.params
  const type = String((req.query as any)?.type ?? '')
  if (type !== 'pdf' && type !== 'xml') {
    res.status(400).json({ error: 'type debe ser pdf o xml' })
    return
  }
  const authContext = (req as any).authContext ?? {}
  const venueId = resolveRequestVenueId(req, authContext)
  if (!venueId) {
    res.status(400).json({ error: 'Venue ID requerido' })
    return
  }

  try {
    const cfdi = await getCfdiStatus({ cfdiId, expectedVenueId: venueId })
    const url: string | null = type === 'pdf' ? cfdi.pdfUrl : cfdi.xmlUrl
    if (!url) {
      res.status(404).json({ error: 'Este CFDI todavía no tiene archivo' })
      return
    }
    const bytes = await fetchBytes(url)
    const name = [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || cfdi.uuid || cfdi.id
    res.setHeader('Content-Type', type === 'pdf' ? 'application/pdf' : 'application/xml')
    res.setHeader('Content-Disposition', `attachment; filename="${String(name).replace(/[^\w.-]/g, '_')}.${type}"`)
    // El dashboard vive en otro origen: sin esto axios no puede leer el nombre del archivo.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
    res.status(200).send(bytes)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // warn si la respuesta es un caso esperado (4xx); error sólo si termina en 5xx.
    const aviso = `[cfdi.controller] downloadCfdiFile failed for cfdi ${cfdiId}: ${message}`
    if (/not found/i.test(message)) {
      logger.warn(aviso)
      res.status(404).json({ error: 'CFDI no encontrado' })
      return
    }
    logger.error(aviso)
    res.status(502).json({ error: 'No se pudo descargar el archivo' })
  }
}

/** Sólo desde nuestro Storage, ≤ 25 MB, 15 s (un PDF de CFDI pesa ~100 KB). */
function defaultFetchBytes(url: string): Promise<Buffer> {
  return fetchStorageObject(url, { maxBytes: 25 * 1024 * 1024, timeoutMs: 15_000 })
}
