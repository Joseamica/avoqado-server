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
jest.mock('@/middlewares/cortesiaPidePermiso.middleware', () => {
  const tieneCortesiaAutorizada = jest.fn(() => false)
  const pinDeLaCortesia = jest.fn(() => undefined)
  return {
    ...jest.requireActual('@/middlewares/cortesiaPidePermiso.middleware'),
    tieneCortesiaAutorizada,
    pinDeLaCortesia,
    // hz:e0b12f00:D1: el controlador manual pasa por `conCortesiaSiRegala`; su primera vuelta lleva la acreditación del request.
    conCortesiaSiRegala: jest.fn((req: any, _res: any, operacion: (c: any) => Promise<unknown>) =>
      operacion((tieneCortesiaAutorizada as jest.Mock)(req) ? { porPin: (pinDeLaCortesia as jest.Mock)(req) } : undefined),
    ),
  }
})
jest.mock('@/middlewares/permissionFlag.middleware', () => ({
  ...jest.requireActual('@/middlewares/permissionFlag.middleware'),
  tienePermisoEnVenue: jest.fn(),
}))

import * as controller from '@/controllers/tpv/discount.tpv.controller'
import * as discountTpvService from '@/services/tpv/discount.tpv.service'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/errors/AppError'
import { MENSAJE_ORDEN_IMPORTADA } from '@/services/shared/ordenImportada'
import { globalErrorHandler } from '../../../../src/app'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { pinDeLaCortesia, tieneCortesiaAutorizada } from '@/middlewares/cortesiaPidePermiso.middleware'

const applyCouponMock = discountTpvService.applyCouponCode as jest.Mock
const permisoMock = tienePermisoEnVenue as jest.Mock
const membresiaMock = discountTpvService.membresiaDeQuienLlama as jest.Mock

function appDeCupon() {
  const app = express()
  app.use(express.json())
  app.post('/venues/:venueId/orders/:orderId/discounts/coupon', (req, _res, next) => {
    ;(req as any).authContext = { venueId: req.params.venueId, userId: 'staff-1' }
    next()
  })
  app.post('/venues/:venueId/orders/:orderId/discounts/coupon', controller.applyCouponCode)
  app.use(globalErrorHandler)
  return app
}

const aplicar = () => request(appDeCupon()).post('/venues/v1/orders/o1/discounts/coupon').send({ couponCode: 'PROMO10' })

beforeEach(() => {
  jest.clearAllMocks()
  permisoMock.mockResolvedValue(false)
  // D3: la sesión real de la TPV no trae `staffVenueId`; el controlador lo resuelve por usuario + negocio.
  membresiaMock.mockImplementation(async (venueId: string, userId?: string) =>
    venueId === 'v1' && userId === 'staff-1' ? 'sv-1' : undefined,
  )
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
      error: 'Esta cuenta ya está pagada y ya no admite cupones. Si cobraste de más, reembolsa la diferencia.',
    })

    const res = await aplicar()

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      success: false,
      error: 'Esta cuenta ya está pagada y ya no admite cupones. Si cobraste de más, reembolsa la diferencia.',
    })
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
    expect(applyCouponMock).toHaveBeenCalledWith('v1', 'o1', 'PROMO10', 'sv-1', false, 'staff-1')
  })

  // D14: el servicio decide si el cupón regala; el controlador le pasa si QUIEN LLAMA tiene `orders:comp`.
  it('D14: pasa al servicio el permiso de cortesía de quien llama', async () => {
    permisoMock.mockResolvedValue(true)
    applyCouponMock.mockResolvedValue({ success: true, couponId: 'c1', discountName: 'Cortesía', amount: 100, newOrderTotal: 10 })

    await aplicar()

    expect(permisoMock).toHaveBeenCalledWith(expect.anything(), 'orders:comp')
    expect(applyCouponMock).toHaveBeenCalledWith('v1', 'o1', 'PROMO10', 'sv-1', true, 'staff-1')
  })

  it('D14: el 403 de cortesía llega a la TPV con su texto en `error`', async () => {
    applyCouponMock.mockRejectedValue(new ForbiddenError('No tienes permiso para dar cortesías'))

    const res = await aplicar()

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ success: false, error: 'No tienes permiso para dar cortesías' })
  })
})

// D1 (hz:f34960c5:D1): el controlador de la TPV pasa al servicio lo que acreditó `checkCortesiaEnDescuento` en ESTE request.
describe('D1: descuento predefinido y manual de la TPV reciben la acreditación de cortesía', () => {
  const manualMock = discountTpvService.applyManualDiscount as jest.Mock
  const predefinidoMock = discountTpvService.applyPredefinedDiscount as jest.Mock
  const acreditado = tieneCortesiaAutorizada as jest.Mock
  function app(auth: Record<string, unknown>) {
    const a = express()
    a.use(express.json())
    a.use((req, _res, next) => {
      ;(req as any).authContext = { venueId: 'v1', ...auth }
      next()
    })
    a.post('/venues/:venueId/orders/:orderId/discounts/manual', controller.applyManualDiscount)
    a.post('/venues/:venueId/orders/:orderId/discounts/apply', controller.applyPredefinedDiscount)
    a.use(globalErrorHandler)
    return a
  }
  beforeEach(() => {
    manualMock.mockResolvedValue({ success: true, amount: 100, newOrderTotal: 10 })
    predefinidoMock.mockResolvedValue({ success: true, amount: 100, newOrderTotal: 10 })
  })

  it('manual con cortesía acreditada y PIN: pasa el usuario y quien tecleó el PIN', async () => {
    acreditado.mockReturnValue(true)
    ;(pinDeLaCortesia as jest.Mock).mockReturnValueOnce('sv-gerente')
    await request(app({ userId: 'u-cajera', overrideAuthorizedBy: 'sv-gerente' }))
      .post('/venues/v1/orders/o1/discounts/manual')
      .send({ type: 'COMP', value: 100, reason: 'Invitación', authorizedById: 'id-inventado' })
    expect(manualMock).toHaveBeenCalledWith(
      'v1',
      'o1',
      'COMP',
      100,
      'Invitación',
      undefined,
      'id-inventado',
      { porPin: 'sv-gerente' },
      'u-cajera',
    )
  })

  it('manual sin acreditación: el servicio no recibe cortesía', async () => {
    acreditado.mockReturnValue(false)
    await request(app({ userId: 'u-cajera' }))
      .post('/venues/v1/orders/o1/discounts/manual')
      .send({ type: 'COMP', value: 100, reason: 'x' })
    expect(manualMock.mock.calls[0][7]).toBeUndefined()
  })

  // D2 (hz:f34960c5:D2): la aprobación sale del permiso comprobado en el request (PIN de gerente incluido), nunca del cuerpo.
  it('predefinido acreditado con PIN: pasa quien tecleó el PIN, no el authorizedById del cuerpo', async () => {
    acreditado.mockReturnValue(true)
    ;(pinDeLaCortesia as jest.Mock).mockReturnValueOnce('sv-gerente')
    await request(app({ userId: 'u-cajera', overrideAuthorizedBy: 'sv-gerente' }))
      .post('/venues/v1/orders/o1/discounts/apply')
      .send({ discountId: 'd-comp', authorizedById: 'id-inventado' })
    expect(predefinidoMock).toHaveBeenCalledWith('v1', 'o1', 'd-comp', undefined, { porPin: 'sv-gerente' })
  })

  it('D2: predefinido sin acreditación: el authorizedById del cuerpo no llega al servicio', async () => {
    acreditado.mockReturnValue(false)
    await request(app({ userId: 'u-cajera' }))
      .post('/venues/v1/orders/o1/discounts/apply')
      .send({ discountId: 'd-aprobar', authorizedById: 'id-inventado' })
    expect(predefinidoMock).toHaveBeenCalledWith('v1', 'o1', 'd-aprobar', undefined, undefined)
  })

  // D3 (hz:f34960c5:D3): con la sesión real (sin `staffVenueId`), el servicio recibe la membresía de quien llama.
  it('D3: manual y predefinido pasan la membresía resuelta por usuario + negocio', async () => {
    acreditado.mockReturnValue(false)
    await request(app({ userId: 'staff-1' }))
      .post('/venues/v1/orders/o1/discounts/manual')
      .send({ type: 'PERCENTAGE', value: 10, reason: 'x' })
    await request(app({ userId: 'staff-1' }))
      .post('/venues/v1/orders/o1/discounts/apply')
      .send({ discountId: 'd1' })
    expect(membresiaMock).toHaveBeenCalledWith('v1', 'staff-1')
    expect(manualMock.mock.calls[0][5]).toBe('sv-1')
    expect(predefinidoMock.mock.calls[0][3]).toBe('sv-1')
  })

  // hz:f34960c5:D5: la bitácora del manual va a nombre de la sesión (Staff.id); el servicio la recibe del controlador.
  it('D5: manual pasa el usuario de la sesión para la bitácora', async () => {
    acreditado.mockReturnValue(false)
    await request(app({ userId: 'staff-1' }))
      .post('/venues/v1/orders/o1/discounts/manual')
      .send({ type: 'PERCENTAGE', value: 10, reason: 'x', staffId: 'otro-vendedor' })
    expect(manualMock.mock.calls[0][8]).toBe('staff-1')
  })
})
