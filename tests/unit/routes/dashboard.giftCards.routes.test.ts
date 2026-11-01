/**
 * Sub-router del dashboard de tarjetas de regalo: permiso EXACTO por ruta, plan SÓLO al prender (R9), validación en
 * español antes del permiso y rutas literales que no caen en `/:giftCardId`. Controllers simulados (molde:
 * passIntegrations.routes.permissions.test.ts).
 */
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'

const mockPermisos: Array<[string, string]> = []
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: (perm: string) => (req: any, _res: any, next: any) => {
    mockPermisos.push([perm, req.params.venueId])
    next()
  },
}))
const mockPlanes: string[] = []
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: (code: string) => (req: any, res: any, next: any) => {
    mockPlanes.push(code)
    if (req.headers['x-sin-plan'])
      return res.status(403).json({ error: 'Feature not available', featureCode: code, subscriptionRequired: true })
    next()
  },
}))
const mockManejador = (nombre: string) => (req: any, res: any) => res.json({ handler: nombre, params: req.params })
jest.mock(
  '@/controllers/dashboard/giftCard.dashboard.controller',
  () => new Proxy({}, { get: (_t, p) => (p === '__esModule' ? true : mockManejador(String(p))) }),
)
jest.mock(
  '@/controllers/shared/giftCardSale.controller',
  () => new Proxy({}, { get: (_t, p) => (p === '__esModule' ? true : mockManejador(`shared.${String(p)}`)) }),
)

import giftCardsRouter from '@/routes/dashboard/giftCards.routes'
import { MENSAJE_PLAN_DE_TARJETAS } from '@/middlewares/giftCardsPlan.middleware'

const app = express()
app.use(express.json())
app.use('/venues/:venueId/gift-cards', giftCardsRouter)
app.use((e: any, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
  res.status(e.statusCode ?? 500).json({ message: e.message, code: e.code }),
)
const B = '/venues/v1/gift-cards'

const CASOS: Array<[string, string, Record<string, unknown> | undefined, string, string]> = [
  ['get', `${B}/settings`, undefined, 'giftCards:read', 'getSettings'],
  ['put', `${B}/settings`, { suggestedAmounts: [500, 1000] }, 'giftCards:manage', 'updateSettings'],
  ['get', `${B}/summary?from=2026-10-01&to=2026-10-14`, undefined, 'giftCards:read', 'summary'],
  ['get', `${B}/aging?at=2026-10-14`, undefined, 'giftCards:read', 'aging'],
  ['get', `${B}/pending-accounting?from=2026-10-01&to=2026-10-14`, undefined, 'giftCards:read', 'pendingAccounting'],
  ['get', `${B}/export.csv`, undefined, 'giftCards:read', 'exportCsv'],
  ['post', `${B}/orders/o1/cancel-sale`, { operationKey: 'cancela-0001-abc' }, 'giftCards:manage', 'shared.cancelSale'],
  [
    'post',
    `${B}/orders/o1/release-cancel`,
    { operationKey: 'libera-0001-abc', confirmacionNoDevuelto: true },
    'giftCards:manage',
    'shared.releaseCancel',
  ],
  ['get', `${B}?page=1&pageSize=50&search=ana&status=ACTIVE,BLOCKED`, undefined, 'giftCards:read', 'list'],
  ['get', `${B}/gc1`, undefined, 'giftCards:read', 'detail'],
  [
    'post',
    `${B}/gc1/operations`,
    { operationKey: 'ajuste-0001-abc', tipo: 'AJUSTE', direccion: 'INCREMENT', amount: 50, reason: 'CASHIER_ERROR', note: 'faltó cargar' },
    'giftCards:manage',
    'operate',
  ],
  // S7 (Q16): el gerente reenvía o cambia el destino desde el panel con SU ruta, siempre con `giftCards:manage`.
  ['post', `${B}/gc1/resend`, { operationKey: 'reenvia-0001-abc' }, 'giftCards:manage', 'resend'],
  [
    'post',
    `${B}/gc1/resend`,
    { operationKey: 'reenvia-0002-abc', deliveryChannel: 'EMAIL', recipientEmail: 'ana@gmail.com' },
    'giftCards:manage',
    'resend',
  ],
]

beforeEach(() => {
  mockPermisos.length = 0
  mockPlanes.length = 0
})

describe('rutas del dashboard de tarjetas de regalo', () => {
  it.each(CASOS)(
    '%s %s → permiso exacto y su manejador (las literales no caen en /:giftCardId)',
    async (metodo, url, cuerpo, permiso, manejador) => {
      const r = await (request(app) as any)[metodo](url).send(cuerpo ?? {})
      expect(r.status).toBe(200)
      expect(r.body.handler).toBe(manejador)
      expect(mockPermisos).toEqual([[permiso, 'v1']])
    },
  )

  it('🔴 sólo PRENDER pide el plan (R9); sin plan, el 403 lo explica en español con su código', async () => {
    for (const [metodo, url, cuerpo] of CASOS) await (request(app) as any)[metodo](url).send(cuerpo ?? {})
    expect(mockPlanes).toEqual([])
    expect((await request(app).put(`${B}/settings`).send({ enabled: true, aceptaTerminos: true })).status).toBe(200)
    expect(mockPlanes).toEqual(['GIFT_CARDS'])
    const sinPlan = await request(app).put(`${B}/settings`).set('x-sin-plan', '1').send({ enabled: true, aceptaTerminos: true })
    expect(sinPlan.status).toBe(403)
    expect(sinPlan.body).toMatchObject({ code: 'GIFT_CARDS_NOT_IN_PLAN', howToEnable: 'PLAN', requiredPlan: 'PRO' })
    // C2 r1: el 403 ya no trae precio fijo (superadmin cambia el de lista); el texto es el del candado de C2.
    expect(sinPlan.body.message).toBe(MENSAJE_PLAN_DE_TARJETAS)
  })

  it('🔴 auditoría r1 A-4: sin plan, guardar montos o APAGAR no pide el plan (sólo `enabled: true` lo pide)', async () => {
    const montos = await request(app)
      .put(`${B}/settings`)
      .set('x-sin-plan', '1')
      .send({ suggestedAmounts: [500, 1000] })
    const apagar = await request(app).put(`${B}/settings`).set('x-sin-plan', '1').send({ enabled: false })
    expect([montos.status, apagar.status]).toEqual([200, 200])
    expect(mockPlanes).toEqual([])
  })

  it.each([
    ['put', `${B}/settings`, {}, /No hay nada que guardar/],
    ['put', `${B}/settings`, { enabled: true, inventado: 1 }, /Hay un campo que no se esperaba/],
    [
      'post',
      `${B}/gc1/operations`,
      { operationKey: 'ajuste-0002-abc', tipo: 'AJUSTE', direccion: 'INCREMENT', amount: 10, reason: 'OTHER' },
      /Escribe una nota que explique el ajuste/,
    ],
    [
      'post',
      `${B}/gc1/operations`,
      { operationKey: 'ajuste-0005-abc', tipo: 'AJUSTE', direccion: 'DECREMENT', amount: 10, reason: 'CASHIER_ERROR' },
      /Escribe una nota que explique el ajuste/,
    ],
    [
      'post',
      `${B}/gc1/operations`,
      { operationKey: 'ajuste-0006-abc', tipo: 'AJUSTE', direccion: 'DECREMENT', amount: 10, reason: 'CASHIER_ERROR', note: '   ' },
      /Escribe una nota que explique el ajuste/,
    ],
    [
      'post',
      `${B}/gc1/operations`,
      {
        operationKey: 'ajuste-0007-abc',
        tipo: 'AJUSTE',
        direccion: 'DECREMENT',
        amount: 10,
        reason: 'CASHIER_ERROR',
        note: 'x'.repeat(501),
      },
      /no puede pasar de 500 caracteres/,
    ],
    [
      'post',
      `${B}/gc1/operations`,
      { operationKey: 'bloquea-0009-abc', tipo: 'BLOQUEAR', reason: 'OTHER' },
      /Con el motivo «Otro» escribe una nota/,
    ],
    ['post', `${B}/gc1/operations`, { operationKey: 'corta', tipo: 'BLOQUEAR', reason: 'CHARGEBACK' }, /al menos 8 caracteres/],
    ['post', `${B}/orders/o1/release-cancel`, { operationKey: 'libera-0003-abc' }, /comprobaste que la devolución NO se hizo/],
    ['post', `${B}/gc1/operations`, { operationKey: 'regala-0001-abc', tipo: 'REGALAR', reason: 'OTHER' }, /Operación no reconocida/],
    [
      'post',
      `${B}/gc1/operations`,
      {
        operationKey: 'ajuste-0003-abc',
        tipo: 'AJUSTE',
        direccion: 'INCREMENT',
        amount: 10.555,
        reason: 'CASHIER_ERROR',
        note: 'faltó cargar',
      },
      /hasta 2 decimales/,
    ],
    [
      'post',
      `${B}/gc1/operations`,
      { operationKey: 'repone-0002-abc', tipo: 'REEMPLAZAR_CODIGO', reason: 'CHARGEBACK', folio: 'ORD-1' },
      /tarjeta perdida/,
    ],
    ['post', `${B}/gc1/operations`, { operationKey: 'repone-0003-abc', tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD' }, /Falta el folio/],
    [
      'post',
      `${B}/gc1/operations`,
      {
        operationKey: 'ajuste-0004-abc',
        tipo: 'AJUSTE',
        direccion: 'INCREMENT',
        amount: 10,
        reason: 'SALE_CANCELLED',
        note: 'faltó cargar',
      },
      /Elige un motivo de la lista/,
    ],
    ['post', `${B}/gc1/resend`, { operationKey: 'reenvia-0003-abc', inventado: 1 }, /Hay un campo que no se esperaba/],
    ['post', `${B}/gc1/resend`, { operationKey: 'reenvia-0004-abc', deliveryChannel: 'WHATSAPP' }, /falta el teléfono/],
    [
      'post',
      `${B}/gc1/resend`,
      { operationKey: 'reenvia-0005-abc', deliveryChannel: 'EMAIL', recipientEmail: 'no-es-correo' },
      /El correo no es válido/,
    ],
    ['post', `${B}/gc1/resend`, { operationKey: 'corta' }, /al menos 8 caracteres/],
    ['get', `${B}/summary?from=01-10-2026&to=2026-10-14`, undefined, /AAAA-MM-DD/],
    ['get', `${B}?status=FOO`, undefined, /Estado no reconocido: FOO/],
  ])('%s %s con un cuerpo malo → 400 en español, antes del permiso', async (metodo, url, cuerpo, texto) => {
    const r = await (request(app) as any)[metodo](url).send(cuerpo ?? {})
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(texto)
    expect(mockPermisos).toEqual([])
  })

  it('el sub-router está montado en dashboard.routes.ts con autenticación', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../../../src/routes/dashboard.routes.ts'), 'utf8')
    expect(fuente).toMatch(/router\.use\('\/venues\/:venueId\/gift-cards', authenticateTokenMiddleware, giftCardsRoutes\)/)
  })
})
