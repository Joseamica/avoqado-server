/**
 * Candado de plan de las tarjetas de regalo (índice R9): sólo VENDER y PRENDER piden GIFT_CARDS, y la negativa dice qué
 * falta, cómo se habilita y a quién pedírselo, con `code` (regla del repo: un 403 pelón obliga a cada cliente a inventar).
 */
import express from 'express'
import request from 'supertest'

const mockPortero = jest.fn()
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: (code: string) => (req: unknown, res: unknown, next: unknown) => mockPortero(code, req, res, next),
}))

import {
  GIFT_CARDS_FEATURE,
  MENSAJE_PLAN_DE_TARJETAS,
  exigirPlanDeTarjetas,
  exigirPlanSiPrende,
} from '@/middlewares/giftCardsPlan.middleware'

const app = express()
app.use(express.json())
app.post('/vender', exigirPlanDeTarjetas, (_req, res) => res.json({ vendido: true }))
app.put('/ajustes', exigirPlanSiPrende, (_req, res) => res.json({ guardado: true }))

const deja = (_code: string, _req: unknown, _res: unknown, next: () => void) => next()
const niega =
  (extra: Record<string, unknown> = {}, featureCode = 'GIFT_CARDS') =>
  (_code: string, _req: unknown, res: any) =>
    res.status(403).json({
      error: 'Feature not available',
      message: 'This venue does not have access to the GIFT_CARDS feature. Please subscribe to enable this feature.',
      featureCode,
      subscriptionRequired: true,
      ...extra,
    })

beforeEach(() => mockPortero.mockReset())

describe('candado de plan de las tarjetas de regalo (R9: sólo vender y prender)', () => {
  it('con el plan, vender pasa y el portero se consulta con GIFT_CARDS', async () => {
    mockPortero.mockImplementation(deja)
    const r = await request(app).post('/vender').send({})
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ vendido: true })
    expect(mockPortero).toHaveBeenCalledWith(GIFT_CARDS_FEATURE, expect.anything(), expect.anything(), expect.any(Function))
  })

  it('sin el plan, el 403 dice qué falta, cómo se habilita y a quién pedírselo, con código', async () => {
    mockPortero.mockImplementation(niega())
    const r = await request(app).post('/vender').send({})
    expect(r.status).toBe(403)
    expect(r.body).toEqual({
      error: 'GIFT_CARDS_NOT_IN_PLAN',
      code: 'GIFT_CARDS_NOT_IN_PLAN',
      message: MENSAJE_PLAN_DE_TARJETAS,
      howToEnable: 'PLAN',
      featureCode: 'GIFT_CARDS',
      requiredPlan: 'PRO',
    })
    expect(r.body.message).toMatch(/plan Pro.*función suelta.*Configuración → Plan/)
    // C2 r1 (b): sin precio fijo — superadmin puede cambiar el de lista y el 403 le mentiría al cliente.
    expect(r.body.message).not.toMatch(/\$|\d/)
  })

  it.each([
    [{ trialExpired: true }, /prueba de las tarjetas de regalo ya terminó/],
    [{ suspended: true }, /suspendidas por un pago fallido/],
  ])('%j explica su caso y conserva la bandera', async (extra, texto) => {
    mockPortero.mockImplementation(niega(extra))
    const r = await request(app).post('/vender').send({})
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ code: 'GIFT_CARDS_NOT_IN_PLAN', ...extra })
    expect(r.body.message).toMatch(texto)
  })

  it('prender sin plan → 403; apagar o guardar montos sin `enabled` ni siquiera consulta el plan', async () => {
    mockPortero.mockImplementation(niega())
    expect((await request(app).put('/ajustes').send({ enabled: true })).status).toBe(403)
    expect((await request(app).put('/ajustes').send({ enabled: false })).body).toEqual({ guardado: true })
    expect(
      (
        await request(app)
          .put('/ajustes')
          .send({ suggestedAmounts: [500] })
      ).body,
    ).toEqual({ guardado: true })
    expect(mockPortero).toHaveBeenCalledTimes(1)
  })

  it('regresión: una negativa de OTRA función no se reescribe', async () => {
    mockPortero.mockImplementation(niega({}, 'CFDI'))
    const r = await request(app).post('/vender').send({})
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ error: 'Feature not available', featureCode: 'CFDI' })
    expect(r.body.code).toBeUndefined()
  })

  it('las dos puertas llevan la marca que leen las pruebas de rutas', () => {
    expect((exigirPlanDeTarjetas as unknown as { featureCode: string }).featureCode).toBe('GIFT_CARDS')
    expect((exigirPlanSiPrende as unknown as { featureCode: string }).featureCode).toBe('GIFT_CARDS')
  })
})
