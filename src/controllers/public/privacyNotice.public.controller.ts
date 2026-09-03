import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { getCurrentPrivacyNotice } from '../../services/customer/consent.service'
import { page, escapeHtml } from './publicHtml'

/**
 * GET /api/v1/public/venues/:venueId/privacy-notice
 *
 * Lectura pública, sin sesión — Fase 1C, Task 7: es el enlace que el pie de cada correo de
 * campaña manda al titular (`campaignSender.service.ts`). Devuelve SÓLO contenido del propio
 * NEGOCIO — nunca un dato personal de un tercero — así que no necesita candado alguno: un
 * aviso de privacidad tiene que poder leerse sin iniciar sesión, es lo que la propia LFPDPPP
 * exige.
 *
 * 🔴 Fix round 1 (revisor, post-Task 7/8) — **el borrador es para el EDITOR, nunca para el
 * público.** Esta URL es pública y ADIVINABLE (`/venues/:venueId/privacy-notice`): no hace
 * falta un correo para pedirla, cualquiera puede consultarla para cualquier venue. Servir
 * aquí la plantilla que `getCurrentPrivacyNotice` arma para PRECARGAR el editor del dashboard
 * (Task 8, `esPlantilla:true`) mostraría un documento legal que ese negocio NUNCA escribió ni
 * aprobó, presentado como si fuera el suyo — exactamente el riesgo contra el que Task 8 blindó
 * `writeConsent` ("la plantilla no cuenta como publicada"), sólo que por la puerta pública.
 * Por eso, cuando `esPlantilla` es `true`, esta ruta **nunca** incluye `content`: dice —en
 * HTML y en JSON— que el negocio todavía no publicó su aviso, y da su nombre y su dato de
 * contacto (si los tiene) para que el titular pueda escribirle directamente. La plantilla
 * sigue viva para el editor AUTENTICADO (`privacyNotice.dashboard.controller.ts`, permiso
 * `marketing:read`, misma `getCurrentPrivacyNotice`) — ese es el único consumidor legítimo.
 *
 * `venueId` inválido (no existe ningún venue con ese id) sí da 404 — ahí no hay nombre ni
 * contacto que ofrecer, ni siquiera un "todavía no publicaste" tiene sentido.
 *
 * Negocia por `Accept` (molde: `receipt.public.controller.ts`): un navegador —que es cómo se
 * abre este enlace desde un correo— recibe una página HTML legible; `application/json`
 * explícito recibe el JSON, para quien lo consuma programáticamente. El contenido y el
 * nombre del venue se ESCAPAN antes de entrar al HTML: el texto del aviso lo teclea el dueño.
 */
export async function getPublicPrivacyNotice(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true, email: true, phone: true },
    })
    if (!venue) throw new NotFoundError('Negocio no encontrado')

    const notice = await getCurrentPrivacyNotice(venueId)

    const acceptHeader = req.get('Accept') ?? ''
    const wantsJson = acceptHeader.includes('application/json') || acceptHeader.includes('*/*')
    const asHtml = !(wantsJson && !acceptHeader.includes('text/html'))

    if (notice.esPlantilla) {
      // 🔴 NUNCA `notice.content` aquí — ese texto es la plantilla, no lo que el negocio
      // publicó. Sólo datos del venue, que sí son suyos.
      const contact = venue.email?.trim() || venue.phone?.trim() || null
      if (asHtml) {
        return res.status(200).type('html').send(renderNotPublishedPage(venue.name, contact))
      }
      return res.json({ data: { published: false, venueName: venue.name, contact } })
    }

    if (asHtml) {
      return res.status(200).type('html').send(renderNoticePage(venue.name, notice.content))
    }
    return res.json({ data: { content: notice.content, language: notice.language, esPlantilla: false } })
  } catch (error) {
    next(error)
  }
}

function renderNotPublishedPage(venueName: string, contact: string | null): string {
  const nombreEscapado = escapeHtml(venueName)
  const body = `
    <h1>${nombreEscapado} todavía no ha publicado su aviso de privacidad</h1>
    <p>Este negocio aún no terminó de configurar el aviso de privacidad que exige la ley.${
      contact
        ? ` Si tienes dudas sobre el uso de tus datos, puedes escribirle directamente a <span class="email">${escapeHtml(contact)}</span>.`
        : ''
    }</p>`
  return page('Aviso de privacidad', body)
}

function renderNoticePage(venueName: string, content: string): string {
  const nombreEscapado = escapeHtml(venueName)
  const contenidoEscapado = escapeHtml(content)
  const body = `
    <h1>Aviso de privacidad de ${nombreEscapado}</h1>
    <div style="text-align:left; white-space:pre-wrap; word-wrap:break-word;">${contenidoEscapado}</div>`
  return page('Aviso de privacidad', body)
}
