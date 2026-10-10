import { ConflictError } from '../../errors/AppError'
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
import { timbreEnDuda } from '../../services/fiscal/timbreEnDuda'

/** Public base URL of THIS API — used to build the zip download link we send over
 *  WhatsApp. Prod: api.avoqado.io; dev: set BASE_URL to the tunnel (ngrok) URL. */
const API_PUBLIC_BASE = process.env.BASE_URL || 'https://api.avoqado.io'

const SELECT_PUBLICO = {
  uuid: true,
  status: true,
  serie: true,
  folio: true,
  pdfUrl: true,
  xmlUrl: true,
  cancelStatus: true,
  replacesCfdiId: true,
} as const
/**
 * La factura de VENTA que se le enseña al cliente: la más reciente (nunca una nota de crédito, H19). Ronda de la ola (2), m2: si ésa es una
 * SUSTITUTA con su cancelación pedida y su original sigue timbrada, la venta está facturada con la ORIGINAL: ésa es la que se enseña.
 */
async function facturaDeLaVentaPublica(orderId: string, soloTimbradas = false) {
  const ultima = await prisma.cfdi.findFirst({
    where: { orderId, type: 'INGRESO', ...(soloTimbradas ? { status: 'STAMPED' as const } : {}) },
    orderBy: { createdAt: 'desc' },
    select: SELECT_PUBLICO,
  })
  if (ultima?.cancelStatus === 'REQUESTED' && ultima.replacesCfdiId) {
    const original = await prisma.cfdi.findFirst({
      where: { id: ultima.replacesCfdiId, orderId, type: 'INGRESO', status: 'STAMPED' },
      select: SELECT_PUBLICO,
    })
    if (original) return original
  }
  return ultima
}

/** Resolve the latest STAMPED sale invoice (INGRESO, with PDF+XML) for a receipt accessKey — never a credit note (H19). */
async function resolveStampedCfdi(accessKey: string) {
  const receipt = await prisma.digitalReceipt.findUnique({
    where: { accessKey },
    select: { payment: { select: { order: { select: { id: true, venue: { select: { name: true } } } } } } },
  })
  const order = receipt?.payment?.order
  if (!order) return { order: null as null, cfdi: null }
  return { order, cfdi: await facturaDeLaVentaPublica(order.id, true) }
}

const MEXICO_TZ = 'America/Mexico_City'

/**
 * Ronda de la ola (2) — la regla desde B3a: la autofactura pública NUNCA enseña al cliente final motivos internos ni folios (lo abre
 * cualquiera con el QR del ticket; los textos están escritos para el comercio). El dueño los sigue viendo en su dashboard y van al log.
 */
const NO_SE_PUEDE_EN_LINEA = {
  error: 'No se pudo facturar',
  code: 'FISCAL_BLOCK',
  message: 'Esta cuenta no se puede facturar en línea. Pide tu factura directamente al negocio.',
} as const
/** Ronda QA (hermanos): un timbre EN DUDA, para el cliente final (sin «rechazó» ni texto técnico, sin invitar a reintentar a ciegas). */
const TEXTO_PUBLICO_TIMBRE_EN_DUDA = 'Tu factura se está procesando. Vuelve a abrir este recibo en unos minutos para descargarla.'
const TEXTO_PUBLICO_CANCELACION_PENDIENTE = 'La factura anterior de esta cuenta se está cancelando. Intenta de nuevo más tarde.'
/**
 * Un motivo que el CLIENTE corrige (sus datos de receptor), y no uno del comercio (emisor, CSD, conceptos, forma de pago, red del PAC).
 * ponytail: por palabras; un motivo nuevo del receptor que no las diga sale neutro (la dirección segura).
 */
const esDelReceptor = (m: string) =>
  /receptor|\bRFC\b|r[eé]gimen|raz[oó]n social|c[oó]digo postal|uso\s*(del\s*)?cfdi|usocfdi|p[uú]blico en general/i.test(m) &&
  // Ronda de la ola (4) (m-a): un motivo de CONCEPTO («Concepto 1 ("Régimen keto")…», o el PAC hablando de un concepto) lleva el nombre del
  // producto: nunca es del receptor.
  !/emisor|\bCSD\b|certificado|sello|concepto/i.test(m)

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

    // 4. «Ya facturada» lo decide el motor (sólo cuenta una factura de VENTA vigente; una nota de crédito no, H19):
    //    devuelve `alreadyIssued` ⇒ 409 abajo, y una cancelación en trámite ⇒ 409 en el catch.
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
      // Los motivos del bloqueo FISCAL (venta que no se puede timbrar exacta) están escritos para el comercio
      // («factúrala con tu contador», con importes): no viajan a este endpoint sin sesión (mismo criterio que el GET).
      // Los errores del RECEPTOR (RFC, CP, régimen…) sí: el cliente los corrige. Si el cargador falla, se oculta
      // (genérico) antes que filtrar.
      const reasons = result.reasons ?? []
      let internos: string[]
      try {
        const bundle = await loadOrderForCfdiFromDb(order.id)
        internos = bundle?.unsupportedReasons ?? []
      } catch {
        internos = reasons
      }
      const fiscal = reasons.filter(r => internos.includes(r) || /no coincide con lo cobrado/i.test(r))
      if (fiscal.length > 0) {
        logger.info('[cfdi.public] autofactura rechazada por bloqueo fiscal', {
          orderId: order.id,
          venueId: order.venueId,
          motivos: fiscal,
        })
        // El GET también dice `FISCAL_BLOCK` (son los motivos del sobre): el panel cierra el formulario y pinta la tarjeta del GET.
        res.status(422).json(NO_SE_PUEDE_EN_LINEA)
        return
      }
      // Ronda de la ola (2): cualquier otro motivo que no sea del receptor (CSD del emisor, conceptos sin clave, forma de pago…) tampoco
      // viaja. Ronda de la ola (4) (I1): como 409 `{ error }` neutro, que el panel pinta como tarjeta; con un 422 `FISCAL_BLOCK` el panel
      // esperaba la tarjeta del GET, que para estos motivos dice «disponible», y el cliente se quedaba sin ningún mensaje.
      const delComercio = reasons.filter(r => !esDelReceptor(r))
      if (delComercio.length > 0) {
        logger.info('[cfdi.public] autofactura rechazada por un motivo del comercio', {
          orderId: order.id,
          venueId: order.venueId,
          motivos: delComercio,
        })
        res.status(409).json({ error: NO_SE_PUEDE_EN_LINEA.message })
        return
      }
      res.status(422).json({ error: 'No se pudo facturar', reasons })
      return
    }

    if (result.status === 'STAMP_FAILED' && timbreEnDuda(result.cfdi)) {
      // Ronda QA (hermanos): el PAC no contestó claro y pudo haberla timbrado (la conciliación lo confirma). Ni el error crudo ni «rechazó»,
      // ni invitar a reintentar a ciegas: 409 `{ error }`, que el panel pinta como tarjeta. El GET la enseña cuando quede timbrada.
      logger.info('[cfdi.public] autofactura en duda: el PAC no contestó claro', { orderId: order.id, lastError: result.cfdi?.lastError })
      res.status(409).json({ error: TEXTO_PUBLICO_TIMBRE_EN_DUDA, code: 'TIMBRE_EN_DUDA' })
      return
    }

    if (result.status === 'STAMP_FAILED') {
      // Surface the PAC/SAT reason so the customer can fix their own data (public
      // endpoint, but the message is about the receptor's own fiscal info — no
      // sensitive data). Strip the boilerplate "Validación de timbrado:" prefix.
      const reason = (result.cfdi?.lastError ?? '').replace(/^Validaci[oó]n de timbrado:\s*/i, '').trim()
      // Ronda de la ola (2): sólo si es del receptor; un error del emisor, del certificado o de la red del PAC no viaja (va al log).
      if (reason && !esDelReceptor(reason))
        logger.info('[cfdi.public] el PAC rechazó por un motivo del comercio', { orderId: order.id, reason })
      res.status(502).json({ error: 'El SAT rechazó el timbrado', message: (esDelReceptor(reason) && reason) || undefined })
      return
    }

    // La venta ya tenía factura vigente (otra petición ganó la carrera): no se timbró nada.
    if (result.alreadyIssued) {
      res.status(409).json({ error: 'Esta cuenta ya fue facturada.' })
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
    // C2 · T10 ronda 1 (M3): el 409 tipado lleva su código si lo trae (`CFDI_CANCEL_PENDING`: la cancelación de la factura anterior sigue
    // pendiente). Aditivo: sin código, la respuesta es la de antes.
    if (err instanceof ConflictError) {
      // Ronda de la ola (2): al cliente final, nunca el texto interno. La cancelación pendiente conserva su código con un texto sin folios;
      // «en proceso» ya es neutro; cualquier otro conflicto (incluida en una global, cancelada en el PAC, revisión de soporte…) es «pídela
      // al negocio», con el motivo en el log.
      if (err.code === 'CFDI_CANCEL_PENDING') {
        res.status(409).json({ error: TEXTO_PUBLICO_CANCELACION_PENDIENTE, code: err.code })
        return
      }
      if (/procesando|en proceso/i.test(err.message)) {
        res.status(409).json({ error: err.message })
        return
      }
      logger.info('[cfdi.public] autofactura no disponible por un motivo interno', { accessKey, motivo: err.message })
      // Ronda de la ola (4) (I1): 409 `{ error }` (el status que estos conflictos tenían), que el panel pinta como tarjeta.
      res.status(409).json({ error: NO_SE_PUEDE_EN_LINEA.message })
      return
    }
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

    // Concurrent in-flight reservation — surface as 409 so the widget can retry. (C2 · T10 ronda 1, M3: la cancelación pendiente de la
    // factura anterior llega como ConflictError con su código, arriba; ya no se adivina por el texto.)
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

    // Return the most-recent sale invoice (INGRESO, any status) so the portal can show "ya facturada /
    // descargar" without re-issuing. A credit note is never "the" invoice of the ticket (H19). Ronda de la ola (2): en el caso m2, la original.
    const cfdi = await facturaDeLaVentaPublica(order.id)
    // C2 · T10: `cancelStatus` sólo para decir `cancelacionEnTramite`; ni él ni `replacesCfdiId` viajan en el objeto público.
    const { cancelStatus, replacesCfdiId: _sustituye, ...cfdiPublico } = cfdi ?? { cancelStatus: null, replacesCfdiId: null }
    // C2 · T10 (nuevo y opcional, sólo cuando es verdad): se pidió cancelar la factura y el SAT todavía no lo resuelve. Sigue vigente.
    const cancelacionEnTramite = cancelStatus === 'REQUESTED'

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
    const habilitada = !!bundle && bundle.facturacionEnabled && bundle.autofacturaEnabled
    const motivos = bundle?.unsupportedReasons ?? []
    const autofacturaAvailable = habilitada && motivos.length === 0
    // B3a ronda final F3 (Codex final #3): campo NUEVO y opcional — nunca se quita ni se renombra uno de los de arriba. Distingue
    // el bloqueo FISCAL (el comercio la habilitó, pero ESTA venta no se puede timbrar exacta: el recibo le dice al cliente que pida
    // su factura al negocio) de la desactivación del comercio (DISABLED: el recibo no la ofrece). Sin él, una venta bloqueada
    // escondía el panel sin explicación.
    // Ajuste 4: los motivos NO viajan a este GET público (lo abre cualquiera con el QR del ticket y están escritos para el comercio:
    // «factúrala con tu contador»). Van al log; el comercio los ve en su dashboard (422 al facturar, `lastError` del intento).
    const autofacturaUnavailable = autofacturaAvailable
      ? undefined
      : habilitada
        ? { kind: 'FISCAL_BLOCK' as const }
        : { kind: 'DISABLED' as const }
    if (autofacturaUnavailable?.kind === 'FISCAL_BLOCK') {
      logger.info('[cfdi.public] autofactura no disponible por bloqueo fiscal', { orderId: order.id, venueId: order.venueId, motivos })
    }

    res.status(200).json({
      cfdi: cfdi ? cfdiPublico : null,
      autofacturaAvailable,
      ...(autofacturaUnavailable && { autofacturaUnavailable }),
      ...(cancelacionEnTramite && { cancelacionEnTramite: true }),
    })
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

export async function sendCfdiWhatsAppController(
  req: Request<{ accessKey: string }, unknown, { phone?: string }>,
  res: Response,
): Promise<void> {
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
