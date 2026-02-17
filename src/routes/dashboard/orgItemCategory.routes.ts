/**
 * Org Item Category Routes
 * CRUD for organization-level item categories.
 *
 * Base path: /api/v1/dashboard/venues/:venueId/org-item-categories
 * Middleware: authenticateToken + verifyAccess (white-label required)
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { verifyAccess } from '../../middlewares/verifyAccess.middleware'
import * as orgCategoryService from '../../services/dashboard/orgItemCategory.dashboard.service'

const router = Router({ mergeParams: true })

const whiteLabelAccess = [authenticateTokenMiddleware, verifyAccess({ requireWhiteLabel: true })]

/**
 * GET /org-item-categories
 * List all org-level categories for the venue's organization
 */
router.get('/', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const categories = await orgCategoryService.getOrgCategories(venueId)

    res.json({ success: true, data: { categories } })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /org-item-categories
 * Create a new org-level category
 */
router.post('/', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { name, description, color, sortOrder, requiresPreRegistration, suggestedPrice, barcodePattern } = req.body

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: 'name is required',
      })
    }

    const category = await orgCategoryService.createOrgCategory(venueId, {
      name,
      description,
      color,
      sortOrder,
      requiresPreRegistration,
      suggestedPrice,
      barcodePattern,
    })

    res.status(201).json({ success: true, data: category })
  } catch (error) {
    next(error)
  }
})

/**
 * PUT /org-item-categories/:categoryId
 * Update an org-level category
 */
router.put('/:categoryId', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { categoryId } = req.params
    const { name, description, color, sortOrder, requiresPreRegistration, suggestedPrice, barcodePattern, active } = req.body

    const category = await orgCategoryService.updateOrgCategory(venueId, categoryId, {
      name,
      description,
      color,
      sortOrder,
      requiresPreRegistration,
      suggestedPrice,
      barcodePattern,
      active,
    })

    res.json({ success: true, data: category })
  } catch (error) {
    next(error)
  }
})

/**
 * DELETE /org-item-categories/:categoryId
 * Delete an org-level category (soft if has items, hard if empty)
 */
router.delete('/:categoryId', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { categoryId } = req.params

    const result = await orgCategoryService.deleteOrgCategory(venueId, categoryId)

    res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
})

export default router
