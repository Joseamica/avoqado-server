import { Request, Response, NextFunction } from 'express'
import * as menuCategoryService from '../../services/dashboard/menu.dashboard.service'
import * as venueService from '../../services/dashboard/venue.dashboard.service' // To verify venue ownership
import { CreateMenuCategoryDto, UpdateMenuCategoryDto, ReorderMenuCategoriesDto } from '../../schemas/dashboard/menuCategory.schema'
import { NotFoundError } from '../../errors/AppError'

// Helper to check venue access against authContext
async function checkVenueAccess(orgIdFromAuth: string, venueIdFromParams: string): Promise<void> {
  const venue = await venueService.getVenueById(orgIdFromAuth, venueIdFromParams)
  if (!venue) {
    // Should be caught by getVenueById if orgId doesn't match, but double check
    throw new NotFoundError(`Venue with ID ${venueIdFromParams} not found or not accessible by your organization.`)
  }
  // If getVenueById in venueService correctly checks orgId, this specific check might be redundant
  // but it's good for clarity or if getVenueById's behavior changes.
}

export async function getMenusHandler(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    const menus = await menuCategoryService.getMenus(venueId)
    res.status(200).json(menus)
  } catch (error) {
    next(error)
  }
}

export async function createMenuCategoryHandler(
  req: Request<{ venueId: string }, {}, CreateMenuCategoryDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const orgId = req.authContext?.orgId

    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    // Ensure the venue belongs to the user's organization
    await checkVenueAccess(orgId, venueId)

    const newCategory = await menuCategoryService.createMenuCategory(venueId, req.body)
    res.status(201).json(newCategory)
  } catch (error) {
    next(error)
  }
}

export async function listMenuCategoriesHandler(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    const categories = await menuCategoryService.listMenuCategoriesForVenue(venueId)
    res.status(200).json(categories)
  } catch (error) {
    next(error)
  }
}

export async function getMenuCategoryHandler(
  req: Request<{ venueId: string; categoryId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, categoryId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    const category = await menuCategoryService.getMenuCategoryById(venueId, categoryId)
    res.status(200).json(category)
  } catch (error) {
    next(error)
  }
}

export async function updateMenuCategoryHandler(
  req: Request<{ venueId: string; categoryId: string }, {}, UpdateMenuCategoryDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, categoryId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    const updatedCategory = await menuCategoryService.updateMenuCategory(venueId, categoryId, req.body)
    res.status(200).json(updatedCategory)
  } catch (error) {
    next(error)
  }
}

export async function deleteMenuCategoryHandler(
  req: Request<{ venueId: string; categoryId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, categoryId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    await menuCategoryService.deleteMenuCategory(venueId, categoryId)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

export async function reorderMenuCategoriesHandler(
  req: Request<{ venueId: string }, {}, ReorderMenuCategoriesDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    await menuCategoryService.reorderMenuCategories(venueId, req.body)
    res.status(200).json({ message: 'Menu categories reordered successfully.' })
  } catch (error) {
    next(error)
  }
}
