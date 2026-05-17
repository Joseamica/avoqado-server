/**
 * Google Calendar Sync — OAuth + connection routes (Phase 1).
 *
 * Mounted at `/api/v1/google-calendar` in `src/routes/index.ts`.
 *
 *   GET    /oauth/init       — auth required, returns Google auth URL
 *   GET    /oauth/callback   — UNAUTHENTICATED, Google's redirect target
 *   GET    /oauth/calendars  — auth required, returns picker list
 *   POST   /connections      — auth required, commits the connection
 *   GET    /connections      — auth required, lists caller's connections
 *   DELETE /connections/:id  — auth required, disconnects a connection
 *
 * The callback route is intentionally NOT authenticated — Google's top-level
 * redirect lands cookieless, and we use a signed `state` JWT instead. Do not
 * add `authenticateTokenMiddleware` to that route.
 */
import { Router } from 'express'

import {
  disconnectConnection,
  getConnectionDetail,
  listCalendars,
  listConnections,
  oauthCallback,
  oauthInit,
  postConnection,
} from '@/controllers/google-calendar.controller'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'

const router = Router()

router.get('/oauth/init', authenticateTokenMiddleware, oauthInit)
// ⚠️ NO auth middleware — Google's redirect lands without cookies. State JWT
// is verified inside the handler.
router.get('/oauth/callback', oauthCallback)
router.get('/oauth/calendars', authenticateTokenMiddleware, listCalendars)

router.post('/connections', authenticateTokenMiddleware, postConnection)
router.get('/connections', authenticateTokenMiddleware, listConnections)
router.get('/connections/:id', authenticateTokenMiddleware, getConnectionDetail)
router.delete('/connections/:id', authenticateTokenMiddleware, disconnectConnection)

export default router
