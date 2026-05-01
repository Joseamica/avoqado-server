import { Request, Response, NextFunction } from 'express'
import { verifyConsumerToken } from '../jwt.service'

export interface ConsumerAuthContext {
  consumerId: string
}

export function authenticateConsumer(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Se requiere autenticacion' })
  }

  try {
    const payload = verifyConsumerToken(authHeader.slice(7))
    ;(req as any).consumerAuth = { consumerId: payload.sub } as ConsumerAuthContext
    next()
  } catch {
    return res.status(401).json({ message: 'Token invalido o expirado' })
  }
}
