import prisma from '@/utils/prismaClient'
import { requestOtp } from '@/services/public/otpAuth.public.service'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: new Proxy({}, { get: () => jest.fn(async () => true) }) }))
jest.mock('@/services/whatsapp.service', () => ({ __esModule: true, sendOtpWhatsApp: jest.fn(async () => undefined) }))

/**
 * D11 (16-nov, Codex r13 #3 de asistencia verificada): contar los códigos recientes y crear el reto eran dos pasos sueltos. Dos
 * pedidos al MISMO teléfono al mismo tiempo leían la misma cuenta y los dos mandaban WhatsApp: se saltaban la espera de 30 s y el
 * máximo por hora. Contra Postgres de verdad: un candado no se prueba con dobles.
 */
const RUN = `${Date.now()}`
let orgId: string | undefined
let venueId: string | undefined

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: 'ITEST OTP tope', phone: '5550000000', email: `otp-tope-${RUN}@test.mx` } })
  orgId = org.id
  venueId = (
    await prisma.venue.create({
      data: {
        name: 'ITEST OTP tope',
        slug: `itest-otp-tope-${RUN}`,
        organizationId: org.id,
        timezone: 'America/Mexico_City',
        status: 'ACTIVE',
      },
    })
  ).id
})
afterAll(async () => {
  if (venueId) {
    await prisma.otpChallenge.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('🔴 dos pedidos simultáneos al mismo teléfono ⇒ sale UN código; el otro espera', async () => {
  const pedir = () => requestOtp({ venueId: venueId!, channel: 'whatsapp', destination: '55 1234 9876' })
  const resultados = await Promise.allSettled([pedir(), pedir(), pedir()])
  expect(resultados.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(await prisma.otpChallenge.count({ where: { venueId, destination: '+525512349876' } })).toBe(1)
  for (const r of resultados.filter(r => r.status === 'rejected')) {
    expect((r as PromiseRejectedResult).reason).toMatchObject({ statusCode: 400, message: 'Espera un momento antes de pedir otro código.' })
  }
})

it('regresión: otro teléfono del mismo negocio no espera al primero', async () => {
  await expect(requestOtp({ venueId: venueId!, channel: 'whatsapp', destination: '55 1234 1111' })).resolves.toEqual({ ok: true })
})
