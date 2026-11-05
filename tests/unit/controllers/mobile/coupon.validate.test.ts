/**
 * D5: la forma de `POST /mobile/.../coupons/validate` es la que leen las apps; se fija aquí porque el fixture de ANDROID la copia
 * (`CuponDelServidorTest`). Sólo cambia el texto: español y con acentos.
 */
import express from 'express'
import request from 'supertest'
import { validateCoupon } from '@/controllers/mobile/coupon.mobile.controller'
import { prismaMock } from '../../../__helpers__/setup'

const app = express()
app.use(express.json())
app.post('/venues/:venueId/coupons/validate', validateCoupon)

const cupon = (extra: Record<string, unknown> = {}) => ({
  id: 'cup-1',
  code: 'DESC10',
  active: true,
  maxUses: null,
  maxUsesPerCustomer: null,
  currentUses: 0,
  minPurchaseAmount: null,
  validFrom: null,
  validUntil: null,
  discount: { id: 'd-1', name: 'Diez', type: 'PERCENTAGE', value: 10, scope: 'ORDER', maxDiscountAmount: 50, active: true },
  ...extra,
})

const validar = (body: Record<string, unknown>) => request(app).post('/venues/v-1/coupons/validate').send(body)

describe('POST /mobile/venues/:venueId/coupons/validate', () => {
  beforeEach(() => jest.clearAllMocks())

  it('válido: la forma exacta de siempre', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(cupon() as any)
    const res = await validar({ code: 'desc10' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      success: true,
      data: {
        valid: true,
        coupon: {
          id: 'cup-1',
          code: 'DESC10',
          discount: { id: 'd-1', name: 'Diez', type: 'PERCENTAGE', value: 10, scope: 'ORDER', maxDiscountAmount: 50 },
        },
      },
    })
  })

  it.each([
    ['no existe', null, 'NOT_FOUND', 'No encontramos ese código de cupón.'],
    ['inactivo', cupon({ active: false }), 'INACTIVE', 'Este cupón está inactivo.'],
    ['vencido', cupon({ validUntil: new Date(Date.now() - 1000) }), 'EXPIRED', 'Este cupón ya venció.'],
    ['agotado', cupon({ maxUses: 1, currentUses: 1 }), 'USAGE_LIMIT', 'Este cupón ya alcanzó su límite de usos.'],
  ])('%s: valid false, con errorCode y texto en español', async (_caso, fila, errorCode, error) => {
    prismaMock.couponCode.findFirst.mockResolvedValue(fila as any)
    const res = await validar({ code: 'DESC10' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { valid: false, error, errorCode } })
  })

  it('CUSTOMER_LIMIT: sólo se mira con cliente', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(cupon({ maxUsesPerCustomer: 1 }) as any)
    prismaMock.couponRedemption.count.mockResolvedValue(1)
    expect((await validar({ code: 'DESC10' })).body.data.valid).toBe(true)
    expect(prismaMock.couponRedemption.count).not.toHaveBeenCalled()
    const res = await validar({ code: 'DESC10', customerId: 'c-1' })
    expect(res.body.data).toEqual({ valid: false, error: 'Este cliente ya usó este cupón 1 vez.', errorCode: 'CUSTOMER_LIMIT' })
  })

  it('MIN_PURCHASE: con el total que manda la app', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue(cupon({ minPurchaseAmount: 150 }) as any)
    const res = await validar({ code: 'DESC10', orderTotal: 100 })
    expect(res.body.data).toEqual({ valid: false, error: 'Este cupón pide una compra mínima de $150.00.', errorCode: 'MIN_PURCHASE' })
  })

  it('sin código: 400; un código que no es texto no truena en 500', async () => {
    expect((await validar({})).status).toBe(400)
    expect((await validar({ code: 123 })).status).toBe(400)
  })
})
