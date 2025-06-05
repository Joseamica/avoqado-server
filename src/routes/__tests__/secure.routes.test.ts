import request from 'supertest'
import jwt from 'jsonwebtoken'
import app from '../../app';
import { pgPool } from '../../server'; // Ajusta la ruta si es necesario
import { StaffRole } from '../../security' // StaffRole enum from local security module

// --- Helper para generar tokens JWT de prueba ---
const TEST_ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-secret-key' // Usa el mismo secreto que tu app o uno de prueba

interface TestTokenPayload {
  sub: string // staffId
  orgId: string
  venueId: string
  role: StaffRole
  // Puedes añadir otros campos que tu AvoqadoJwtPayload espere
}

const generateTestToken = (payload: TestTokenPayload): string => {
  return jwt.sign(payload, TEST_ACCESS_TOKEN_SECRET, { expiresIn: '15m' }) // Token de corta duración para pruebas
}

describe('Secure Routes API', () => {
  afterAll(async () => {
    await pgPool.end()
  })

  // Ejemplo de un endpoint protegido. Ajusta la ruta y el payload según tus necesidades.
  // Por ejemplo, una ruta GET /api/v1/secure/staff/profile que devuelve el perfil del staff autenticado.
  const secureProfileEndpoint = '/api/v1/secure/staff/profile' // CAMBIA ESTA RUTA si es diferente

  /* // TODO: Implement /api/v1/secure/staff/profile route or adapt these tests
describe(`GET ${secureProfileEndpoint}`, () => {
    it('should return 401 Unauthorized if no token is provided', async () => {
      const response = await request(app).get(secureProfileEndpoint);
      expect(response.status).toBe(401);
      // Podrías también verificar el cuerpo del error si tu API devuelve uno específico
      // expect(response.body.error).toBe('No token provided'); // O el mensaje que uses
    });

    it('should return 401 Unauthorized if an invalid or malformed token is provided', async () => {
      const response = await request(app)
        .get(secureProfileEndpoint)
        .set('Authorization', 'Bearer invalidtoken123');
      expect(response.status).toBe(401);
      // expect(response.body.error).toBe('Invalid token'); // O el mensaje que uses
    });

    it('should return 200 OK and profile data if a valid token (ADMIN role) is provided', async () => {
      const adminToken = generateTestToken({
        sub: 'test-admin-staff-id',
        orgId: 'test-org-id',
        venueId: 'test-venue-id',
        role: StaffRole.ADMIN,
      });

      const response = await request(app)
        .get(secureProfileEndpoint) // Asume que esta ruta existe y devuelve datos del perfil
        .set('Authorization', `Bearer ${adminToken}`);
      
      // Esto es un ejemplo. El código de estado y el cuerpo dependerán de tu implementación real.
      // Si la ruta /api/v1/secure/staff/profile no existe, esto fallará.
      // Deberás crearla o adaptar la prueba a una ruta segura existente.
      expect(response.status).toBe(200); 
      // expect(response.body).toHaveProperty('staffId', 'test-admin-staff-id');
      // expect(response.body).toHaveProperty('role', StaffRole.ADMIN);
    });

    it('should return 200 OK and profile data if a valid token (MANAGER role) is provided', async () => {
      const managerToken = generateTestToken({
        sub: 'test-manager-staff-id',
        orgId: 'test-org-id',
        venueId: 'test-venue-id',
        role: StaffRole.MANAGER,
      });

      const response = await request(app)
        .get(secureProfileEndpoint) // Asume que esta ruta existe
        .set('Authorization', `Bearer ${managerToken}`);
      
      expect(response.status).toBe(200); // Adaptar según tu endpoint
      // expect(response.body).toHaveProperty('staffId', 'test-manager-staff-id');
    });

    // Opcional: Prueba de autorización fallida (rol incorrecto)
    // Supongamos que el endpoint secureProfileEndpoint requiere rol ADMIN o MANAGER,
    // pero no WAITER.
    // Necesitarías un middleware de autorización en esa ruta para que esto funcione.
    
    it('should return 403 Forbidden if a valid token with an unauthorized role (WAITER) is provided', async () => {
      const waiterToken = generateTestToken({
        sub: 'test-waiter-staff-id',
        orgId: 'test-org-id',
        venueId: 'test-venue-id',
        role: StaffRole.WAITER,
      });

      const response = await request(app)
        .get(secureProfileEndpoint) // Asume que esta ruta tiene control de roles
        .set('Authorization', `Bearer ${waiterToken}`);
      
      // Como la ruta no existe, esperamos 404 en lugar de 403
      expect(response.status).toBe(404); 
      // expect(response.body.error).toBe('Forbidden'); // O el mensaje que uses
    });
    
  });
*/

  // Puedes añadir más describe blocks para otros endpoints seguros
  // Ejemplo: POST /api/v1/secure/venues/{venueId}/orders (ya tienes este en orders.routes.ts)
  describe('POST /api/v1/secure/venues/:venueId/orders', () => {
    const venueId = 'test-venue-for-orders'
    const orderCreationEndpoint = `/api/v1/secure/venues/${venueId}/orders`

    it('should return 401 if no token is provided when creating an order', async () => {
      const response = await request(app)
        .post(orderCreationEndpoint)
        .send({ items: [{ productId: 'prod1', quantity: 1, price: 10 }] })
      expect(response.status).toBe(401)
    })

    it('should return 201 Created (or 200 OK) when creating an order with a valid token', async () => {
      const staffToken = generateTestToken({
        sub: 'staff-creating-order',
        orgId: 'org-for-orders',
        venueId: venueId, // El token debe ser válido para este venueId
        role: StaffRole.WAITER, // O el rol que tenga permiso para crear pedidos
      })

      const response = await request(app)
        .post(orderCreationEndpoint)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ items: [{ productId: 'prod-uuid-1', quantity: 2, price: 15.99 }] })

      // Tu API podría devolver 201 (Created) o 200 (OK) con el pedido creado.
      // La ruta real en orders.routes.ts devuelve 201.
      expect(response.status).toBe(201)
      expect(response.body.order).toHaveProperty('id')
      expect(response.body.order).toHaveProperty('venueId', venueId); // Check for 'venueId' within the 'order' object
      expect(response.body.order.items[0].productId).toBe('prod-uuid-1'); // Check for 'items' within the 'order' object
    })
  })
})
