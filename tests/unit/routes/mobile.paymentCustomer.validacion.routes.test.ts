/**
 * 🔴 BAJO-2 (full-testing, 15-oct-2026): `{"customerId": 12345}` en «Agregar cliente» de «Cobro exitoso»
 * (`POST /mobile/venues/:venueId/payments/:paymentId/customer` y `/payments/customer`) respondía 500
 * «customerId?.trim is not a function». Ninguna de las dos rutas validaba el body: el número llegaba al servicio.
 *
 * Ahora las dos validan la FORMA del body con zod (mensajes en español) y responden 400 antes del controller.
 * 🔴 `validateRequest` QUITA los campos que el schema no nombra: cada campo que lee el controller tiene que estar en el
 * schema, o la ruta deja de funcionar en silencio (el filtro del pago por monto/propina/quien cobró de `/payments/customer`).
 *
 * Se monta el router REAL y se corre su cadena (sin la autenticación), con el controller espiado.
 */
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: (permission: string) => {
    const mw = (_req: unknown, _res: unknown, next: () => void) => next()
    ;(mw as any).requiredPermission = permission
    return mw
  },
}))

const mockAttach = jest.fn((_req: any, res: any) => res.status(200).json({ success: true }))
const mockAttachLatest = jest.fn((_req: any, res: any) => res.status(200).json({ success: true }))
jest.mock('@/controllers/mobile/payment.mobile.controller', () => ({
  recordFastPayment: jest.fn(),
  getPaymentLoyalty: jest.fn(),
  attachCustomerToPayment: (req: any, res: any) => mockAttach(req, res),
  attachCustomerToLatestPayment: (req: any, res: any) => mockAttachLatest(req, res),
}))

import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'

const POR_PAGO = '/venues/:venueId/payments/:paymentId/customer'
const ULTIMO_PAGO = '/venues/:venueId/payments/customer'

function handlersDe(path: string): any[] {
  for (const layer of (mobileRouter as any).stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const capas: any[] = layer.route.stack ?? []
    if (!capas.some(c => c.method === 'post')) continue
    return capas.map(c => c.handle)
  }
  return []
}

function respuesta() {
  const res: any = {}
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn(() => res)
  return res
}

/** Corre la cadena de la ruta SIN la autenticación (primer handler), como Express: se detiene en el primer error o respuesta. */
async function correr(path: string, body: unknown, params: Record<string, string>) {
  const req: any = { body, params, query: {}, headers: {}, method: 'POST', authContext: { userId: 'staff-1', venueId: 'v1' } }
  const res = respuesta()
  for (const handler of handlersDe(path).slice(1)) {
    let siguio = false
    let error: any
    await handler(req, res, (e?: unknown) => {
      siguio = true
      error = e
    })
    if (error) return { error, req, res }
    if (!siguio) break
  }
  return { error: undefined as any, req, res }
}

beforeEach(() => {
  mockAttach.mockClear()
  mockAttachLatest.mockClear()
})

describe('POST /mobile/venues/:venueId/payments/:paymentId/customer — body validado', () => {
  const params = { venueId: 'v1', paymentId: 'pay-1' }

  it('cableado: autenticación primero, payments:create de siempre y el controller al final', () => {
    const h = handlersDe(POR_PAGO)
    expect(h[0]).toBe(authenticateTokenMiddleware)
    expect(h.map(x => x.requiredPermission).filter(Boolean)).toEqual(['payments:create'])
    expect(h.length).toBeGreaterThanOrEqual(4) // auth · permiso · validación · controller
  })

  it.each<[string, unknown]>([
    ['número', { customerId: 12345 }],
    ['objeto', { customerId: { id: 'c1' } }],
    ['arreglo', { customerId: ['c1'] }],
    ['vacío', { customerId: '' }],
    ['sólo espacios', { customerId: '   ' }],
    ['ausente', {}],
    ['null', { customerId: null }],
  ])('🔴 customerId %s ⇒ 400 en español, sin llegar al controller (antes: 500)', async (_caso, body) => {
    const { error } = await correr(POR_PAGO, body, params)
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toMatch(/^Error de validación: customerId: /)
    expect(error?.message).not.toMatch(/Expected|Required|Invalid/)
    expect(mockAttach).not.toHaveBeenCalled()
  })

  it('regresión: un customerId de texto pasa y el controller lo recibe (los campos ajenos se quitan)', async () => {
    const { error, res } = await correr(POR_PAGO, { customerId: 'cust-1', otro: 'x' }, params)
    expect(error).toBeUndefined()
    expect(res.statusCode).toBe(200)
    expect(mockAttach).toHaveBeenCalledTimes(1)
    const [req] = mockAttach.mock.calls[0]
    expect(req.body).toEqual({ customerId: 'cust-1' })
    // La ruta no valida params: el paymentId de la URL llega intacto.
    expect(req.params).toEqual(params)
  })
})

describe('POST /mobile/venues/:venueId/payments/customer — body validado (último pago por monto)', () => {
  const params = { venueId: 'v1' }

  it('cableado: autenticación primero, payments:create de siempre y el controller al final', () => {
    const h = handlersDe(ULTIMO_PAGO)
    expect(h[0]).toBe(authenticateTokenMiddleware)
    expect(h.map(x => x.requiredPermission).filter(Boolean)).toEqual(['payments:create'])
    expect(h.length).toBeGreaterThanOrEqual(4)
  })

  it.each<[string, unknown]>([
    ['customerId número', { customerId: 12345, amountCents: 5000 }],
    ['customerId ausente', { amountCents: 5000 }],
    ['customerId vacío', { customerId: ' ', amountCents: 5000 }],
  ])('🔴 %s ⇒ 400 en español, sin llegar al controller (antes: 500)', async (_caso, body) => {
    const { error } = await correr(ULTIMO_PAGO, body, params)
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toMatch(/customerId: /)
    expect(mockAttachLatest).not.toHaveBeenCalled()
  })

  it.each<[string, unknown, RegExp]>([
    ['staffId número', { customerId: 'c1', amountCents: 5000, staffId: 123 }, /staffId: /],
    ['tipCents texto', { customerId: 'c1', amountCents: 5000, tipCents: 'diez' }, /tipCents: /],
    ['amountCents texto', { customerId: 'c1', amountCents: '5000' }, /amountCents: /],
    ['amountCents ausente', { customerId: 'c1' }, /amountCents: /],
  ])('%s ⇒ 400 en español (antes: 500 o un pago que nunca se encontraba)', async (_caso, body, campo) => {
    const { error } = await correr(ULTIMO_PAGO, body, params)
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toMatch(campo)
    expect(error?.message).not.toMatch(/Expected|Required|Invalid/)
    expect(mockAttachLatest).not.toHaveBeenCalled()
  })

  it('🔴 regresión: lo que mandan Android e iOS llega COMPLETO al controller (validateRequest no se come ningún campo)', async () => {
    const body = { customerId: 'cust-1', amountCents: 5000, tipCents: 500, staffId: 'staff-cobro' }
    const { error } = await correr(ULTIMO_PAGO, body, params)
    expect(error).toBeUndefined()
    expect(mockAttachLatest).toHaveBeenCalledTimes(1)
    expect(mockAttachLatest.mock.calls[0][0].body).toEqual(body)
  })

  it('regresión: propina y quien cobró son opcionales (sin staffId, o con null)', async () => {
    for (const body of [
      { customerId: 'cust-1', amountCents: 5000 },
      { customerId: 'cust-1', amountCents: 5000, tipCents: 0, staffId: null },
    ]) {
      const { error } = await correr(ULTIMO_PAGO, body, params)
      expect(error).toBeUndefined()
    }
    expect(mockAttachLatest).toHaveBeenCalledTimes(2)
    expect(mockAttachLatest.mock.calls[0][0].body).toEqual({ customerId: 'cust-1', amountCents: 5000 })
  })
})
