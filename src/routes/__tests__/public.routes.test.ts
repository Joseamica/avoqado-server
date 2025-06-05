import request from 'supertest'
import app from '../../app'
import { pgPool } from '../../server' // Ajusta la ruta si tu server.ts está en otro lugar

describe('Public Routes API', () => {
  // Cierra la conexión de la base de datos después de todas las pruebas en este archivo
  afterAll(async () => {
    await pgPool.end()
  })

  describe('GET /api/public/healthcheck', () => {
    it('should return 200 OK with status and timestamp', async () => {
      const response = await request(app).get('/api/public/healthcheck')
      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('status', 'ok')
      expect(response.body).toHaveProperty('timestamp')
      // Opcionalmente, validar el formato del timestamp si es necesario
      expect(new Date(response.body.timestamp).toISOString()).toBe(response.body.timestamp)
    })
  })

  // Ejemplo de prueba para una ruta pública de tu aplicación (publicMenu.routes.ts)
  // Asumiendo que tienes un venue con ID 'test-venue-id' o que el endpoint maneja IDs no existentes graciosamente
  describe('GET /api/v1/public/venues/:venueId/menu', () => {
    it('should return 200 OK for an existing venue menu (or appropriate error for non-existing)', async () => {
      const venueId = 'cmbihyc5g00019krw05irssyh' // Reemplaza con un ID de venue válido para pruebas o mockea la respuesta
      const response = await request(app).get(`/api/v1/public/venues/${venueId}/menu`)

      // El código de estado esperado dependerá de tu implementación:
      // Si el venue no existe, podría ser 404.
      // Si existe y tiene menú, 200.
      // Para este ejemplo, asumiremos que un 404 es aceptable si el venue de prueba no existe,
      // o que tu endpoint de mock devuelve 200 como en el checkpoint.
      expect([200, 404]).toContain(response.status)

      if (response.status === 200) {
        expect(response.body).toHaveProperty('venueId', venueId)
        expect(response.body).toHaveProperty('categories')
        expect(Array.isArray(response.body.categories)).toBe(true)
      }
    })
  })
})
