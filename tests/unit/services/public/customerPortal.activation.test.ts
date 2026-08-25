import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/jwt.service', () => ({ __esModule: true, generateCustomerToken: jest.fn(() => 'signed.jwt.token') }))
jest.mock('bcryptjs', () => ({ __esModule: true, default: { hash: jest.fn(async () => 'hashed'), compare: jest.fn(async () => true) } }))
jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  activateCustomerAccount: jest.fn(async () => ({ approvalStatus: 'APPROVED', requestsApproval: false, approvalVersion: 0 })),
}))

import { registerCustomer } from '@/services/public/customerPortal.public.service'
import { activateCustomerAccount } from '@/services/public/customerBookingAccess.service'
import { generateCustomerToken } from '@/jwt.service'
import bcrypt from 'bcryptjs'

/**
 * Fase 1 slice 2 — el registro se vuelve TRANSACCIONAL para que el estado de aprobación se
 * decida en la MISMA tx que activa la cuenta. Fronteras exigidas por la auditoría de diseño:
 *   · DENTRO: los lookups de email/teléfono + create/update del Customer + activateCustomerAccount.
 *   · FUERA: el hash de bcrypt (lento, no toca DB) y generateCustomerToken (post-commit).
 * Con el switch apagado, nada del comportamiento anterior cambia.
 */
const VENUE = 'venue-1'
const DATA = { email: 'ana@test.com', password: 'Secreto123' }

function armTx() {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
}

describe('registerCustomer — transaccional (Fase 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    armTx()
    prismaMock.customer.findUnique.mockResolvedValue(null)
    prismaMock.customer.create.mockResolvedValue({
      id: 'c-new',
      venueId: VENUE,
      email: DATA.email,
      firstName: null,
      lastName: null,
      phone: null,
    } as any)
  })

  it('🔴 cuenta nueva: create + activateCustomerAccount corren DENTRO de una sola transacción', async () => {
    await registerCustomer(VENUE, DATA)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.customer.create).toHaveBeenCalled()
    expect(activateCustomerAccount).toHaveBeenCalledWith(expect.anything(), { customerId: 'c-new', venueId: VENUE, origin: 'PASSWORD' })
  })

  it('🔴 el hash de bcrypt corre FUERA de la tx (no se sostiene una transacción durante ~100ms de CPU)', async () => {
    const order: string[] = []
    ;(bcrypt.hash as jest.Mock).mockImplementation(async () => {
      order.push('hash')
      return 'hashed'
    })
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      order.push('tx')
      return fn(prismaMock)
    })

    await registerCustomer(VENUE, DATA)
    expect(order).toEqual(['hash', 'tx'])
  })

  it('🔴 el token se emite DESPUÉS del commit: si la tx revienta, nadie recibe sesión', async () => {
    ;(prismaMock.$transaction as jest.Mock).mockRejectedValue(new Error('db down'))
    await expect(registerCustomer(VENUE, DATA)).rejects.toThrow('db down')
    expect(generateCustomerToken).not.toHaveBeenCalled()
  })

  it('devuelve el bookingAccess de la activación para que el widget pinte "en espera"', async () => {
    ;(activateCustomerAccount as jest.Mock).mockResolvedValue({ approvalStatus: 'PENDING', requestsApproval: true, approvalVersion: 0 })

    const r = await registerCustomer(VENUE, DATA)
    expect(r).toEqual(expect.objectContaining({ token: 'signed.jwt.token', approvalStatus: 'PENDING' }))
  })

  // ---- Regresión: el switch apagado no cambia NADA de lo de antes ------------------------
  it('regresión: contacto existente sin password → se le pone password y recibe token', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', venueId: VENUE, email: DATA.email, password: null, active: true } as any)
    prismaMock.customer.update.mockResolvedValue({ id: 'c1', email: DATA.email, firstName: null, lastName: null, phone: null } as any)

    const r = await registerCustomer(VENUE, DATA)
    expect(prismaMock.customer.update).toHaveBeenCalled()
    expect(r.token).toBe('signed.jwt.token')
    expect(activateCustomerAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerId: 'c1', origin: 'PASSWORD' }),
    )
  })

  it('regresión: cuenta inactiva → 401 CUSTOMER_INACTIVE y NO abre transacción', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', venueId: VENUE, password: 'x', active: false } as any)

    await expect(registerCustomer(VENUE, DATA)).rejects.toMatchObject({ statusCode: 401, code: 'CUSTOMER_INACTIVE' })
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
    expect(activateCustomerAccount).not.toHaveBeenCalled()
  })

  it('regresión: ya existe cuenta con ese correo → 400, sin activar nada', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', venueId: VENUE, password: 'hashed', active: true } as any)

    await expect(registerCustomer(VENUE, DATA)).rejects.toMatchObject({ statusCode: 400 })
    expect(activateCustomerAccount).not.toHaveBeenCalled()
  })

  it('regresión: merge por teléfono (contacto con tel, sin password) sigue funcionando dentro de la tx', async () => {
    prismaMock.customer.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.venueId_email) return null
      if (where.venueId_phone) return { id: 'c-tel', venueId: VENUE, phone: '+525511111111', password: null, active: true }
      return null
    })
    prismaMock.customer.update.mockResolvedValue({
      id: 'c-tel',
      email: DATA.email,
      firstName: null,
      lastName: null,
      phone: '+525511111111',
    } as any)

    const r = await registerCustomer(VENUE, { ...DATA, phone: '+525511111111' })
    expect(r.customer.id).toBe('c-tel')
    expect(activateCustomerAccount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customerId: 'c-tel' }))
  })
})
