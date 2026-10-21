import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/jwt.service', () => ({
  __esModule: true,
  generateCustomerToken: jest.fn(() => 'signed.jwt.token'),
}))
jest.mock('bcryptjs', () => ({
  __esModule: true,
  default: { hash: jest.fn(async () => 'hashed'), compare: jest.fn(async () => true) },
}))

import bcrypt from 'bcryptjs'
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
    ;(bcrypt.compare as jest.Mock).mockResolvedValue(true)
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
      expect(bcrypt.compare).toHaveBeenCalledWith('secreto', 'hashed')
    })

    // Entrar con contraseña sigue siendo para cuentas que YA la tienen: se compara siempre, y la incorrecta no da token.
    it('contraseña incorrecta → 401, sin token', async () => {
      prismaMock.customer.findUnique.mockResolvedValue({
        id: 'c1',
        venueId: VENUE,
        email: 'a@b.com',
        password: 'hashed',
        active: true,
      } as any)
      ;(bcrypt.compare as jest.Mock).mockResolvedValue(false)

      await expect(loginCustomer(VENUE, 'a@b.com', 'otra')).rejects.toMatchObject({ statusCode: 401 })
      expect(generateCustomerToken).not.toHaveBeenCalled()
    })

    it('cuenta sin contraseña (nació con código) → 401, sin comparar ni token', async () => {
      prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', venueId: VENUE, email: 'a@b.com', password: null, active: true } as any)

      await expect(loginCustomer(VENUE, 'a@b.com', 'cualquiera')).rejects.toMatchObject({ statusCode: 401 })
      expect(bcrypt.compare).not.toHaveBeenCalled()
      expect(generateCustomerToken).not.toHaveBeenCalled()
    })
  })

  // 🔴 Desde el 1-oct (toma de cuentas de clientes) «Crear cuenta» no consulta nada: toda cuenta nueva se crea con código, y es
  // `verifyOtp` el que responde 401 CUSTOMER_INACTIVE a una cuenta desactivada. El registro ya no revela si el contacto existe.
  describe('registerCustomer sobre contacto existente', () => {
    it('contacto desactivado: el mismo 400 que cualquiera, sin tocar la base ni emitir token', async () => {
      prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', venueId: VENUE, email: 'a@b.com', password: null, active: false } as any)

      expect(() => registerCustomer()).toThrow(expect.objectContaining({ statusCode: 400, code: 'CUSTOMER_REGISTER_USE_CODE' }))
      expect(prismaMock.customer.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.customer.update).not.toHaveBeenCalled()
      expect(generateCustomerToken).not.toHaveBeenCalled()
    })
  })
})
