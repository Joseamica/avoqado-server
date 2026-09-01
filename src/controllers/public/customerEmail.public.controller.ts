import { Request, Response } from 'express'
import asyncHandler from '../../utils/asyncHandler'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { page, escapeHtml } from './publicHtml'
import { verifyCustomerUnsubscribeToken, verifyBirthdateCaptureToken } from '../../utils/customerActionToken'
import { revokeMarketingConsent } from '../../services/customer/consent.service'

/**
 * Public, login-free pages for CUSTOMERS (not staff — see `unsubscribe.public.controller.ts`
 * for the staff-facing equivalent, which shares `page()`/`escapeHtml()` via `publicHtml.ts`).
 *
 * GET  /api/v1/public/customers/unsubscribe?token=…  → confirmation page (NEVER mutates —
 *      email clients prefetch links, so a GET must be safe).
 * POST /api/v1/public/customers/unsubscribe?token=…  → revokes marketing consent. Idempotent
 *      (revoking twice never throws) and doubles as the RFC 8058 List-Unsubscribe-Post
 *      one-click target.
 *
 * GET  /api/v1/public/customers/birthdate?token=…    → capture form, only if the token
 *      verifies AND its row is unconsumed and unexpired (NEVER mutates).
 * POST /api/v1/public/customers/birthdate?token=…    → consumes the token ATOMICALLY
 *      (replay ⇒ 400) and writes `birthDate` ONLY if it was null (already-set ⇒ 409,
 *      token still consumed — never overwrites what the customer already told us).
 *
 * 🔴 Ninguna de las dos páginas GET muestra datos del cliente (email, nombre) antes de
 * que actúe — a diferencia de la versión de staff, que sí lo hace para el propio dueño.
 */

const INVALID_UNSUB_PAGE = page(
  'Enlace no válido',
  `<h1>Enlace no válido o expirado</h1>
   <p>No pudimos procesar esta solicitud. Es posible que el enlace esté incompleto o haya expirado.</p>`,
)

const INVALID_CAPTURE_PAGE = page(
  'Enlace no válido',
  `<h1>Enlace no válido o expirado</h1>
   <p>No pudimos procesar esta solicitud. Es posible que el enlace haya expirado o ya se haya usado.</p>`,
)

const INVALID_DATE_PAGE = page(
  'Fecha no válida',
  `<h1>Fecha no válida</h1>
   <p>No pudimos leer la fecha que enviaste. Vuelve a intentarlo desde el enlace de tu correo.</p>`,
)

const ALREADY_REGISTERED_PAGE = page(
  'Dato ya registrado',
  `<h1>Este dato ya está registrado</h1>
   <p>Ya teníamos guardada tu fecha de cumpleaños. Si necesitas corregirla, contacta directamente al negocio.</p>`,
)

const BIRTHDATE_RE = /^\d{4}-\d{2}-\d{2}$/

function requestUserAgent(req: Request): string | undefined {
  const raw = req.get?.('user-agent')
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

export const getCustomerUnsubscribePage = asyncHandler(async (req: Request, res: Response) => {
  const data = verifyCustomerUnsubscribeToken(req.query.token as string | undefined)
  if (!data) {
    return res.status(400).type('html').send(INVALID_UNSUB_PAGE)
  }

  const action = escapeHtml(req.originalUrl) // same URL incl. ?token=… → POST here
  const body = `
    <h1>¿Dejar de recibir correos de marketing?</h1>
    <p>Dejarás de recibir promociones y correos de marketing de este negocio. Seguirás recibiendo confirmaciones de tus
       compras y reservaciones.</p>
    <form method="POST" action="${action}">
      <button type="submit">Dejar de recibir estos correos</button>
    </form>`
  return res.status(200).type('html').send(page('Preferencias de correo', body))
})

export const postCustomerUnsubscribe = asyncHandler(async (req: Request, res: Response) => {
  const data = verifyCustomerUnsubscribeToken(req.query.token as string | undefined)
  if (!data) {
    return res.status(400).type('html').send(INVALID_UNSUB_PAGE)
  }

  // revokeMarketingConsent es idempotente a nivel semántico: revocar dos veces no truena
  // (RFC 8058 — Gmail/Yahoo pueden re-disparar el one-click).
  await revokeMarketingConsent({
    venueId: data.venueId,
    customerId: data.customerId,
    channel: 'ONE_CLICK_UNSUBSCRIBE',
    ip: req.ip,
    userAgent: requestUserAgent(req),
  })
  logger.info('📧 Customer marketing unsubscribe processed', { customerId: data.customerId, venueId: data.venueId })

  const body = `
    <h1>Listo, cancelamos tu suscripción</h1>
    <p>Ya no recibirás correos de marketing de este negocio. Si cambias de opinión, puedes volver a suscribirte
       contactando directamente al negocio.</p>`
  return res.status(200).type('html').send(page('Suscripción cancelada', body))
})

export const getBirthdateCapturePage = asyncHandler(async (req: Request, res: Response) => {
  const data = verifyBirthdateCaptureToken(req.query.token as string | undefined)
  if (!data) {
    return res.status(400).type('html').send(INVALID_CAPTURE_PAGE)
  }

  // El token ya valida firma+expiración, pero NO sabe si ya se consumió — eso vive en la
  // fila. Esta lectura NUNCA muta (GET es prefetch-safe).
  const row = await prisma.customerCaptureToken.findUnique({
    where: { tokenHash: data.tokenHash },
    select: { consumedAt: true, expiresAt: true },
  })
  if (!row || row.consumedAt !== null || row.expiresAt.getTime() < Date.now()) {
    return res.status(400).type('html').send(INVALID_CAPTURE_PAGE)
  }

  const action = escapeHtml(req.originalUrl) // same URL incl. ?token=… → POST here
  const body = `
    <h1>¡Cuéntanos cuándo es tu cumpleaños!</h1>
    <p>Te avisaremos con promociones especiales en tu día.</p>
    <form method="POST" action="${action}">
      <input type="date" name="birthdate" required>
      <button type="submit">Guardar</button>
    </form>`
  return res.status(200).type('html').send(page('Tu cumpleaños', body))
})

export const postBirthdateCapture = asyncHandler(async (req: Request, res: Response) => {
  const data = verifyBirthdateCaptureToken(req.query.token as string | undefined)
  if (!data) {
    return res.status(400).type('html').send(INVALID_CAPTURE_PAGE)
  }

  const raw = req.body?.birthdate
  if (typeof raw !== 'string' || !BIRTHDATE_RE.test(raw)) {
    return res.status(400).type('html').send(INVALID_DATE_PAGE)
  }

  // Consumo ATÓMICO: count 0 significa que ya se usó (o nunca existió) — replay.
  const consumed = await prisma.customerCaptureToken.updateMany({
    where: { tokenHash: data.tokenHash, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (consumed.count === 0) {
    return res.status(400).type('html').send(INVALID_CAPTURE_PAGE)
  }

  // Fecha civil, jamás parseo pelón: `new Date('YYYY-MM-DD')` puede correr un día según el
  // reloj del runtime. Escribe SÓLO si birthDate sigue null — nunca sobrescribe lo que el
  // cliente ya nos dijo, aunque el token ya haya quedado consumido arriba.
  const written = await prisma.customer.updateMany({
    where: { id: data.customerId, venueId: data.venueId, birthDate: null },
    data: { birthDate: new Date(`${raw}T00:00:00.000Z`) },
  })
  if (written.count === 0) {
    return res.status(409).type('html').send(ALREADY_REGISTERED_PAGE)
  }

  logger.info('🎂 Customer birthdate captured', { customerId: data.customerId, venueId: data.venueId })

  const body = `
    <h1>¡Gracias!</h1>
    <p>Guardamos tu fecha de cumpleaños. Te avisaremos con promociones especiales en tu día.</p>`
  return res.status(200).type('html').send(page('¡Gracias!', body))
})
