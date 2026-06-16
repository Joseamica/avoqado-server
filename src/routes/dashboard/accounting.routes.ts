/**
 * Dashboard Accounting Routes — Capa A (gerencial)
 *
 * Estado de resultados (ingresos) de un local. INCLUIDO para todos los venues:
 * gateado SOLO por permiso `accounting:read`, sin `checkFeatureAccess`. El paywall
 * (Feature ACCOUNTING → Pro) se reserva para la futura Capa B (contabilidad fiscal).
 *
 * Montado en dashboard.routes.ts bajo `/venues/:venueId/accounting`
 * (con authenticateTokenMiddleware). `mergeParams` expone :venueId al sub-router.
 */

import express from 'express'
import { z } from 'zod'

import * as accountingController from '@/controllers/dashboard/accounting.dashboard.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'

const router = express.Router({ mergeParams: true })

const incomeStatementSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del local no es válido.' }),
  }),
  query: z.object({
    from: z
      .string({ required_error: 'La fecha inicial (from) es requerida.' })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha inicial (from) debe tener formato AAAA-MM-DD.' }),
    to: z
      .string({ required_error: 'La fecha final (to) es requerida.' })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha final (to) debe tener formato AAAA-MM-DD.' }),
  }),
})

/**
 * GET /api/v1/dashboard/venues/:venueId/accounting/income-statement?from=&to=
 *
 * Estado de resultados de ingresos del periodo: ventas brutas, devoluciones, ingreso
 * neto, base e IVA trasladado (precios IVA-incluido), propinas (informativas) y métricas.
 *
 * @permission accounting:read
 */
router.get(
  '/income-statement',
  checkPermission('accounting:read'),
  validateRequest(incomeStatementSchema),
  accountingController.getIncomeStatement,
)

export default router
