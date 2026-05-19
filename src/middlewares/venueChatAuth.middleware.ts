import { NextFunction, Request, Response } from 'express'

import { verifyAccessToken } from '@/utils/sessionToken'
import prisma from '@/utils/prismaClient'

// Bearer-token auth for the customer-facing venue-chat endpoints. The token
// was minted at session creation time and only its sha256 hash is stored.
// On match, attaches the resolved session to req for downstream handlers.
export async function venueChatAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('Authorization') || ''
  const m = header.match(/^Bearer\s+(.+)$/)
  if (!m) return res.sendStatus(401)
  const presentedToken = m[1].trim()

  const sessionId = req.params.id
  if (!sessionId) return res.sendStatus(400)

  const session = await prisma.venueChatSession.findUnique({ where: { id: sessionId } })
  if (!session) return res.sendStatus(404)
  if (!verifyAccessToken(presentedToken, session.accessTokenHash)) return res.sendStatus(401)
  ;(req as Request & { venueChatSession?: typeof session }).venueChatSession = session
  next()
}
