/**
 * Controller del POS para tarjetas de regalo: lo que llega a los servicios (pesos → Decimal exacto, quién, qué aparato), lo
 * que vuelve, la bitácora (una vez, fuera de la tx, nunca con el código) y los 4xx de `GiftCardError` con `code` y extras
 * al mismo nivel. El cableado real de rutas (permiso, plan, límite) lo prueba mobile.giftCards.routes.permissions.test.ts.
 */
import express from 'express'
import request from 'supertest'

jest.mock('@/services/giftCards/giftCardSurface.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardSurface.service'),
  auditarTarjetas: jest.fn(),
  estadoDeVentaDeTarjetas: jest.fn(),
  // 1b S1: `tieneTarjetas` de los ajustes (su prueba propia vive en tests/unit/controllers/shared/giftCardSale.controller.test.ts).
  negocioHaActivadoTarjetas: jest.fn().mockResolvedValue(false),
  // 1b S4 (Q102): la bitácora que SÍ espera y lanza; la del reenvío de la venta la escribe el controller.
  registrarSalidaDelSecreto: jest.fn().mockResolvedValue(undefined),
}))
// 1b S4: el detalle de la cuenta y sus acciones (su lógica la prueba giftCardCuenta.service.test.ts y la integración).
jest.mock('@/services/giftCards/giftCardCuenta.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardCuenta.service'),
  getCuentaDeTarjetasPos: jest.fn(),
  reenviarTarjeta: jest.fn(),
  cambiarDestinoDeTarjeta: jest.fn(),
  revelarCodigo: jest.fn(),
  revelarCodigosDeLaCuenta: jest.fn(),
}))
// `auditarReenvio` (real) llama a `auditarTarjetas` dentro de su propio módulo: su renglón se ve en `logAction`.
jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: jest.fn(),
}))
jest.mock('@/middlewares/permissionFlag.middleware', () => ({
  ...jest.requireActual('@/middlewares/permissionFlag.middleware'),
  tienePermisoEnVenue: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardDelivery.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardDelivery.service'),
  entregarTarjetas: jest.fn().mockResolvedValue({ reclamadas: 0, enviadas: 0, reprogramadas: 0, fallidas: 0, atoradas: 0 }),
}))
jest.mock('@/services/giftCards/giftCardSettings.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardSettings.service'),
  getGiftCardSettings: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardOrder.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardOrder.service'),
  createGiftCardOrder: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardLookup.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLookup.service'),
  lookupGiftCards: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardCancel.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardCancel.service'),
  iniciarCancelacionDeVenta: jest.fn(),
  liberarCancelacionDeVenta: jest.fn(),
}))
jest.mock('@/services/mobile/order.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/order.mobile.service'),
  payGiftCardBalanceOnOrder: jest.fn(),
  payGiftCardOnNewOrder: jest.fn(),
  getGiftCardPaymentByKey: jest.fn(),
  returnGiftBalanceAndCancelOrder: jest.fn(),
}))

import { globalErrorHandler } from '@/app'
import { validateRequest } from '@/middlewares/validation'
import { liberarCancelacionSchema, operationKeyOnOrderSchema, soloVenueSchema } from '@/schemas/common/giftCard.common.schema'
import * as s from '@/schemas/mobile/giftCard.mobile.schema'
import * as ctrl from '@/controllers/mobile/giftCard.mobile.controller'
import * as venta from '@/controllers/shared/giftCardSale.controller'
import * as superficie from '@/services/giftCards/giftCardSurface.service'
import { getGiftCardSettings } from '@/services/giftCards/giftCardSettings.service'
import { createGiftCardOrder } from '@/services/giftCards/giftCardOrder.service'
import { lookupGiftCards } from '@/services/giftCards/giftCardLookup.service'
import { segunElAparato } from '@/utils/giftCardRequest'
import { iniciarCancelacionDeVenta, liberarCancelacionDeVenta } from '@/services/giftCards/giftCardCancel.service'
import {
  getGiftCardPaymentByKey,
  payGiftCardBalanceOnOrder,
  payGiftCardOnNewOrder,
  returnGiftBalanceAndCancelOrder,
} from '@/services/mobile/order.mobile.service'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { BadRequestError, ServiceUnavailableError } from '@/errors/AppError'
import { crearLimiteDeReenvio } from '@/middlewares/gift-card-lookup-rate-limit.middleware'
import {
  cambiarDestinoDeTarjeta,
  getCuentaDeTarjetasPos,
  reenviarTarjeta,
  revelarCodigo,
  revelarCodigosDeLaCuenta,
} from '@/services/giftCards/giftCardCuenta.service'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { entregarTarjetas } from '@/services/giftCards/giftCardDelivery.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const m = (f: unknown) => f as jest.Mock
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  ;(req as any).authContext = { userId: 'staff-1', venueId: 'v1', role: 'CASHIER' }
  // El PIN de gerente: lo pone `checkPermission` al consumir el `x-permission-override` (aquí, el encabezado de la prueba).
  if (req.headers['x-test-override']) (req as any).authContext.overrideAuthorizedBy = req.headers['x-test-override']
  next()
})
app.get('/venues/:venueId/gift-cards/settings', validateRequest(soloVenueSchema), venta.getSettings)
app.post('/venues/:venueId/gift-cards/orders', validateRequest(s.createGiftCardOrderSchema), ctrl.createOrder)
app.post('/venues/:venueId/gift-cards/lookup', validateRequest(s.lookupSchema), ctrl.lookup)
app.post('/venues/:venueId/orders/:orderId/pay-gift-card', validateRequest(s.payGiftCardSchema), ctrl.payWithBalance)
app.post('/venues/:venueId/gift-cards/pay-new-order', validateRequest(s.payNewOrderSchema), ctrl.payNewOrder)
app.get('/venues/:venueId/gift-cards/payments/:idempotencyKey', validateRequest(s.paymentByKeySchema), ctrl.getPaymentByKey)
app.post(
  '/venues/:venueId/orders/:orderId/gift-balance-return-and-cancel',
  validateRequest(operationKeyOnOrderSchema),
  ctrl.returnBalanceAndCancel,
)
app.post('/venues/:venueId/gift-cards/orders/:orderId/cancel-sale', validateRequest(operationKeyOnOrderSchema), venta.cancelSale)
app.post('/venues/:venueId/gift-cards/orders/:orderId/release-cancel', validateRequest(liberarCancelacionSchema), venta.releaseCancel)
app.get('/venues/:venueId/gift-cards/orders/:orderId', validateRequest(s.cuentaDeTarjetasSchema), ctrl.getCuenta)
app.post('/venues/:venueId/gift-cards/orders/:orderId/reveal', validateRequest(operationKeyOnOrderSchema), ctrl.revealCuenta)
app.post('/venues/:venueId/gift-cards/:giftCardId/resend', validateRequest(s.resendSchema), ctrl.resend)
app.post('/venues/:venueId/gift-cards/:giftCardId/change-destination', validateRequest(s.changeDestinationSchema), ctrl.changeDestination)
app.post('/venues/:venueId/gift-cards/:giftCardId/reveal', validateRequest(s.revealSchema), ctrl.reveal)
app.post('/venues/:venueId/gift-cards/:giftCardId/reveal-manager', validateRequest(s.revealSchema), ctrl.revealManager)
app.use(globalErrorHandler)

const B = '/venues/v1'
const audit = m(superficie.auditarTarjetas)

beforeEach(() => {
  jest.clearAllMocks()
})

describe('ajustes para el POS', () => {
  it('trae los ajustes y por qué se puede o no vender (el botón se explica solo)', async () => {
    m(getGiftCardSettings).mockResolvedValue({
      enabled: true,
      suggestedAmounts: [500, 1000, 2000],
      minAmount: 100,
      maxAmount: 10000,
      validityMonths: null,
      termsVersion: '2026-10-14',
      topePorOperacion: 70000,
      llavesConfiguradas: true,
      updatedAt: null,
    })
    m(superficie.estadoDeVentaDeTarjetas).mockResolvedValue({
      sellable: false,
      code: 'GIFT_CARDS_NOT_IN_PLAN',
      message: 'Las tarjetas de regalo vienen en el plan Pro…',
      howToEnable: 'PLAN',
      operationLimit: 70000,
    })
    const r = await request(app).get(`${B}/gift-cards/settings`)
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({
      enabled: true,
      suggestedAmounts: [500, 1000, 2000],
      sale: { sellable: false, code: 'GIFT_CARDS_NOT_IN_PLAN', howToEnable: 'PLAN', operationLimit: 70000 },
    })
  })
})

const VENTA = {
  idempotencyKey: 'venta-0001-abc',
  purchaserName: 'Luis',
  sobres: [
    { amount: 500.5, deliveryChannel: 'WHATSAPP', recipientName: 'Ana', recipientPhone: '5512345678', message: '¡Feliz cumpleaños!' },
    { amount: 1000, deliveryChannel: 'PRINTED' },
  ],
}
const CUENTA = {
  orderId: 'o1',
  orderNumber: 'ORD-9',
  total: 1500.5,
  replay: false,
  sobres: [
    {
      id: 'g1',
      codigo: 'K7QZ-ABCD-EFGH-JKMN-P',
      ultimos4: 'JKMN',
      monto: 500.5,
      pageToken: 'tok-1',
      deliveryChannel: 'WHATSAPP',
      venceEnMeses: null,
      termsVersion: '2026-10-14',
    },
    {
      id: 'g2',
      codigo: 'M2PX-ABCD-EFGH-JKMN-Q',
      ultimos4: 'JKMN',
      monto: 1000,
      pageToken: 'tok-2',
      deliveryChannel: 'PRINTED',
      venceEnMeses: null,
      termsVersion: '2026-10-14',
    },
  ],
}

describe('vender (cuenta propia de tarjetas)', () => {
  it('manda a A5 su entrada tal cual (montos en pesos), quién vende; responde 201 y deja UNA bitácora sin códigos', async () => {
    m(createGiftCardOrder).mockResolvedValue(CUENTA)
    const r = await request(app).post(`${B}/gift-cards/orders`).set('X-Device-Id', 'caja-1').send(VENTA)
    expect(r.status).toBe(201)
    expect(r.body.data).toEqual(CUENTA)
    expect(createGiftCardOrder).toHaveBeenCalledWith('v1', 'staff-1', VENTA)
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v1',
        staffId: 'staff-1',
        action: 'GIFT_CARD_SALE_CREATED',
        entity: 'Order',
        entityId: 'o1',
        data: { idempotencyKey: 'venta-0001-abc', sobres: 2, total: 1500.5 },
      }),
    )
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/K7QZ-ABCD|tok-1/)
  })

  it('el reintento con la misma llave (A5 responde `replay`) devuelve la misma cuenta con 200 y sin otra bitácora', async () => {
    m(createGiftCardOrder).mockResolvedValue({ ...CUENTA, replay: true })
    const r = await request(app).post(`${B}/gift-cards/orders`).send(VENTA)
    expect(r.status).toBe(200)
    expect(r.body.data.orderId).toBe('o1')
    expect(audit).not.toHaveBeenCalled()
  })

  it.each([
    [
      'WhatsApp sin teléfono',
      { idempotencyKey: 'venta-0002-abc', sobres: [{ amount: 500, deliveryChannel: 'WHATSAPP' }] },
      /falta el teléfono/,
    ],
    ['correo sin correo', { idempotencyKey: 'venta-0003-abc', sobres: [{ amount: 500, deliveryChannel: 'EMAIL' }] }, /falta el correo/],
    [
      'tres decimales',
      { idempotencyKey: 'venta-0004-abc', sobres: [{ amount: 100.555, deliveryChannel: 'PRINTED' }] },
      /hasta 2 decimales/,
    ],
    ['monto en cero', { idempotencyKey: 'venta-0005-abc', sobres: [{ amount: 0, deliveryChannel: 'PRINTED' }] }, /mayor a \$0/],
    [
      'cargar a la tarjeta del cliente (fase 1c)',
      { idempotencyKey: 'venta-0006-abc', sobres: [{ amount: 500, deliveryChannel: 'CUSTOMER_CARD' }] },
      /Elige a dónde va la tarjeta/,
    ],
    ['sin tarjetas', { idempotencyKey: 'venta-0007-abc', sobres: [] }, /al menos una tarjeta/],
    [
      // C1 (cierre): `POS` + `externalId` es la marca de una integrada de SoftRestaurant; una cuenta de tarjetas nunca la lleva.
      'origen POS',
      { idempotencyKey: 'venta-0009-abc', source: 'POS', sobres: [{ amount: 500, deliveryChannel: 'PRINTED' }] },
      /Origen de la venta no reconocido/,
    ],
    ['llave corta', { idempotencyKey: 'abc', sobres: [{ amount: 500, deliveryChannel: 'PRINTED' }] }, /al menos 8 caracteres/],
    [
      'teléfono con espacios (A5 no lo acepta)',
      { idempotencyKey: 'venta-0008-abc', sobres: [{ amount: 500, deliveryChannel: 'WHATSAPP', recipientPhone: '55 1234 5678' }] },
      /sin espacios/,
    ],
  ])('%s → 400 en español y no se crea nada', async (_caso, body, texto) => {
    const r = await request(app).post(`${B}/gift-cards/orders`).send(body)
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(texto)
    expect(createGiftCardOrder).not.toHaveBeenCalled()
  })

  it('un tope rebasado llega con su código y el tope en pesos, al mismo nivel y en `details` (sin sugerir partir la compra)', async () => {
    m(createGiftCardOrder).mockRejectedValue(
      new GiftCardError('GIFT_CARD_OPERATION_LIMIT', 'El total de tarjetas de regalo de una compra debe ser menor a $70,000.00.', 422, {
        tope: 70000,
      }),
    )
    const r = await request(app).post(`${B}/gift-cards/orders`).send(VENTA)
    expect(r.status).toBe(422)
    expect(r.body).toEqual({
      code: 'GIFT_CARD_OPERATION_LIMIT',
      message: 'El total de tarjetas de regalo de una compra debe ser menor a $70,000.00.',
      tope: 70000,
      details: { tope: 70000 },
    })
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('consultar por código', () => {
  it('pasa el código tal cual con el aparato y la IP (el servicio cuenta los fallos); no deja bitácora', async () => {
    m(lookupGiftCards).mockResolvedValue({
      usableBalance: 400.5,
      cards: [{ giftCardId: 'g1', last4: 'K7QZ', balance: 400.5, status: 'ACTIVE', expiresAt: null, usable: true, notUsableReason: null }],
    })
    const r = await request(app).post(`${B}/gift-cards/lookup`).send({ code: 'k7qz-abcd-efgh-jkmn-p' }).set('X-Device-Id', 'caja-1')
    expect(r.status).toBe(200)
    expect(r.body.data.usableBalance).toBe(400.5)
    expect(lookupGiftCards).toHaveBeenCalledWith('v1', { code: 'k7qz-abcd-efgh-jkmn-p' }, { deviceId: 'caja-1', ip: expect.any(String) })
    expect(audit).not.toHaveBeenCalled()
  })

  it('un código que no existe → 404 GIFT_CARD_NOT_FOUND', async () => {
    m(lookupGiftCards).mockRejectedValue(
      new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos una tarjeta con ese código. Revisa que esté completo.', 404),
    )
    const r = await request(app).post(`${B}/gift-cards/lookup`).send({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-Z' })
    expect(r.status).toBe(404)
    // Sin extra no hay `details` (A2: «sin extra no inventa details»).
    expect(r.body).toEqual({ code: 'GIFT_CARD_NOT_FOUND', message: 'No encontramos una tarjeta con ese código. Revisa que esté completo.' })
  })

  it('sin código ni liga → 400', async () => {
    const r = await request(app).post(`${B}/gift-cards/lookup`).send({})
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(/Manda el código o la liga de la tarjeta/)
    expect(lookupGiftCards).not.toHaveBeenCalled()
  })

  it('1b S2: por la liga (pageToken) pasa { pageToken } con el aparato y la IP; no deja bitácora', async () => {
    const liga = 'Xk3pQ9vLmN2bR7tY4wZ8aC1dE5fG6hJ0kL9pQ3sT7uV'
    m(lookupGiftCards).mockResolvedValue({ usableBalance: 0, cards: [] })
    const r = await request(app).post(`${B}/gift-cards/lookup`).send({ pageToken: liga }).set('X-Device-Id', 'caja-1')
    expect(r.status).toBe(200)
    expect(lookupGiftCards).toHaveBeenCalledWith('v1', { pageToken: liga }, { deviceId: 'caja-1', ip: expect.any(String) })
    expect(audit).not.toHaveBeenCalled()
  })
})

const COBRO = { idempotencyKey: 'cobro-0001-abc', proof: { kind: 'CODE', code: 'K7QZ-ABCD-EFGH-JKMN-P' }, amount: 300, tip: 20.5 }
const RESULTADO = {
  paymentId: 'p1',
  orderId: 'o9',
  orderNumber: 'ORD-7',
  amount: 300,
  tipAmount: 20.5,
  redeemed: [{ giftCardId: 'g1', last4: 'K7QZ', amount: 320.5, balanceAfter: 80 }],
  orderRemaining: 150,
  orderPaymentStatus: 'PARTIAL',
  replay: false,
}

describe('cobrar con saldo', () => {
  it('manda venta y propina por separado como Decimal y deja UNA bitácora sin el código', async () => {
    m(payGiftCardBalanceOnOrder).mockResolvedValue(RESULTADO)
    const r = await request(app).post(`${B}/orders/o9/pay-gift-card`).set('X-Device-Id', 'caja-1').send(COBRO)
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual(RESULTADO)
    const [venueId, orderId, input] = m(payGiftCardBalanceOnOrder).mock.calls[0]
    expect([venueId, orderId]).toEqual(['v1', 'o9'])
    expect(input).toMatchObject({
      idempotencyKey: 'cobro-0001-abc',
      proof: { kind: 'CODE', code: 'K7QZ-ABCD-EFGH-JKMN-P' },
      staffId: 'staff-1',
      deviceId: 'caja-1',
    })
    expect(input.amount.toString()).toBe('300')
    expect(input.tip.toString()).toBe('20.5')
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'GIFT_CARD_REDEEMED', entity: 'Payment', entityId: 'p1' }))
    expect(JSON.stringify(audit.mock.calls)).not.toContain('K7QZ-ABCD')
  })

  it('sin propina manda $0', async () => {
    m(payGiftCardBalanceOnOrder).mockResolvedValue(RESULTADO)
    await request(app)
      .post(`${B}/orders/o9/pay-gift-card`)
      .send({ ...COBRO, tip: undefined })
    expect(m(payGiftCardBalanceOnOrder).mock.calls[0][2].tip.toString()).toBe('0')
  })

  it('🔴 F9: el reintento (A8 responde `replay: true`, decidido bajo candado) responde lo mismo y NO duplica la bitácora', async () => {
    m(payGiftCardBalanceOnOrder).mockResolvedValue({ ...RESULTADO, replay: true })
    const r = await request(app).post(`${B}/orders/o9/pay-gift-card`).send(COBRO)
    expect(r.body.data).toEqual({ ...RESULTADO, replay: true })
    expect(audit).not.toHaveBeenCalled()
  })

  it('🔴 F9: dos peticiones simultáneas con la misma llave → UNA bitácora (la perdedora sale con `replay: true`)', async () => {
    m(payGiftCardBalanceOnOrder)
      .mockResolvedValueOnce({ ...RESULTADO, replay: false })
      .mockResolvedValueOnce({ ...RESULTADO, replay: true })
    await Promise.all([
      request(app).post(`${B}/orders/o9/pay-gift-card`).send(COBRO),
      request(app).post(`${B}/orders/o9/pay-gift-card`).send(COBRO),
    ])
    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('saldo insuficiente → 409 con lo disponible al mismo nivel y en `details`', async () => {
    m(payGiftCardBalanceOnOrder).mockRejectedValue(
      new GiftCardError('GIFT_CARD_INSUFFICIENT_BALANCE', 'Quedan $120.00 en la tarjeta de regalo.', 409, { saldoDisponible: 120 }),
    )
    const r = await request(app).post(`${B}/orders/o9/pay-gift-card`).send(COBRO)
    expect(r.status).toBe(409)
    expect(r.body).toEqual({
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
      message: 'Quedan $120.00 en la tarjeta de regalo.',
      saldoDisponible: 120,
      details: { saldoDisponible: 120 },
    })
    expect(audit).not.toHaveBeenCalled()
  })

  it('los extras nunca pisan el código ni el mensaje', async () => {
    m(payGiftCardBalanceOnOrder).mockRejectedValue(
      new GiftCardError('GIFT_CARD_BLOCKED', 'Esta tarjeta está bloqueada.', 409, { code: 'OTRO', message: 'pisado', giftCardId: 'g1' }),
    )
    const r = await request(app).post(`${B}/orders/o9/pay-gift-card`).send(COBRO)
    expect(r.body).toMatchObject({ code: 'GIFT_CARD_BLOCKED', message: 'Esta tarjeta está bloqueada.', giftCardId: 'g1' })
  })

  it.each([
    ['monto cero', { ...COBRO, amount: 0 }, /mayor a \$0/],
    ['sin prueba de posesión', { idempotencyKey: COBRO.idempotencyKey, amount: 100 }, /Falta cómo se identificó la tarjeta/],
    ['propina negativa', { ...COBRO, tip: -5 }, /monto en pesos/],
  ])('%s → 400 y no se cobra', async (_caso, body, texto) => {
    const r = await request(app).post(`${B}/orders/o9/pay-gift-card`).send(body)
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(texto)
    expect(payGiftCardBalanceOnOrder).not.toHaveBeenCalled()
  })
})

describe('recuperar un cobro por su llave (la app murió entre el toque y la respuesta)', () => {
  it('encontrado → { found: true, payment }', async () => {
    m(getGiftCardPaymentByKey).mockResolvedValue(RESULTADO)
    const r = await request(app).get(`${B}/gift-cards/payments/cobro-0001-abc`)
    expect(r.body).toEqual({ success: true, data: { found: true, payment: RESULTADO } })
    expect(getGiftCardPaymentByKey).toHaveBeenCalledWith('v1', 'cobro-0001-abc')
  })

  it('no encontrado → { found: false } (la app reenvía la MISMA solicitud)', async () => {
    m(getGiftCardPaymentByKey).mockResolvedValue(null)
    const r = await request(app).get(`${B}/gift-cards/payments/cobro-0002-abc`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, data: { found: false } })
  })
})

describe('regresar el saldo y cancelar la cuenta', () => {
  it('pasa quién y la llave; una bitácora (la escribe esta capa: A8 ya no la escribe, F9)', async () => {
    m(returnGiftBalanceAndCancelOrder).mockResolvedValue({ replay: false })
    const r = await request(app).post(`${B}/orders/o9/gift-balance-return-and-cancel`).send({ operationKey: 'regresa-0001-abc' })
    expect(r.body).toEqual({ success: true, data: { cancelled: true } })
    expect(returnGiftBalanceAndCancelOrder).toHaveBeenCalledWith('v1', 'o9', { staffId: 'staff-1', operationKey: 'regresa-0001-abc' })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GIFT_CARD_BALANCE_RETURNED_ORDER_CANCELLED',
        entity: 'Order',
        entityId: 'o9',
        data: { operationKey: 'regresa-0001-abc' },
      }),
    )
  })

  it('🔴 F9: reintento con la misma llave (A8 responde `{ replay: true }`): misma respuesta y no repite la bitácora', async () => {
    m(returnGiftBalanceAndCancelOrder).mockResolvedValue({ replay: true })
    const r = await request(app).post(`${B}/orders/o9/gift-balance-return-and-cancel`).send({ operationKey: 'regresa-0001-abc' })
    expect(r.body).toEqual({ success: true, data: { cancelled: true } })
    expect(audit).not.toHaveBeenCalled()
  })

  it('llave de menos de 8 caracteres → 400', async () => {
    const r = await request(app).post(`${B}/orders/o9/gift-balance-return-and-cancel`).send({ operationKey: 'corta' })
    expect(r.status).toBe(400)
    expect(returnGiftBalanceAndCancelOrder).not.toHaveBeenCalled()
  })
})

describe('cancelar la venta de una tarjeta (en tienda, el mismo día)', () => {
  it('inicia la cancelación (bloquea los sobres); la bitácora la deja B2, no esta capa', async () => {
    // El servicio también dice qué bloqueó ESTA llamada (lo usa el MCP); la respuesta HTTP no cambia.
    m(iniciarCancelacionDeVenta).mockResolvedValue({ giftCardIds: ['g1', 'g2'], bloqueadas: ['g1'] })
    const r = await request(app).post(`${B}/gift-cards/orders/o1/cancel-sale`).send({ operationKey: 'cancela-0001-abc' })
    expect(r.body).toEqual({ success: true, data: { giftCardIds: ['g1', 'g2'] } })
    expect(iniciarCancelacionDeVenta).toHaveBeenCalledWith('v1', 'o1', { staffId: 'staff-1', operationKey: 'cancela-0001-abc' })
    expect(audit).not.toHaveBeenCalled()
  })

  it('una tarjeta ya usada → 409 GIFT_CARD_ALREADY_USED', async () => {
    m(iniciarCancelacionDeVenta).mockRejectedValue(
      new GiftCardError('GIFT_CARD_ALREADY_USED', 'La tarjeta ya se usó: su venta no se puede cancelar.', 409),
    )
    const r = await request(app).post(`${B}/gift-cards/orders/o1/cancel-sale`).send({ operationKey: 'cancela-0002-abc' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('GIFT_CARD_ALREADY_USED')
  })

  it('liberar la cancelación: el gerente confirmó que la devolución NO se hizo (F6)', async () => {
    m(liberarCancelacionDeVenta).mockResolvedValue({ liberadas: ['g1'] })
    const r = await request(app)
      .post(`${B}/gift-cards/orders/o1/release-cancel`)
      .send({ operationKey: 'libera-0001-abc', confirmacionNoDevuelto: true })
    expect(r.body).toEqual({ success: true, data: { released: true } })
    expect(liberarCancelacionDeVenta).toHaveBeenCalledWith('v1', 'o1', {
      staffId: 'staff-1',
      operationKey: 'libera-0001-abc',
      confirmacionNoDevuelto: true,
    })
    expect(audit).not.toHaveBeenCalled()
  })

  it.each([
    ['sin la confirmación', { operationKey: 'libera-0002-abc' }],
    ['con la confirmación en false', { operationKey: 'libera-0002-abc', confirmacionNoDevuelto: false }],
  ])('🔴 F6: liberar %s → 400 y la tarjeta sigue bloqueada (un timeout no prueba que el dinero no salió)', async (_caso, body) => {
    const r = await request(app).post(`${B}/gift-cards/orders/o1/release-cancel`).send(body)
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(/comprobaste que la devolución NO se hizo/)
    expect(liberarCancelacionDeVenta).not.toHaveBeenCalled()
  })
})

/** Q110 (1b S2): el autor es SIEMPRE la sesión; `iniciadoPor` es sólo una nota de la bitácora («según el aparato…»). */
describe('Q110: quién empezó un reenvío (sólo nota de bitácora)', () => {
  const ANA = 'cl9ana0000000000000000000'
  const reqDe = (userId: string, body: Record<string, unknown>) => ({ authContext: { userId }, body }) as any

  it('segunElAparato: sin iniciadoPor, o igual a la sesión ⇒ {}', () => {
    expect(segunElAparato(reqDe('staff-1', {}))).toEqual({})
    expect(segunElAparato(reqDe('staff-1', { iniciadoPor: 'staff-1', iniciadoPorNombre: 'Yo' }))).toEqual({})
  })

  it('segunElAparato: distinto de la sesión ⇒ la nota con los dos campos', () => {
    expect(segunElAparato(reqDe('staff-1', { iniciadoPor: ANA, iniciadoPorNombre: 'Ana' }))).toEqual({
      iniciadoPorSegunElAparato: { iniciadoPor: ANA, iniciadoPorNombre: 'Ana' },
    })
  })

  it('🔴 payWithBalance con iniciadoPor A y el token de B ⇒ el servicio recibe B y la bitácora es de B con la nota de A', async () => {
    m(payGiftCardBalanceOnOrder).mockResolvedValue(RESULTADO)
    const r = await request(app)
      .post(`${B}/orders/o9/pay-gift-card`)
      .send({ ...COBRO, iniciadoPor: ANA, iniciadoPorNombre: 'Ana' })
    expect(r.status).toBe(200)
    const input = m(payGiftCardBalanceOnOrder).mock.calls[0][2]
    expect(input.staffId).toBe('staff-1')
    expect(JSON.stringify(input)).not.toContain(ANA) // nunca autor: el servicio no lo recibe
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-1',
        action: 'GIFT_CARD_REDEEMED',
        data: expect.objectContaining({ iniciadoPorSegunElAparato: { iniciadoPor: ANA, iniciadoPorNombre: 'Ana' } }),
      }),
    )
  })

  it('sin iniciadoPor la bitácora no lleva nota', async () => {
    m(payGiftCardBalanceOnOrder).mockResolvedValue(RESULTADO)
    await request(app).post(`${B}/orders/o9/pay-gift-card`).send(COBRO)
    expect(audit.mock.calls[0][0].data).not.toHaveProperty('iniciadoPorSegunElAparato')
  })
})

/** S2b (Q58): la venta de mostrador (el cuerpo de `POST /orders`) y el cobro con saldo en una sola petición. */
describe('cobrar con saldo una venta nueva (pay-new-order)', () => {
  const ANA = 'cl9ana0000000000000000000'
  const VENTA = { items: [{ name: 'Blusa', quantity: 1, unitPrice: 80000 }], discount: 500, ...COBRO }
  const entrada = () => m(payGiftCardOnNewOrder).mock.calls[0][1]

  it('la venta llega como en POST /orders (vendedor = la sesión, TAKEOUT); el cobro, aparte; `tip` es la propina DEL COBRO', async () => {
    m(payGiftCardOnNewOrder).mockResolvedValue(RESULTADO)
    const r = await request(app).post(`${B}/gift-cards/pay-new-order`).set('X-Device-Id', 'caja-1').send(VENTA)
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual(RESULTADO)
    expect(m(payGiftCardOnNewOrder).mock.calls[0][0]).toBe('v1')
    expect(entrada()).toMatchObject({
      items: VENTA.items,
      staffId: 'staff-1',
      orderType: 'TAKEOUT',
      discount: 500,
      idempotencyKey: 'cobro-0001-abc',
      proof: { kind: 'CODE', code: 'K7QZ-ABCD-EFGH-JKMN-P' },
      deviceId: 'caja-1',
      procesadoPor: 'staff-1',
    })
    expect(entrada().amount.toString()).toBe('300')
    expect(entrada().tip.toString()).toBe('20.5')
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff-1', action: 'GIFT_CARD_REDEEMED', entity: 'Payment', entityId: 'p1' }),
    )
    expect(JSON.stringify(audit.mock.calls)).not.toContain('K7QZ-ABCD')
  })

  it('🔴 Q76: con el vendedor B en el cuerpo la venta va a B; quien procesa el cobro sigue siendo la sesión', async () => {
    m(payGiftCardOnNewOrder).mockResolvedValue(RESULTADO)
    await request(app)
      .post(`${B}/gift-cards/pay-new-order`)
      .send({ ...VENTA, staffId: 'staff-B' })
    expect(entrada()).toMatchObject({ staffId: 'staff-B', procesadoPor: 'staff-1' })
  })

  it('🔴 Q110: iniciadoPor A con el token de B ⇒ el cobro es de la sesión y la bitácora lleva la nota; el servicio no recibe A', async () => {
    m(payGiftCardOnNewOrder).mockResolvedValue(RESULTADO)
    await request(app)
      .post(`${B}/gift-cards/pay-new-order`)
      .send({ ...VENTA, iniciadoPor: ANA, iniciadoPorNombre: 'Ana' })
    expect(JSON.stringify(entrada())).not.toContain(ANA)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-1',
        data: expect.objectContaining({ iniciadoPorSegunElAparato: { iniciadoPor: ANA, iniciadoPorNombre: 'Ana' } }),
      }),
    )
  })

  it('el reintento (`replay: true`) responde lo mismo y NO duplica la bitácora', async () => {
    m(payGiftCardOnNewOrder).mockResolvedValue({ ...RESULTADO, replay: true })
    const r = await request(app).post(`${B}/gift-cards/pay-new-order`).send(VENTA)
    expect(r.body.data).toEqual({ ...RESULTADO, replay: true })
    expect(audit).not.toHaveBeenCalled()
  })

  it('sin artículos ⇒ el mismo 400 de POST /orders, sin llegar al servicio', async () => {
    const r = await request(app)
      .post(`${B}/gift-cards/pay-new-order`)
      .send({ ...VENTA, items: [] })
    expect(r.status).toBe(400)
    expect(r.body.message).toBe('Se requiere al menos un item')
    expect(payGiftCardOnNewOrder).not.toHaveBeenCalled()
  })

  // Unión con develop (S9 de «Cobrar sin red»): una venta pagada con saldo también puede regalar renglones. La autoridad es de la
  // SESIÓN, igual que en POST /orders (`autoridadDeLaVenta`); sin ella, la cortesía saldría sin permiso por esta puerta.
  const CORTESIA = { items: [{ name: 'Blusa', quantity: 1, unitPrice: 80000, isCortesia: true, cortesiaReason: 'Invitación' }] }

  it('🔴 unión: una cortesía sin orders:comp ⇒ 403 y no llega al servicio', async () => {
    m(tienePermisoEnVenue).mockResolvedValue(false)
    const r = await request(app)
      .post(`${B}/gift-cards/pay-new-order`)
      .send({ ...VENTA, ...CORTESIA })
    expect(r.status).toBe(403)
    expect(payGiftCardOnNewOrder).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('🔴 unión: con orders:comp la venta lleva la autoridad, y quien regala es la SESIÓN (nunca el cuerpo)', async () => {
    m(tienePermisoEnVenue).mockResolvedValue(true)
    m(payGiftCardOnNewOrder).mockResolvedValue(RESULTADO)
    const r = await request(app)
      .post(`${B}/gift-cards/pay-new-order`)
      .send({ ...VENTA, ...CORTESIA, canCompItems: true, performedBy: 'intruso' })
    expect(r.status).toBe(200)
    expect(tienePermisoEnVenue).toHaveBeenCalledWith(expect.anything(), 'orders:comp')
    expect(entrada()).toMatchObject({ canCompItems: true, performedBy: 'staff-1' })
  })

  it('sin la prueba de posesión ⇒ 400 del esquema', async () => {
    const r = await request(app)
      .post(`${B}/gift-cards/pay-new-order`)
      .send({ ...VENTA, proof: undefined })
    expect(r.status).toBe(400)
    expect(payGiftCardOnNewOrder).not.toHaveBeenCalled()
  })

  // Revisión S2b: ignorarlos en silencio cobraba una venta de MOSTRADOR aparte y dejaba la mesa abierta con lo mismo.
  it.each([
    ['tableId', { tableId: 'mesa-9' }, 'Las cuentas de mesa se cobran con saldo desde la mesa, no como venta nueva.'],
    ['externalId', { externalId: 'venta-de-la-app' }, 'Esta venta nace con la llave del cobro: no mandes externalId.'],
    [
      'isOfflineReplay: true',
      { isOfflineReplay: true },
      'Una venta guardada sin red no se cobra con saldo de tarjeta: el saldo necesita conexión.',
    ],
  ])('🔴 con %s ⇒ 400 GIFT_CARD_NEW_ORDER_FIELD_NOT_ALLOWED, sin llegar al servicio', async (_campo, extra, mensaje) => {
    const r = await request(app)
      .post(`${B}/gift-cards/pay-new-order`)
      .send({ ...VENTA, ...extra })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'GIFT_CARD_NEW_ORDER_FIELD_NOT_ALLOWED', message: mensaje })
    expect(payGiftCardOnNewOrder).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it.each([
    ['ausentes', {}],
    ['en null (isOfflineReplay en false)', { tableId: null, externalId: null, isOfflineReplay: false }],
    // El armado de Android que reúsa el T1 manda SIEMPRE `"splitType":"FULLPAYMENT"`: un 400 tumbaría sus cobros.
    ["con splitType 'FULLPAYMENT'", { splitType: 'FULLPAYMENT' }],
  ])('mesa, externalId e isOfflineReplay %s ⇒ llega al servicio', async (_caso, extra) => {
    m(payGiftCardOnNewOrder).mockResolvedValue(RESULTADO)
    const r = await request(app)
      .post(`${B}/gift-cards/pay-new-order`)
      .send({ ...VENTA, ...extra })
    expect(r.status).toBe(200)
    expect(payGiftCardOnNewOrder).toHaveBeenCalledTimes(1)
  })
})

/** 1b Q36 (Q102): repetir la venta ya no es otra salida del código sin su renglón confirmado. */
describe('Q36: repetir la venta y el código', () => {
  const salida = m(superficie.registrarSalidaDelSecreto)
  const conEstado = (estados: string[], over: Record<string, unknown> = {}) => ({
    ...CUENTA,
    replay: true,
    sobres: CUENTA.sobres.map((sobre, i) => ({ ...sobre, status: estados[i], ...over })),
  })

  it('🔴 un reenvío que trae el código ⇒ un GIFT_CARD_CODE_REVEALED (REPLAY) por sobre, antes de responder', async () => {
    const orden: string[] = []
    salida.mockImplementationOnce(async () => void orden.push('bitacora'))
    m(createGiftCardOrder).mockResolvedValue(conEstado(['ACTIVE', 'ACTIVE']))
    const r = await request(app).post(`${B}/gift-cards/orders`).send(VENTA)
    orden.push('respuesta')
    expect(r.status).toBe(200)
    expect(orden).toEqual(['bitacora', 'respuesta'])
    expect(salida).toHaveBeenCalledTimes(1)
    const [db, filas] = salida.mock.calls[0]
    expect(db).toBeDefined()
    expect(filas).toEqual(
      ['g1', 'g2'].map(entityId =>
        expect.objectContaining({
          venueId: 'v1',
          staffId: 'staff-1',
          action: 'GIFT_CARD_CODE_REVEALED',
          entity: 'GiftCard',
          entityId,
          data: { motivo: 'REPLAY', idempotencyKey: 'venta-0001-abc' },
        }),
      ),
    )
    expect(JSON.stringify(filas)).not.toMatch(/K7QZ-ABCD|M2PX|tok-1|tok-2/)
  })

  // M1 de la revisión de S4: el renglón lo decide lo que la respuesta TRAE, no el estado del sobre.
  it.each([
    ['BLOCKED (la venta del día que un gerente bloqueó)', ['BLOCKED', 'BLOCKED']],
    ['PENDING (la venta aún sin cobrar)', ['PENDING', 'PENDING']],
    ['ACTIVE y otro BLOCKED', ['ACTIVE', 'BLOCKED']],
  ])('🔴 M1: el código de un sobre %s también sale con su renglón', async (_caso, estados) => {
    m(createGiftCardOrder).mockResolvedValue(conEstado(estados))
    const r = await request(app).post(`${B}/gift-cards/orders`).send(VENTA)
    expect(r.status).toBe(200)
    expect(salida.mock.calls.flatMap(c => c[1]).map(f => f.entityId)).toEqual(['g1', 'g2'])
  })

  it('🔴 M1: en la misma venta, un sobre PENDING con código y otro BLOCKED oculto ⇒ sólo el que trae el código lleva renglón', async () => {
    const base = conEstado(['PENDING', 'BLOCKED'])
    const cuenta = {
      ...base,
      sobres: [base.sobres[0], { ...base.sobres[1], codigo: null, pageToken: null, pageUrl: null, codigoOculto: true }],
    }
    m(createGiftCardOrder).mockResolvedValue(cuenta)
    const r = await request(app).post(`${B}/gift-cards/orders`).send(VENTA)
    expect(r.status).toBe(200)
    expect(salida.mock.calls.flatMap(c => c[1]).map(f => f.entityId)).toEqual(['g1'])
  })

  it('🔴 si ese renglón no se guarda ⇒ 503 «No se pudo mostrar el código. Intenta otra vez.» y la venta no se responde', async () => {
    salida.mockRejectedValueOnce(new Error('la base no contestó'))
    m(createGiftCardOrder).mockResolvedValue(conEstado(['ACTIVE', 'ACTIVE']))
    const r = await request(app).post(`${B}/gift-cards/orders`).send(VENTA)
    expect(r.status).toBe(503)
    expect(r.body.message).toBe('No se pudo mostrar el código. Intenta otra vez.')
    expect(JSON.stringify(r.body)).not.toMatch(/K7QZ-ABCD|M2PX|tok-1|tok-2/)
  })

  it.each([
    ['ACTIVE', conEstado(['ACTIVE', 'ACTIVE'], { codigo: null, pageToken: null, pageUrl: null, codigoOculto: true })],
    ['PENDING', conEstado(['PENDING', 'PENDING'], { codigo: null, pageToken: null, pageUrl: null, codigoOculto: true })],
  ])('con el código oculto (sobres %s) ⇒ ningún renglón', async (_caso, cuenta) => {
    m(createGiftCardOrder).mockResolvedValue(cuenta)
    const r = await request(app).post(`${B}/gift-cards/orders`).send(VENTA)
    expect(r.status).toBe(200)
    expect(salida.mock.calls.flatMap(c => c[1])).toEqual([])
  })

  it('la creación (replay: false) nunca lo escribe', async () => {
    m(createGiftCardOrder).mockResolvedValue({ ...conEstado(['ACTIVE', 'ACTIVE']), replay: false })
    await request(app).post(`${B}/gift-cards/orders`).send(VENTA)
    expect(salida.mock.calls.flatMap(c => c[1])).toEqual([])
  })

  it('🔴 Q110: la venta es de la sesión y la bitácora lleva «según el aparato» (no entra a la huella: el servicio recibe el cuerpo)', async () => {
    const ANA = 'cl9ana0000000000000000000'
    m(createGiftCardOrder).mockResolvedValue(CUENTA)
    const r = await request(app)
      .post(`${B}/gift-cards/orders`)
      .send({ ...VENTA, iniciadoPor: ANA, iniciadoPorNombre: 'Ana' })
    expect(r.status).toBe(201)
    expect(m(createGiftCardOrder).mock.calls[0][1]).toBe('staff-1')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-1',
        action: 'GIFT_CARD_SALE_CREATED',
        data: expect.objectContaining({ iniciadoPorSegunElAparato: { iniciadoPor: ANA, iniciadoPorNombre: 'Ana' } }),
      }),
    )
  })
})

/** 1b S4: el detalle de la cuenta, reenviar, cambiar el destino y mostrar el código (Q16, Q17, Q42, Q102, RF3). */
describe('S4: la cuenta de tarjetas en el POS', () => {
  const permisos = (vender: boolean, gestionar: boolean) =>
    m(tienePermisoEnVenue).mockImplementation(async (_req: unknown, permiso: string) =>
      permiso === 'giftCards:sell' ? vender : permiso === 'giftCards:manage' ? gestionar : false,
    )
  const sobre = (over: Record<string, unknown>) => ({
    id: 'g1',
    ultimos4: 'JKMN',
    status: 'ACTIVE',
    deliveryChannel: 'WHATSAPP',
    deliveryStatus: 'PENDING',
    ...over,
  })
  const RESULTADO_REENVIO = {
    giftCardId: 'g1',
    deliveryStatus: 'PENDING',
    repuesta: false,
    ultimos4: 'JKMN',
    replay: false,
    destinoAnterior: null,
    destinoNuevo: null,
  }
  const CERT = {
    codigo: 'K7QZ-ABCD-EFGH-JKMN-P',
    pageToken: 'tok-1',
    pageUrl: 'https://pay.avoqado.io/tarjeta/tok-1',
    ultimos4: 'JKMN',
    monto: 500,
    saldo: 500,
    venceEl: null,
    termsVersion: '2026-10-14',
    recipientName: 'Ana',
    purchaserName: 'Luis',
    message: null,
  }
  /** Toda bitácora de mejor esfuerzo: la del controller (`auditarTarjetas`) y la de `auditarReenvio` (llega a `logAction`). */
  const bitacora = () => [...audit.mock.calls, ...m(logAction).mock.calls].map(c => c[0])
  const sinSecretos = () => {
    const todo = JSON.stringify(bitacora())
    expect(todo).not.toMatch(/K7QZ-ABCD|tok-1|5512345678|5598765432|ana@gmail\.com/)
  }

  beforeEach(() => permisos(true, false))

  it('getCuenta pregunta sell y manage de verdad, responde el detalle y patea SÓLO las ACTIVE de WhatsApp/correo en PENDING', async () => {
    let soltarEntrega: () => void = () => undefined
    m(entregarTarjetas).mockImplementationOnce(() => new Promise(r => (soltarEntrega = () => r({} as any))))
    const data = {
      orderId: 'o1',
      sobres: [
        sobre({ id: 'g1' }),
        sobre({ id: 'g2', deliveryChannel: 'EMAIL' }),
        sobre({ id: 'g3', deliveryStatus: 'SENT' }),
        sobre({ id: 'g4', deliveryChannel: 'PRINTED' }),
        sobre({ id: 'g5', status: 'PENDING' }),
      ],
    }
    m(getCuentaDeTarjetasPos).mockResolvedValue(data)
    const r = await request(app).get(`${B}/gift-cards/orders/o1`)
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual(data)
    expect(
      m(tienePermisoEnVenue)
        .mock.calls.map(c => c[1])
        .sort(),
    ).toEqual(['giftCards:manage', 'giftCards:sell'])
    expect(getCuentaDeTarjetasPos).toHaveBeenCalledWith('v1', 'o1', {
      staffId: 'staff-1',
      puedeVender: true,
      puedeGestionar: false,
      overrideAuthorizedBy: null,
    })
    // Respondió SIN esperar la entrega (que sigue colgada).
    expect(entregarTarjetas).toHaveBeenCalledWith({ ids: ['g1', 'g2'] })
    soltarEntrega()
  })

  it('getCuenta sin nada por entregar no patea', async () => {
    m(getCuentaDeTarjetasPos).mockResolvedValue({ orderId: 'o1', sobres: [sobre({ deliveryStatus: 'SENT' })] })
    await request(app).get(`${B}/gift-cards/orders/o1`)
    expect(entregarTarjetas).not.toHaveBeenCalled()
  })

  it('resend nuevo: responde los cuatro campos, deja GIFT_CARD_RESENT y patea esa tarjeta', async () => {
    m(reenviarTarjeta).mockResolvedValue(RESULTADO_REENVIO)
    const r = await request(app).post(`${B}/gift-cards/g1/resend`).send({ operationKey: 'reenvia-0001' })
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({ giftCardId: 'g1', deliveryStatus: 'PENDING', repuesta: false, ultimos4: 'JKMN' })
    expect(m(reenviarTarjeta).mock.calls[0][3]).toEqual({ operationKey: 'reenvia-0001', destino: undefined })
    expect(bitacora()).toHaveLength(1)
    expect(bitacora()).toContainEqual(
      expect.objectContaining({
        action: 'GIFT_CARD_RESENT',
        entity: 'GiftCard',
        entityId: 'g1',
        staffId: 'staff-1',
        data: expect.objectContaining({ operationKey: 'reenvia-0001' }),
      }),
    )
    expect(entregarTarjetas).toHaveBeenCalledWith({ ids: ['g1'] })
  })

  it('resend con destino lo pasa leído (P-2)', async () => {
    m(reenviarTarjeta).mockResolvedValue(RESULTADO_REENVIO)
    await request(app)
      .post(`${B}/gift-cards/g1/resend`)
      .send({ operationKey: 'reenvia-0002', deliveryChannel: 'WHATSAPP', recipientPhone: '5512345678' })
    expect(m(reenviarTarjeta).mock.calls[0][3].destino).toEqual({ deliveryChannel: 'WHATSAPP', recipientPhone: '5512345678' })
  })

  it('🔴 un replay del reenvío no repite la bitácora ni patea', async () => {
    m(reenviarTarjeta).mockResolvedValue({ ...RESULTADO_REENVIO, replay: true, deliveryStatus: 'SENT' })
    const r = await request(app).post(`${B}/gift-cards/g1/resend`).send({ operationKey: 'reenvia-0001' })
    expect(r.body.data.deliveryStatus).toBe('SENT')
    expect(bitacora()).toEqual([])
    expect(entregarTarjetas).not.toHaveBeenCalled()
  })

  it.each([
    ['GIFT_CARD_NOT_DELIVERABLE', new GiftCardError('GIFT_CARD_NOT_DELIVERABLE', 'Esta tarjeta se entregó en papel o en mano.', 409), 409],
    ['GIFT_CARD_ALREADY_USED', new GiftCardError('GIFT_CARD_ALREADY_USED', 'Esta tarjeta ya se usó: no se puede reponer.', 409), 409],
    [
      'GIFT_CARD_USE_CHANGE_DESTINATION',
      new BadRequestError('Para mandarla a otro teléfono o correo usa «Cambiar destino».', 'GIFT_CARD_USE_CHANGE_DESTINATION'),
      400,
    ],
  ])('🔴 RF3: el rechazo %s deja GIFT_CARD_RESEND_DENIED y se relanza', async (code, error, status) => {
    m(reenviarTarjeta).mockRejectedValue(error)
    const r = await request(app)
      .post(`${B}/gift-cards/g1/resend`)
      .send({ operationKey: 'reenvia-0003', deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' })
    expect(r.status).toBe(status)
    expect(r.body.code).toBe(code)
    expect(bitacora()).toHaveLength(1)
    expect(bitacora()).toContainEqual(
      expect.objectContaining({
        action: 'GIFT_CARD_RESEND_DENIED',
        entityId: 'g1',
        data: { code, operationKey: 'reenvia-0003', ruta: 'POST /mobile/venues/:venueId/gift-cards/:giftCardId/resend' },
      }),
    )
    expect(entregarTarjetas).not.toHaveBeenCalled()
    sinSecretos()
  })

  it('un rechazo que no es de reenvío (p. ej. bloqueada) no deja RESEND_DENIED', async () => {
    m(reenviarTarjeta).mockRejectedValue(new GiftCardError('GIFT_CARD_BLOCKED', 'Esta tarjeta de regalo está bloqueada.', 409))
    const r = await request(app).post(`${B}/gift-cards/g1/resend`).send({ operationKey: 'reenvia-0004' })
    expect(r.status).toBe(409)
    expect(bitacora()).toEqual([])
  })

  it('🔴 change-destination NO pregunta permisos (los dio la ruta o el PIN) y pasa quién autorizó; deja DESTINATION_CHANGED enmascarado', async () => {
    m(cambiarDestinoDeTarjeta).mockResolvedValue({
      ...RESULTADO_REENVIO,
      repuesta: true,
      ultimos4: 'WXYZ',
      destinoAnterior: '55•••••678',
      destinoNuevo: '55•••••432',
    })
    const r = await request(app)
      .post(`${B}/gift-cards/g1/change-destination`)
      .set('x-test-override', 'sv-gerente')
      .send({ operationKey: 'cambia-0001', deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' })
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({ giftCardId: 'g1', deliveryStatus: 'PENDING', repuesta: true, ultimos4: 'WXYZ' })
    expect(tienePermisoEnVenue).not.toHaveBeenCalled()
    const [venueId, giftCardId, quien, p] = m(cambiarDestinoDeTarjeta).mock.calls[0]
    expect([venueId, giftCardId]).toEqual(['v1', 'g1'])
    expect(quien).toMatchObject({ staffId: 'staff-1', overrideAuthorizedBy: 'sv-gerente' })
    expect(p).toEqual({ operationKey: 'cambia-0001', destino: { deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' } })
    expect(p).not.toHaveProperty('comoGerente')
    expect(bitacora()).toContainEqual(
      expect.objectContaining({
        action: 'GIFT_CARD_DESTINATION_CHANGED',
        data: expect.objectContaining({
          operationKey: 'cambia-0001',
          destinoAnterior: '55•••••678',
          destinoNuevo: '55•••••432',
          overrideAuthorizedBy: 'sv-gerente',
        }),
      }),
    )
    expect(entregarTarjetas).toHaveBeenCalledWith({ ids: ['g1'] })
    sinSecretos()
  })

  it.each(['PRINTED', 'HANDED_TO_BUYER'])(
    'change-destination a %s ⇒ 400 GIFT_CARD_DESTINATION_CHANNEL_INVALID, sin llegar al servicio',
    async canal => {
      const r = await request(app)
        .post(`${B}/gift-cards/g1/change-destination`)
        .send({ operationKey: 'cambia-0002', deliveryChannel: canal })
      expect(r.status).toBe(400)
      expect(r.body).toMatchObject({
        code: 'GIFT_CARD_DESTINATION_CHANNEL_INVALID',
        message: 'Para cambiar el destino elige WhatsApp o correo',
      })
      expect(cambiarDestinoDeTarjeta).not.toHaveBeenCalled()
    },
  )

  it('🔴 change-destination de una usada ⇒ el 409 y GIFT_CARD_RESEND_DENIED', async () => {
    m(cambiarDestinoDeTarjeta).mockRejectedValue(
      new GiftCardError('GIFT_CARD_ALREADY_USED', 'Esta tarjeta ya se usó: no se puede reponer.', 409),
    )
    const r = await request(app)
      .post(`${B}/gift-cards/g1/change-destination`)
      .send({ operationKey: 'cambia-0003', deliveryChannel: 'EMAIL', recipientEmail: 'ana@gmail.com' })
    expect(r.status).toBe(409)
    expect(bitacora()).toContainEqual(expect.objectContaining({ action: 'GIFT_CARD_RESEND_DENIED' }))
    sinSecretos()
  })

  it('reveal pregunta sell y manage de verdad, pasa comoGerente: false y responde el certificado; la bitácora del secreto es del servicio', async () => {
    permisos(true, true)
    m(revelarCodigo).mockResolvedValue(CERT)
    const r = await request(app).post(`${B}/gift-cards/g1/reveal`).send({ operationKey: 'revela-0001', motivo: 'REPRINT' })
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual(CERT)
    expect(
      m(tienePermisoEnVenue)
        .mock.calls.map(c => c[1])
        .sort(),
    ).toEqual(['giftCards:manage', 'giftCards:sell'])
    const [, , quien, p] = m(revelarCodigo).mock.calls[0]
    expect(quien).toEqual({ staffId: 'staff-1', puedeVender: true, puedeGestionar: true, overrideAuthorizedBy: null })
    expect(p).toMatchObject({
      operationKey: 'revela-0001',
      motivo: 'REPRINT',
      comoGerente: false,
      auditoria: expect.objectContaining({ staffId: 'staff-1', ruta: 'POST /mobile/venues/:venueId/gift-cards/:giftCardId/reveal' }),
    })
    expect(audit).not.toHaveBeenCalled()
  })

  it('🔴 RF3: reveal otro día ⇒ 403 GIFT_CARD_REVEAL_NOT_ALLOWED con su GIFT_CARD_REVEAL_DENIED', async () => {
    m(revelarCodigo).mockRejectedValue(
      new GiftCardError('GIFT_CARD_REVEAL_NOT_ALLOWED', 'Volver a imprimir o enseñar el código otro día lo hace un gerente.', 403),
    )
    const r = await request(app).post(`${B}/gift-cards/g1/reveal`).send({ operationKey: 'revela-0002', motivo: 'SHOW_QR' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('GIFT_CARD_REVEAL_NOT_ALLOWED')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GIFT_CARD_REVEAL_DENIED',
        entity: 'GiftCard',
        entityId: 'g1',
        data: {
          code: 'GIFT_CARD_REVEAL_NOT_ALLOWED',
          operationKey: 'revela-0002',
          ruta: 'POST /mobile/venues/:venueId/gift-cards/:giftCardId/reveal',
        },
      }),
    )
  })

  it('🔴 reveal-manager NO pregunta permisos, pasa comoGerente: true y quién autorizó el PIN', async () => {
    m(revelarCodigo).mockResolvedValue(CERT)
    const r = await request(app)
      .post(`${B}/gift-cards/g1/reveal-manager`)
      .set('x-test-override', 'sv-gerente')
      .send({ operationKey: 'revela-0003', motivo: 'REPRINT' })
    expect(r.status).toBe(200)
    expect(tienePermisoEnVenue).not.toHaveBeenCalled()
    const [, , quien, p] = m(revelarCodigo).mock.calls[0]
    expect(quien).toMatchObject({ staffId: 'staff-1', overrideAuthorizedBy: 'sv-gerente' })
    expect(p).toMatchObject({
      comoGerente: true,
      auditoria: expect.objectContaining({
        overrideAuthorizedBy: 'sv-gerente',
        ruta: 'POST /mobile/venues/:venueId/gift-cards/:giftCardId/reveal-manager',
      }),
    })
  })

  it('el 503 de Q102 llega tal cual, sin secreto', async () => {
    m(revelarCodigo).mockRejectedValue(new ServiceUnavailableError('No se pudo mostrar el código. Intenta otra vez.'))
    const r = await request(app).post(`${B}/gift-cards/g1/reveal-manager`).send({ operationKey: 'revela-0004', motivo: 'REPRINT' })
    expect(r.status).toBe(503)
    expect(r.body.message).toBe('No se pudo mostrar el código. Intenta otra vez.')
    expect(audit).not.toHaveBeenCalled()
  })

  it('reveal sin motivo o con una llave corta ⇒ 400 del esquema', async () => {
    for (const body of [{ operationKey: 'revela-0005' }, { operationKey: 'corta', motivo: 'REPRINT' }]) {
      expect((await request(app).post(`${B}/gift-cards/g1/reveal`).send(body)).status).toBe(400)
    }
    expect(revelarCodigo).not.toHaveBeenCalled()
  })

  it('Q42: revealCuenta responde las tarjetas; otro día ⇒ 403 con su REVEAL_DENIED sobre la cuenta', async () => {
    m(revelarCodigosDeLaCuenta).mockResolvedValue({ orderId: 'o1', tarjetas: [{ id: 'g1', ...CERT }] })
    const ok = await request(app).post(`${B}/gift-cards/orders/o1/reveal`).send({ operationKey: 'imprime-0001' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.tarjetas).toHaveLength(1)
    expect(m(revelarCodigosDeLaCuenta).mock.calls[0][3]).toMatchObject({
      operationKey: 'imprime-0001',
      auditoria: expect.objectContaining({ ruta: 'POST /mobile/venues/:venueId/gift-cards/orders/:orderId/reveal' }),
    })
    m(revelarCodigosDeLaCuenta).mockRejectedValue(
      new GiftCardError('GIFT_CARD_REVEAL_NOT_ALLOWED', 'Volver a imprimir o enseñar el código otro día lo hace un gerente.', 403),
    )
    const otroDia = await request(app).post(`${B}/gift-cards/orders/o1/reveal`).send({ operationKey: 'imprime-0002' })
    expect(otroDia.status).toBe(403)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'GIFT_CARD_REVEAL_DENIED', entity: 'Order', entityId: 'o1' }))
  })
})

/**
 * Cierre A (C4): el límite de reenvíos (un contador por tarjeta) sólo cuenta lo que manda algo nuevo. Aquí con el controller REAL
 * y un límite de 1: la repetición de una llave (`replay: true` del servicio) no lo gasta; un reenvío nuevo sí, y el siguiente
 * —por cualquiera de las dos rutas— ya es 429.
 */
describe('Cierre A (C4): la repetición de un reenvío no gasta el límite', () => {
  const NUEVO = {
    giftCardId: 'g1',
    deliveryStatus: 'PENDING',
    repuesta: false,
    ultimos4: 'JKMN',
    replay: false,
    destinoAnterior: null,
    destinoNuevo: null,
  }
  function conLimiteDeUno() {
    const limite = crearLimiteDeReenvio(1)
    const a = express()
    a.use(express.json())
    a.use((req, _res, next) => {
      ;(req as any).authContext = { userId: 'staff-1', venueId: 'v1', role: 'MANAGER' }
      next()
    })
    a.post('/venues/:venueId/gift-cards/:giftCardId/resend', validateRequest(s.resendSchema), limite, ctrl.resend)
    a.post(
      '/venues/:venueId/gift-cards/:giftCardId/change-destination',
      validateRequest(s.changeDestinationSchema),
      limite,
      ctrl.changeDestination,
    )
    a.use(globalErrorHandler)
    return a
  }

  it('dos repeticiones y luego un reenvío nuevo pasan; el siguiente reenvío o cambio de destino ⇒ 429', async () => {
    const a = conLimiteDeUno()
    m(reenviarTarjeta).mockResolvedValue({ ...NUEVO, replay: true, deliveryStatus: 'SENT' })
    for (let i = 0; i < 2; i++)
      expect((await request(a).post(`${B}/gift-cards/g1/resend`).send({ operationKey: 'reenvia-0001' })).status).toBe(200)
    m(reenviarTarjeta).mockResolvedValue(NUEVO)
    expect((await request(a).post(`${B}/gift-cards/g1/resend`).send({ operationKey: 'reenvia-0002' })).status).toBe(200)

    const otro = await request(a).post(`${B}/gift-cards/g1/resend`).send({ operationKey: 'reenvia-0003' })
    expect(otro.status).toBe(429)
    expect(otro.body.code).toBe('GIFT_CARD_RESEND_RATE_LIMITED')
    m(cambiarDestinoDeTarjeta).mockResolvedValue({ ...NUEVO, repuesta: true })
    const cambio = await request(a)
      .post(`${B}/gift-cards/g1/change-destination`)
      .send({ operationKey: 'cambia-0001', deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' })
    expect(cambio.status).toBe(429)
    expect(reenviarTarjeta).toHaveBeenCalledTimes(3)
    expect(cambiarDestinoDeTarjeta).not.toHaveBeenCalled()
  })

  it('la repetición de un cambio de destino tampoco lo gasta', async () => {
    const a = conLimiteDeUno()
    m(cambiarDestinoDeTarjeta).mockResolvedValue({ ...NUEVO, repuesta: true, replay: true })
    const cuerpo = { operationKey: 'cambia-0002', deliveryChannel: 'WHATSAPP', recipientPhone: '5598765432' }
    for (let i = 0; i < 3; i++) expect((await request(a).post(`${B}/gift-cards/g1/change-destination`).send(cuerpo)).status).toBe(200)
    m(reenviarTarjeta).mockResolvedValue(NUEVO)
    expect((await request(a).post(`${B}/gift-cards/g1/resend`).send({ operationKey: 'reenvia-0004' })).status).toBe(200)
  })
})
