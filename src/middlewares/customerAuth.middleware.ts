/**
 * Customer Authentication Middleware
 *
 * Verifies customer JWT tokens for the public customer portal.
 * Separate from staff auth — uses `type: 'customer'` claim.
 */

import { Request, Response, NextFunction } from 'express'
import { verifyCustomerToken } from '../jwt.service'

export interface CustomerAuthContext {
  customerId: string
  venueId: string
}

export function authenticateCustomer(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Se requiere autenticación' })
  }

  const token = authHeader.slice(7)

  try {
    const payload = verifyCustomerToken(token)
    ;(req as any).customerAuth = {
      customerId: payload.sub,
      venueId: payload.venueId,
    } as CustomerAuthContext
    next()
  } catch {
    return res.status(401).json({ message: 'Token inválido o expirado' })
  }
}
