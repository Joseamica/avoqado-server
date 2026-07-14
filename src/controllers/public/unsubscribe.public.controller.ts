import { Request, Response } from 'express'
import asyncHandler from '../../utils/asyncHandler'
import logger from '../../config/logger'
import { verifyUnsubscribeToken } from '../../utils/unsubscribeToken'
import { getUnsubscribeContext, unsubscribeFromEmailCategory } from '../../services/notifications/emailUnsubscribe.service'

/**
 * Public, login-free one-click email unsubscribe.
 *
 * GET  /api/v1/public/unsubscribe?token=…  → confirmation page (NEVER mutates —
 *      email clients prefetch links, so a GET must be safe).
 * POST /api/v1/public/unsubscribe?token=…  → performs the unsubscribe. Doubles
 *      as the RFC 8058 List-Unsubscribe-Post one-click target (mail providers
 *      POST here directly with body "List-Unsubscribe=One-Click"; the token in
 *      the query is what authorizes it).
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Avoqado</title>
<style>
  body { margin:0; background:#ffffff; color:#000000; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:480px; margin:0 auto; padding:48px 24px; text-align:center; }
  img.logo { width:40px; height:40px; margin-bottom:24px; }
  h1 { font-size:20px; font-weight:700; margin:0 0 12px; }
  p { font-size:15px; line-height:1.5; color:#333; margin:0 0 20px; }
  .email { font-weight:600; color:#000; }
  button { background:#000; color:#fff; border:none; border-radius:6px; padding:14px 28px; font-size:15px; font-weight:600; cursor:pointer; }
  .muted { font-size:13px; color:#666; margin-top:28px; }
  a { color:#000; }
</style>
</head>
<body>
  <div class="wrap">
    <img class="logo" src="https://avoqado.io/isotipo.svg" alt="Avoqado">
    ${bodyHtml}
    <p class="muted">Avoqado · Servicios Tecnologicos Avo S.A. de C.V.</p>
  </div>
</body>
</html>`
}

const INVALID_PAGE = page(
  'Enlace no válido',
  `<h1>Enlace no válido o expirado</h1>
   <p>No pudimos procesar esta solicitud. Es posible que el enlace esté incompleto. Si sigues recibiendo correos que no deseas, puedes ajustar tus preferencias desde el panel de Avoqado.</p>`,
)

export const getUnsubscribePage = asyncHandler(async (req: Request, res: Response) => {
  const data = verifyUnsubscribeToken(req.query.token as string | undefined)
  if (!data) {
    return res.status(400).type('html').send(INVALID_PAGE)
  }

  const ctx = await getUnsubscribeContext(data.staffId, data.venueId, data.category)
  if (!ctx) {
    return res.status(400).type('html').send(INVALID_PAGE)
  }

  const action = escapeHtml(req.originalUrl) // same URL incl. ?token=… → POST here
  const venueSuffix = ctx.venueName ? ` de <span class="email">${escapeHtml(ctx.venueName)}</span>` : ''
  const body = `
    <h1>¿Dejar de recibir ${escapeHtml(ctx.categoryLabel)}?</h1>
    <p>Dejarás de recibir correos de <span class="email">${escapeHtml(ctx.categoryLabel)}</span>${venueSuffix} en
       <span class="email">${escapeHtml(ctx.staffEmail)}</span>. Seguirás viendo estas alertas dentro del panel.</p>
    <form method="POST" action="${action}">
      <button type="submit">Dejar de recibir estos correos</button>
    </form>`
  return res.status(200).type('html').send(page('Preferencias de correo', body))
})

export const postUnsubscribe = asyncHandler(async (req: Request, res: Response) => {
  const data = verifyUnsubscribeToken(req.query.token as string | undefined)
  if (!data) {
    return res.status(400).type('html').send(INVALID_PAGE)
  }

  const result = await unsubscribeFromEmailCategory(data.staffId, data.venueId, data.category)
  logger.info('📧 Email unsubscribe processed', {
    staffId: data.staffId,
    venueId: data.venueId,
    category: data.category,
    affectedTypes: result.affectedTypes,
    alreadyUnsubscribed: result.alreadyUnsubscribed,
  })

  const ctx = await getUnsubscribeContext(data.staffId, data.venueId, data.category)
  const label = ctx?.categoryLabel ?? 'estos correos'
  const body = `
    <h1>Listo, cancelamos tu suscripción</h1>
    <p>Ya no recibirás correos de <span class="email">${escapeHtml(label)}</span>${
      ctx?.staffEmail ? ` en <span class="email">${escapeHtml(ctx.staffEmail)}</span>` : ''
    }. Si cambias de opinión, puedes reactivarlos desde <em>Preferencias de notificaciones</em> en el panel de Avoqado.</p>`
  return res.status(200).type('html').send(page('Suscripción cancelada', body))
})
