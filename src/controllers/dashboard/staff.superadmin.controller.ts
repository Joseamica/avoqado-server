import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as staffService from '../../services/superadmin/staff.superadmin.service'

// ===========================================
// LIST STAFF
// ===========================================

export async function listStaff(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, pageSize, search, active, organizationId, venueId, hasOrganization, hasVenue } = req.query as any

    const result = await staffService.listStaff({
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 20,
      search: search as string | undefined,
      active: active as 'true' | 'false' | 'all' | undefined,
      organizationId: organizationId as string | undefined,
      venueId: venueId as string | undefined,
      hasOrganization: hasOrganization === 'true',
      hasVenue: hasVenue === 'true',
    })

    logger.info(`[STAFF-SUPERADMIN] Listed ${result.staff.length} staff (page ${result.pagination.page}/${result.pagination.totalPages})`)
    return res.status(200).json(result)
  } catch (error) {
    logger.error('[STAFF-SUPERADMIN] Error listing staff', { error })
    next(error)
  }
}

// ===========================================
// GET STAFF BY ID
// ===========================================

export async function getStaffById(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId } = req.params
    const staff = await staffService.getStaffById(staffId)

    if (!staff) {
      return res.status(404).json({ error: 'Usuario no encontrado' })
    }

    logger.info(`[STAFF-SUPERADMIN] Retrieved staff: ${staff.email}`, { staffId })
    return res.status(200).json({ staff })
  } catch (error) {
    logger.error('[STAFF-SUPERADMIN] Error getting staff', { error })
    next(error)
  }
}

// ===========================================
// CREATE STAFF
// ===========================================

export async function createStaff(req: Request, res: Response, next: NextFunction) {
  try {
    const staff = await staffService.createStaff(req.body)
    return res.status(201).json({ staff })
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    logger.error('[STAFF-SUPERADMIN] Error creating staff', { error })
    next(error)
  }
}

// ===========================================
// UPDATE STAFF
// ===========================================

export async function updateStaff(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId } = req.params
    const staff = await staffService.updateStaff(staffId, req.body)
    return res.status(200).json({ staff })
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    logger.error('[STAFF-SUPERADMIN] Error updating staff', { error })
    next(error)
  }
}

// ===========================================
// ASSIGN TO ORGANIZATION
// ===========================================

export async function assignToOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId } = req.params
    const { organizationId, role } = req.body
    const staff = await staffService.assignToOrganization(staffId, organizationId, role)
    return res.status(200).json({ staff })
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    logger.error('[STAFF-SUPERADMIN] Error assigning to org', { error })
    next(error)
  }
}

// ===========================================
// REMOVE FROM ORGANIZATION
// ===========================================

export async function removeFromOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId, organizationId } = req.params
    const staff = await staffService.removeFromOrganization(staffId, organizationId)
    return res.status(200).json({ staff })
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    logger.error('[STAFF-SUPERADMIN] Error removing from org', { error })
    next(error)
  }
}

// ===========================================
// ASSIGN TO VENUE
// ===========================================

export async function assignToVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId } = req.params
    const { venueId, role, pin } = req.body
    const staff = await staffService.assignToVenue(staffId, venueId, role, pin)
    return res.status(200).json({ staff })
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    logger.error('[STAFF-SUPERADMIN] Error assigning to venue', { error })
    next(error)
  }
}

// ===========================================
// UPDATE VENUE ASSIGNMENT
// ===========================================

export async function updateVenueAssignment(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId, venueId } = req.params
    const staff = await staffService.updateVenueAssignment(staffId, venueId, req.body)
    return res.status(200).json({ staff })
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    logger.error('[STAFF-SUPERADMIN] Error updating venue assignment', { error })
    next(error)
  }
}

// ===========================================
// REMOVE FROM VENUE
// ===========================================

export async function removeFromVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId, venueId } = req.params
    const staff = await staffService.removeFromVenue(staffId, venueId)
    return res.status(200).json({ staff })
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    logger.error('[STAFF-SUPERADMIN] Error removing from venue', { error })
    next(error)
  }
}

// ===========================================
// DELETE STAFF
// ===========================================

export async function deleteStaff(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId } = req.params
    const { userId } = (req as any).authContext
    const result = await staffService.deleteStaff(staffId, userId)
    return res.status(200).json(result)
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    logger.error('[STAFF-SUPERADMIN] Error deleting staff', { error })
    next(error)
  }
}

// ===========================================
// RESET PASSWORD
// ===========================================

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId } = req.params
    const { newPassword } = req.body
    const result = await staffService.resetPassword(staffId, newPassword)
    return res.status(200).json(result)
  } catch (error: any) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    logger.error('[STAFF-SUPERADMIN] Error resetting password', { error })
    next(error)
  }
}
