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
import * as chartController from '@/controllers/dashboard/chartOfAccounts.controller'
import * as mappingController from '@/controllers/dashboard/accountMapping.controller'
import * as journalController from '@/controllers/dashboard/journalEntry.controller'
import { getTrialBalanceController } from '@/controllers/dashboard/trialBalance.controller'
import { getAccountingReportsController } from '@/controllers/dashboard/accountingReports.controller'
import { getIvaCashflowController } from '@/controllers/dashboard/ivaFlujo.controller'
import { generatePoliciesController } from '@/controllers/dashboard/autoPosting.controller'
import {
  createExpenseController,
  listExpensesController,
  generateExpensePoliciesController,
  getDiotController,
} from '@/controllers/dashboard/expense.controller'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'

const router = express.Router({ mergeParams: true })

const venueParamSchema = z.object({
  params: z.object({ venueId: z.string().cuid({ message: 'El ID del local no es válido.' }) }),
})

const LEDGER_TYPES = ['ACTIVO', 'PASIVO', 'CAPITAL', 'INGRESO', 'COSTO', 'GASTO', 'ORDEN'] as const
const LEDGER_NATURES = ['DEUDORA', 'ACREEDORA'] as const

const createAccountSchema = z.object({
  params: z.object({ venueId: z.string().cuid({ message: 'El ID del local no es válido.' }) }),
  body: z.object({
    code: z.string().min(1, { message: 'El código de la cuenta es requerido.' }).max(40),
    name: z.string().min(1, { message: 'El nombre de la cuenta es requerido.' }).max(200),
    satGroupingCode: z.string().min(1, { message: 'El código agrupador SAT es requerido.' }).max(40),
    type: z.enum(LEDGER_TYPES, { errorMap: () => ({ message: 'Tipo de cuenta no válido.' }) }),
    nature: z.enum(LEDGER_NATURES).optional(),
    parentCode: z.string().max(40).nullable().optional(),
  }),
})

const updateAccountSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del local no es válido.' }),
    accountId: z.string().cuid({ message: 'El ID de la cuenta no es válido.' }),
  }),
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    satGroupingCode: z.string().min(1).max(40).optional(),
    nature: z.enum(LEDGER_NATURES).optional(),
    isActive: z.boolean().optional(),
  }),
})

// Las tres rutas comparten el mismo contrato: :venueId cuid + rango from/to AAAA-MM-DD.
/**
 * True solo si `s` (AAAA-MM-DD, ya validado por el regex) es una fecha REAL del calendario.
 * Descarta mes 13, día 99, 30-feb, etc. — que sí pasan el regex pero reventarían en
 * `parseDbDateRange`. Si el formato no calza, devuelve true para dejar que el regex reporte.
 */
const isRealCalendarDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return true
  const [y, m, d] = s.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const periodSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del local no es válido.' }),
  }),
  query: z.object({
    from: z
      .string({ required_error: 'La fecha inicial (from) es requerida.' })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha inicial (from) debe tener formato AAAA-MM-DD.' })
      .refine(isRealCalendarDate, { message: 'La fecha inicial (from) no es una fecha válida del calendario.' }),
    to: z
      .string({ required_error: 'La fecha final (to) es requerida.' })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha final (to) debe tener formato AAAA-MM-DD.' })
      .refine(isRealCalendarDate, { message: 'La fecha final (to) no es una fecha válida del calendario.' }),
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

// ───────────────────────────────────────────────────────────────────────────
// Catálogo de cuentas (Capa B fiscal) — gated PREMIUM (bundle con CFDI).
// Ver = accounting:read; sembrar/editar = accounting:manage. checkFeatureAccess('CFDI')
// es el gate autoritativo (PREMIUM): mismo candado que las rutas de facturación.
// ───────────────────────────────────────────────────────────────────────────

/** GET /accounting/chart-of-accounts — catálogo del local (o needsFiscalSetup). */
router.get(
  '/chart-of-accounts',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:read'),
  validateRequest(venueParamSchema),
  chartController.getChartOfAccounts,
)

/** POST /accounting/chart-of-accounts/seed — siembra el catálogo base por giro (idempotente). */
router.post(
  '/chart-of-accounts/seed',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:manage'),
  validateRequest(venueParamSchema),
  chartController.seedChartOfAccounts,
)

/** POST /accounting/chart-of-accounts — crea una cuenta nueva. */
router.post(
  '/chart-of-accounts',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:manage'),
  validateRequest(createAccountSchema),
  chartController.createLedgerAccount,
)

/** PATCH /accounting/chart-of-accounts/:accountId — edita una cuenta. */
router.patch(
  '/chart-of-accounts/:accountId',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:manage'),
  validateRequest(updateAccountSchema),
  chartController.updateLedgerAccount,
)

// ───────────────────────────────────────────────────────────────────────────
// Configuración contable (AccountMapping) — gated PREMIUM (bundle con CFDI).
// ───────────────────────────────────────────────────────────────────────────

const setMappingSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del local no es válido.' }),
    movementType: z.string().min(1, { message: 'El tipo de movimiento es requerido.' }),
  }),
  body: z.object({
    ledgerAccountId: z.string().cuid({ message: 'El ID de la cuenta no es válido.' }).nullable(),
  }),
})

/** GET /accounting/account-mapping — los 16 movimientos con su cuenta. */
router.get(
  '/account-mapping',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:read'),
  validateRequest(venueParamSchema),
  mappingController.getAccountMapping,
)

/** POST /accounting/account-mapping/seed — siembra los defaults (idempotente). */
router.post(
  '/account-mapping/seed',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:manage'),
  validateRequest(venueParamSchema),
  mappingController.seedAccountMapping,
)

/** PATCH /accounting/account-mapping/:movementType — reasigna un movimiento a una cuenta. */
router.patch(
  '/account-mapping/:movementType',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:manage'),
  validateRequest(setMappingSchema),
  mappingController.setAccountMapping,
)

// ───────────────────────────────────────────────────────────────────────────
// Libro diario · Pólizas (JournalEntry) — gated PREMIUM (bundle con CFDI).
// ───────────────────────────────────────────────────────────────────────────

const createEntrySchema = z.object({
  params: z.object({ venueId: z.string().cuid({ message: 'El ID del local no es válido.' }) }),
  body: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha debe tener formato AAAA-MM-DD.' }),
    concept: z.string().min(1, { message: 'El concepto de la póliza es requerido.' }).max(300),
    lines: z
      .array(
        z.object({
          ledgerAccountId: z.string().cuid({ message: 'El ID de la cuenta no es válido.' }),
          debitCents: z.number().int().min(0),
          creditCents: z.number().int().min(0),
          description: z.string().max(300).nullable().optional(),
        }),
      )
      .min(2, { message: 'Una póliza necesita al menos dos líneas.' }),
  }),
})

/** GET /accounting/journal?period=YYYY-MM — libro diario. */
router.get(
  '/journal',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:read'),
  validateRequest(venueParamSchema),
  journalController.getJournal,
)

/** POST /accounting/journal — crea una póliza manual (balanceada). */
router.post(
  '/journal',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:manage'),
  validateRequest(createEntrySchema),
  journalController.createJournalEntry,
)

// ───────────────────────────────────────────────────────────────────────────
// Balanza de comprobación — read-model sobre pólizas. Gated PREMIUM (CFDI).
// ───────────────────────────────────────────────────────────────────────────

const trialBalanceSchema = z.object({
  params: z.object({ venueId: z.string().cuid({ message: 'El ID del local no es válido.' }) }),
  query: z.object({
    period: z
      .string()
      .regex(/^\d{4}-\d{2}$/, { message: 'El periodo debe tener formato AAAA-MM.' })
      .optional(),
  }),
})

/** GET /accounting/trial-balance?period=YYYY-MM — balanza de comprobación (default: mes actual). */
router.get(
  '/trial-balance',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:read'),
  validateRequest(trialBalanceSchema),
  getTrialBalanceController,
)

/** GET /accounting/reports?period=YYYY-MM — estado de resultados + balance general. */
router.get(
  '/reports',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:read'),
  validateRequest(trialBalanceSchema),
  getAccountingReportsController,
)

/** GET /accounting/vat-flow?period=YYYY-MM — IVA en flujo de efectivo (trasladado cobrado del contribuyente). */
router.get(
  '/vat-flow',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:read'),
  validateRequest(trialBalanceSchema),
  getIvaCashflowController,
)

/** POST /accounting/generate-policies?period=YYYY-MM — posteo automático de pólizas desde los pagos. */
router.post(
  '/generate-policies',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:manage'),
  validateRequest(trialBalanceSchema),
  generatePoliciesController,
)

// ───────────────────────────────────────────────────────────────────────────
// Buzón de CFDIs / Gastos (Capa B, Pilar #2) — gated PREMIUM (bundle con CFDI).
// Captura de CFDIs recibidos → IVA acreditable + DIOT + costos/gastos reales.
// ───────────────────────────────────────────────────────────────────────────

const cents = (label: string) =>
  z
    .number({ invalid_type_error: `El monto '${label}' debe ser un número en centavos.` })
    .int({ message: `El monto '${label}' debe ser un entero en centavos.` })
    .min(0, { message: `El monto '${label}' no puede ser negativo.` })
const dateStr = (label: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: `La ${label} debe tener formato AAAA-MM-DD.` })

const createExpenseSchema = z.object({
  params: z.object({ venueId: z.string().cuid({ message: 'El ID del local no es válido.' }) }),
  body: z.object({
    proveedorRfc: z.string().min(1, { message: 'El RFC del proveedor es requerido.' }).max(20),
    proveedorNombre: z.string().min(1, { message: 'El nombre del proveedor es requerido.' }).max(300),
    proveedorRegimen: z.string().max(10).nullable().optional(),
    tipoTercero: z.enum(['NACIONAL', 'EXTRANJERO', 'GLOBAL']).optional(),
    comprobanteTipo: z.enum(['INGRESO', 'EGRESO', 'NOMINA', 'PAGO', 'TRASLADO']).optional(),
    usoCfdi: z.string().max(10).nullable().optional(),
    metodoPago: z.enum(['PUE', 'PPD']).optional(),
    formaPago: z.string().max(10).nullable().optional(),
    categoria: z.enum(['COSTO_MERCANCIA', 'GASTO_GENERAL', 'ARRENDAMIENTO', 'COMBUSTIBLE', 'HONORARIOS', 'SERVICIOS', 'OTRO']).optional(),
    fechaEmision: dateStr('fecha de emisión'),
    fechaPago: dateStr('fecha de pago').nullable().optional(),
    subtotalCents: cents('subtotal'),
    descuentoCents: cents('descuento').optional(),
    ivaCents: cents('IVA').optional(),
    iva16Cents: cents('IVA 16%').optional(),
    iva8Cents: cents('IVA 8%').optional(),
    iva0BaseCents: cents('base 0%').optional(),
    exentoBaseCents: cents('base exenta').optional(),
    iepsCents: cents('IEPS').optional(),
    isrRetenidoCents: cents('ISR retenido').optional(),
    ivaRetenidoCents: cents('IVA retenido').optional(),
    totalCents: cents('total'),
    deducible: z.boolean().optional(),
    ivaAcreditable: z.boolean().optional(),
    paid: z.boolean().optional(),
    uuid: z.string().max(60).nullable().optional(),
    serie: z.string().max(40).nullable().optional(),
    folio: z.string().max(40).nullable().optional(),
    source: z.enum(['MANUAL', 'XML_UPLOAD', 'SAT_DESCARGA']).optional(),
    supplierId: z.string().cuid({ message: 'El ID del proveedor no es válido.' }).nullable().optional(),
  }),
})

const listExpensesSchema = z.object({
  params: z.object({ venueId: z.string().cuid({ message: 'El ID del local no es válido.' }) }),
  query: z.object({
    period: z
      .string()
      .regex(/^\d{4}-\d{2}$/, { message: 'El periodo debe tener formato AAAA-MM.' })
      .optional(),
    paymentStatus: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']).optional(),
    proveedorRfc: z.string().max(20).optional(),
    includeCancelled: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }),
})

/** POST /accounting/expenses — registra un gasto / CFDI recibido. */
router.post(
  '/expenses',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:manage'),
  validateRequest(createExpenseSchema),
  createExpenseController,
)

/** GET /accounting/expenses?period=&paymentStatus=&proveedorRfc= — lista los gastos del contribuyente. */
router.get(
  '/expenses',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:read'),
  validateRequest(listExpensesSchema),
  listExpensesController,
)

/** POST /accounting/expenses/generate-policies?period=YYYY-MM — postea las pólizas de gasto del periodo. */
router.post(
  '/expenses/generate-policies',
  checkFeatureAccess('CFDI'),
  checkPermission('accounting:manage'),
  validateRequest(trialBalanceSchema),
  generateExpensePoliciesController,
)

/** GET /accounting/diot?period=YYYY-MM — DIOT (IVA pagado a proveedores por tercero y tasa). */
router.get('/diot', checkFeatureAccess('CFDI'), checkPermission('accounting:read'), validateRequest(trialBalanceSchema), getDiotController)

export default router
