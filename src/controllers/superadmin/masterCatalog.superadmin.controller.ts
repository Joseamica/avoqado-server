import type { NextFunction, Request, Response } from 'express'
import AppError from '../../errors/AppError'
import { masterCatalogControlPlaneService } from '../../services/master-catalog/masterCatalogControlPlane.service'

function endpoint(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next)
}

function id(req: Request, key: string): string {
  const value = req.params[key]
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new AppError(`${key} no válido`, 422, true, 'CATALOG_REQUEST_INVALID')
  return value
}

function actor(req: Request) {
  if (!req.authContext?.userId) throw new AppError('Autenticación requerida', 401, true, 'AUTHENTICATION_REQUIRED')
  return { type: 'HUMAN' as const, staffId: req.authContext.userId, impersonating: req.authContext.isImpersonating === true }
}

function body(req: Request): Record<string, unknown> {
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))
    throw new AppError('Solicitud de control no válida', 422, true, 'CATALOG_REQUEST_INVALID')
  const value = req.body as Record<string, unknown>
  if (['organizationId', 'orgId', 'venueId'].some(key => key in value))
    throw new AppError('El scope sólo puede venir de la ruta', 422, true, 'CATALOG_SCOPE_FORGED')
  return value
}

function assertQueryContract(req: Request, allowedKeys: readonly string[] = []) {
  const keys = Object.keys(req.query)
  if (keys.some(key => ['organizationId', 'orgId', 'venueId'].includes(key))) {
    throw new AppError('El scope sólo puede venir de la ruta', 422, true, 'CATALOG_SCOPE_FORGED')
  }
  const unknown = keys.filter(key => !allowedKeys.includes(key))
  if (unknown.length) {
    throw new AppError('Solicitud de control no válida', 422, true, 'CATALOG_REQUEST_INVALID', { unknownQueryKeys: unknown })
  }
}

function ok(res: Response, data: unknown) {
  res.status(200).json({ success: true, data })
}

export const listOrganizations = endpoint(async (req, res) => {
  assertQueryContract(req, ['cursor', 'pageSize'])
  ok(
    res,
    await masterCatalogControlPlaneService.listOrganizations(actor(req), {
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      pageSize: typeof req.query.pageSize === 'string' ? Number(req.query.pageSize) : undefined,
    }),
  )
})

export const getOrganization = endpoint(async (req, res) => {
  assertQueryContract(req)
  ok(res, await masterCatalogControlPlaneService.getOrganization(id(req, 'organizationId'), actor(req)))
})
export const updateEntitlement = endpoint(async (req, res) => {
  assertQueryContract(req)
  ok(res, await masterCatalogControlPlaneService.updateEntitlement(id(req, 'organizationId'), actor(req), body(req)))
})
export const updateModule = endpoint(async (req, res) => {
  assertQueryContract(req)
  ok(res, await masterCatalogControlPlaneService.updateModule(id(req, 'organizationId'), actor(req), body(req)))
})
export const updateConfig = endpoint(async (req, res) => {
  assertQueryContract(req)
  ok(res, await masterCatalogControlPlaneService.updateConfig(id(req, 'organizationId'), actor(req), body(req)))
})
export const updateGovernance = endpoint(async (req, res) => {
  assertQueryContract(req)
  ok(res, await masterCatalogControlPlaneService.updateGovernance(id(req, 'organizationId'), id(req, 'venueId'), actor(req), body(req)))
})
