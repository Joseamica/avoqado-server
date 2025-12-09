// src/routes/index.ts
import express from 'express'
import dashboardRoutes from './dashboard.routes'
import analyticsRoutes from './analytics.routes'
import organizationRoutes from './organization.routes'
import tpvRoutes from './tpv.routes'
import publicRoutes from './public.routes'
import posSyncRoutes from './pos-sync.routes'
import invitationRoutes from './invitations.routes'
import onboardingRoutes from './onboarding.routes'
import superadminRoutes from './superadmin.routes'
import liveDemoRoutes from './liveDemo.routes'
import demoRoutes from './demo.routes'
import sdkRoutes from './sdk.routes'

const router = express.Router({ mergeParams: true })

router.use('/dashboard', dashboardRoutes) // All dashboard routes under /api/v1/dashboard
router.use('/analytics', analyticsRoutes) // Executive analytics endpoints
router.use('/organizations', organizationRoutes) // Organization-level routes for OWNER dashboard
router.use('/tpv', tpvRoutes) // All TPV routes under /api/v1/tpv
router.use('/public', publicRoutes) // All public routes under /api/v1/public
router.use('/pos-sync', posSyncRoutes) // All posSync routes under /api/posSync
router.use('/invitations', invitationRoutes) // All invitation routes under /api/v1/invitations
router.use('/onboarding', onboardingRoutes) // All onboarding routes under /api/v1/onboarding
router.use('/superadmin', superadminRoutes) // All superadmin routes under /api/v1/superadmin
router.use('/live-demo', liveDemoRoutes) // Live demo routes for demo.dashboard.avoqado.io
router.use('/demo', demoRoutes) // Legacy demo redirects for obsolete QR codes
router.use('/sdk', sdkRoutes) // Avoqado Payment SDK routes under /api/v1/sdk

export default router
