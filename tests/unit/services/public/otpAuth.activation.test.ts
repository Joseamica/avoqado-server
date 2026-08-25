import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/jwt.service', () => ({ __esModule: true, generateCustomerToken: jest.fn(() => 'signed.jwt.token') }))
jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  activateCustomerAccount: jest.fn(async () => ({ approvalStatus: 'APPROVED', requestsApproval: false, approvalVersion: 0 })),
}))

import crypto from 'crypto'
import { verifyOtp } from '@/services/public/otpAuth.public.service'
import { activateCustomerAccount } from '@/services/public/customerBookingAccess.service'
import { generateCustomerToken } from '@/jwt.service'

/**
 * Fase 1 slice 2 — el verify de OTP se vuelve TRANSACCIONAL.
 *
 * Antes: consumir el reto, crear el Consumer, crear el Customer y ligarlos eran cuatro
 * escrituras sueltas. Si algo tronaba en medio quedaba un Consumer huérfano y el código ya
 * quemado — el cliente tenía que pedir otro. Ahora todo eso vive en UNA transacción, y el
 * estado de aprobación se decide dentro de ella.
 *
 * Fronteras (auditoría de diseño): DENTRO el reto + Consumer + Customer + vínculo + activación;
 * FUERA el token (post-commit). El envío del código vive en `requestOtp`, otro flujo.
 */
const VENUE = 'venue-1'
const PHONE = '+525511110000'
const CODE = '123456'

function hash(code: string) {
  return crypto.createHash('sha256').update(`${code}:${process.env.OTP_PEPPER}`).digest('hex')
}

function armHappyPath() {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.otpChallenge.findFirst.mockResolvedValue({
    id: 'ch1',
    venueId: VENUE,
    destination: PHONE,
    channel: 'whatsapp',
    codeHash: hash(CODE),
    attempts: 0,
    maxAttempts: 5,
    expiresAt: new Date(Date.now() + 600_000),
    consumedAt: null,
  } as any)
  prismaMock.otpChallenge.update.mockResolvedValue({} as any)
  ;(prismaMock.otpChallenge.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  prismaMock.consumer.findMany.mockResolvedValue([{ id: 'cons1', phone: PHONE }] as any)
  prismaMock.customer.findUnique.mockResolvedValue(null)
  prismaMock.customer.findFirst.mockResolvedValue(null)
  prismaMock.reservation.findFirst.mockResolvedValue(null)
  // El backfill de nombre por teléfono usa SQL crudo (prefiltro por últimos 10 dígitos).
  ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
  prismaMock.customer.create.mockResolvedValue({
    id: 'cust1',
    venueId: VENUE,
    phone: PHONE,
    email: null,
    firstName: null,
    lastName: null,
    active: true,
  } as any)
}

describe('verifyOtp — transaccional (Fase 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.OTP_PEPPER = process.env.OTP_PEPPER || 'test-pepper'
    armHappyPath()
  })

  it('🔴 consumo del reto + Consumer + Customer + activación corren en UNA sola transacción', async () => {
    await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE })

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(activateCustomerAccount).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust1', venueId: VENUE, origin: 'OTP' })
  })

  it('🔴 si la identidad falla a media transacción, el reto NO queda quemado (todo se revierte)', async () => {
    prismaMock.customer.create.mockRejectedValue(new Error('db down'))

    await expect(verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE })).rejects.toThrow('db down')
    // El token nunca se emite y el rollback deshace el consumedAt del reto.
    expect(generateCustomerToken).not.toHaveBeenCalled()
  })

  it('🔴 el token se emite DESPUÉS del commit', async () => {
    const order: string[] = []
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      const r = await fn(prismaMock)
      order.push('commit')
      return r
    })
    ;(generateCustomerToken as jest.Mock).mockImplementation(() => {
      order.push('token')
      return 'signed.jwt.token'
    })

    await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE })
    expect(order).toEqual(['commit', 'token'])
  })

  it('devuelve approvalStatus para que el controller lo componga en bookingAccess', async () => {
    ;(activateCustomerAccount as jest.Mock).mockResolvedValue({ approvalStatus: 'PENDING', requestsApproval: true, approvalVersion: 0 })

    const r = await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE })
    expect(r).toEqual(expect.objectContaining({ token: 'signed.jwt.token', approvalStatus: 'PENDING' }))
  })

  // ---- Regresiones de Fase 0 que NO se pueden romper --------------------------------------
  it('regresión: código incorrecto → 400 y NO abre transacción de identidad', async () => {
    await expect(verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: '999999' })).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(activateCustomerAccount).not.toHaveBeenCalled()
  })

  it('regresión: reto expirado → 400, sin tocar identidad', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue({
      id: 'ch1',
      codeHash: hash(CODE),
      attempts: 0,
      maxAttempts: 5,
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
    } as any)

    await expect(verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE })).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(activateCustomerAccount).not.toHaveBeenCalled()
  })

  // ---- Un solo uso de verdad (hallazgo #7 de la auditoría de Codex) ---------------------
  it('🔴 el reto se consume con CAS sobre `consumedAt: null`, no con un update ciego', async () => {
    await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE })

    // Un `update` por id consume el reto aunque otra petición simultánea ya lo haya
    // consumido: las dos emitirían token. El CAS deja pasar a UNA sola.
    expect(prismaMock.otpChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'ch1', consumedAt: null }) }),
    )
  })

  it('🔴 si otra petición ya lo consumió (count 0) → 400 y NO se emite token', async () => {
    ;(prismaMock.otpChallenge.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    await expect(verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE })).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(generateCustomerToken).not.toHaveBeenCalled()
    expect(activateCustomerAccount).not.toHaveBeenCalled()
  })

  it('regresión: cuenta desactivada → 401 CUSTOMER_INACTIVE, sin token', async () => {
    const inactivo = { id: 'cust1', venueId: VENUE, phone: PHONE, active: false, consumerId: 'cons1' }
    prismaMock.customer.findUnique.mockResolvedValue(inactivo as any)
    prismaMock.customer.update.mockResolvedValue(inactivo as any)

    await expect(verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE })).rejects.toMatchObject({
      statusCode: 401,
      code: 'CUSTOMER_INACTIVE',
    })
    expect(generateCustomerToken).not.toHaveBeenCalled()
  })
})
