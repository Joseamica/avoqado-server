import { Router } from 'express'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { financialConnectionRateLimiter } from '@/middlewares/financial-connection-rate-limit.middleware'
import * as ctrl from '@/controllers/dashboard/financialConnection.controller'

// TODO anidado bajo /venues/:venueId/… (mergeParams hereda :venueId). checkPermission
// resuelve el rol efectivo contra ESE :venueId (lookup a StaffVenue, no confía en el JWT a
// ciegas) — es el único middleware de este codebase que hace esa verificación por-request.
// Los tres endpoints que llegan al banco con credenciales/OTP llevan rate limit
// (fuerza bruta de TOTP / prueba de credenciales por proxy).
export const venueFinancialConnectionRoutes = Router({ mergeParams: true })
venueFinancialConnectionRoutes.get('/', checkPermission('financialConnections:manage'), ctrl.listConnections)
venueFinancialConnectionRoutes.post(
  '/',
  checkPermission('financialConnections:manage'),
  financialConnectionRateLimiter,
  ctrl.createConnection,
)
venueFinancialConnectionRoutes.post(
  '/:id/validate-device',
  checkPermission('financialConnections:manage'),
  financialConnectionRateLimiter,
  ctrl.validateDevice,
)
venueFinancialConnectionRoutes.post(
  '/:id/validate-2fa',
  checkPermission('financialConnections:manage'),
  financialConnectionRateLimiter,
  ctrl.validateTwoFactorAuth,
)
venueFinancialConnectionRoutes.post('/:id/select-account', checkPermission('financialConnections:manage'), ctrl.selectAccount)
venueFinancialConnectionRoutes.delete('/:id', checkPermission('financialConnections:manage'), ctrl.disconnect)

// Cuentas (saldo en vivo) — mismo prefijo de venue, recurso distinto.
export const venueFinancialAccountRoutes = Router({ mergeParams: true })
venueFinancialAccountRoutes.get('/:id/balance', checkPermission('financialConnections:manage'), ctrl.getBalance)
venueFinancialAccountRoutes.get('/:id/movements', checkPermission('financialConnections:manage'), ctrl.getMovements)
venueFinancialAccountRoutes.get('/:id/movements/stats', checkPermission('financialConnections:manage'), ctrl.getMovementStats)
// Read-only: verifica el nombre del beneficiario de una cuenta destino antes de enviar (confirmar nombre, no solo número).
venueFinancialAccountRoutes.get('/:id/resolve-destination', checkPermission('financialConnections:manage'), ctrl.resolveDestination)
// MUEVE DINERO: permiso OWNER + rate limit (dedup del proveedor no existe → el límite acota el daño de un doble-envío accidental).
venueFinancialAccountRoutes.post(
  '/:id/internal-transfer',
  checkPermission('financialConnections:manage'),
  financialConnectionRateLimiter,
  ctrl.internalTransfer,
)

// Catálogo — de solo lectura, sin scope de venue, cualquier usuario autenticado.
export const financialProviderRoutes = Router()
financialProviderRoutes.get('/financial-providers', ctrl.listProviders)
