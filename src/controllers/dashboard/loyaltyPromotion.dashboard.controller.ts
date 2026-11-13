/** Promociones de lealtad del panel: capa HTTP delgada; las reglas viven en `loyaltyPromotion.service.ts`. */
import { Request, Response } from 'express'
import * as service from '@/services/loyalty/promotions/loyaltyPromotion.service'

const actor = (req: Request): string => (req as any).authContext.userId

/** GET /venues/:venueId/loyalty/promotions?status&page&pageSize */
export async function listLoyaltyPromotions(req: Request, res: Response) {
  res.json(await service.listLoyaltyPromotions(req.params.venueId, req.query as service.ListLoyaltyPromotionsQuery))
}

/** POST /venues/:venueId/loyalty/promotions */
export async function createLoyaltyPromotion(req: Request, res: Response) {
  res.status(201).json(await service.createLoyaltyPromotion(req.params.venueId, req.body, actor(req)))
}

/** PATCH /venues/:venueId/loyalty/promotions/:id */
export async function updateLoyaltyPromotion(req: Request, res: Response) {
  res.json(await service.updateLoyaltyPromotion(req.params.venueId, req.params.id, req.body, actor(req)))
}

/** POST /venues/:venueId/loyalty/promotions/:id/end */
export async function endLoyaltyPromotion(req: Request, res: Response) {
  res.json(await service.endLoyaltyPromotion(req.params.venueId, req.params.id, actor(req)))
}
