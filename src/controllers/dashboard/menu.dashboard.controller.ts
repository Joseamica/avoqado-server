import { Request, Response, NextFunction } from 'express'
import * as menuCategoryService from '../../services/dashboard/menu.dashboard.service'
import * as venueService from '../../services/dashboard/venue.dashboard.service' // To verify venue ownership
import { CreateMenuCategoryDto, UpdateMenuCategoryDto, ReorderMenuCategoriesDto } from '../../schemas/dashboard/menuCategory.schema'
import { 
  CreateMenuDto,
  UpdateMenuDto,
  CloneMenuDto,
  ReorderMenusDto,
  AssignCategoryToMenuDto
} from '../../schemas/dashboard/menu.schema'
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

// ==========================================
// MENU CONTROLLERS
// ==========================================

export async function createMenuHandler(
  req: Request<{ venueId: string }, {}, CreateMenuDto>,
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

    const newMenu = await menuCategoryService.createMenu(venueId, req.body)
    res.status(201).json(newMenu)
  } catch (error) {
    next(error)
  }
}

export async function getMenuHandler(
  req: Request<{ venueId: string; menuId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, menuId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    const menu = await menuCategoryService.getMenuById(venueId, menuId)
    res.status(200).json(menu)
  } catch (error) {
    next(error)
  }
}

export async function updateMenuHandler(
  req: Request<{ venueId: string; menuId: string }, {}, UpdateMenuDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, menuId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    const updatedMenu = await menuCategoryService.updateMenu(venueId, menuId, req.body)
    res.status(200).json(updatedMenu)
  } catch (error) {
    next(error)
  }
}

export async function deleteMenuHandler(
  req: Request<{ venueId: string; menuId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, menuId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    await menuCategoryService.deleteMenu(venueId, menuId)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

export async function cloneMenuHandler(
  req: Request<{ venueId: string; menuId: string }, {}, CloneMenuDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, menuId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    const clonedMenu = await menuCategoryService.cloneMenu(venueId, menuId, req.body)
    res.status(201).json(clonedMenu)
  } catch (error) {
    next(error)
  }
}

export async function reorderMenusHandler(
  req: Request<{ venueId: string }, {}, ReorderMenusDto>,
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

    await menuCategoryService.reorderMenus(venueId, req.body)
    res.status(200).json({ message: 'Menus reordered successfully.' })
  } catch (error) {
    next(error)
  }
}

export async function assignCategoryToMenuHandler(
  req: Request<{ venueId: string; menuId: string }, {}, AssignCategoryToMenuDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, menuId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    const assignment = await menuCategoryService.assignCategoryToMenu(venueId, menuId, req.body)
    res.status(201).json(assignment)
  } catch (error) {
    next(error)
  }
}

export async function removeCategoryFromMenuHandler(
  req: Request<{ venueId: string; menuId: string; categoryId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, menuId, categoryId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId)

    await menuCategoryService.removeCategoryFromMenu(venueId, menuId, categoryId)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}
