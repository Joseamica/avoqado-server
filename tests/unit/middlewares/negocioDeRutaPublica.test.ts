/**
 * Rutas públicas: el negocio entra al contexto en cuanto la URL lo identifica. Sin esto, el candado de los negocios
 * demo no sabía de qué negocio era un correo o WhatsApp del portal o del recibo digital (Codex r1, hallazgo 2).
 */
import { getContext, runWithContext, type ExecutionContext } from '@/observability/executionContext'
import prisma from '@/utils/prismaClient'
import { negocioPorLigaDePago, negocioPorReciboDigital, negocioPorSlug } from '@/middlewares/negocioDeRutaPublica.middleware'
import { __olvidarNegociosDemoParaPruebas } from '@/services/demo/candadoDemo'

const db = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  paymentLink: { findUnique: jest.Mock }
  digitalReceipt: { findUnique: jest.Mock }
}
db.paymentLink ??= { findUnique: jest.fn() }
db.digitalReceipt ??= { findUnique: jest.fn() }

const ctx = (): ExecutionContext => ({ correlationId: 'c', source: 'http', entrypoint: 'GET /api/v1/public/x' })

function correr(handler: any, valor: string, req: any = { method: 'GET', path: '/' }): Promise<ExecutionContext | undefined> {
  return runWithContext(
    ctx(),
    () =>
      new Promise(resolve => {
        handler(req, {}, () => resolve(getContext()), valor, 'p')
      }),
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  __olvidarNegociosDemoParaPruebas()
})

it('por slug: el negocio queda en el contexto', async () => {
  db.venue.findUnique.mockResolvedValue({ id: 'v-demo' })
  expect((await correr(negocioPorSlug, 'studio-bloom'))?.venueId).toBe('v-demo')
})

it('por liga de pago y por recibo digital', async () => {
  db.paymentLink.findUnique.mockResolvedValue({ venueId: 'v-liga' })
  expect((await correr(negocioPorLigaDePago, 'AB12CD34'))?.venueId).toBe('v-liga')
  db.digitalReceipt.findUnique.mockResolvedValue({ payment: { venueId: 'v-recibo' } })
  expect((await correr(negocioPorReciboDigital, 'ckey'))?.venueId).toBe('v-recibo')
})

it('si no existe o la base falla, la petición sigue sin negocio (nunca la rompe)', async () => {
  db.venue.findUnique.mockResolvedValue(null)
  expect((await correr(negocioPorSlug, 'no-existe'))?.venueId).toBeUndefined()
  db.venue.findUnique.mockRejectedValue(new Error('P1001'))
  expect((await correr(negocioPorSlug, 'x'))?.venueId).toBeUndefined()
})

it('una liga de pago de un negocio demo no cobra: 403 antes de tocar al procesador', async () => {
  db.paymentLink.findUnique.mockResolvedValue({ venueId: 'v-demo' })
  db.venue.findUnique.mockResolvedValue({ status: 'LIVE_DEMO' })
  const json = jest.fn()
  const res = { status: jest.fn(() => ({ json })) }
  const next = jest.fn()
  await new Promise<void>(resolve => {
    runWithContext(ctx(), () => {
      negocioPorLigaDePago({ method: 'POST', path: '/payment-links/AB12/charge' } as any, res as any, next, 'AB12', 'shortCode')
    })
    setTimeout(resolve, 10)
  })
  expect(res.status).toHaveBeenCalledWith(403)
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NEGOCIO_DEMO' }))
  expect(next).not.toHaveBeenCalled()
})

it('regresión: la liga de un negocio real cobra normal, y ver la liga del demo también', async () => {
  db.paymentLink.findUnique.mockResolvedValue({ venueId: 'v-real' })
  db.venue.findUnique.mockResolvedValue({ status: 'ACTIVE' })
  expect((await correr(negocioPorLigaDePago, 'AB12', { method: 'POST', path: '/payment-links/AB12/charge' }))?.venueId).toBe('v-real')
  db.paymentLink.findUnique.mockResolvedValue({ venueId: 'v-demo2' })
  db.venue.findUnique.mockResolvedValue({ status: 'LIVE_DEMO' })
  expect((await correr(negocioPorLigaDePago, 'CD34', { method: 'GET', path: '/payment-links/CD34' }))?.venueId).toBe('v-demo2')
})

it('🔴 /CHARGE en mayúsculas también es un cobro (Codex r2, 2)', async () => {
  db.paymentLink.findUnique.mockResolvedValue({ venueId: 'v-demo3' })
  db.venue.findUnique.mockResolvedValue({ status: 'LIVE_DEMO' })
  const json = jest.fn()
  const res = { status: jest.fn(() => ({ json })) }
  const next = jest.fn()
  await new Promise<void>(resolve => {
    runWithContext(ctx(), () => {
      negocioPorLigaDePago(
        { method: 'POST', originalUrl: '/api/v1/public/payment-links/AB12/CHARGE' } as any,
        res as any,
        next,
        'AB12',
        'shortCode',
      )
    })
    setTimeout(resolve, 10)
  })
  expect(res.status).toHaveBeenCalledWith(403)
  expect(next).not.toHaveBeenCalled()
})

it('🔴 un cobro público sin poder confirmar el negocio no sigue: 503 (Codex r2, 8)', async () => {
  db.paymentLink.findUnique.mockResolvedValue({ venueId: 'v-x' })
  db.venue.findUnique.mockRejectedValue(new Error('P1001'))
  const json = jest.fn()
  const res = { status: jest.fn(() => ({ json })) }
  const next = jest.fn()
  await new Promise<void>(resolve => {
    runWithContext(ctx(), () => {
      negocioPorLigaDePago(
        { method: 'POST', originalUrl: '/api/v1/public/payment-links/AB12/charge' } as any,
        res as any,
        next,
        'AB12',
        'shortCode',
      )
    })
    setTimeout(resolve, 10)
  })
  expect(res.status).toHaveBeenCalledWith(503)
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NEGOCIO_DEMO_SIN_CONFIRMAR' }))
  expect(next).not.toHaveBeenCalled()
})

it('🔴 si no se pudo confirmar el negocio de una ruta pública que no cobra, sigue, pero marcada para no mandar mensajes (Codex r3, 1)', async () => {
  db.venue.findUnique.mockRejectedValue(new Error('P1001'))
  const contexto = await correr(negocioPorSlug, 'studio-bloom', { method: 'POST', originalUrl: '/api/v1/public/venues/studio-bloom/auth/otp/request' })
  expect(contexto?.venueId).toBeUndefined()
  expect(contexto?.negocioSinConfirmar).toBe(true)
})
