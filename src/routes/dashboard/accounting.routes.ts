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

// Las tres rutas comparten el mismo contrato: :venueId cuid + rango from/to AAAA-MM-DD.
const periodSchema = z.object({
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
router.get('/income-statement', checkPermission('accounting:read'), validateRequest(periodSchema), accountingController.getIncomeStatement)

/**
 * GET /api/v1/dashboard/venues/:venueId/accounting/business-summary?from=&to=
 *
 * Resumen del negocio (portada de Contabilidad): ingreso del periodo, facturación
 * (CFDIs timbrados), cobro efectivo vs banco, comisiones, propinas y estado de la
 * conciliación bancaria. Read-model, incluido. @permission accounting:read
 */
router.get('/business-summary', checkPermission('accounting:read'), validateRequest(periodSchema), accountingController.getBusinessSummary)

/**
 * GET /api/v1/dashboard/venues/:venueId/accounting/banks?from=&to=
 *
 * Bancos y cajas: entradas por método de cobro del periodo, separando caja
 * (efectivo) de banco (electrónico, neto de comisiones). @permission accounting:read
 */
router.get('/banks', checkPermission('accounting:read'), validateRequest(periodSchema), accountingController.getBankAndCashSummary)

export default router
