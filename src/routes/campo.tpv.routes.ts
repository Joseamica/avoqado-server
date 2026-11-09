/**
 * App de campo (bloque 0): lo que sube el celular del promotor. Se monta en `/tpv/campo`. La sucursal va en la dirección
 * (`:venueId`), así que `checkPermission` evalúa el rol en ESA sucursal contra la base, no la del token (plan H4).
 */
import { NextFunction, Request, Response, Router } from 'express'
import AppError, { NotFoundError } from '@/errors/AppError'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'
import { aceptarCustodia, rechazarCustodia } from '@/controllers/tpv/campo/custodiaDeCampo.controller'
import { aceptarCustodiaSchema, rechazarCustodiaSchema, ventaDeCampoSchema } from '@/schemas/tpv/campo.schema'
import { registrarVentaDeCampo } from '@/services/tpv/campo/ventaDeCampo.service'
import prisma from '@/utils/prismaClient'

const router = Router()

/**
 * POST /tpv/campo/venues/:venueId/ventas — la venta de una SIM. 201 nueva, 200 repetida (misma llave).
 * Reintentables: 409 VENTA_EN_PROCESO y cualquier 5xx. Lo demás es definitivo; 422 PRECIO_CAMBIO trae `precioActual`.
 */
router.post(
  '/venues/:venueId/ventas',
  authenticateTokenMiddleware,
  checkPermission('serialized-inventory:sell'),
  checkPermission('payments:create'),
  validateRequest(ventaDeCampoSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { venueId } = req.params
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
      if (!venue) throw new NotFoundError('Sucursal no encontrada')
      const r = await registrarVentaDeCampo({ venueId, orgId: venue.organizationId, staffId: req.authContext!.userId }, req.body)
      res.status(r.repetida ? 200 : 201).json(r)
    } catch (error) {
      if (error instanceof AppError && error.code === 'PRECIO_CAMBIO') {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, ...(error.details as object) })
      }
      next(error)
    }
  },
)

/** Custodia del celular: sin `simCustodyIdempotency`; «ya estaba hecho» (misma persona) es éxito con `repetida: true`. */
router.post(
  '/venues/:venueId/custodia/aceptar',
  authenticateTokenMiddleware,
  checkPermission('tpv-sim-custody:accept'),
  validateRequest(aceptarCustodiaSchema),
  aceptarCustodia,
)
router.post(
  '/venues/:venueId/custodia/rechazar',
  authenticateTokenMiddleware,
  checkPermission('tpv-sim-custody:reject'),
  validateRequest(rechazarCustodiaSchema),
  rechazarCustodia,
)

export default router
