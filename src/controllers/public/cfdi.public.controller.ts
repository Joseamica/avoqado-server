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
import AdmZip from 'adm-zip'
import { issueCfdiForOrder, loadOrderForCfdiFromDb } from '../../services/fiscal/cfdi.service'
import { sendCfdiWhatsApp } from '../../services/whatsapp.service'
import { logAction } from '../../services/dashboard/activity-log.service'
import logger from '../../config/logger'
import { env } from '../../config/env'

/** Public base URL of THIS API — used to build the zip download link we send over
 *  WhatsApp. Prod: api.avoqado.io; dev: set BASE_URL to the tunnel (ngrok) URL. */
const API_PUBLIC_BASE = process.env.BASE_URL || 'https://api.avoqado.io'

/** Resolve the latest STAMPED CFDI (with PDF+XML) for a receipt accessKey. */
async function resolveStampedCfdi(accessKey: string) {
  const receipt = await prisma.digitalReceipt.findUnique({
    where: { accessKey },
    select: { payment: { select: { order: { select: { id: true, venue: { select: { name: true } } } } } } },
  })
  const order = receipt?.payment?.order
  if (!order) return { order: null as null, cfdi: null }
  const cfdi = await prisma.cfdi.findFirst({
    where: { orderId: order.id, status: 'STAMPED' },
    orderBy: { createdAt: 'desc' },
    select: { serie: true, folio: true, uuid: true, pdfUrl: true, xmlUrl: true },
  })
  return { order, cfdi }
}

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
      // Surface the PAC/SAT reason so the customer can fix their own data (public
      // endpoint, but the message is about the receptor's own fiscal info — no
      // sensitive data). Strip the boilerplate "Validación de timbrado:" prefix.
      const reason = (result.cfdi?.lastError ?? '').replace(/^Validaci[oó]n de timbrado:\s*/i, '').trim()
      res.status(502).json({ error: 'El SAT rechazó el timbrado', message: reason || undefined })
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

    // Whether the customer may self-invoice this ticket. This is the ADMIN's
    // decision: the merchant that collected the payment must have BOTH
    // facturación AND autofactura enabled (and a resolvable emisor for this
    // venue). If it's off, the receipt must not even OFFER the option — the
    // widget hides the CTA entirely instead of showing it and then 403-ing,
    // which would read to the customer as a broken promise rather than an
    // intentional merchant setting. `loadOrderForCfdiFromDb` is the canonical
    // resolver (most-recent COMPLETED payment → merchant → MerchantFiscalConfig
    // → venue-matched emisor); it returns null when invoicing isn't possible.
    const bundle = await loadOrderForCfdiFromDb(order.id)
    const autofacturaAvailable = !!bundle && bundle.facturacionEnabled && bundle.autofacturaEnabled

    res.status(200).json({ cfdi: cfdi ?? null, autofacturaAvailable })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[cfdi.public] get status error', { accessKey, error: message })
    res.status(500).json({ error: 'Error interno al consultar el CFDI' })
  }
}

// ─── POST /receipt/:accessKey/cfdi/whatsapp ──────────────────────────────────
// Send the already-stamped CFDI (factura) to a customer-supplied WhatsApp number.
// Public: ownership is proven by the accessKey → payment → order → stamped CFDI
// chain (we never send a CFDI that doesn't belong to this receipt).

export async function sendCfdiWhatsAppController(req: Request<{ accessKey: string }, unknown, { phone?: string }>, res: Response): Promise<void> {
  const { accessKey } = req.params
  const phone = (req.body?.phone ?? '').trim()

  // E.164 (+ then 8–15 digits). The dashboard PhoneInput already emits this shape.
  if (!/^\+\d{8,15}$/.test(phone)) {
    res.status(400).json({ error: 'Número de WhatsApp inválido.' })
    return
  }

  try {
    const { order, cfdi } = await resolveStampedCfdi(accessKey)
    if (!order) {
      res.status(404).json({ error: 'Recibo no encontrado' })
      return
    }
    if (!cfdi || !cfdi.pdfUrl) {
      res.status(409).json({ error: 'Esta cuenta todavía no tiene factura para enviar.' })
      return
    }

    const folio = [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || 's/folio'
    // Link to the zip endpoint → tapping it downloads a single .zip with PDF + XML.
    const zipUrl = `${API_PUBLIC_BASE}/api/v1/public/receipt/${accessKey}/cfdi/download`
    await sendCfdiWhatsApp(phone, { venueName: order.venue.name, folio, invoiceUrl: zipUrl })

    res.status(200).json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[cfdi.public] whatsapp send error', { accessKey, error: message })
    res.status(502).json({ error: 'No pudimos enviar la factura por WhatsApp. Inténtalo de nuevo.' })
  }
}

// ─── GET /receipt/:accessKey/cfdi/download ───────────────────────────────────
// Streams a single .zip containing the factura's PDF + XML, so the customer gets
// BOTH fiscal files in one download (WhatsApp/email link and the on-page button
// both point here). Public: gated by the accessKey → stamped-CFDI chain.

export async function downloadCfdiZipController(req: Request<{ accessKey: string }>, res: Response): Promise<void> {
  const { accessKey } = req.params

  try {
    const { order, cfdi } = await resolveStampedCfdi(accessKey)
    if (!order || !cfdi || (!cfdi.pdfUrl && !cfdi.xmlUrl)) {
      res.status(404).json({ error: 'Factura no encontrada.' })
      return
    }

    const base = [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || cfdi.uuid || 'factura'
    const zip = new AdmZip()

    // Fetch the stored PDF/XML (public Firebase URLs) and add each to the zip.
    await Promise.all(
      [
        { url: cfdi.pdfUrl, name: `factura-${base}.pdf` },
        { url: cfdi.xmlUrl, name: `factura-${base}.xml` },
      ]
        .filter(f => !!f.url)
        .map(async f => {
          const resp = await fetch(f.url as string)
          if (!resp.ok) throw new Error(`fetch ${f.name} failed: ${resp.status}`)
          zip.addFile(f.name, Buffer.from(await resp.arrayBuffer()))
        }),
    )

    const buffer = zip.toBuffer()
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="factura-${base}.zip"`)
    res.setHeader('Content-Length', String(buffer.length))
    res.status(200).end(buffer)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[cfdi.public] zip download error', { accessKey, error: message })
    res.status(502).json({ error: 'No pudimos preparar la descarga de la factura.' })
  }
}
