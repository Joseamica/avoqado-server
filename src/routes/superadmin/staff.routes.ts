import { Router } from 'express'
import * as staffController from '../../controllers/dashboard/staff.superadmin.controller'
import { validateRequest } from '../../middlewares/validation'
import {
  listStaffQuerySchema,
  staffIdParamSchema,
  createStaffSchema,
  updateStaffSchema,
  assignOrgSchema,
  removeOrgSchema,
  assignVenueSchema,
  updateVenueAssignmentSchema,
  staffVenueParamSchema,
  resetPasswordSchema,
} from '../../schemas/dashboard/superadmin-staff.schema'

const router = Router()

/**
 * Staff Management Routes
 * Base path: /api/v1/dashboard/superadmin/staff
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// ===========================================
// STAFF CRUD
// ===========================================

/**
 * @route   GET /api/v1/dashboard/superadmin/staff
 * @desc    List staff with pagination, search, and filters
 * @access  Superadmin only
 */
router.get('/', validateRequest(listStaffQuerySchema), staffController.listStaff)

/**
 * @route   POST /api/v1/dashboard/superadmin/staff
 * @desc    Create new staff with org membership and optional venue assignment
 * @access  Superadmin only
 */
router.post('/', validateRequest(createStaffSchema), staffController.createStaff)

/**
 * @route   GET /api/v1/dashboard/superadmin/staff/:staffId
 * @desc    Get staff detail with all orgs and venues
 * @access  Superadmin only
 */
router.get('/:staffId', validateRequest(staffIdParamSchema), staffController.getStaffById)

/**
 * @route   PATCH /api/v1/dashboard/superadmin/staff/:staffId
 * @desc    Update staff profile
 * @access  Superadmin only
 */
router.patch('/:staffId', validateRequest(updateStaffSchema), staffController.updateStaff)

// ===========================================
// ORGANIZATION MEMBERSHIP
// ===========================================

/**
 * @route   POST /api/v1/dashboard/superadmin/staff/:staffId/organizations
 * @desc    Assign staff to an organization
 * @access  Superadmin only
 */
router.post('/:staffId/organizations', validateRequest(assignOrgSchema), staffController.assignToOrganization)

/**
 * @route   DELETE /api/v1/dashboard/superadmin/staff/:staffId/organizations/:organizationId
 * @desc    Remove staff from organization (soft delete)
 * @access  Superadmin only
 */
router.delete('/:staffId/organizations/:organizationId', validateRequest(removeOrgSchema), staffController.removeFromOrganization)

// ===========================================
// VENUE ASSIGNMENT
// ===========================================

/**
 * @route   POST /api/v1/dashboard/superadmin/staff/:staffId/venues
 * @desc    Assign staff to a venue
 * @access  Superadmin only
 */
router.post('/:staffId/venues', validateRequest(assignVenueSchema), staffController.assignToVenue)

/**
 * @route   PATCH /api/v1/dashboard/superadmin/staff/:staffId/venues/:venueId
 * @desc    Update venue assignment (role, pin, active)
 * @access  Superadmin only
 */
router.patch('/:staffId/venues/:venueId', validateRequest(updateVenueAssignmentSchema), staffController.updateVenueAssignment)

/**
 * @route   DELETE /api/v1/dashboard/superadmin/staff/:staffId/venues/:venueId
 * @desc    Remove staff from venue (soft delete)
 * @access  Superadmin only
 */
router.delete('/:staffId/venues/:venueId', validateRequest(staffVenueParamSchema), staffController.removeFromVenue)

// ===========================================
// PASSWORD MANAGEMENT
// ===========================================

/**
 * @route   POST /api/v1/dashboard/superadmin/staff/:staffId/reset-password
 * @desc    Reset staff password (superadmin sets new password)
 * @access  Superadmin only
 */
router.post('/:staffId/reset-password', validateRequest(resetPasswordSchema), staffController.resetPassword)

export default router
