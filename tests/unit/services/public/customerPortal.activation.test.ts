import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/jwt.service', () => ({ __esModule: true, generateCustomerToken: jest.fn(() => 'signed.jwt.token') }))
jest.mock('bcryptjs', () => ({ __esModule: true, default: { hash: jest.fn(async () => 'hashed'), compare: jest.fn(async () => true) } }))

import { registerCustomer } from '@/services/public/customerPortal.public.service'
import { generateCustomerToken } from '@/jwt.service'
import bcrypt from 'bcryptjs'

/**
 * 🔴 Auditoría de seguridad 2026-09-30/10-01 — toma de cuentas de clientes. «Crear cuenta» con correo y contraseña le ponía la
 * contraseña de quien llenara el formulario a un cliente que ya existía sin contraseña (y por teléfono, además, le cambiaba el
 * correo), y dejaba «apartar» el correo de alguien antes de que reservara. Decisión del founder (1-oct): toda cuenta nueva se
 * crea con código (`verifyOtp`, que prueba que el correo o el teléfono son de quien entra). El registro con contraseña responde
 * SIEMPRE lo mismo y no toca nada: tampoco dice si el contacto ya existe o está desactivado.
 */
describe('registerCustomer — toda cuenta nueva se crea con código', () => {
  beforeEach(() => jest.clearAllMocks())

  it('400 CUSTOMER_REGISTER_USE_CODE, sin tocar la base, sin contraseña y sin sesión', () => {
    expect(() => registerCustomer()).toThrow(expect.objectContaining({ statusCode: 400, code: 'CUSTOMER_REGISTER_USE_CODE' }))

    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(bcrypt.hash).not.toHaveBeenCalled()
    expect(generateCustomerToken).not.toHaveBeenCalled()
  })

  it('el mensaje le dice al cliente qué hacer', () => {
    expect(() => registerCustomer()).toThrow(/entra con un código/i)
  })
})
