import express, { Request, Response, Router } from 'express'

const router: Router = express.Router({ mergeParams: true })

/**
 * @openapi
 * components:
 *   schemas:
 *     MenuItem:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: ID único del ítem del menú.
 *           example: 'd290f1ee-6c54-4b01-90e6-d701748f0851'
 *         name:
 *           type: string
 *           description: Nombre del ítem del menú.
 *           example: 'Pizza Margherita'
 *         description:
 *           type: string
 *           description: Descripción detallada del ítem.
 *           example: 'Pizza clásica con tomate, mozzarella y albahaca.'
 *         price:
 *           type: number
 *           format: float
 *           description: Precio del ítem.
 *           example: 12.99
 *         imageUrl:
 *           type: string
 *           format: url
 *           description: URL de la imagen del ítem (opcional).
 *           example: 'https://example.com/images/pizza.jpg'
 *           nullable: true
 *     MenuCategory:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: ID único de la categoría del menú.
 *           example: 'c290f1ee-6c54-4b01-90e6-d701748f0852'
 *         name:
 *           type: string
 *           description: Nombre de la categoría.
 *           example: 'Pizzas'
 *         items:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/MenuItem'
 *     PublicMenuResponse:
 *       type: object
 *       properties:
 *         venueId:
 *           type: string
 *           format: uuid
 *           description: ID del venue al que pertenece el menú.
 *         categories:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/MenuCategory'
 */

/**
 * @openapi
 * /public/venues/{venueId}/menu:
 *   get:
 *     tags:
 *       - Public Menu
 *     summary: Obtiene el menú público de un venue específico.
 *     description: Retorna una lista de categorías, cada una con sus ítems de menú para el venue especificado.
 *     parameters:
 *       - in: path
 *         name: venueId
 *         required: true
 *         description: El ID del venue para el cual obtener el menú.
 *         schema:
 *           type: string
 *           format: uuid
 *           example: 'a1b2c3d4-e5f6-7890-1234-567890abcdef'
 *     responses:
 *       '200':
 *         description: Menú obtenido exitosamente.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PublicMenuResponse'
 *       '404':
 *         description: Venue no encontrado o sin menú disponible.
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
router.get('/venues/:venueId/menu', (req: Request, res: Response) => {
  const { venueId } = req.params
  // Lógica para obtener el menú del venueId
  // Ejemplo de respuesta mock:
  const mockMenu: any = {
    venueId: venueId,
    categories: [
      {
        id: 'cat1',
        name: 'Entradas',
        items: [{ id: 'item1', name: 'Bruschetta', description: 'Pan tostado con tomate y ajo', price: 7.5 }],
      },
      {
        id: 'cat2',
        name: 'Platos Fuertes',
        items: [
          { id: 'item2', name: 'Lasaña', description: 'Lasaña de carne tradicional', price: 15.0 },
          { id: 'item3', name: 'Salmón a la parrilla', description: 'Con vegetales de temporada', price: 18.5 },
        ],
      },
    ],
  }
  res.status(200).json(mockMenu)
})

export default router
