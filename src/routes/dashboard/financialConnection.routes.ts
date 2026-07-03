import { Router } from 'express'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import { financialConnectionRateLimiter } from '@/middlewares/financial-connection-rate-limit.middleware'
import * as ctrl from '@/controllers/dashboard/financialConnection.controller'

// TODO anidado bajo /venues/:venueId/… (mergeParams hereda :venueId). checkPermission
// resuelve el rol efectivo contra ESE :venueId (lookup a StaffVenue, no confía en el JWT a
// ciegas) — es el único middleware de este codebase que hace esa verificación por-request.
// Los tres endpoints que llegan al banco con credenciales/OTP llevan rate limit
// (fuerza bruta de TOTP / prueba de credenciales por proxy).
//
// checkFeatureAccess('BANKING_HUB'): el hub Bancos es PRO. El gate va DESPUÉS del permiso
// (primero "¿tienes acceso?", luego "¿tu plan lo incluye?"). Espeja el FeatureGate del
// dashboard end-to-end (frontend ya apaga las queries sin PRO). El middleware exenta
// demo/grandfathered/superadmin igual que useVenueTier, así que no rompe demos ni legacy.
// BANKING_HUB no está en PREMIUM_ONLY_CODES → PLAN_PRO lo desbloquea sin registrar el code.
export const venueFinancialConnectionRoutes = Router({ mergeParams: true })
venueFinancialConnectionRoutes.get('/', checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'), ctrl.listConnections)
venueFinancialConnectionRoutes.post(
  '/',
  checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'),
  financialConnectionRateLimiter,
  ctrl.createConnection,
)
venueFinancialConnectionRoutes.post(
  '/:id/validate-device',
  checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'),
  financialConnectionRateLimiter,
  ctrl.validateDevice,
)
venueFinancialConnectionRoutes.post(
  '/:id/validate-2fa',
  checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'),
  financialConnectionRateLimiter,
  ctrl.validateTwoFactorAuth,
)
venueFinancialConnectionRoutes.post('/:id/select-account', checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'), ctrl.selectAccount)
venueFinancialConnectionRoutes.delete('/:id', checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'), ctrl.disconnect)

// Cuentas (saldo en vivo) — mismo prefijo de venue, recurso distinto.
export const venueFinancialAccountRoutes = Router({ mergeParams: true })
venueFinancialAccountRoutes.get('/:id/balance', checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'), ctrl.getBalance)
venueFinancialAccountRoutes.get('/:id/movements', checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'), ctrl.getMovements)
venueFinancialAccountRoutes.get('/:id/movements/stats', checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'), ctrl.getMovementStats)
// Read-only: verifica el nombre del beneficiario de una cuenta destino antes de enviar (confirmar nombre, no solo número).
venueFinancialAccountRoutes.get('/:id/resolve-destination', checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'), ctrl.resolveDestination)
// MUEVE DINERO: permiso OWNER + rate limit (dedup del proveedor no existe → el límite acota el daño de un doble-envío accidental).
venueFinancialAccountRoutes.post(
  '/:id/internal-transfer',
  checkPermission('financialConnections:manage'), checkFeatureAccess('BANKING_HUB'),
  financialConnectionRateLimiter,
  ctrl.internalTransfer,
)

// Catálogo — de solo lectura, sin scope de venue, cualquier usuario autenticado.
export const financialProviderRoutes = Router()
financialProviderRoutes.get('/financial-providers', ctrl.listProviders)
