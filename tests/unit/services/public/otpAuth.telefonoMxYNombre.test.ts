/**
 * OTP de la página de la tarjeta (spec 2026-10-14 §3.3, C3): el teléfono se guarda con 52 y el alta pide el nombre.
 * Medido en prod (14-oct): 71 clientes / 73 consumidores con «+» + 10 dígitos sin lada, 41 de 41 sin nombre en Testarudo.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { BadRequestError } from '@/errors/AppError'
import { hashOtpCode } from '@/lib/otp'

jest.mock('@/services/whatsapp.service', () => ({ __esModule: true, sendOtpWhatsApp: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendOtpCodeEmail: jest.fn().mockResolvedValue(true) } }))
jest.mock('@/jwt.service', () => ({ __esModule: true, generateCustomerToken: jest.fn(() => 'tok') }))
jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  activateCustomerAccount: jest.fn(async () => ({ approvalStatus: 'APPROVED', requestsApproval: false, approvalVersion: 0 })),
}))

import { requestOtp, verifyOtp } from '@/services/public/otpAuth.public.service'
import { sendOtpWhatsApp } from '@/services/whatsapp.service'
import { otpVerifySchema } from '@/schemas/dashboard/creditPack.schema'

const VENUE = 'v1'
const NORM = '+525543453965'
const VIEJO = '+5543453965'
const CODE = '123456'

function sembrarReto(destination = NORM) {
  prismaMock.otpChallenge.findFirst.mockResolvedValue({
    id: 'ch1',
    venueId: VENUE,
    destination,
    channel: 'whatsapp',
    codeHash: hashOtpCode(CODE),
    attempts: 0,
    maxAttempts: 5,
    expiresAt: new Date(Date.now() + 300_000),
    consumedAt: null,
  } as any)
  prismaMock.otpChallenge.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([] as any)
  prismaMock.reservation.findFirst.mockResolvedValue(null)
}

describe('OTP — teléfono mexicano por defecto', () => {
  beforeEach(() => {
    process.env.OTP_PEPPER = 'test-pepper'
    prismaMock.otpChallenge.count.mockResolvedValue(0)
    prismaMock.otpChallenge.create.mockResolvedValue({ id: 'otp-1' } as any)
    prismaMock.otpChallenge.updateMany.mockResolvedValue({ count: 0 } as any)
  })

  it('pedir con 10 dígitos guarda el reto y manda el WhatsApp a +52…', async () => {
    await requestOtp({ venueId: VENUE, channel: 'whatsapp', destination: '5543453965' })
    expect((prismaMock.otpChallenge.create as jest.Mock).mock.calls[0][0].data.destination).toBe(NORM)
    expect((sendOtpWhatsApp as jest.Mock).mock.calls[0][0]).toBe(NORM)
  })

  it('pedir con «+» + 10 dígitos (lo que mandaba el portal viejo) también queda +52…', async () => {
    await requestOtp({ venueId: VENUE, channel: 'whatsapp', destination: VIEJO })
    expect((prismaMock.otpChallenge.create as jest.Mock).mock.calls[0][0].data.destination).toBe(NORM)
  })

  it('🔴 un «teléfono» sin dígitos es 400 y no crea reto (nunca cae al camino del correo con email undefined)', async () => {
    await expect(requestOtp({ venueId: VENUE, channel: 'whatsapp', destination: 'abcdefgh' })).rejects.toThrow(BadRequestError)
    await expect(verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: 'abcdefgh', code: CODE })).rejects.toThrow('Teléfono inválido')
    expect(prismaMock.otpChallenge.create).not.toHaveBeenCalled()
    expect(prismaMock.consumer.findFirst).not.toHaveBeenCalled()
  })

  it('verificar busca el reto con el MISMO valor normalizado', async () => {
    sembrarReto()
    prismaMock.consumer.findMany.mockResolvedValue([{ id: 'cons1', phone: NORM }] as any)
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', active: true, firstName: 'Dany', lastName: null, consumerId: 'cons1' } as any)
    await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: '55 4345 3965', code: CODE })
    expect((prismaMock.otpChallenge.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({ destination: NORM })
  })

  it('🔴 Dany guardado como +5543453965 (OTP viejo) ENTRA a su cuenta: no se duplica', async () => {
    sembrarReto()
    const DANY = { id: 'dany', venueId: VENUE, phone: VIEJO, firstName: 'Dany', lastName: null, active: true, consumerId: 'cons-viejo' }
    // El Consumer viejo se encuentra por su forma sin lada; no se crea otro.
    prismaMock.consumer.findMany.mockResolvedValue([{ id: 'cons-viejo', phone: VIEJO, createdAt: new Date('2026-09-01') }] as any)
    // Por +52 exacto no está; por consumerId nuevo tampoco.
    prismaMock.customer.findUnique.mockImplementation(async (a: any) => (a?.where?.id === 'dany' ? (DANY as any) : null))
    prismaMock.customer.findFirst.mockResolvedValue(DANY as any) // consumerId 'cons-viejo' sí lo encuentra
    const r = await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: '5543453965', code: CODE })
    expect(r.customer.id).toBe('dany')
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
    expect(prismaMock.consumer.create).not.toHaveBeenCalled()
    expect((prismaMock.consumer.findMany as jest.Mock).mock.calls[0][0].where).toEqual({ phone: { in: [NORM, VIEJO] } })
  })

  it('🔴 Dany con +5543453965 SIN Consumer ligado se encuentra por los últimos 10 dígitos (phonesMatch extendido)', async () => {
    sembrarReto()
    const DANY = { id: 'dany', venueId: VENUE, phone: VIEJO, firstName: 'Dany', lastName: null, active: true, consumerId: null }
    prismaMock.consumer.findMany.mockResolvedValue([])
    prismaMock.consumer.create.mockResolvedValue({ id: 'cons-nuevo', phone: NORM } as any)
    prismaMock.customer.findUnique.mockImplementation(async (a: any) => (a?.where?.id === 'dany' ? (DANY as any) : null))
    prismaMock.customer.findFirst.mockResolvedValue(null)
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'dany', phone: VIEJO }] as any) // findCustomerIdByPhone
    prismaMock.customer.update.mockImplementation(async ({ data }: any) => ({ ...DANY, ...data }) as any)
    const r = await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: '5543453965', code: CODE })
    expect(r.customer.id).toBe('dany')
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
  })
})

describe('OTP — nombre en el alta (nunca pisa uno existente)', () => {
  beforeEach(() => {
    process.env.OTP_PEPPER = 'test-pepper'
    sembrarReto()
    prismaMock.consumer.findMany.mockResolvedValue([{ id: 'cons1', phone: NORM }] as any)
    prismaMock.customer.findFirst.mockResolvedValue(null)
    prismaMock.customer.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, active: true, ...data }) as any)
  })

  it('cliente nuevo sin nombre: «Dany» queda como firstName', async () => {
    prismaMock.customer.findUnique.mockResolvedValue(null)
    prismaMock.customer.create.mockResolvedValue({ id: 'nuevo', active: true, firstName: null, lastName: null, phone: NORM } as any)
    const r = await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: NORM, code: CODE, firstName: 'Dany' })
    expect(prismaMock.customer.update).toHaveBeenCalledWith({ where: { id: 'nuevo' }, data: { firstName: 'Dany' } })
    expect(r.customer.firstName).toBe('Dany')
  })

  it('«María José Pérez» sin nombre ni apellido: primera palabra → firstName, resto → lastName', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', active: true, firstName: null, lastName: null, consumerId: 'cons1' } as any)
    await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: NORM, code: CODE, firstName: 'María José Pérez' })
    expect(prismaMock.customer.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { firstName: 'María', lastName: 'José Pérez' } })
  })

  it('🔴 no pisa un nombre que ya existe', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', active: true, firstName: 'Daniela', lastName: 'Ruiz', consumerId: 'cons1' } as any)
    const r = await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: NORM, code: CODE, firstName: 'Dany' })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
    expect(r.customer.firstName).toBe('Daniela')
  })

  it('sin nombre pero CON apellido: pone el nombre y no toca el apellido', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', active: true, firstName: null, lastName: 'López', consumerId: 'cons1' } as any)
    await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: NORM, code: CODE, firstName: 'Ana Gómez' })
    expect(prismaMock.customer.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { firstName: 'Ana' } })
  })

  it('regresión: sin firstName no escribe nada extra', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'c1', active: true, firstName: null, lastName: null, consumerId: 'cons1' } as any)
    await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: NORM, code: CODE })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })
})

describe('otpVerifySchema — firstName', () => {
  const base = { phone: '5543453965', code: '123456' }
  it('acepta 1-60 caracteres y recorta espacios', () => {
    const r = otpVerifySchema.safeParse({ ...base, firstName: '  Dany  ' })
    expect(r.success && r.data.firstName).toBe('Dany')
  })
  it('rechaza vacío tras recortar, en español', () => {
    const r = otpVerifySchema.safeParse({ ...base, firstName: '   ' })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r)).toMatch(/Escribe tu nombre/)
  })
  it('rechaza más de 60 caracteres, en español', () => {
    const r = otpVerifySchema.safeParse({ ...base, firstName: 'a'.repeat(61) })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r)).toMatch(/60 caracteres/)
  })
  it('regresión: sin firstName sigue siendo válido', () => {
    expect(otpVerifySchema.safeParse(base).success).toBe(true)
  })
})
