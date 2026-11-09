/**
 * App de campo (bloque 0): lo que sube el celular del promotor. Se monta en `/tpv/campo`. La sucursal va en la dirección
 * (`:venueId`), así que `checkPermission` evalúa el rol en ESA sucursal contra la base, no la del token (plan H4).
 */
import { NextFunction, Request, Response, Router } from 'express'
import AppError, { NotFoundError } from '@/errors/AppError'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { requireVenueMembership } from '@/middlewares/validateVenueAccess.middleware'
import { validateRequest } from '@/middlewares/validation'
import { aceptarCustodia, rechazarCustodia } from '@/controllers/tpv/campo/custodiaDeCampo.controller'
import {
  aceptarCustodiaSchema,
  entradaDeCampoSchema,
  rechazarCustodiaSchema,
  salidaDeCampoSchema,
  ventaDeCampoSchema,
} from '@/schemas/tpv/campo.schema'
import { registrarEntradaDeCampo, registrarSalidaDeCampo } from '@/services/tpv/campo/checadaDeCampo.service'
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

/**
 * La checada del celular: la persona sale del token (no hay PIN) y `requireVenueMembership` exige que siga activa y con
 * su rol en la sucursal de la dirección, contra la base. Entrada: 201 nueva, 200 repetida. Salida: 200.
 * Rechazos: 409 YA_TIENE_ENTRADA y ENTRADA_SE_ENCIMA / SALIDA_SE_ENCIMA (con el `timeEntryId`, `venueId` y horas del
 * otro turno al mismo nivel), 400 SALIDA_SIN_ENTRADA, 404, 422 SALIDA_ANTES_DE_ENTRADA, 409 YA_TIENE_SALIDA;
 * reintentable: 409 CHECADA_EN_PROCESO y cualquier 5xx.
 */
const checada =
  (registrar: typeof registrarEntradaDeCampo | typeof registrarSalidaDeCampo, nueva: number) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await registrar({ venueId: req.params.venueId, staffId: req.authContext!.userId }, req.body)
      res.status(r.repetida ? 200 : nueva).json(r)
    } catch (error) {
      // Los rechazos con datos (YA_TIENE_ENTRADA, ENTRADA_SE_ENCIMA, SALIDA_SE_ENCIMA) los llevan al mismo nivel que `code`.
      if (error instanceof AppError && error.details && typeof error.details === 'object') {
        return res.status(error.statusCode).json({ code: error.code, message: error.message, ...(error.details as object) })
      }
      next(error)
    }
  }
router.post(
  '/venues/:venueId/checadas/entrada',
  authenticateTokenMiddleware,
  requireVenueMembership,
  validateRequest(entradaDeCampoSchema),
  checada(registrarEntradaDeCampo, 201),
)
router.post(
  '/venues/:venueId/checadas/salida',
  authenticateTokenMiddleware,
  requireVenueMembership,
  validateRequest(salidaDeCampoSchema),
  checada(registrarSalidaDeCampo, 200),
)

export default router
