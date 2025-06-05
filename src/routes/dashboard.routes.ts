import express, { RequestHandler } from 'express'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware' // Verifica esta ruta
import { authorizeRole } from '../middlewares/authorizeRole.middleware' // Verifica esta ruta
import { validateRequest as validateRequestMiddleware } from '../middlewares/validation' // Verifica esta ruta

// Importa StaffRole desde @prisma/client si ahí es donde está definido tu enum de Prisma
// o desde donde lo hayas exportado como enum de TS (si es una copia manual)
import { StaffRole } from '@prisma/client' // O '../security' si StaffRole está definido ahí como un enum de TS manualmente

// Importa el SCHEMA de Zod, no el tipo DTO, para el middleware de validación
import { createVenueSchema, listVenuesQuerySchema } from '../schemas/venue.schema'
import * as venueController from '../controllers/dashboard/venue.dashboard.controller'

const router = express.Router()

// Rutas de Venue para el Dashboard
router.post(
  '/venues',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN]),
  validateRequestMiddleware(createVenueSchema), // Pasas el schema de Zod
  venueController.createVenue, // Llamas al método del controlador
)

router.get(
  '/venues',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER]),
  validateRequestMiddleware(listVenuesQuerySchema), // Validar query params
  venueController.listVenues as unknown as RequestHandler, // Type assertion for controller
)
// ... más rutas del dashboard

export default router
