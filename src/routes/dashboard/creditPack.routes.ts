import { Router } from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { validateRequest } from '../../middlewares/validation'
import * as controller from '../../controllers/dashboard/creditPack.dashboard.controller'
import {
  createCreditPackSchema,
  updateCreditPackSchema,
  packIdParamsSchema,
  customerIdParamsSchema,
  redeemBodySchema,
  adjustBodySchema,
  refundBodySchema,
  purchasesQuerySchema,
  transactionsQuerySchema,
} from '../../schemas/dashboard/creditPack.schema'

// ==========================================
// CREDIT PACK ROUTES (Permission-gated)
// ==========================================

const router = Router({ mergeParams: true })

// ---- Purchases (MUST be before /:packId to avoid shadowing) ----

router.get('/purchases', checkPermission('creditPacks:read'), validateRequest(purchasesQuerySchema), controller.getPurchases)

router.get(
  '/purchases/:customerId',
  checkPermission('creditPacks:read'),
  validateRequest(customerIdParamsSchema),
  controller.getCustomerPurchases,
)

router.post(
  '/purchases/:purchaseId/refund',
  checkPermission('creditPacks:delete'),
  validateRequest(refundBodySchema),
  controller.refundPurchase,
)

// ---- Transactions (MUST be before /:packId to avoid shadowing) ----

router.get('/transactions', checkPermission('creditPacks:read'), validateRequest(transactionsQuerySchema), controller.getTransactions)

// ---- Balances (MUST be before /:packId to avoid shadowing) ----

router.post('/balances/:balanceId/redeem', checkPermission('creditPacks:update'), validateRequest(redeemBodySchema), controller.redeemItem)

router.post(
  '/balances/:balanceId/adjust',
  checkPermission('creditPacks:update'),
  validateRequest(adjustBodySchema),
  controller.adjustBalance,
)

// ---- CRUD ----

router.get('/', checkPermission('creditPacks:read'), controller.getCreditPacks)

router.post('/', checkPermission('creditPacks:create'), validateRequest(createCreditPackSchema), controller.createCreditPack)

router.get('/:packId', checkPermission('creditPacks:read'), validateRequest(packIdParamsSchema), controller.getCreditPackById)

router.patch('/:packId', checkPermission('creditPacks:update'), validateRequest(updateCreditPackSchema), controller.updateCreditPack)

router.delete('/:packId', checkPermission('creditPacks:delete'), validateRequest(packIdParamsSchema), controller.deactivateCreditPack)

export default router
