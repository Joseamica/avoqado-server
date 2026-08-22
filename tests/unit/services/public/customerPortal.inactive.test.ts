import { prismaMock } from '@tests/__helpers__/setup'
import { UnauthorizedError } from '@/errors/AppError'

jest.mock('@/jwt.service', () => ({
  __esModule: true,
  generateCustomerToken: jest.fn(() => 'signed.jwt.token'),
}))
jest.mock('bcryptjs', () => ({
  __esModule: true,
  default: { hash: jest.fn(async () => 'hashed'), compare: jest.fn(async () => true) },
}))

import { loginCustomer, registerCustomer } from '@/services/public/customerPortal.public.service'
import { generateCustomerToken } from '@/jwt.service'

const VENUE = 'venue-1'

/**
 * Fase 0.B — los emisores de token respetan `Customer.active`.
 * Una cuenta desactivada por el venue no recibe token por ninguna puerta.
 */
describe('customerPortal — Customer.active en emisores de token', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(generateCustomerToken as jest.Mock).mockReturnValue('signed.jwt.token')
  })

  describe('loginCustomer', () => {
    it('cuenta inactiva con password correcto → 401 CUSTOMER_INACTIVE, sin token', async () => {
      prismaMock.customer.findUnique.mockResolvedValue({
        id: 'c1',
        venueId: VENUE,
        email: 'a@b.com',
        password: 'hashed',
        active: false,
      } as any)

      await expect(loginCustomer(VENUE, 'a@b.com', 'secreto')).rejects.toMatchObject({
        statusCode: 401,
        code: 'CUSTOMER_INACTIVE',
      })
      expect(generateCustomerToken).not.toHaveBeenCalled()
    })

    it('regresión: cuenta activa con password correcto → token', async () => {
      prismaMock.customer.findUnique.mockResolvedValue({
        id: 'c1',
        venueId: VENUE,
        email: 'a@b.com',
        password: 'hashed',
        active: true,
        firstName: 'Ana',
        lastName: 'R',
        phone: null,
      } as any)

      const r = await loginCustomer(VENUE, 'a@b.com', 'secreto')
      expect(r.token).toBe('signed.jwt.token')
    })
  })

  describe('registerCustomer sobre contacto existente', () => {
    it('contacto existente INACTIVO sin password → 401 CUSTOMER_INACTIVE, no se le pone password ni token', async () => {
      prismaMock.customer.findUnique.mockResolvedValue({
        id: 'c1',
        venueId: VENUE,
        email: 'a@b.com',
        password: null,
        active: false,
      } as any)

      await expect(registerCustomer(VENUE, { email: 'a@b.com', password: 'Secreto123' })).rejects.toMatchObject({
        statusCode: 401,
        code: 'CUSTOMER_INACTIVE',
      })

      expect(prismaMock.customer.update).not.toHaveBeenCalled()
      expect(generateCustomerToken).not.toHaveBeenCalled()
    })

    it('🔴 contacto existente por TELÉFONO, inactivo, sin password → 401 CUSTOMER_INACTIVE (rama phoneExists)', async () => {
      // No hay cuenta por email; sí hay un contacto por teléfono, desactivado.
      prismaMock.customer.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.venueId_email) return null
        if (where.venueId_phone) return { id: 'c_tel', venueId: VENUE, phone: '+525511111111', password: null, active: false }
        return null
      })

      await expect(registerCustomer(VENUE, { email: 'nuevo@b.com', password: 'Secreto123', phone: '+525511111111' })).rejects.toMatchObject(
        { statusCode: 401, code: 'CUSTOMER_INACTIVE' },
      )

      expect(prismaMock.customer.update).not.toHaveBeenCalled()
      expect(generateCustomerToken).not.toHaveBeenCalled()
    })

    it('regresión: contacto existente ACTIVO sin password → se le pone password y recibe token', async () => {
      prismaMock.customer.findUnique.mockResolvedValue({
        id: 'c1',
        venueId: VENUE,
        email: 'a@b.com',
        password: null,
        active: true,
        phone: null,
        firstName: null,
        lastName: null,
      } as any)
      prismaMock.customer.update.mockResolvedValue({
        id: 'c1',
        venueId: VENUE,
        email: 'a@b.com',
        firstName: null,
        lastName: null,
        phone: null,
      } as any)

      const r = await registerCustomer(VENUE, { email: 'a@b.com', password: 'Secreto123' })
      expect(prismaMock.customer.update).toHaveBeenCalled()
      expect(r.token).toBe('signed.jwt.token')
    })
  })
})
