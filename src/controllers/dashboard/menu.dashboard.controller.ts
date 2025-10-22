import { Request, Response, NextFunction } from 'express'
import * as menuCategoryService from '../../services/dashboard/menu.dashboard.service'
import * as venueService from '../../services/dashboard/venue.dashboard.service' // To verify venue ownership
import { CreateMenuCategoryDto, UpdateMenuCategoryDto, ReorderMenuCategoriesDto } from '../../schemas/dashboard/menuCategory.schema'
import {
  CreateMenuDto,
  UpdateMenuDto,
  CloneMenuDto,
  ReorderMenusDto,
  ReorderProductsDto,
  AssignCategoryToMenuDto,
  // Modifier DTOs
  CreateModifierGroupDto,
  UpdateModifierGroupDto,
  CreateModifierDto,
  UpdateModifierDto,
  AssignModifierGroupToProductDto,
} from '../../schemas/dashboard/menu.schema'
import { NotFoundError } from '../../errors/AppError'

// Helper to check venue access against authContext
async function checkVenueAccess(orgIdFromAuth: string, venueIdFromParams: string, userRole: string): Promise<void> {
  // SUPERADMIN can access any venue (skip org check)
  const skipOrgCheck = userRole === 'SUPERADMIN'
  const venue = await venueService.getVenueById(orgIdFromAuth, venueIdFromParams, { skipOrgCheck })
  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueIdFromParams} not found or not accessible by your organization.`)
  }
}

export async function getMenusHandler(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const menus = await menuCategoryService.getMenus(venueId)
    res.status(200).json(menus)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// MODIFIER GROUPS & MODIFIERS CONTROLLERS
// ==========================================

export async function listModifierGroupsHandler(
  req: Request<{ venueId: string }, {}, {}, any>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const groups = await menuCategoryService.getModifierGroups(venueId, req.query as any)
    res.status(200).json(groups)
  } catch (error) {
    next(error)
  }
}

export async function createModifierGroupHandler(
  req: Request<{ venueId: string }, {}, CreateModifierGroupDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const created = await menuCategoryService.createModifierGroup(venueId, req.body)
    res.status(201).json(created)
  } catch (error) {
    next(error)
  }
}

export async function getModifierGroupHandler(
  req: Request<{ venueId: string; modifierGroupId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, modifierGroupId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const group = await menuCategoryService.getModifierGroupById(venueId, modifierGroupId)
    res.status(200).json(group)
  } catch (error) {
    next(error)
  }
}

export async function updateModifierGroupHandler(
  req: Request<{ venueId: string; modifierGroupId: string }, {}, UpdateModifierGroupDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, modifierGroupId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const updated = await menuCategoryService.updateModifierGroup(venueId, modifierGroupId, req.body)
    res.status(200).json(updated)
  } catch (error) {
    next(error)
  }
}

export async function deleteModifierGroupHandler(
  req: Request<{ venueId: string; modifierGroupId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, modifierGroupId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    await menuCategoryService.deleteModifierGroup(venueId, modifierGroupId)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

export async function listModifiersHandler(
  req: Request<{ venueId: string; modifierGroupId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, modifierGroupId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const group = await menuCategoryService.getModifierGroupById(venueId, modifierGroupId)
    res.status(200).json(group.modifiers)
  } catch (error) {
    next(error)
  }
}

export async function createModifierHandler(
  req: Request<{ venueId: string; modifierGroupId: string }, {}, CreateModifierDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, modifierGroupId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const created = await menuCategoryService.createModifier(venueId, modifierGroupId, req.body)
    res.status(201).json(created)
  } catch (error) {
    next(error)
  }
}

export async function getModifierHandler(
  req: Request<{ venueId: string; modifierGroupId: string; modifierId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, modifierGroupId, modifierId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const modifier = await menuCategoryService.getModifierById(venueId, modifierGroupId, modifierId)
    res.status(200).json(modifier)
  } catch (error) {
    next(error)
  }
}

export async function updateModifierHandler(
  req: Request<{ venueId: string; modifierGroupId: string; modifierId: string }, {}, UpdateModifierDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, modifierGroupId, modifierId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const updated = await menuCategoryService.updateModifier(venueId, modifierGroupId, modifierId, req.body)
    res.status(200).json(updated)
  } catch (error) {
    next(error)
  }
}

export async function deleteModifierHandler(
  req: Request<{ venueId: string; modifierGroupId: string; modifierId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, modifierGroupId, modifierId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    await menuCategoryService.deleteModifier(venueId, modifierGroupId, modifierId)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

export async function assignModifierGroupToProductHandler(
  req: Request<{ venueId: string; productId: string }, {}, AssignModifierGroupToProductDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, productId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const assignment = await menuCategoryService.assignModifierGroupToProduct(venueId, productId, req.body)
    res.status(201).json(assignment)
  } catch (error) {
    next(error)
  }
}

export async function removeModifierGroupFromProductHandler(
  req: Request<{ venueId: string; productId: string; modifierGroupId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, productId, modifierGroupId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    await menuCategoryService.removeModifierGroupFromProduct(venueId, productId, modifierGroupId)
    res.status(204).send()
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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    const newMenu = await menuCategoryService.createMenu(venueId, req.body)
    res.status(201).json(newMenu)
  } catch (error) {
    next(error)
  }
}

export async function getMenuHandler(req: Request<{ venueId: string; menuId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, menuId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

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
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    await menuCategoryService.removeCategoryFromMenu(venueId, menuId, categoryId)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

export async function reorderProductsHandler(
  req: Request<{ venueId: string }, {}, ReorderProductsDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Authentication context not found. Organization ID is missing.'))
    }
    await checkVenueAccess(orgId, venueId, req.authContext?.role || '')

    await menuCategoryService.reorderProducts(venueId, req.body)
    res.status(200).json({ message: 'Products reordered successfully.' })
  } catch (error) {
    next(error)
  }
}
