/**
 * Cash Out (PlayTelecom) dashboard routes — config layer (rate table + active-days calendar).
 *
 * Mounted at /dashboard/cash-out from dashboard.routes.ts (behind authenticateToken).
 * Pipeline per endpoint: authenticateToken → checkPermission → validateRequest → controller.
 * The service additionally gates every operation by SERIALIZED_INVENTORY (cash-out is on wherever serialized inventory is).
 */
import { Router } from 'express'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'
import * as ctrl from '@/controllers/dashboard/cash-out.dashboard.controller'
import {
  replaceCommissionRatesSchema,
  setActiveDaysSchema,
  listActiveDaysSchema,
  generateReportSchema,
  listWithdrawalsSchema,
} from '@/schemas/dashboard/cash-out.schema'

const router = Router({ mergeParams: true })

// Escalated commission rate table
router.get('/venues/:venueId/commission-rates', checkPermission('cash-out:read'), ctrl.getCommissionRates)
router.put(
  '/venues/:venueId/commission-rates',
  checkPermission('cash-out:manage'),
  validateRequest(replaceCommissionRatesSchema),
  ctrl.putCommissionRates,
)

// Active-days calendar (ADMIN day-selection)
router.get('/venues/:venueId/active-days', checkPermission('cash-out:read'), validateRequest(listActiveDaysSchema), ctrl.getActiveDays)
router.put('/venues/:venueId/active-days', checkPermission('cash-out:manage'), validateRequest(setActiveDaysSchema), ctrl.putActiveDays)

// Saldo + withdrawals (back-office in v1; promoter self-service = v2 TPV)
router.get('/venues/:venueId/promoters/:staffId/saldo', checkPermission('cash-out:read'), ctrl.getSaldo)
router.post('/venues/:venueId/promoters/:staffId/withdraw', checkPermission('cash-out:manage'), ctrl.postWithdraw)
router.get('/venues/:venueId/withdrawals', checkPermission('cash-out:read'), validateRequest(listWithdrawalsSchema), ctrl.getWithdrawals)

// Finanzas dispersion report (manual corte; the cron also runs it at 18:15)
router.post('/venues/:venueId/report', checkPermission('cash-out:report'), validateRequest(generateReportSchema), ctrl.postReport)

export default router
