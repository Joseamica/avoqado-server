import documentRequestsRoutes from './superadmin/documentRequests.routes'
import hybridCampaignRoutes from './superadmin/hybridCampaign.routes'
import hybridPricingRoutes from './superadmin/hybridPricing.routes'
// src/routes/superadmin.routes.ts
import express from 'express'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { authorizeRole } from '../middlewares/authorizeRole.middleware'
import { StaffRole } from '@prisma/client'
import { validateRequest } from '../middlewares/validation'
import * as organizationController from '../controllers/dashboard/organizations.superadmin.controller'
import { setOrganizationGrandfatheredSchema } from '../schemas/superadmin/organizationGrandfathered.schema'

// Import superadmin sub-routes
import kycReviewRoutes from './superadmin/kycReview.routes'
import paymentProviderRoutes from './superadmin/paymentProvider.routes'
import merchantAccountRoutes from './superadmin/merchantAccount.routes'
import paymentAnalyticsRoutes from './superadmin/paymentAnalytics.routes'
import earningsRoutes from './superadmin/earnings.routes'
import providerCostStructureRoutes from './superadmin/providerCostStructure.routes'
import venuePricingRoutes from './superadmin/venuePricing.routes'
import paymentPositionsRoutes from './superadmin/paymentPositions.routes'
import webhookRoutes from './superadmin/webhook.routes'
import terminalRoutes from './superadmin/terminal.routes'
import venueAccessRoutes from './superadmin/venue-access.routes'
import venueAdministrationRoutes from './superadmin/venueAdministration.routes'
import creditAssessmentRoutes from './superadmin/creditAssessment.routes'
import moduleRoutes from './superadmin/module.routes'
import onboardingRoutes from './superadmin/onboarding.routes'
import trainingRoutes from './superadmin/training.routes'
import activityLogRoutes from './superadmin/activityLog.routes'
import dashboardRoutes from './superadmin/dashboard.routes'
import systemLogsRoutes from './superadmin/systemLogs.routes'
import partnerKeyRoutes from './superadmin/partnerKey.routes'
import aggregatorRoutes from './superadmin/aggregator.routes'
import balanceProviderRoutes from './superadmin/balanceProvider.routes'
import holidaysRoutes from './superadmin/holidays.routes'
import venueCommissionRoutes from './superadmin/venueCommission.routes'
import settlementConfigRoutes from './superadmin/settlementConfiguration.routes'
import settlementCalendarRoutes from './superadmin/settlementCalendar.routes'
import merchantRevenueShareRoutes from './superadmin/merchantRevenueShare.routes'
import stripeConnectOffboardingRoutes from './superadmin/stripeConnectOffboarding.routes'
import angelpayUserAccountRoutes from './superadmin/angelpayUserAccount.routes'
import rateCorrectionRoutes from './superadmin/rateCorrection.routes'
import terminalOrderSuperadminRoutes from './superadmin/terminalOrder.routes'
import subscriptionRoutes from './superadmin/subscription.routes'
import billingRoutes from './superadmin/billing.routes'
import platformChargesRoutes from './superadmin/platformCharges.routes'
import posAppVersionsRoutes from './superadmin/posAppVersions.routes'
import reportsRoutes from './superadmin/reports.routes'
import deliveryActivationRoutes from './superadmin/deliveryActivation.routes'
import masterCatalogRoutes from './superadmin/masterCatalog.routes'
import announcementRoutes from './superadmin/announcement.routes'
import launchCampaignRoutes from './superadmin/launchCampaign.routes'
import systemConfigRoutes from './superadmin/systemConfig.routes'
// NOTE: appUpdateRoutes are mounted EARLY in app.ts with 100MB body limit for APK uploads
// Do NOT mount here to avoid duplicate route registration

const router = express.Router({ mergeParams: true })

// All superadmin routes require authentication and SUPERADMIN role
router.use(authenticateTokenMiddleware)
router.use(authorizeRole([StaffRole.SUPERADMIN]))

// Mount superadmin sub-routes
router.use('/announcements', announcementRoutes)
// Campañas ligeras de lanzamiento (spec 2026-09-17). Hereda el guardia de SUPERADMIN del padre.
router.use('/document-requests', documentRequestsRoutes)
router.use('/launch-campaigns', launchCampaignRoutes)
router.use('/hybrid-campaigns', hybridCampaignRoutes)
// Precios de lista y «% de descuento» (spec 2026-09-30). Hereda el guardia de SUPERADMIN del padre.
router.use('/hybrid-pricing', hybridPricingRoutes)
// «Cliente de antes» de toda la organización (CRM C1): mismo controlador y esquema que la ruta legacy de /dashboard/superadmin.
router.post(
  '/organizations/:organizationId/plan/grandfathered',
  validateRequest(setOrganizationGrandfatheredSchema),
  organizationController.setOrganizationPlanGrandfathered,
)
router.use('/kyc', kycReviewRoutes)
router.use('/payment-providers', paymentProviderRoutes)
router.use('/merchant-accounts', merchantAccountRoutes)
router.use('/terminals', terminalRoutes)
router.use('/venues', venueAccessRoutes)
router.use('/venues', venueAdministrationRoutes)
router.use('/tpv-orders', terminalOrderSuperadminRoutes)
router.use('/payment-analytics', paymentAnalyticsRoutes)
router.use('/earnings', earningsRoutes)
router.use('/cost-structures', providerCostStructureRoutes)
router.use('/venue-pricing', venuePricingRoutes)
router.use('/payment-positions', paymentPositionsRoutes) // tarifa al comercio, paso 2: reporte de sólo lectura
router.use('/rate-corrections', rateCorrectionRoutes)
router.use('/webhooks', webhookRoutes)
router.use('/credit', creditAssessmentRoutes)
router.use('/modules', moduleRoutes)
router.use('/onboarding', onboardingRoutes)
router.use('/trainings', trainingRoutes)
router.use('/activity-log', activityLogRoutes)
router.use('/dashboard', dashboardRoutes)
router.use('/system-logs', systemLogsRoutes)
// Estado de la configuración crítica de ESTE servidor. Hereda token + rol SUPERADMIN del padre.
router.use('/system', systemConfigRoutes)
router.use('/partner-keys', partnerKeyRoutes)
router.use('/aggregators', aggregatorRoutes)
router.use('/balance-providers', balanceProviderRoutes)
router.use('/holidays', holidaysRoutes)
router.use('/venue-commissions', venueCommissionRoutes)
router.use('/subscriptions', subscriptionRoutes)
router.use('/billing', billingRoutes) // Platform billing CFDI (Avoqado factura a sus propios clientes)
// «Por cobrar» (spec 2026-11-02): cobros recurrentes de Avoqado a un cliente, con recordatorio y factura. Hereda el guardia de SUPERADMIN.
router.use('/platform-charges', platformChargesRoutes)
// Actualizador del POS (versiones mínimas por plataforma). Hereda el guardia de SUPERADMIN del padre.
router.use('/pos-app-versions', posAppVersionsRoutes)
router.use('/reports', reportsRoutes)
router.use('/delivery-activation', deliveryActivationRoutes) // Task 4/7 delivery-activation-backend: cola de ops + avanzar status
router.use('/master-catalog', masterCatalogRoutes)
// Aditivo (2026-05): mismos controllers que ya viven en /api/v1/dashboard/superadmin/*,
// expuestos también aquí para que el frontend superadmin use un solo namespace.
router.use('/settlement-configurations', settlementConfigRoutes)
router.use('/settlement-calendar', settlementCalendarRoutes)
router.use('/merchant-revenue-shares', merchantRevenueShareRoutes)
router.use('/stripe-connect', stripeConnectOffboardingRoutes)
// AngelPay user accounts — mounted at root because endpoints span
// /venues/:venueId/angelpay-account AND /angelpay-accounts/:id/...
router.use('/', angelpayUserAccountRoutes)
// app-updates route is mounted in app.ts with 100MB body limit (not here)

export default router
