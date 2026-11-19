import { Router, type RequestHandler } from 'express'
import { authenticateTokenMiddleware, requireVersionedSession } from '@/middlewares/authenticateToken.middleware'
import { requireJsonBodyMiddleware } from '@/middlewares/requireJsonBody.middleware'
import { validateRequest } from '@/middlewares/validation'
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'
import { assertSupportPrincipal } from '@/services/support/link.service'
import {
  supportChallengeSchema,
  supportDataAccessQuerySchema,
  supportDataAccessSchema,
  supportVerifySchema,
  supportVenuesSchema,
} from '@/schemas/supportWhatsapp.schema'
import * as controller from '@/controllers/supportWhatsapp.controller'

const router = Router()
const freshIdentity: RequestHandler = async (req, res, next) => {
  const ctx = req.authContext!
  if (req.get('X-Support-Staff-Id') !== ctx.userId)
    throw new ForbiddenError('Tu cuenta cambió. Abre de nuevo la ayuda desde tu sesión actual.', 'SUPPORT_IDENTITY_CHANGED')
  const session = ctx.sid ? await prisma.session.findUnique({ where: { id: ctx.sid } }) : null
  if (
    !session ||
    session.staffId !== ctx.userId ||
    session.revokedAt ||
    !session.strongAuthAt ||
    session.authMethod === 'PIN' ||
    session.deviceId ||
    ctx.isImpersonating ||
    ctx.terminalSerialNumber ||
    ctx.origen === 'POS' ||
    req.cookies?.liveDemoSessionId
  )
    throw new ForbiddenError('Usa tu sesión personal del panel para vincular WhatsApp.', 'SUPPORT_PERSONAL_SESSION_REQUIRED')
  await assertSupportPrincipal(ctx.userId, session.strongAuthAt)
  res.locals.supportStrongAuthAt = session.strongAuthAt
  if (req.method !== 'GET') {
    // JSON alone does not prevent authenticated cross-site requests.
    if (req.cookies?.accessToken) {
      const origin = req.get('Origin') ?? ''
      const permitted =
        ['https://dashboard.avoqado.io', 'https://dashboardv2.avoqado.io'].includes(origin) ||
        /^https:\/\/[a-z0-9-]+\.avoqado-web-dashboard-4wx\.pages\.dev$/.test(origin) ||
        (process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))
      if (!permitted) throw new ForbiddenError('Abre esta opción desde el panel de Avoqado.', 'SUPPORT_ORIGIN_REQUIRED')
    }
    const venue = /^[c][a-z0-9]{24}$/.test(session.venueId)
      ? await prisma.venue.findUnique({ where: { id: session.venueId }, select: { id: true, status: true } })
      : null
    if (venue?.status === 'LIVE_DEMO') throw new ForbiddenError('La demostración no envía códigos de WhatsApp.', 'SUPPORT_DEMO_DISABLED')
    res.locals.supportAuditVenueId = venue?.id
  }
  next()
}
router.use(authenticateTokenMiddleware, requireVersionedSession, requireJsonBodyMiddleware, freshIdentity)
router.get('/status', controller.status)
router.post('/challenge', validateRequest(supportChallengeSchema), controller.challenge)
router.post('/verify', validateRequest(supportVerifySchema), controller.verify)
router.post('/unlink', controller.unlinkPhone)
router.get('/venues', validateRequest(supportVenuesSchema), controller.venues)
router.get('/data-access', validateRequest(supportDataAccessQuerySchema), controller.dataAccess)
router.post('/data-access', validateRequest(supportDataAccessSchema), controller.grantData)
export default router
