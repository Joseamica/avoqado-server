import express, { Request, Response, Router } from 'express'
import { StaffRole } from '@prisma/client' // StaffRole from Prisma
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { authorizeRole } from '../middlewares/authorizeRole.middleware' // Corrected import

const router: Router = express.Router({ mergeParams: true })

/**
 * @openapi
 * components:
 *   schemas:
 *     OrderItem:
 *       type: object
 *       properties:
 *         menuItemId:
 *           type: string
 *           format: uuid
 *           description: ID del ítem del menú.
 *           example: 'd290f1ee-6c54-4b01-90e6-d701748f0851'
 *         quantity:
 *           type: integer
 *           description: Cantidad del ítem.
 *           example: 2
 *         notes:
 *           type: string
 *           description: Notas especiales para este ítem (ej. sin cebolla).
 *           example: 'Extra queso, sin aceitunas'
 *           nullable: true
 *     CreateOrderRequest:
 *       type: object
 *       required:
 *         - items
 *       properties:
 *         tableNumber:
 *           type: string
 *           description: Número o identificador de la mesa (opcional).
 *           example: 'Mesa 5'
 *           nullable: true
 *         customerNotes:
 *           type: string
 *           description: Notas generales para el pedido (opcional).
 *           example: 'Alergia a los frutos secos'
 *           nullable: true
 *         items:
 *           type: array
 *           description: Lista de ítems en el pedido.
 *           items:
 *             $ref: '#/components/schemas/OrderItem'
 *           minItems: 1
 *     Order:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: ID único del pedido.
 *           example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
 *         venueId:
 *           type: string
 *           format: uuid
 *           description: ID del venue donde se realizó el pedido.
 *           example: 'a1b2c3d4-e5f6-7890-1234-567890abcdef'
 *         tableNumber:
 *           type: string
 *           nullable: true
 *         status:
 *           type: string
 *           description: Estado actual del pedido.
 *           enum: [PENDING, CONFIRMED, PREPARING, READY, SERVED, PAID, CANCELLED]
 *           example: 'PENDING'
 *         totalAmount:
 *           type: number
 *           format: float
 *           description: Monto total del pedido.
 *           example: 35.50
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Fecha y hora de creación del pedido.
 *         items:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/OrderItem'
 *     CreateOrderResponse:
 *       type: object
 *       properties:
 *         message:
 *           type: string
 *           example: 'Pedido creado exitosamente.'
 *         order:
 *           $ref: '#/components/schemas/Order'
 */

/**
 * @openapi
 * /secure/venues/{venueId}/orders:
 *   post:
 *     tags:
 *       - Orders
 *     summary: Crea un nuevo pedido para un venue específico.
 *     description: Este endpoint requiere autenticación (Bearer Token) y que el staff tenga un rol permitido.
 *     security:
 *       - bearerAuth: [] # Indica que se usa el esquema de seguridad 'bearerAuth'
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         description: El ID del venue donde se creará el pedido.
 *         schema:
 *           type: string
 *           format: uuid
 *           example: 'a1b2c3d4-e5f6-7890-1234-567890abcdef'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateOrderRequest'
 *     responses:
 *       '201':
 *         description: Pedido creado exitosamente.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CreateOrderResponse'
 *       '400':
 *         description: Datos de entrada inválidos.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '401':
 *         description: No autenticado (token no provisto o inválido).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '403':
 *         description: Prohibido (rol no permitido para esta acción).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '404':
 *         description: Venue no encontrado.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '500':
 *         description: Error interno del servidor.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post(
  '/venues/:venueId/orders',
  authenticateTokenMiddleware, // Apply authentication middleware
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.WAITER]), // Apply authorization middleware
  (req: Request, res: Response) => {
    const { venueId } = req.params
    const orderData = req.body // Debería coincidir con CreateOrderRequest

    // Lógica para crear el pedido...
    // Validar datos, interactuar con la base de datos, etc.
    // Aquí se asumiría que req.authContext está disponible si los middlewares de auth se ejecutan antes

    // Ejemplo de respuesta mock:
    const mockCreatedOrder: any = {
      id: 'new-order-id-123',
      venueId: venueId,
      tableNumber: orderData.tableNumber,
      status: 'PENDING',
      totalAmount: orderData.items.reduce((sum: number, item: any) => sum + item.quantity * 10, 0), // Precio mock
      createdAt: new Date().toISOString(),
      items: orderData.items,
    }

    res.status(201).json({
      message: 'Pedido creado exitosamente.',
      order: mockCreatedOrder,
    })
  },
)

export default router
