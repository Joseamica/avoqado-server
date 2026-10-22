/**
 * Tarjetas de regalo — API del dashboard. Montado en /api/v1/dashboard/venues/:venueId/gift-cards (dashboard.routes.ts),
 * con `authenticateTokenMiddleware` en el montaje.
 *
 * Orden: validar (español) → permiso exacto → [plan sólo al PRENDER] → controller. Las rutas literales van ANTES de
 * `/:giftCardId` para que «settings», «summary», «aging», «pending-accounting», «export.csv» y «orders» nunca se lean como un
 * id. Nada aquí pide el plan salvo prender (R9): un negocio que bajó de plan sigue viendo, ajustando y cancelando lo vendido.
 */
import { Router } from 'express'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'
import { exigirPlanSiPrende } from '@/middlewares/giftCardsPlan.middleware'
import * as ctrl from '@/controllers/dashboard/giftCard.dashboard.controller'
import * as venta from '@/controllers/shared/giftCardSale.controller'
import * as s from '@/schemas/dashboard/giftCard.schema'
import { liberarCancelacionSchema, operationKeyOnOrderSchema, soloVenueSchema } from '@/schemas/common/giftCard.common.schema'

const router = Router({ mergeParams: true })

router.get('/settings', validateRequest(soloVenueSchema), checkPermission('giftCards:read'), ctrl.getSettings)
router.put(
  '/settings',
  validateRequest(s.updateSettingsSchema),
  checkPermission('giftCards:manage'),
  exigirPlanSiPrende,
  ctrl.updateSettings,
)
router.get('/summary', validateRequest(s.summarySchema), checkPermission('giftCards:read'), ctrl.summary)
router.get('/aging', validateRequest(s.agingSchema), checkPermission('giftCards:read'), ctrl.aging)
router.get('/pending-accounting', validateRequest(s.pendingAccountingSchema), checkPermission('giftCards:read'), ctrl.pendingAccounting)
// Exportar recorre páginas acotadas y sólo corre por este clic explícito (bounded-queries: «exports after an explicit action»).
router.get('/export.csv', validateRequest(soloVenueSchema), checkPermission('giftCards:read'), ctrl.exportCsv)
router.post(
  '/orders/:orderId/cancel-sale',
  validateRequest(operationKeyOnOrderSchema),
  checkPermission('giftCards:manage'),
  venta.cancelSale,
)
// F6: liberar exige `confirmacionNoDevuelto: true` (el gerente comprobó que la devolución NO se hizo; lo incierto sigue bloqueado).
router.post(
  '/orders/:orderId/release-cancel',
  validateRequest(liberarCancelacionSchema),
  checkPermission('giftCards:manage'),
  venta.releaseCancel,
)
router.get('/', validateRequest(s.listSchema), checkPermission('giftCards:read'), ctrl.list)
router.get('/:giftCardId', validateRequest(s.detailSchema), checkPermission('giftCards:read'), ctrl.detail)
router.post('/:giftCardId/operations', validateRequest(s.operationSchema), checkPermission('giftCards:manage'), ctrl.operate)
// 1b S7 (Q16): reenviar o cambiar el destino desde el panel. Siempre de gerente: el panel no pide PIN, así que usa SU ruta.
router.post('/:giftCardId/resend', validateRequest(s.resendSchema), checkPermission('giftCards:manage'), ctrl.resend)

export default router
