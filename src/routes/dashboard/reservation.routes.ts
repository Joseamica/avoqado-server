import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/reservation.dashboard.controller'
import * as waitlistService from '../../services/dashboard/reservationWaitlist.service'
import { getReservationSettings } from '../../services/dashboard/reservationSettings.service'
import {
  getReservationsQuerySchema,
  getAvailabilityQuerySchema,
  getWaitlistQuerySchema,
  getStatsQuerySchema,
  getCalendarQuerySchema,
  createReservationBodySchema,
  updateReservationBodySchema,
  rescheduleBodySchema,
  updateReservationSettingsBodySchema,
  addToWaitlistBodySchema,
  promoteWaitlistBodySchema,
  venueParamsSchema,
  waitlistEntryParamsSchema,
  staffScheduleParamsSchema,
  productStaffParamsSchema,
  replaceStaffScheduleBodySchema,
  replaceProductStaffBodySchema,
} from '../../schemas/dashboard/reservation.schema'
import { updateReservationBrandingSchema } from '../../schemas/dashboard/reservationBranding.schema'

// ==========================================
// RESERVATION ROUTES (Permission-gated — core Avoqado feature)
// ==========================================

const router = Router({ mergeParams: true })

// ---- List / Stats / Calendar / Availability ----

router.get(
  '/',
  checkPermission('reservations:read'),
  validateRequest(z.object({ query: getReservationsQuerySchema })),
  controller.getReservations,
)

router.get('/stats', checkPermission('reservations:read'), validateRequest(z.object({ query: getStatsQuerySchema })), controller.getStats)

router.get(
  '/calendar',
  checkPermission('reservations:read'),
  validateRequest(z.object({ query: getCalendarQuerySchema })),
  controller.getCalendar,
)

router.get(
  '/availability',
  checkPermission('reservations:read'),
  validateRequest(z.object({ query: getAvailabilityQuerySchema })),
  controller.getAvailability,
)

// ---- Settings (MUST be before /:id to avoid shadowing) ----

router.get('/settings', checkPermission('reservations:read'), controller.getSettings)
router.put(
  '/settings',
  checkPermission('reservations:update'),
  validateRequest(z.object({ body: updateReservationSettingsBodySchema })),
  controller.updateSettings,
)

// ---- Branding (MUST be before /:id to avoid shadowing) ----
// GET/PUT /venues/:venueId/reservations/branding/config
router.get('/branding/config', checkPermission('reservations:read'), controller.getReservationBranding)
router.put(
  '/branding/config',
  checkPermission('reservations:update'),
  validateRequest(updateReservationBrandingSchema),
  controller.updateReservationBranding,
)

// ---- Waitlist (MUST be before /:id to avoid shadowing) ----

router.get(
  '/waitlist',
  checkPermission('reservations:read'),
  validateRequest(z.object({ params: venueParamsSchema, query: getWaitlistQuerySchema })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const venueId = req.params.venueId
      const entries = await waitlistService.getWaitlist(venueId, req.query.status as any)
      res.json(entries)
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/waitlist',
  checkPermission('reservations:create'),
  validateRequest(z.object({ body: addToWaitlistBodySchema })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const venueId = req.params.venueId
      const settings = await getReservationSettings(venueId)
      const entry = await waitlistService.addToWaitlist(venueId, req.body, settings)
      res.status(201).json(entry)
    } catch (error) {
      next(error)
    }
  },
)

router.delete(
  '/waitlist/:entryId',
  checkPermission('reservations:cancel'),
  validateRequest(z.object({ params: waitlistEntryParamsSchema })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const venueId = req.params.venueId
      await waitlistService.removeFromWaitlist(venueId, req.params.entryId)
      res.status(204).send()
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/waitlist/:entryId/promote',
  checkPermission('reservations:update'),
  validateRequest(z.object({ params: waitlistEntryParamsSchema, body: promoteWaitlistBodySchema })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const venueId = req.params.venueId
      const { reservationId } = req.body
      const entry = await waitlistService.promoteWaitlistEntry(venueId, req.params.entryId, reservationId)
      res.json(entry)
    } catch (error) {
      next(error)
    }
  },
)

// ---- CRUD ----

router.post(
  '/',
  checkPermission('reservations:create'),
  validateRequest(z.object({ body: createReservationBodySchema })),
  controller.createReservation,
)

// ---- Staff schedules and service mappings (MUST be before /:id) ----

router.get(
  '/staff/:staffVenueId/schedule',
  checkPermission('teams:read'),
  validateRequest(z.object({ params: staffScheduleParamsSchema })),
  controller.getStaffSchedule,
)
router.put(
  '/staff/:staffVenueId/schedule',
  checkPermission('teams:update'),
  validateRequest(z.object({ params: staffScheduleParamsSchema, body: replaceStaffScheduleBodySchema })),
  controller.replaceStaffSchedule,
)
router.get(
  '/products/:productId/staff',
  checkPermission('menu:read'),
  validateRequest(z.object({ params: productStaffParamsSchema })),
  controller.getProductStaff,
)
router.put(
  '/products/:productId/staff',
  checkPermission('menu:update'),
  validateRequest(z.object({ params: productStaffParamsSchema, body: replaceProductStaffBodySchema })),
  controller.replaceProductStaff,
)

router.get('/:id', checkPermission('reservations:read'), controller.getReservation)

router.put(
  '/:id',
  checkPermission('reservations:update'),
  validateRequest(z.object({ body: updateReservationBodySchema })),
  controller.updateReservation,
)

router.delete('/:id', checkPermission('reservations:cancel'), controller.deleteReservation)

// ---- State Transitions ----

router.post('/:id/confirm', checkPermission('reservations:update'), controller.confirmReservation)
router.post('/:id/check-in', checkPermission('reservations:update'), controller.checkInReservation)
router.post('/:id/complete', checkPermission('reservations:update'), controller.completeReservation)
router.post('/:id/no-show', checkPermission('reservations:update'), controller.markNoShow)

router.post(
  '/:id/reschedule',
  checkPermission('reservations:update'),
  validateRequest(z.object({ body: rescheduleBodySchema })),
  controller.rescheduleReservation,
)

export default router
