// tests/unit/controllers/mobile/promotions.carousel.test.ts
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

const listPromotionsForPosMock = jest.fn()
const carouselForDeviceMock = jest.fn()

jest.mock('@/services/promotions/promotionCatalog.service', () => ({
  listPromotionsForPos: (...a: unknown[]) => listPromotionsForPosMock(...a),
}))
jest.mock('@/services/customer-display/promotionCarousel.service', () => ({
  carouselForDevice: (...a: unknown[]) => carouselForDeviceMock(...a),
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    if (!raw) return void res.status(401).json({ message: 'No autorizado' })
    ;(req as any).authContext = JSON.parse(String(raw))
    next()
  },
}))
jest.mock('@/middlewares/validateVenueAccess.middleware', () => ({
  validateVenueAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireVenueMembership: (req: Request, res: Response, next: NextFunction) => {
    const allowed: string[] = (req as any).authContext?.allowedVenueIds ?? []
    if (!allowed.includes(req.params.venueId)) return void res.status(403).json({ message: 'No tienes acceso' })
    next()
  },
}))

import mobileRoutes from '@/routes/mobile.routes'

const VENUE = 'venue-1'
const auth = { 'x-test-auth-context': JSON.stringify({ userId: 's1', venueId: VENUE, allowedVenueIds: [VENUE] }) }
const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/api/v1/mobile', mobileRoutes)
  return a
}
const legado = { active: [{ id: 'p1' }], upcoming: [], timezone: 'America/Mexico_City' }

beforeEach(() => {
  jest.clearAllMocks()
  listPromotionsForPosMock.mockResolvedValue(legado)
  carouselForDeviceMock.mockResolvedValue(null)
})

it('los campos de siempre, IDÉNTICOS, más timezone y fetchedAt para todos', async () => {
  const r = await request(app()).get(`/api/v1/mobile/venues/${VENUE}/promotions`).set(auth)
  expect(r.status).toBe(200)
  expect(r.body.success).toBe(true)
  expect(r.body.data.active).toEqual([{ id: 'p1' }])
  expect(r.body.data.upcoming).toEqual([])
  expect(r.body.data.timezone).toBe('America/Mexico_City')
  expect(Date.parse(r.body.data.fetchedAt)).not.toBeNaN()
  expect(r.body.data).not.toHaveProperty('carousel')
})

it('el iPad (o una app vieja) no recibe carrusel: se le pregunta con SU cabecera', async () => {
  await request(app())
    .get(`/api/v1/mobile/venues/${VENUE}/promotions`)
    .set({ ...auth, 'x-device-id': ' ipad-1 ' })
  expect(carouselForDeviceMock).toHaveBeenCalledWith(VENUE, 'ipad-1')
})

it('la tablet v2 recibe el carrusel con su huella y su estado', async () => {
  carouselForDeviceMock.mockResolvedValue({
    timezone: 'America/Mexico_City',
    carousel: [{ id: 'c1' }],
    carouselTruncated: false,
    carouselEvaluated: 1,
    carouselStatus: 'ok',
    fingerprints: { promotions: 'f'.repeat(32) },
  })
  const r = await request(app())
    .get(`/api/v1/mobile/venues/${VENUE}/promotions`)
    .set({ ...auth, 'x-device-id': 'tab-1' })
  expect(r.body.data).toMatchObject({ carousel: [{ id: 'c1' }], carouselStatus: 'ok', fingerprints: { promotions: 'f'.repeat(32) } })
  expect(r.body.data.active).toEqual([{ id: 'p1' }])
})

it('🔴 Codex r1 #6: con carrusel, la `timezone` de la respuesta es la del CARRUSEL (la de su huella), no la del catálogo', async () => {
  listPromotionsForPosMock.mockResolvedValue({ ...legado, timezone: 'America/Mexico_City' }) // leyó antes del cambio
  carouselForDeviceMock.mockResolvedValue({
    timezone: 'America/Tijuana',
    carousel: [],
    carouselTruncated: false,
    carouselEvaluated: 0,
    carouselStatus: 'ok',
    fingerprints: { promotions: 'a'.repeat(32) },
  })
  const r = await request(app())
    .get(`/api/v1/mobile/venues/${VENUE}/promotions`)
    .set({ ...auth, 'x-device-id': 'tab-1' })
  expect(r.body.data.timezone).toBe('America/Tijuana')
  expect(r.body.data.active).toEqual([{ id: 'p1' }]) // y los campos del catálogo, intactos
})

it('si el carrusel falla, la ruta NO: active/upcoming salen y el carrusel dice failed', async () => {
  carouselForDeviceMock.mockResolvedValue({ carouselStatus: 'failed' })
  const r = await request(app())
    .get(`/api/v1/mobile/venues/${VENUE}/promotions`)
    .set({ ...auth, 'x-device-id': 'tab-1' })
  expect(r.status).toBe(200)
  expect(r.body.data).toMatchObject({ active: [{ id: 'p1' }], carouselStatus: 'failed' })
  expect(r.body.data).not.toHaveProperty('carousel')
})

it('aunque carouselForDevice LANZARA, la ruta responde el catálogo de siempre', async () => {
  carouselForDeviceMock.mockRejectedValue(new Error('inesperado'))
  const r = await request(app())
    .get(`/api/v1/mobile/venues/${VENUE}/promotions`)
    .set({ ...auth, 'x-device-id': 'tab-1' })
  expect(r.status).toBe(200)
  expect(r.body.data.active).toEqual([{ id: 'p1' }])
})
