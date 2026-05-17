/**
 * Google Calendar Sync — Dashboard venue-scoped routes (Phase 3).
 *
 * Mounted at `/api/v1/dashboard/venues/:venueId/google-calendar` from
 * `src/routes/dashboard.routes.ts`.
 *
 *   GET  /busy-blocks                Availability overlay rows (calendar:view_status)
 *   GET  /outbox/dead-letter         Dead-letter outbox list   (calendar:view_status)
 *   POST /outbox/:rowId/retry        Reset a DLQ row → PENDING (calendar:manage_venue)
 *
 * `authenticateTokenMiddleware` is applied by the parent router; here we layer
 * on permission checks per route.
 */
import { Router } from 'express'

import { listBusyBlocks, listDeadLetterOutbox, retryDeadLetterOutbox } from '../../controllers/dashboard/googleCalendarStatus.controller'
import { checkPermission } from '../../middlewares/checkPermission.middleware'

const router = Router({ mergeParams: true })

router.get('/busy-blocks', checkPermission('calendar:view_status'), listBusyBlocks)
router.get('/outbox/dead-letter', checkPermission('calendar:view_status'), listDeadLetterOutbox)
router.post('/outbox/:rowId/retry', checkPermission('calendar:manage_venue'), retryDeadLetterOutbox)

export default router
