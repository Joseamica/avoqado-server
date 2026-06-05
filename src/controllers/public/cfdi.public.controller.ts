// src/controllers/public/cfdi.public.controller.ts
/**
 * Public autofactura controller — Flow A customer self-service CFDI.
 *
 * A customer who paid reaches their digital receipt via `accessKey` and
 * invoices their own ticket. Ownership is proven by the accessKey → payment
 * → order chain. Guards: paid + same-month (Mexico TZ) + not-already-stamped.
 * Delegates issuance to `issueCfdiForOrder` which enforces the merchant's
 * `facturacionEnabled` / `autofacturaEnabled` flags internally.
 *
 * No auth (public route). Abuse-gated by the dedicated `cfdiLimit` in routes.
 */
import { Request, Response } from 'express'
import { toZonedTime } from 'date-fns-tz'
import prisma from '../../utils/prismaClient'
import { issueCfdiForOrder } from '../../services/fiscal/cfdi.service'
import { logAction } from '../../services/dashboard/activity-log.service'
import logger from '../../config/logger'
import { env } from '../../config/env'

const MEXICO_TZ = 'America/Mexico_City'

// ─── POST /receipt/:accessKey/cfdi ───────────────────────────────────────────

export async function autofacturaController(req: Request<{ accessKey: string }>, res: Response): Promise<void> {
  const { accessKey } = req.params

  try {
    // 1. Resolve receipt → payment → order in ONE query (don't trust stale data)
    const receipt = await prisma.digitalReceipt.findUnique({
      where: { accessKey },
      select: {
        payment: {
          select: {
            orderId: true,
            order: {
              select: {
                id: true,
                venueId: true,
                paymentStatus: true,
                createdAt: true,
              },
            },
          },
        },
      },
    })

    const order = receipt?.payment?.order
    if (!order) {
      res.status(404).json({ error: 'Recibo no encontrado' })
      return
    }

    // 2. Order must be fully paid
    if (order.paymentStatus !== 'PAID') {
      res.status(409).json({ error: 'La cuenta aún no está pagada.' })
      return
    }

    // 3. Same-month window in America/Mexico_City
    //    SAT requires CFDI within the same fiscal month; Plan 6 global sweep
    //    excludes individually-stamped orders, so cross-month overlap is bounded.
    const nowMx = toZonedTime(new Date(), MEXICO_TZ)
    const orderMx = toZonedTime(order.createdAt, MEXICO_TZ)
    if (orderMx.getMonth() !== nowMx.getMonth() || orderMx.getFullYear() !== nowMx.getFullYear()) {
      res.status(409).json({ error: 'Solo puedes facturar tickets del mes en curso.' })
      return
    }

    // 4. Already stamped guard — prevent double-invoice for same order
    const existing = await prisma.cfdi.findFirst({
      where: { orderId: order.id, status: 'STAMPED' },
    })
    if (existing) {
      res.status(409).json({ error: 'Esta cuenta ya fue facturada.' })
      return
    }

    // 5. Delegate to the issuance engine (enforces facturacionEnabled + autofacturaEnabled)
    const result = await issueCfdiForOrder({
      orderId: order.id,
      receptor: req.body,
      sandbox: env.NODE_ENV !== 'production',
      flow: 'AUTOFACTURA_A',
      expectedVenueId: order.venueId,
    })

    // 6. Map service results to HTTP responses
    if (result.status === 'VALIDATION_FAILED') {
      res.status(422).json({ error: 'No se pudo facturar', reasons: result.reasons })
      return
    }

    if (result.status === 'STAMP_FAILED') {
      res.status(502).json({ error: 'El SAT rechazó el timbrado' })
      return
    }

    // STAMPED — log the action before returning
    await logAction({
      staffId: null,
      venueId: order.venueId,
      action: 'CFDI_ISSUED',
      entity: 'Cfdi',
      entityId: result.cfdi.id,
      data: {
        flow: 'AUTOFACTURA_A',
        accessKey,
        orderId: order.id,
        uuid: result.cfdi.uuid,
      },
    })

    res.status(200).json({
      cfdi: {
        uuid: result.cfdi.uuid,
        serie: result.cfdi.serie,
        folio: result.cfdi.folio,
        pdfUrl: result.cfdi.pdfUrl,
        xmlUrl: result.cfdi.xmlUrl,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)

    // Merchant disabled autofactura/facturacion — surface as 403, not 500
    if (/no habilitada/i.test(message)) {
      res.status(403).json({ error: 'La facturación no está disponible para esta cuenta.' })
      return
    }

    // Tenant isolation / not-found thrown by issueCfdiForOrder
    if (/not found/i.test(message)) {
      res.status(404).json({ error: 'Recibo no encontrado' })
      return
    }

    // Concurrent in-flight reservation — surface as 409 so the widget can retry
    if (/en proceso/i.test(message)) {
      res.status(409).json({ error: message })
      return
    }

    logger.error('[cfdi.public] autofactura error', { accessKey, error: message })
    res.status(500).json({ error: 'Error interno al generar el CFDI' })
  }
}

// ─── GET /receipt/:accessKey/cfdi ────────────────────────────────────────────

export async function getAutofacturaStatusController(req: Request<{ accessKey: string }>, res: Response): Promise<void> {
  const { accessKey } = req.params

  try {
    // Resolve receipt → order (same first query pattern as the POST)
    const receipt = await prisma.digitalReceipt.findUnique({
      where: { accessKey },
      select: {
        payment: {
          select: {
            orderId: true,
            order: {
              select: {
                id: true,
                venueId: true,
                paymentStatus: true,
                createdAt: true,
              },
            },
          },
        },
      },
    })

    const order = receipt?.payment?.order
    if (!order) {
      res.status(404).json({ error: 'Recibo no encontrado' })
      return
    }

    // Return the most-recent CFDI for this order (any status) so the portal
    // can show "ya facturada / descargar" without re-issuing.
    const cfdi = await prisma.cfdi.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
      select: { uuid: true, status: true, serie: true, folio: true, pdfUrl: true, xmlUrl: true },
    })

    res.status(200).json({ cfdi: cfdi ?? null })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[cfdi.public] get status error', { accessKey, error: message })
    res.status(500).json({ error: 'Error interno al consultar el CFDI' })
  }
}
