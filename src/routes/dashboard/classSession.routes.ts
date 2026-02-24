import { Router } from 'express'
import { z } from 'zod'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/classSession.dashboard.controller'
import {
  sessionParamsSchema,
  attendeeParamsSchema,
  createClassSessionSchema,
  updateClassSessionSchema,
  listClassSessionsQuerySchema,
  addAttendeeSchema,
} from '../../schemas/dashboard/classSession.schema'

// ==========================================
// CLASS SESSION ROUTES
// ==========================================

const router = Router({ mergeParams: true })

// ---- List ----

router.get(
  '/',
  checkPermission('reservations:read'),
  validateRequest(z.object({ query: listClassSessionsQuerySchema })),
  controller.getClassSessions,
)

// ---- Create ----

router.post(
  '/',
  checkPermission('reservations:create'),
  validateRequest(z.object({ body: createClassSessionSchema })),
  controller.createClassSession,
)

// ---- Get one ----

router.get(
  '/:sessionId',
  checkPermission('reservations:read'),
  validateRequest(z.object({ params: sessionParamsSchema })),
  controller.getClassSession,
)

// ---- Update ----

router.patch(
  '/:sessionId',
  checkPermission('reservations:update'),
  validateRequest(z.object({ params: sessionParamsSchema, body: updateClassSessionSchema })),
  controller.updateClassSession,
)

// ---- Cancel ----

router.post(
  '/:sessionId/cancel',
  checkPermission('reservations:cancel'),
  validateRequest(z.object({ params: sessionParamsSchema })),
  controller.cancelClassSession,
)

// ---- Attendees ----

router.post(
  '/:sessionId/attendees',
  checkPermission('reservations:create'),
  validateRequest(z.object({ params: sessionParamsSchema, body: addAttendeeSchema })),
  controller.addAttendee,
)

router.delete(
  '/:sessionId/attendees/:reservationId',
  checkPermission('reservations:cancel'),
  validateRequest(z.object({ params: attendeeParamsSchema })),
  controller.removeAttendee,
)

export default router
