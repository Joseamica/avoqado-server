/**
 * Mobile Sync Controller — offline-first Fase 1 (Corte D).
 *
 * POST /mobile/venues/:venueId/sync/intents — el punto de replay del outbox
 * de los POS. Batch FIFO por dispositivo; responde un ack por intent (ACKED /
 * REJECTED estructurado). Errores de INFRAESTRUCTURA responden 500 y el
 * cliente reintenta el batch completo (idempotente por diseño); errores de
 * NEGOCIO nunca son 500 — van dentro del ack.
 */

import { Request, Response } from 'express'
import * as syncService from '../../services/mobile/sync.mobile.service'
import logger from '../../config/logger'
import { getUserAccess, hasPermission } from '../../services/access/access.service'

const MAX_BATCH = 100

export async function syncIntents(req: Request, res: Response): Promise<void> {
  try {
    const { venueId } = req.params
    const authContext = (req as any).authContext
    const staffId: string | undefined = authContext?.userId
    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.slice(0, 64) : ''
    const intents = Array.isArray(req.body?.intents) ? req.body.intents : null

    if (!staffId) {
      res.status(401).json({ success: false, message: 'Authentication required' })
      return
    }
    if (!deviceId || !intents) {
      res.status(400).json({ success: false, message: 'deviceId e intents[] son requeridos' })
      return
    }
    if (intents.length === 0) {
      res.status(200).json({ success: true, data: [] })
      return
    }
    if (intents.length > MAX_BATCH) {
      res.status(400).json({ success: false, message: `Máximo ${MAX_BATCH} intents por batch` })
      return
    }
    for (const intent of intents) {
      if (typeof intent?.id !== 'string' || intent.id.length === 0 || intent.id.length > 64 || typeof intent?.type !== 'string') {
        res.status(400).json({ success: false, message: 'Cada intent requiere id (≤64) y type' })
        return
      }
    }

    // Resolver permisos UNA vez por batch y evaluar cada intent con el permiso
    // de su ruta online equivalente. El replay no es una puerta trasera.
    const access = await getUserAccess(staffId, venueId)
    const acks = await syncService.processIntents({
      venueId,
      staffId,
      deviceId,
      intents,
      authorizeIntent: (_intent, requiredPermission) => hasPermission(access, requiredPermission),
    })
    res.status(200).json({ success: true, data: acks })
  } catch (error: any) {
    logger.error(`[SYNC MOBILE CONTROLLER] Error procesando intents: ${error.message}`)
    res.status(500).json({ success: false, message: 'Error interno al sincronizar' })
  }
}
