import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/jwt.service', () => ({
  __esModule: true,
  generateCustomerToken: jest.fn(() => 'token.de.cliente'),
  generateOrderingCustomerToken: jest.fn(() => 'token.de.pedidos'),
}))
jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  activateCustomerAccount: jest.fn(async () => ({ approvalStatus: 'PENDING', requestsApproval: true, approvalVersion: 0 })),
}))

import { hashOtpCode } from '@/lib/otp'
import { generateCustomerToken, generateOrderingCustomerToken } from '@/jwt.service'
import { activateCustomerAccount } from '@/services/public/customerBookingAccess.service'
import { verifyOtp } from '@/services/public/otpAuth.public.service'
import { otpVerifySchema } from '@/schemas/dashboard/creditPack.schema'

const VENUE = 'venue-1'
const PHONE = '+525511110000'
const EMAIL = 'ana@example.com'
const CODE = '123456'

function armar(destination: string) {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.otpChallenge.findFirst.mockResolvedValue({
    id: 'ch1',
    venueId: VENUE,
    destination,
    codeHash: hashOtpCode(CODE),
    attempts: 0,
    maxAttempts: 5,
    expiresAt: new Date(Date.now() + 600_000),
    consumedAt: null,
  } as any)
  ;(prismaMock.otpChallenge.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  prismaMock.consumer.findMany.mockResolvedValue([{ id: 'cons1', phone: PHONE }] as any)
  prismaMock.consumer.findFirst.mockResolvedValue({ id: 'cons1', email: EMAIL } as any)
  prismaMock.customer.findUnique.mockResolvedValue(null)
  prismaMock.customer.findFirst.mockResolvedValue(null)
  prismaMock.reservation.findFirst.mockResolvedValue(null)
  ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
  prismaMock.customer.create.mockResolvedValue({
    id: 'cust1',
    venueId: VENUE,
    phone: destination === EMAIL ? null : PHONE,
    email: destination === EMAIL ? EMAIL : null,
    firstName: null,
    lastName: null,
    active: true,
    approvalStatus: 'APPROVED',
  } as any)
}

describe('verifyOtp · propósito ORDERING (R7) con token de pedidos aparte (H1)', () => {
  it('con purpose ORDERING verifica el teléfono SIN activar la cuenta de reservas y devuelve el token de PEDIDOS', async () => {
    armar(PHONE)
    const r = await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE, purpose: 'ORDERING' })
    expect(activateCustomerAccount).not.toHaveBeenCalled()
    expect(r.approvalStatus).toBe('APPROVED') // el de la ficha, sin tocarlo
    expect(generateOrderingCustomerToken).toHaveBeenCalledWith('cust1', VENUE, PHONE)
    expect(generateCustomerToken).not.toHaveBeenCalled()
    expect(r.token).toBe('token.de.pedidos')
  })

  it('🔴 el teléfono del token de pedidos va en la forma canónica del pedido (+521… → +52…)', async () => {
    armar('+5215543453965')
    await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: '+5215543453965', code: CODE, purpose: 'ORDERING' })
    expect(generateOrderingCustomerToken).toHaveBeenCalledWith('cust1', VENUE, '+525543453965')
  })

  it('ORDERING por correo es 400 ORDERING_REQUIRES_PHONE y no toca el reto (el código sigue sirviendo)', async () => {
    armar(EMAIL)
    await expect(
      verifyOtp({ venueId: VENUE, channel: 'email', destination: EMAIL, code: CODE, purpose: 'ORDERING' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDERING_REQUIRES_PHONE',
    })
    expect(prismaMock.otpChallenge.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.otpChallenge.updateMany).not.toHaveBeenCalled()
    expect(generateOrderingCustomerToken).not.toHaveBeenCalled()
  })

  it('sin purpose (reservas) todo sigue igual: activa la cuenta y firma el token de cliente de siempre, con dos argumentos', async () => {
    armar(PHONE)
    const r = await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE })
    expect(activateCustomerAccount).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust1', venueId: VENUE, origin: 'OTP' })
    expect(r.approvalStatus).toBe('PENDING')
    expect(generateCustomerToken).toHaveBeenCalledWith('cust1', VENUE)
    expect(generateOrderingCustomerToken).not.toHaveBeenCalled()
    expect(r.token).toBe('token.de.cliente')
  })

  it('el esquema acepta purpose ORDERING y rechaza cualquier otro', () => {
    expect(otpVerifySchema.safeParse({ phone: PHONE, code: CODE, purpose: 'ORDERING' }).success).toBe(true)
    expect(otpVerifySchema.safeParse({ phone: PHONE, code: CODE }).success).toBe(true)
    expect(otpVerifySchema.safeParse({ phone: PHONE, code: CODE, purpose: 'RESERVAS' }).success).toBe(false)
  })
})
