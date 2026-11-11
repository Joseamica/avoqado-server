/**
 * S13 (E7, E8; R2): el enrutado de «Mi cuenta» y de «Guardar en mi cuenta».
 *  - El límite del claim es PROPIO: por negocio (del slug) + clienta de la sesión, y por negocio + IP real (`ipDelCliente`, nunca
 *    `req.ip`, que en producción es el borde de Cloudflare). Dos sucursales y dos visitantes no se comparten el cupo; el 429 es en español.
 *  - Cada ruta resuelve el negocio por el slug y exige la sesión ANTES de todo lo demás (una sesión vieja o de otra sucursal se queda en
 *    el 401 de `authenticateCustomer`, como hoy); el límite del claim va después de la identidad, porque cuenta por clienta.
 */
// Los controladores pesan al cargarse; aquí sólo importa la cadena de middlewares de cada ruta.
const mockProxy = () => new Proxy({}, { get: () => (_req: any, res: any) => res.json({ ok: true }) })
jest.mock('@/controllers/hybridBilling.controller', () => mockProxy())
jest.mock('@/controllers/kiosk/kioskCheckIn.controller', () => mockProxy())
jest.mock('@/controllers/public/cfdi.public.controller', () => mockProxy())
jest.mock('@/controllers/public/creditPack.public.controller', () => mockProxy())
jest.mock('@/controllers/public/customerEmail.public.controller', () => mockProxy())
jest.mock('@/controllers/public/customerPortal.public.controller', () => mockProxy())
jest.mock('@/controllers/public/featureCatalog.public.controller', () => mockProxy())
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

import express from 'express'
import request from 'supertest'
import { crearLimiteDeGuardadoDeTarjeta, giftCardClaimRateLimiters } from '@/middlewares/gift-card-lookup-rate-limit.middleware'
import routes from '@/routes/public.routes'
import { resolveVenueBySlug } from '@/middlewares/resolveVenueBySlug.middleware'
import { authenticateCustomer } from '@/middlewares/customerAuth.middleware'
import { generateCustomerSession } from '@/jwt.service'
import { prismaMock } from '@tests/__helpers__/setup'

/** Un app mínimo: el negocio y la clienta los pone la prueba, como los dejarían `resolveVenueBySlug` y `authenticateCustomer`. */
function app(max: { clienta: number; ip: number }) {
  const a = express()
  a.use((req: any, _res, next) => {
    req.publicVenue = { id: req.header('x-venue'), slug: req.header('x-venue') }
    req.customerAuth = { customerId: req.header('x-clienta') }
    next()
  })
  const l = crearLimiteDeGuardadoDeTarjeta(max.clienta, max.ip, 1000)
  a.post('/claim', l.porIp, l.porClienta, (_req, res) => {
    res.json({ ok: true })
  })
  return a
}
const intento = (a: express.Express, venue: string, clienta: string, ip: string) =>
  request(a).post('/claim').set('x-venue', venue).set('x-clienta', clienta).set('cf-connecting-ip', ip)

describe('R2 · límite propio de «Guardar en mi cuenta»', () => {
  it('por clienta: la misma clienta en el MISMO negocio se frena; en otra sucursal o otra clienta, no', async () => {
    const a = app({ clienta: 2, ip: 100 })
    expect((await intento(a, 'v1', 'ana', '198.51.100.1')).status).toBe(200)
    expect((await intento(a, 'v1', 'ana', '198.51.100.2')).status).toBe(200)
    const frenada = await intento(a, 'v1', 'ana', '198.51.100.3')
    expect(frenada.status).toBe(429)
    expect(frenada.body).toEqual({
      success: false,
      code: 'GIFT_CARD_CLAIM_RATE_LIMITED',
      message: 'Demasiados intentos de guardar tarjetas seguidos. Espera unos minutos y vuelve a intentar.',
      retryAfter: 600,
    })
    expect((await intento(a, 'v2', 'ana', '198.51.100.4')).status).toBe(200)
    expect((await intento(a, 'v1', 'bety', '198.51.100.5')).status).toBe(200)
  })

  it('por IP REAL (cf-connecting-ip): dos visitantes detrás del mismo borde no se comparten el cupo, y dos sucursales tampoco', async () => {
    const a = app({ clienta: 100, ip: 2 })
    expect((await intento(a, 'v1', 'c1', '203.0.113.7')).status).toBe(200)
    expect((await intento(a, 'v1', 'c2', '203.0.113.7')).status).toBe(200)
    expect((await intento(a, 'v1', 'c3', '203.0.113.7')).status).toBe(429)
    // Otro visitante (otra IP real, mismo borde de Cloudflare = mismo req.ip) sigue pudiendo.
    expect((await intento(a, 'v1', 'c4', '203.0.113.8')).status).toBe(200)
    // La misma IP en otra sucursal tiene su propio cupo.
    expect((await intento(a, 'v2', 'c5', '203.0.113.7')).status).toBe(200)
  })
})

describe('E7/E8 · el enrutado', () => {
  const capa = (metodo: string, ruta: string) => {
    const l = (routes as any).stack.find((x: any) => x.route?.path === ruta && x.route.methods[metodo])
    expect(l).toBeDefined()
    return l.route.stack.map((s: any) => s.handle)
  }

  it.each([
    ['get', '/venues/:venueSlug/customer/orders'],
    ['get', '/venues/:venueSlug/customer/gift-cards'],
    ['get', '/venues/:venueSlug/customer/discounts'],
    ['post', '/venues/:venueSlug/customer/gift-cards/claim'],
  ])('%s %s: el slug manda y la sesión es obligatoria, antes de validar y del controlador', (metodo, ruta) => {
    const h = capa(metodo, ruta)
    const negocio = h.indexOf(resolveVenueBySlug)
    const sesion = h.indexOf(authenticateCustomer)
    expect(negocio).toBeGreaterThan(0) // después de un límite por visitante
    expect(sesion).toBeGreaterThan(negocio)
  })

  it('el claim NO pasa por writeLimit: primero su cupo de FALLOS por IP (antes de tocar la base), luego negocio + IP y negocio + clienta', () => {
    const h = capa('post', '/venues/:venueSlug/customer/gift-cards/claim')
    expect(h.slice(0, 5)).toEqual([
      giftCardClaimRateLimiters.fallosPorIp,
      resolveVenueBySlug,
      giftCardClaimRateLimiters.porIp,
      authenticateCustomer,
      giftCardClaimRateLimiters.porClienta,
    ])
  })
})

describe('R2 · la PILA REAL de la ruta del claim (router de verdad, prisma de prueba, controlador simulado)', () => {
  const VENUES: Record<string, { id: string; slug: string }> = {
    centro: { id: 'cvenuecentro0000000000000', slug: 'centro' },
    norte: { id: 'cvenuenorte00000000000000', slug: 'norte' },
  }
  const real = express()
  real.use(express.json())
  real.use('/api/v1/public', routes)

  beforeAll(() => {
    prismaMock.venue.findFirst.mockImplementation(async (q: any) => VENUES[q?.where?.slug] ?? null)
    prismaMock.customer.findFirst.mockImplementation(async (q: any) => ({
      id: q.where.id,
      venueId: q.where.venueId,
      active: true,
      versionDeSesion: 0,
      phone: null,
      email: null,
      accountActivatedAt: new Date(),
    }))
  })

  const sesionDe = (clienta: string, venue: string) =>
    generateCustomerSession({ sub: clienta, venueId: VENUES[venue].id, v: 0, contactos: [] })
  const guardar = (venue: string, clienta: string, ip: string) =>
    request(real)
      .post(`/api/v1/public/venues/${venue}/customer/gift-cards/claim`)
      .set('authorization', `Bearer ${sesionDe(clienta, venue)}`)
      .set('cf-connecting-ip', ip)
      .send({ code: 'AAAA-BBBB-CCCC-DDDD-E' })
  /** `n` intentos en tandas (el cupo de prueba es 1,000: fuera de producción el límite es holgado). */
  async function intentos(n: number, venue: string, clienta: string, ip: string) {
    const estados: number[] = []
    for (let hechos = 0; hechos < n; hechos += 100) {
      const tanda = await Promise.all(Array.from({ length: Math.min(100, n - hechos) }, () => guardar(venue, clienta, ip)))
      estados.push(...tanda.map(r => r.status))
    }
    return estados
  }
  const ESPAÑOL = {
    success: false,
    code: 'GIFT_CARD_CLAIM_RATE_LIMITED',
    message: 'Demasiados intentos de guardar tarjetas seguidos. Espera unos minutos y vuelve a intentar.',
    retryAfter: 600,
  }

  it('la misma IP agota su cupo en una sucursal (429 en español) y en OTRA sucursal sigue pasando; writeLimit (5/min) ya no frena', async () => {
    const ip = '198.51.100.77'
    const estados = await intentos(1000, 'centro', 'cana000000000000000000001', ip)
    expect(estados.every(e => e === 200)).toBe(true) // con writeLimit, el 6.º ya sería 429 en inglés
    const frenado = await guardar('centro', 'cana000000000000000000001', ip)
    expect(frenado.status).toBe(429)
    expect(frenado.body).toEqual(ESPAÑOL)
    expect((await guardar('norte', 'cnorte0000000000000000001', ip)).status).toBe(200)
  })

  const aUnSlugInventado = (slug: string, ip: string) =>
    request(real)
      .post(`/api/v1/public/venues/${slug}/customer/gift-cards/claim`)
      .set('cf-connecting-ip', ip)
      .send({ code: 'AAAA-BBBB-CCCC-DDDD-E' })

  it('codex-s13-r3 #2: una IP que prueba slugs inventados agota su cupo COMÚN de fallos ⇒ 429 en español sin tocar la base', async () => {
    const ip = '192.0.2.10'
    const estados: number[] = []
    for (let hechos = 0; hechos < 1000; hechos += 100) {
      const tanda = await Promise.all(Array.from({ length: 100 }, (_, i) => aUnSlugInventado(`inventado-${hechos + i}`, ip)))
      estados.push(...tanda.map(r => r.status))
    }
    expect(estados.every(e => e === 404)).toBe(true) // cada slug distinto es un intento fallido del MISMO cupo
    const consultas = prismaMock.venue.findFirst.mock.calls.length
    const frenado = await aUnSlugInventado('inventado-otro-mas', ip)
    expect(frenado.status).toBe(429)
    expect(frenado.body).toEqual(ESPAÑOL)
    expect(prismaMock.venue.findFirst.mock.calls.length).toBe(consultas) // se frenó antes de buscar el negocio
    // Ni con sesión en un negocio real: ese visitante ya gastó su cupo de fallos.
    expect((await guardar('centro', 'cfallos00000000000000001a', ip)).status).toBe(429)
  })

  it('codex-s13-r3 #2: los claims que salen bien no gastan el cupo de fallos: la misma IP guarda en dos negocios reales sin frenarse', async () => {
    const ip = '192.0.2.20'
    const fallos = await Promise.all(Array.from({ length: 999 }, (_, i) => aUnSlugInventado(`otro-inventado-${i}`, ip)))
    expect(fallos.every(r => r.status === 404)).toBe(true)
    for (const [venue, clienta] of [
      ['centro', 'cbuena00000000000000001a'],
      ['norte', 'cbuena00000000000000002a'],
    ]) {
      const buenos = await Promise.all(Array.from({ length: 20 }, () => guardar(venue, clienta, ip)))
      expect(buenos.every(r => r.status === 200)).toBe(true)
    }
    expect((await aUnSlugInventado('el-ultimo-que-cabe', ip)).status).toBe(404) // el fallo 1,000 todavía cabe
    expect((await aUnSlugInventado('ya-no-cabe', ip)).status).toBe(429)
  })

  it('la misma clienta agota su cupo aunque cambie de IP; otra clienta en la misma sucursal no comparte el suyo', async () => {
    const estados = await intentos(1000, 'norte', 'cbety0000000000000000001a', '203.0.113.1')
    expect(estados.every(e => e === 200)).toBe(true)
    const frenada = await guardar('norte', 'cbety0000000000000000001a', '203.0.113.2')
    expect(frenada.status).toBe(429)
    expect(frenada.body).toEqual(ESPAÑOL)
    expect((await guardar('norte', 'ccarla000000000000000001a', '203.0.113.3')).status).toBe(200)
  })
})
