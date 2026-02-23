/**
 * Product Mobile Controller
 *
 * Lightweight endpoints for iOS/Android product-related data.
 * Returns simplified payloads optimized for mobile apps.
 */

import { Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

/**
 * GET /api/v1/mobile/venues/:venueId/categories
 *
 * Returns simplified category list for mobile apps (create product flow).
 */
export async function listCategories(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const categories = await prisma.menuCategory.findMany({
      where: { venueId },
      orderBy: { displayOrder: 'asc' },
      select: {
        id: true,
        name: true,
        color: true,
      },
    })

    return res.json(categories)
  } catch (error) {
    logger.error('Error in listCategories (mobile)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.params.venueId,
    })

    return res.status(500).json({
      success: false,
      message: 'Error al cargar categorías',
    })
  }
}
