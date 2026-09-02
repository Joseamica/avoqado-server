import type { RequestHandler } from 'express'
import { env } from '@/config/env'
import { assertCommercialV2CheckoutActive } from '@/services/commercial/commercialV2CheckoutPolicy.service'

export const requireCommercialV2CheckoutActive: RequestHandler = (_req, _res, next) => {
  try {
    assertCommercialV2CheckoutActive(env.COMMERCIAL_V2_CHECKOUT_MODE)
    next()
  } catch (error) {
    next(error)
  }
}
