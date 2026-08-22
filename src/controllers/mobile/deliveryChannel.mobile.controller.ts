/**
 * "Me saturé" — frenar los pedidos de reparto un rato, desde el punto de venta.
 *
 * Vive en `/mobile` por la misma razón que aceptar y rechazar: el que se satura está en la
 * cocina, con las manos llenas, no en la computadora de la oficina. Que el único freno
 * viviera en el dashboard significaba que alguien tenía que dejar la plancha y caminar.
 *
 * Lo que este controlador NO expone, y es deliberado: conectar o desconectar un canal,
 * cambiar precios y horario, o apagarlo indefinidamente. Eso sigue siendo del dashboard,
 * con el permiso `delivery-channels:manage`. Aquí sólo el freno con reloj.
 */
import type { NextFunction, Request, Response } from 'express'

import { ValidationError } from '@/errors/AppError'
import {
  cancelarSnooze,
  listChannelsResumen,
  snoozeChannelLink,
  SNOOZE_MINUTOS_VALIDOS,
} from '@/services/delivery-channels/core/deliveryChannelLink.service'

/**
 * GET /mobile/venues/:venueId/delivery/channels
 *
 * Lo mínimo para pintar el control: qué canales hay, si están recibiendo pedidos, y hasta
 * cuándo dura la pausa si alguien ya la puso. Nada de secretos ni de configuración.
 */
export const listChannels = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    // La versión LEAN, no `listChannelLinks`: cada aparato de cocina consulta esto cada 10
    // segundos, y la completa calcula tasa de inyección y estado del menú por llamada.
    const links = await listChannelsResumen(venueId)

    return res.json({
      ok: true,
      // El POS no necesita —ni debe recibir— el resto del registro.
      channels: links.map(l => ({
        id: l.id,
        provider: l.provider,
        status: l.status,
        // `null` con status PAUSED = la pausa indefinida del dashboard. El POS la muestra
        // como pausado pero SIN cuenta regresiva, porque no se va a reactivar sola y
        // pintar un reloj que no corre sería mentir.
        snoozedUntil: l.snoozedUntil?.toISOString() ?? null,
      })),
      duracionesValidas: SNOOZE_MINUTOS_VALIDOS,
    })
  } catch (e) {
    return next(e)
  }
}

/**
 * POST /mobile/venues/:venueId/delivery/channels/:linkId/snooze
 * Body: { minutos: 20 | 40 | 60 | 120 }
 */
export const snoozeChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, linkId } = req.params
    const { userId } = (req as any).authContext
    const minutos = Number((req.body ?? {}).minutos)

    if (!Number.isFinite(minutos)) {
      throw new ValidationError(`Falta cuántos minutos pausar. Opciones: ${SNOOZE_MINUTOS_VALIDOS.join(', ')}.`)
    }

    const link = await snoozeChannelLink(venueId, linkId, minutos, userId)

    return res.json({
      ok: true,
      status: link.status,
      snoozedUntil: (link as { snoozedUntil?: Date | null }).snoozedUntil?.toISOString() ?? null,
    })
  } catch (e) {
    return next(e)
  }
}

/**
 * DELETE /mobile/venues/:venueId/delivery/channels/:linkId/snooze
 *
 * "Ya nos pusimos al día." Sólo cancela una pausa CON reloj — la indefinida del dashboard
 * no se puede deshacer desde el POS, y el servicio devuelve un 400 que lo explica.
 */
export const resumeChannel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, linkId } = req.params
    const { userId } = (req as any).authContext
    const link = await cancelarSnooze(venueId, linkId, userId)
    return res.json({ ok: true, status: link.status, snoozedUntil: null })
  } catch (e) {
    return next(e)
  }
}
