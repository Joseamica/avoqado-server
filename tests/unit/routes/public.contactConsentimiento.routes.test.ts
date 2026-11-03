/**
 * La casilla «Quiero recibir novedades de Avoqado por correo» en `POST /public/contact` (CRM fase 2, tarea 6), con
 * `public.routes.ts` real: el esquema deja pasar la casilla y la versión del aviso, y rechaza lo que no cabe en su columna
 * (la versión es de 20 caracteres como máximo) o no es un booleano. Lo que pasa llega al controlador tal cual.
 */
import express from 'express'
import request from 'supertest'

const mockSubmitContact = jest.fn()
const mockProxy = () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) })
jest.mock('@/controllers/hybridBilling.controller', () => mockProxy())
jest.mock('@/controllers/kiosk/kioskCheckIn.controller', () => mockProxy())
jest.mock('@/controllers/public/cfdi.public.controller', () => mockProxy())
jest.mock('@/controllers/public/creditPack.public.controller', () => mockProxy())
jest.mock('@/controllers/public/customerEmail.public.controller', () => mockProxy())
jest.mock('@/controllers/public/customerPortal.public.controller', () => mockProxy())
jest.mock('@/controllers/public/featureCatalog.public.controller', () => mockProxy())
jest.mock('@/controllers/public/giftCard.public.controller', () => mockProxy())
jest.mock('@/controllers/public/landing.public.controller', () => {
  const fallback = (_req: any, res: any) => res.json({ ok: true })
  return new Proxy(
    {},
    { get: (_target, name) => (name === 'submitContact' ? (req: any, res: any) => mockSubmitContact(req, res) : fallback) },
  )
})
jest.mock('@/controllers/public/launchOffer.public.controller', () => mockProxy())
jest.mock('@/controllers/public/otpAuth.public.controller', () => mockProxy())
jest.mock('@/controllers/public/passkit.public.controller', () => mockProxy())
jest.mock('@/controllers/public/paymentLink.public.controller', () => mockProxy())
jest.mock('@/controllers/public/privacyNotice.public.controller', () => mockProxy())
jest.mock('@/controllers/public/receipt.public.controller', () => mockProxy())
jest.mock('@/controllers/public/receiptReview.public.controller', () => mockProxy())
jest.mock('@/controllers/public/reservation.public.controller', () => mockProxy())
jest.mock('@/controllers/public/tpvOrder.public.controller', () => mockProxy())
jest.mock('@/controllers/public/unsubscribe.public.controller', () => mockProxy())
jest.mock('@/controllers/public/venueCheckout.public.controller', () => mockProxy())
jest.mock('@/controllers/public/venueChat.public.controller', () => mockProxy())
jest.mock('@/controllers/public/walletPass.public.controller', () => mockProxy())
jest.mock('@/controllers/public/walletStamps.public.controller', () => mockProxy())

import routes from '@/routes/public.routes'

const app = express()
app.use(express.json())
app.use('/api/v1/public', routes)
// A bad body ends in the app's error handler in production; here only its status matters.
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode ?? 500).json({ message: error.message }))

const FORM = { firstName: 'Ana', lastName: 'López', phone: '55 1234 5678', companyName: 'Café Ana' }
let visitante = 0
/** Each send comes from its own IP and its own email: the contact limits count by both. */
const enviar = (extra: Record<string, unknown>) => {
  visitante++
  return request(app)
    .post('/api/v1/public/contact')
    .set('CF-Connecting-IP', `198.51.100.${visitante}`)
    .send({ ...FORM, email: `ana${visitante}@cafe.mx`, ...extra })
}

beforeEach(() => {
  mockSubmitContact.mockReset()
  mockSubmitContact.mockImplementation((_req: any, res: any) => res.json({ ok: true }))
})

describe('POST /public/contact: la casilla de novedades', () => {
  it('deja pasar la casilla y la versión del aviso, y el controlador las recibe tal cual', async () => {
    const res = await enviar({ marketingConsent: true, privacyNoticeVersion: '2026-10-02' })

    expect(res.status).toBe(200)
    expect(mockSubmitContact.mock.calls[0][0].body).toMatchObject({ marketingConsent: true, privacyNoticeVersion: '2026-10-02' })
  })

  it('ambas son opcionales: el formulario de siempre sigue pasando', async () => {
    const res = await enviar({})

    expect(res.status).toBe(200)
    expect(mockSubmitContact.mock.calls[0][0].body).not.toHaveProperty('marketingConsent')
  })

  it('un privacyNoticeVersion de 300 caracteres da 400 y no llega al controlador', async () => {
    const res = await enviar({ marketingConsent: true, privacyNoticeVersion: 'x'.repeat(300) })

    expect(res.status).toBe(400)
    expect(mockSubmitContact).not.toHaveBeenCalled()
  })

  it('el tope es de 20 caracteres: 20 pasan y 21 no', async () => {
    expect((await enviar({ privacyNoticeVersion: 'v'.repeat(20) })).status).toBe(200)
    expect((await enviar({ privacyNoticeVersion: 'v'.repeat(21) })).status).toBe(400)
  })

  it('una casilla que no es booleana (el texto «true») da 400: sólo un true de verdad es un sí', async () => {
    const res = await enviar({ marketingConsent: 'true' })

    expect(res.status).toBe(400)
    expect(mockSubmitContact).not.toHaveBeenCalled()
  })
})
