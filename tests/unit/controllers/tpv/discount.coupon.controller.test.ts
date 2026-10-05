/**
 * Contrato HTTP del rechazo del cupón en la TPV (Codex B2b r1, REAL P2).
 *
 * La TPV lee SÓLO la llave `error` del 400 del cupón (`avoqado-tpv` `DiscountRepositoryImpl.kt:312`); sin ella muestra
 * «Coupon already applied or invalid» y esconde la causa. Los rechazos que el servicio LANZA (R11 de una cuenta importada,
 * descuento con IVA anterior, orden inexistente) salían por el manejador global, que no pone `error`. Esta prueba fija el sobre
 * completo de la respuesta real, con el manejador global montado.
 */
import express from 'express'
import request from 'supertest'

jest.mock('../../../../src/config/env', () => ({
  ...jest.requireActual('../../../../src/config/env'),
  NODE_ENV: 'production',
}))
jest.mock('@/services/tpv/discount.tpv.service')

import * as controller from '@/controllers/tpv/discount.tpv.controller'
import * as discountTpvService from '@/services/tpv/discount.tpv.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { MENSAJE_ORDEN_IMPORTADA } from '@/services/shared/ordenImportada'
import { globalErrorHandler } from '../../../../src/app'

const applyCouponMock = discountTpvService.applyCouponCode as jest.Mock

function appDeCupon() {
  const app = express()
  app.use(express.json())
  app.post('/venues/:venueId/orders/:orderId/discounts/coupon', (req, _res, next) => {
    ;(req as any).authContext = { venueId: req.params.venueId, userId: 'staff-1', staffVenueId: 'sv-1' }
    next()
  })
  app.post('/venues/:venueId/orders/:orderId/discounts/coupon', controller.applyCouponCode)
  app.use(globalErrorHandler)
  return app
}

const aplicar = () => request(appDeCupon()).post('/venues/v1/orders/o1/discounts/coupon').send({ couponCode: 'PROMO10' })

beforeEach(() => {
  jest.clearAllMocks()
})

describe('POST cupón TPV — rechazos lanzados llevan `error` para la TPV', () => {
  it('R11: una cuenta importada responde 400 con success:false + error = la causa, conservando message/code/details', async () => {
    applyCouponMock.mockRejectedValue(
      new BadRequestError(MENSAJE_ORDEN_IMPORTADA, 'ORDEN_IMPORTADA_DEL_POS', { originSystem: 'POS_SOFTRESTAURANT' }),
    )

    const res = await aplicar()

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      success: false,
      error: MENSAJE_ORDEN_IMPORTADA,
      message: MENSAJE_ORDEN_IMPORTADA,
      code: 'ORDEN_IMPORTADA_DEL_POS',
      details: { originSystem: 'POS_SOFTRESTAURANT' },
    })
  })

  it('cualquier otro 4xx lanzado (descuento con IVA anterior) también trae `error`', async () => {
    applyCouponMock.mockRejectedValue(new BadRequestError('El descuento se aplicó con el IVA anterior.', 'DESCUENTO_CON_IVA_ANTERIOR'))

    const res = await aplicar()

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      success: false,
      error: 'El descuento se aplicó con el IVA anterior.',
      message: 'El descuento se aplicó con el IVA anterior.',
      code: 'DESCUENTO_CON_IVA_ANTERIOR',
    })
  })

  it('404 lanzado conserva su status y trae `error`', async () => {
    applyCouponMock.mockRejectedValue(new NotFoundError('Order not found'))

    const res = await aplicar()

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ success: false, error: 'Order not found', message: 'Order not found' })
  })

  // --- Regresiones: lo que ya funcionaba no cambia ---

  it('un error inesperado (500) sigue por el manejador global, sin `error` ni detalles internos', async () => {
    applyCouponMock.mockRejectedValue(new Error('connection reset by peer'))

    const res = await aplicar()

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ message: 'Ocurrió un error inesperado en el servidor.' })
  })

  it('el rechazo devuelto por el servicio (success:false) sigue igual', async () => {
    applyCouponMock.mockResolvedValue({
      success: false,
      discountName: '',
      amount: 0,
      newOrderTotal: 100,
      error: 'Cannot apply coupon to a paid order',
    })

    const res = await aplicar()

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ success: false, error: 'Cannot apply coupon to a paid order' })
  })

  it('el cupón aplicado sigue respondiendo 200 con el mismo sobre', async () => {
    applyCouponMock.mockResolvedValue({
      success: true,
      couponId: 'c1',
      discountName: 'Promo 10',
      amount: 10,
      newOrderTotal: 90,
    })

    const res = await aplicar()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      success: true,
      data: { couponId: 'c1', discountName: 'Promo 10', amount: 10, newOrderTotal: 90 },
      message: 'Coupon "PROMO10" applied successfully',
    })
    expect(applyCouponMock).toHaveBeenCalledWith('v1', 'o1', 'PROMO10', 'sv-1')
  })
})
