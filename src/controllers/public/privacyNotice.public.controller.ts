import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { getCurrentPrivacyNotice } from '../../services/customer/consent.service'

/**
 * GET /api/v1/public/venues/:venueId/privacy-notice
 *
 * Lectura pública, sin sesión — Fase 1C, Task 7: es el enlace que el pie de cada correo de
 * campaña manda al titular (`campaignSender.service.ts`). Devuelve SÓLO contenido del propio
 * NEGOCIO — nunca un dato personal de un tercero — así que no necesita candado alguno: un
 * aviso de privacidad tiene que poder leerse sin iniciar sesión, es lo que la propia LFPDPPP
 * exige.
 *
 * Reusa `getCurrentPrivacyNotice` (Task 8): si el venue todavía no publicó su propio aviso,
 * el enlace no cae en un 404 — muestra la PLANTILLA precargada con sus datos, marcada
 * `esPlantilla: true`, para que quien abre el enlace vea un texto coherente en vez de una
 * página rota (caso que, per diseño, no debería ocurrir — ver el comentario de
 * `buildPrivacyNoticeUrl` en campaignSender.service.ts — pero si ocurre, esto es lo correcto).
 *
 * `venueId` inválido (no existe ningún venue con ese id) sí da 404 — a diferencia del caso de
 * arriba, ahí no hay NADA que mostrar, ni siquiera un borrador con datos propios.
 */
export async function getPublicPrivacyNotice(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true } })
    if (!venue) throw new NotFoundError('Negocio no encontrado')

    const notice = await getCurrentPrivacyNotice(venueId)
    res.json({ data: { content: notice.content, language: notice.language, esPlantilla: notice.esPlantilla } })
  } catch (error) {
    next(error)
  }
}
