import { Router } from 'express'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import * as ctrl from '@/controllers/dashboard/financialConnection.controller'

// TODO anidado bajo /venues/:venueId/… (mergeParams hereda :venueId). checkPermission
// resuelve el rol efectivo contra ESE :venueId (lookup a StaffVenue, no confía en el JWT a
// ciegas) — es el único middleware de este codebase que hace esa verificación por-request.
export const venueFinancialConnectionRoutes = Router({ mergeParams: true })
venueFinancialConnectionRoutes.get('/', checkPermission('financialConnections:manage'), ctrl.listConnections)
venueFinancialConnectionRoutes.post('/', checkPermission('financialConnections:manage'), ctrl.createConnection)
venueFinancialConnectionRoutes.post('/:id/validate-device', checkPermission('financialConnections:manage'), ctrl.validateDevice)
venueFinancialConnectionRoutes.post('/:id/validate-2fa', checkPermission('financialConnections:manage'), ctrl.validateTwoFactorAuth)
venueFinancialConnectionRoutes.post('/:id/select-account', checkPermission('financialConnections:manage'), ctrl.selectAccount)
venueFinancialConnectionRoutes.delete('/:id', checkPermission('financialConnections:manage'), ctrl.disconnect)

// Cuentas (saldo en vivo) — mismo prefijo de venue, recurso distinto.
export const venueFinancialAccountRoutes = Router({ mergeParams: true })
venueFinancialAccountRoutes.get('/:id/balance', checkPermission('financialConnections:manage'), ctrl.getBalance)

// Catálogo — de solo lectura, sin scope de venue, cualquier usuario autenticado.
export const financialProviderRoutes = Router()
financialProviderRoutes.get('/financial-providers', ctrl.listProviders)
