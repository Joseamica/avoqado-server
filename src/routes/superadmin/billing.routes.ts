import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import * as controller from '@/controllers/superadmin/platformBilling.controller'
import {
  upsertEmisorSchema,
  provisionEmisorSchema,
  uploadCsdSchema,
  upsertTaxProfileSchema,
  uploadConstanciaSchema,
  issueInvoiceSchema,
  listInvoicesSchema,
  cancelInvoiceSchema,
  registerPaymentSchema,
  sendEmailSchema,
} from './billing.schemas'

/**
 * Platform billing (Avoqado → cliente) CFDI endpoints. Mounted under `/billing`
 * in superadmin.routes.ts, which already applies authenticateTokenMiddleware +
 * authorizeRole([SUPERADMIN]). checkPermission adds defense-in-depth + keeps the
 * permission catalog in sync (npm run audit:permissions). validateRequest runs
 * BEFORE checkPermission so malformed requests fail fast.
 *
 *   GET  /api/v1/superadmin/billing/emisor
 *   PUT  /api/v1/superadmin/billing/emisor
 *   POST /api/v1/superadmin/billing/emisor/provision
 *   POST /api/v1/superadmin/billing/emisor/csd
 *   GET  /api/v1/superadmin/billing/customers?type=&q=
 *   GET  /api/v1/superadmin/billing/customers/:type/:id/tax-profile
 *   PUT  /api/v1/superadmin/billing/tax-profiles
 *   GET  /api/v1/superadmin/billing/tax-profiles/:id
 *   POST /api/v1/superadmin/billing/tax-profiles/:id/constancia
 *   POST /api/v1/superadmin/billing/invoices
 *   GET  /api/v1/superadmin/billing/invoices
 *   GET  /api/v1/superadmin/billing/invoices/:id
 *   DELETE /api/v1/superadmin/billing/invoices/:id  (descartar una factura STAMP_FAILED)
 *   GET  /api/v1/superadmin/billing/invoices/:id/pdf | /xml
 *   POST /api/v1/superadmin/billing/invoices/:id/cancel
 */
const router = Router()

// Emisor (Avoqado)
router.get('/emisor', checkPermission('platform-billing:view'), controller.getEmisor)
router.put('/emisor', validateRequest(upsertEmisorSchema), checkPermission('platform-billing:configure'), controller.upsertEmisor)
router.post(
  '/emisor/provision',
  validateRequest(provisionEmisorSchema),
  checkPermission('platform-billing:configure'),
  controller.provisionEmisor,
)
router.post('/emisor/csd', validateRequest(uploadCsdSchema), checkPermission('platform-billing:configure'), controller.uploadCsd)

// Receptores (tax profiles)
router.get('/customers', checkPermission('platform-billing:view'), controller.searchCustomers)
router.get('/customers/:type/:id/tax-profile', checkPermission('platform-billing:view'), controller.getTaxProfileForCustomer)
router.put(
  '/tax-profiles',
  validateRequest(upsertTaxProfileSchema),
  checkPermission('platform-billing:configure'),
  controller.upsertTaxProfile,
)
router.get('/tax-profiles/:id', checkPermission('platform-billing:view'), controller.getTaxProfile)
router.post(
  '/tax-profiles/:id/constancia',
  validateRequest(uploadConstanciaSchema),
  checkPermission('platform-billing:configure'),
  controller.attachConstanciaController,
)

// Facturas (CFDIs) — list route registered before the :id route
router.post('/invoices', validateRequest(issueInvoiceSchema), checkPermission('platform-billing:issue'), controller.issueInvoice)
router.get('/invoices', validateRequest(listInvoicesSchema), checkPermission('platform-billing:view'), controller.listInvoices)
router.get('/invoices/:id', checkPermission('platform-billing:view'), controller.getInvoice)
router.delete('/invoices/:id', checkPermission('platform-billing:delete'), controller.discardInvoice)
router.get('/invoices/:id/pdf', checkPermission('platform-billing:view'), controller.downloadPdf)
router.get('/invoices/:id/xml', checkPermission('platform-billing:view'), controller.downloadXml)
router.post(
  '/invoices/:id/payments',
  validateRequest(registerPaymentSchema),
  checkPermission('platform-billing:issue'),
  controller.registerPayment,
)
router.post('/invoices/:id/email', validateRequest(sendEmailSchema), checkPermission('platform-billing:issue'), controller.sendInvoiceEmail)
router.post(
  '/invoices/:id/cancel',
  validateRequest(cancelInvoiceSchema),
  checkPermission('platform-billing:issue'),
  controller.cancelInvoice,
)

export default router
