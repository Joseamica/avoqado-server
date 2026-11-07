import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import * as controller from '@/controllers/superadmin/platformCharges.controller'
import {
  createChargeSchema,
  createChargeV2Schema,
  groupOccurrencesSchema,
  invoiceOccurrenceSchema,
  linkInvoiceSchema,
  listChargesSchema,
  listInvoiceCandidatesSchema,
  listOccurrencesSchema,
  pauseChargeSchema,
  payOccurrenceSchema,
  unlinkInvoiceSchema,
  updateChargeSchema,
} from './platformCharges.schemas'

/**
 * «Por cobrar»: cobros recurrentes de Avoqado a un cliente, con recordatorio y factura. Montado en `/platform-charges` desde
 * superadmin.routes.ts, que ya exige token y rol SUPERADMIN. `checkPermission` agrega la defensa en profundidad y mantiene el
 * catálogo al día (`npm run audit:permissions`): lecturas con `platform-billing:view`, escrituras con `platform-billing:issue`
 * (permisos que ya existen; sin espejos nuevos). `validateRequest` corre ANTES de `checkPermission` para que lo mal formado falle
 * rápido, y deja en `req.body` / `req.query` lo ya limpio.
 *
 * `/summary`, `/occurrences…` e `/invoice-candidates` van ANTES de `/:id`.
 *
 *   GET   /api/v1/superadmin/platform-charges/summary
 *   GET   /api/v1/superadmin/platform-charges/occurrences?view=open|paid|skipped&q=&frequency=&invoice=&customerType=&from=&to=&customer=&page=&pageSize=
 *   GET   /api/v1/superadmin/platform-charges/occurrences/groups?groupBy=customer|month|frequency|invoice&…los mismos filtros
 *   GET   /api/v1/superadmin/platform-charges/occurrences/:id/pay-preview
 *   POST  /api/v1/superadmin/platform-charges/occurrences/:id/pay        { invoice, receptor?, expectedTotalCents? }
 *   POST  /api/v1/superadmin/platform-charges/occurrences/:id/skip
 *   POST  /api/v1/superadmin/platform-charges/occurrences/:id/reopen
 *   POST  /api/v1/superadmin/platform-charges/occurrences/:id/invoice    { billingTaxProfileId?, conceptKeys? }
 *   POST  /api/v1/superadmin/platform-charges/occurrences/:id/invoice-link   { cfdiId }
 *   DELETE /api/v1/superadmin/platform-charges/occurrences/:id/invoice-link?cfdiId=
 *   GET   /api/v1/superadmin/platform-charges/invoice-candidates?customerType=&organizationId=&venueId=&rfc=&q=&page=&pageSize=
 *   GET   /api/v1/superadmin/platform-charges?status=active|paused&q=&page=&pageSize=
 *   POST  /api/v1/superadmin/platform-charges                         (con `invoiceId`: una sola vez, de una factura de «Facturas CFDI»)
 *   GET   /api/v1/superadmin/platform-charges/:id
 *   PATCH /api/v1/superadmin/platform-charges/:id
 *   POST  /api/v1/superadmin/platform-charges/:id/pause                  { skipOverdue }
 *   POST  /api/v1/superadmin/platform-charges/:id/resume
 */
const router = Router()
router.post('/v2', validateRequest(createChargeV2Schema), checkPermission('platform-billing:issue'), controller.createCharge)

// Pantalla: tarjetas y filas
router.get('/summary', checkPermission('platform-billing:view'), controller.getSummary)
router.get('/occurrences', validateRequest(listOccurrencesSchema), checkPermission('platform-billing:view'), controller.listOccurrences)
router.get(
  '/occurrences/groups',
  validateRequest(groupOccurrencesSchema),
  checkPermission('platform-billing:view'),
  controller.groupOccurrences,
)
router.get('/occurrences/:id/pay-preview', checkPermission('platform-billing:view'), controller.getPayPreview)
router.post(
  '/occurrences/:id/pay',
  validateRequest(payOccurrenceSchema),
  checkPermission('platform-billing:issue'),
  controller.payOccurrence,
)
router.post('/occurrences/:id/skip', checkPermission('platform-billing:issue'), controller.skipOccurrence)
router.post('/occurrences/:id/reopen', checkPermission('platform-billing:issue'), controller.reopenOccurrence)
router.post(
  '/occurrences/:id/invoice',
  validateRequest(invoiceOccurrenceSchema),
  checkPermission('platform-billing:issue'),
  controller.invoiceOccurrence,
)

// Anexar a una fecha una factura que ya existe en «Facturas CFDI»
router.post(
  '/occurrences/:id/invoice-link',
  validateRequest(linkInvoiceSchema),
  checkPermission('platform-billing:issue'),
  controller.linkInvoice,
)
router.delete(
  '/occurrences/:id/invoice-link',
  validateRequest(unlinkInvoiceSchema),
  checkPermission('platform-billing:issue'),
  controller.unlinkInvoice,
)
router.get(
  '/invoice-candidates',
  validateRequest(listInvoiceCandidatesSchema),
  checkPermission('platform-billing:view'),
  controller.listInvoiceCandidates,
)

// Cobros recurrentes
router.get('/', validateRequest(listChargesSchema), checkPermission('platform-billing:view'), controller.listCharges)
router.post('/', validateRequest(createChargeSchema), checkPermission('platform-billing:issue'), controller.createCharge)
router.get('/:id', checkPermission('platform-billing:view'), controller.getCharge)
router.patch('/:id', validateRequest(updateChargeSchema), checkPermission('platform-billing:issue'), controller.updateCharge)
router.post('/:id/pause', validateRequest(pauseChargeSchema), checkPermission('platform-billing:issue'), controller.pauseCharge)
router.post('/:id/resume', checkPermission('platform-billing:issue'), controller.resumeCharge)

export default router
