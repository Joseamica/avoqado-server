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
  lookupGiftCardsByCode: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardCancel.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardCancel.service'),
  iniciarCancelacionDeVenta: jest.fn(),
  liberarCancelacionDeVenta: jest.fn(),
}))
jest.mock('@/services/mobile/order.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/order.mobile.service'),
  payGiftCardBalanceOnOrder: jest.fn(),
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
import { lookupGiftCardsByCode } from '@/services/giftCards/giftCardLookup.service'
import { iniciarCancelacionDeVenta, liberarCancelacionDeVenta } from '@/services/giftCards/giftCardCancel.service'
import { getGiftCardPaymentByKey, payGiftCardBalanceOnOrder, returnGiftBalanceAndCancelOrder } from '@/services/mobile/order.mobile.service'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'

const m = (f: unknown) => f as jest.Mock
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  ;(req as any).authContext = { userId: 'staff-1', venueId: 'v1', role: 'CASHIER' }
  next()
})
app.get('/venues/:venueId/gift-cards/settings', validateRequest(soloVenueSchema), venta.getSettings)
app.post('/venues/:venueId/gift-cards/orders', validateRequest(s.createGiftCardOrderSchema), ctrl.createOrder)
app.post('/venues/:venueId/gift-cards/lookup', validateRequest(s.lookupSchema), ctrl.lookup)
app.post('/venues/:venueId/orders/:orderId/pay-gift-card', validateRequest(s.payGiftCardSchema), ctrl.payWithBalance)
app.get('/venues/:venueId/gift-cards/payments/:idempotencyKey', validateRequest(s.paymentByKeySchema), ctrl.getPaymentByKey)
app.post(
  '/venues/:venueId/orders/:orderId/gift-balance-return-and-cancel',
  validateRequest(operationKeyOnOrderSchema),
  ctrl.returnBalanceAndCancel,
)
app.post('/venues/:venueId/gift-cards/orders/:orderId/cancel-sale', validateRequest(operationKeyOnOrderSchema), venta.cancelSale)
app.post('/venues/:venueId/gift-cards/orders/:orderId/release-cancel', validateRequest(liberarCancelacionSchema), venta.releaseCancel)
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
    m(lookupGiftCardsByCode).mockResolvedValue({
      usableBalance: 400.5,
      cards: [{ giftCardId: 'g1', last4: 'K7QZ', balance: 400.5, status: 'ACTIVE', expiresAt: null, usable: true, notUsableReason: null }],
    })
    const r = await request(app).post(`${B}/gift-cards/lookup`).send({ code: 'k7qz-abcd-efgh-jkmn-p' }).set('X-Device-Id', 'caja-1')
    expect(r.status).toBe(200)
    expect(r.body.data.usableBalance).toBe(400.5)
    expect(lookupGiftCardsByCode).toHaveBeenCalledWith('v1', 'k7qz-abcd-efgh-jkmn-p', { deviceId: 'caja-1', ip: expect.any(String) })
    expect(audit).not.toHaveBeenCalled()
  })

  it('un código que no existe → 404 GIFT_CARD_NOT_FOUND', async () => {
    m(lookupGiftCardsByCode).mockRejectedValue(
      new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos una tarjeta con ese código. Revisa que esté completo.', 404),
    )
    const r = await request(app).post(`${B}/gift-cards/lookup`).send({ code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-Z' })
    expect(r.status).toBe(404)
    // Sin extra no hay `details` (A2: «sin extra no inventa details»).
    expect(r.body).toEqual({ code: 'GIFT_CARD_NOT_FOUND', message: 'No encontramos una tarjeta con ese código. Revisa que esté completo.' })
  })

  it('sin código → 400', async () => {
    const r = await request(app).post(`${B}/gift-cards/lookup`).send({})
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(/Falta el código de la tarjeta/)
    expect(lookupGiftCardsByCode).not.toHaveBeenCalled()
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
    m(iniciarCancelacionDeVenta).mockResolvedValue({ giftCardIds: ['g1', 'g2'] })
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
    m(liberarCancelacionDeVenta).mockResolvedValue(undefined)
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
