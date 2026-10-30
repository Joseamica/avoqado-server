// src/controllers/public/giftCard.public.controller.ts
/**
 * GET /api/v1/public/gift-cards/:pageToken — la página pública del regalo (1b S6). La ruta, su límite y su CORS propio viven
 * en `public.routes.ts`; la forma de la respuesta, en `giftCardPublic.service.ts`.
 * 🔴 Sin logs propios: el token es la llave de la tarjeta. El log de peticiones lo tapa (`SECRET_SEGMENT_AFTER`).
 */
import type { NextFunction, Request, Response } from 'express'
import * as paginaDelRegalo from '@/services/giftCards/giftCardPublic.service'

export async function getPaginaDelRegalo(req: Request<{ pageToken: string }>, res: Response, next: NextFunction): Promise<void> {
  // S-11: sin caché y fuera de los buscadores, también cuando falla (por eso antes de leer).
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
  try {
    const data = await paginaDelRegalo.getPaginaDelRegalo(req.params.pageToken)
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
