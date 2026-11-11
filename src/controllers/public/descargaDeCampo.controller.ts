import { Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

/**
 * @route GET /api/v1/public/campo/descargar[?ambiente=sandbox]
 * La liga de primera instalación de la app de campo (la manda el supervisor por WhatsApp o en QR desde «Celulares de
 * promotores»): siempre la última versión activa de PRODUCCIÓN para todos, nunca un APK de la TPV. Después, la app se
 * actualiza sola por el check-update. `ambiente=sandbox` sólo sirve para la prueba de punta a punta.
 */
export async function descargarAppDeCampo(req: Request, res: Response) {
  try {
    const environment = req.query.ambiente === 'sandbox' ? 'SANDBOX' : 'PRODUCTION'
    const ultima = await prisma.appUpdate.findFirst({
      where: { platform: 'ANDROID_CAMPO', environment, isActive: true, targetType: 'ALL' },
      orderBy: { versionCode: 'desc' },
      select: { downloadUrl: true },
    })
    res.set('Cache-Control', 'no-store')
    if (!ultima) {
      return res.status(404).type('text/plain; charset=utf-8').send('La app de campo todavía no está publicada. Pídele a tu supervisor que te avise.')
    }
    return res.redirect(302, ultima.downloadUrl)
  } catch (error) {
    logger.error('[descargarAppDeCampo] no se pudo buscar la versión', { error })
    return res.status(500).type('text/plain; charset=utf-8').send('No se pudo bajar la app de campo. Intenta otra vez en un momento.')
  }
}
