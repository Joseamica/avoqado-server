/**
 * El ENRUTADO de la baja de los correos de Avoqado, con `public.routes.ts` real y el límite real (sin mockear
 * express-rate-limit): el GET sólo muestra, el POST da de baja (también el de RFC 8058 que manda el propio cliente de correo,
 * un formulario y no JSON), y el límite es POR TOKEN —como el de los clientes— para que las pocas IPs compartidas de
 * Gmail/Yahoo no se tiren entre sí.
 */
import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

const mockProxy = () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) })
jest.mock('@/controllers/hybridBilling.controller', () => mockProxy())
jest.mock('@/controllers/kiosk/kioskCheckIn.controller', () => mockProxy())
jest.mock('@/controllers/public/cfdi.public.controller', () => mockProxy())
jest.mock('@/controllers/public/creditPack.public.controller', () => mockProxy())
jest.mock('@/controllers/public/customerEmail.public.controller', () => mockProxy())
jest.mock('@/controllers/public/customerPortal.public.controller', () => mockProxy())
jest.mock('@/controllers/public/featureCatalog.public.controller', () => mockProxy())
jest.mock('@/controllers/public/giftCard.public.controller', () => mockProxy())
jest.mock('@/controllers/public/landing.public.controller', () => mockProxy())
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
import { signPlatformUnsubscribeToken } from '@/utils/platformUnsubscribeToken'

const app = express()
app.use(express.json())
app.use('/api/v1/public', routes)

const RUTA = '/api/v1/public/avoqado/unsubscribe'
const tokenDe = (email: string) => signPlatformUnsubscribeToken(email)
let visitante = 0
const nuevaIp = () => `198.51.100.${++visitante}`

beforeEach(() => {
  prismaMock.crmEmailOptOut.createMany.mockReset()
  prismaMock.crmEmailOptOut.createMany.mockResolvedValue({ count: 1 })
})

it('🔴 el GET con un token válido muestra la pregunta y NO da de baja a nadie', async () => {
  const res = await request(app)
    .get(`${RUTA}?token=${tokenDe('get@example.com')}`)
    .set('CF-Connecting-IP', nuevaIp())

  expect(res.status).toBe(200)
  expect(res.type).toBe('text/html')
  expect(res.text).toContain('¿Dejar de recibir los correos de Avoqado?')
  expect(res.text).toContain('Sí, darme de baja')
  expect(prismaMock.crmEmailOptOut.createMany).not.toHaveBeenCalled()
})

it('el POST del botón da de baja al correo del token y contesta «Listo»', async () => {
  const res = await request(app)
    .post(`${RUTA}?token=${tokenDe('boton@example.com')}`)
    .set('CF-Connecting-IP', nuevaIp())

  expect(res.status).toBe(200)
  expect(res.text).toContain('Listo: ya no te llegarán correos de Avoqado')
  expect(prismaMock.crmEmailOptOut.createMany).toHaveBeenCalledWith({
    data: [{ email: 'boton@example.com', source: 'UN_CLIC', actorStaffId: null }],
    skipDuplicates: true,
  })
})

it('el POST de RFC 8058 (formulario «List-Unsubscribe=One-Click», sin sesión ni JSON) también da de baja', async () => {
  const res = await request(app)
    .post(`${RUTA}?token=${tokenDe('rfc8058@example.com')}`)
    .type('form')
    .send('List-Unsubscribe=One-Click')
    .set('CF-Connecting-IP', nuevaIp())

  expect(res.status).toBe(200)
  expect(prismaMock.crmEmailOptOut.createMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: [expect.objectContaining({ email: 'rfc8058@example.com' })] }),
  )
})

it('un token inválido (GET o POST) es 400 con «Esta liga no es válida» y no escribe', async () => {
  const get = await request(app).get(`${RUTA}?token=basura`).set('CF-Connecting-IP', nuevaIp())
  const post = await request(app).post(RUTA).set('CF-Connecting-IP', nuevaIp())
  const alterado = await request(app)
    .post(`${RUTA}?token=${tokenDe('x@example.com').slice(0, -2)}AA`)
    .set('CF-Connecting-IP', nuevaIp())

  for (const res of [get, post, alterado]) {
    expect(res.status).toBe(400)
    expect(res.text).toContain('Esta liga no es válida')
  }
  expect(prismaMock.crmEmailOptOut.createMany).not.toHaveBeenCalled()
})

it('el límite del POST es POR TOKEN: 10 por minuto para una liga, aunque lleguen de IPs distintas; otra liga tiene el suyo', async () => {
  const token = tokenDe('limite@example.com')
  for (let i = 0; i < 10; i++)
    expect((await request(app).post(`${RUTA}?token=${token}`).set('CF-Connecting-IP', nuevaIp())).status).toBe(200)

  expect((await request(app).post(`${RUTA}?token=${token}`).set('CF-Connecting-IP', nuevaIp())).status).toBe(429)
  expect(
    (
      await request(app)
        .post(`${RUTA}?token=${tokenDe('otra@example.com')}`)
        .set('CF-Connecting-IP', nuevaIp())
    ).status,
  ).toBe(200)
})
