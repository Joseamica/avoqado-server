import { NextFunction, Request, Response } from 'express'

import { BadRequestError } from '@/errors/AppError'
import * as promotionService from '@/services/dashboard/promotion.dashboard.service'
import { getPromotionsQuerySchema } from '@/schemas/dashboard/promotion.schema'

function actor(req: Request): string | undefined {
  return (req as any).authContext?.userId
}

export async function getPromotions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const query = getPromotionsQuerySchema.parse(req.query)
    res.json(await promotionService.getPromotions(venueId, query.page, query.pageSize, query.status, query.search))
  } catch (error) {
    next(error)
  }
}

export async function getPromotionById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, promotionId } = req.params
    res.json(await promotionService.getPromotionById(venueId, promotionId))
  } catch (error) {
    next(error)
  }
}

export async function createPromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    res.status(201).json(await promotionService.createPromotion(venueId, req.body, actor(req)))
  } catch (error) {
    next(error)
  }
}

export async function updatePromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, promotionId } = req.params
    res.json(await promotionService.updatePromotion(venueId, promotionId, req.body, actor(req)))
  } catch (error) {
    // 🔴 Mismo contrato que publishPromotion: editar una PUBLISHED revalida con
    // el MISMO validador de publicar, y el dashboard ya lee errors[] en ese
    // flujo — para que la lista de promociones pinte todos los motivos juntos.
    if (error instanceof BadRequestError) {
      res.status(400).json({ errors: error.message.split('\n') })
      return
    }
    next(error)
  }
}

export async function publishPromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, promotionId } = req.params
    res.json(await promotionService.publishPromotion(venueId, promotionId, actor(req)))
  } catch (error) {
    // 🔴 TODO BadRequestError de publish sale como { errors: [...] } — también
    // cuando es UN solo motivo (audit 2026-08-14: con un error único, dejarlo
    // pasar a next() respondía { message } y el dashboard esperaba errors[]).
    if (error instanceof BadRequestError) {
      res.status(400).json({ errors: error.message.split('\n') })
      return
    }
    next(error)
  }
}

export async function archivePromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, promotionId } = req.params
    res.json(await promotionService.archivePromotion(venueId, promotionId, actor(req)))
  } catch (error) {
    next(error)
  }
}

export async function unarchivePromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, promotionId } = req.params
    res.json(await promotionService.unarchivePromotion(venueId, promotionId, actor(req)))
  } catch (error) {
    next(error)
  }
}

export async function deletePromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, promotionId } = req.params
    await promotionService.deletePromotion(venueId, promotionId, actor(req))
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}
