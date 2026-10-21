/**
 * order-table.tpv.controller — ciclo de orden de mesa bajo /tpv (Plan B Task 4, 2026-07-27).
 *
 * Los 4 handlers son wrappers delgados sobre los MISMOS servicios puros que usa
 * /mobile (order.mobile.service.ts / service-charge.mobile.service.ts) — mockeamos
 * esos servicios y verificamos la delegación, no la lógica de negocio (ya probada
 * del lado de /mobile). Lo que SÍ es nuevo y hay que proteger aquí:
 *
 *   1. El staffId SIEMPRE sale de authContext.userId, NUNCA del body — si un
 *      atacante mete su propio staffId en el body, se ignora.
 *   2. 400 en español cuando falta un input requerido que el controller valida
 *      él mismo (sourceOrderId, serviceChargeId) — ver por qué en el controller:
 *      un `undefined` sin validar deja pasar un `where: { id: undefined }` de
 *      Prisma, que matchea CUALQUIER fila del venue en vez de rechazar.
 *   3. La delegación pasa los argumentos en el orden EXACTO que esperan los
 *      servicios puros: (venueId, orderId, <input>, staffId).
 */
import { BadRequestError, ConflictError } from '@/errors/AppError'
import * as controller from '@/controllers/tpv/order-table.tpv.controller'
import * as orderMobileService from '@/services/mobile/order.mobile.service'
import * as serviceChargeMobileService from '@/services/mobile/service-charge.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/mobile/order.mobile.service')
jest.mock('@/services/mobile/service-charge.mobile.service')
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

const mockRes = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}

const splitOrderItemsMock = orderMobileService.splitOrderItems as jest.Mock
const splitOrderBySeatMock = orderMobileService.splitOrderBySeat as jest.Mock
const mergeOrdersMock = orderMobileService.mergeOrdersInTransaction as jest.Mock
const cancelOrderMock = orderMobileService.cancelOrderInTransaction as jest.Mock
const applyServiceChargeMock = serviceChargeMobileService.applyServiceCharge as jest.Mock
const publishMergedOrdersMock = orderMobileService.publishMergedOrders as jest.Mock
const publishCancelledOrderMock = orderMobileService.publishCancelledOrder as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  let committed = false
  prismaMock.$transaction.mockImplementation(async (callback: any) => {
    const result = await callback(prismaMock)
    committed = true
    return result
  })
  publishMergedOrdersMock.mockImplementation(async () => {
    expect(committed).toBe(true)
  })
  publishCancelledOrderMock.mockImplementation(async () => {
    expect(committed).toBe(true)
  })
})

describe('order-table.tpv.controller — splitOrder', () => {
  // NEW FEATURE TESTS
  it('pasa el staffId del authContext, NO el del body', async () => {
    splitOrderItemsMock.mockResolvedValue({ id: 'nueva-orden' })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: { itemIds: ['item-1'], staffId: 'ATACANTE' },
      authContext: { venueId: 'venue-a', userId: 'staff-real' },
    }

    await controller.splitOrder(req, mockRes())

    expect(splitOrderItemsMock).toHaveBeenCalledWith('venue-a', 'orden-1', ['item-1'], 'staff-real')
  })

  it('delega los argumentos en el orden exacto (venueId, orderId, itemIds, staffId)', async () => {
    splitOrderItemsMock.mockResolvedValue({ id: 'nueva-orden' })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: { itemIds: ['item-1', 'item-2'] },
      authContext: { userId: 'staff-real' },
    }

    await controller.splitOrder(req, mockRes())

    expect(splitOrderItemsMock).toHaveBeenCalledTimes(1)
    expect(splitOrderItemsMock.mock.calls[0]).toEqual(['venue-a', 'orden-1', ['item-1', 'item-2'], 'staff-real'])
  })

  it('responde 200 con la data del servicio', async () => {
    splitOrderItemsMock.mockResolvedValue({ source: { id: 'orden-1' }, created: { id: 'orden-2' } })
    const req: any = { params: { venueId: 'v', orderId: 'o' }, body: { itemIds: ['i'] }, authContext: { userId: 's' } }
    const res = mockRes()

    await controller.splitOrder(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { source: { id: 'orden-1' }, created: { id: 'orden-2' } } })
  })

  it('responde 400 en español cuando el servicio rechaza itemIds ausente (sin duplicar el guard)', async () => {
    splitOrderItemsMock.mockRejectedValue(new BadRequestError('itemIds es requerido'))
    const req: any = { params: { venueId: 'v', orderId: 'o' }, body: {}, authContext: { userId: 's' } }
    const res = mockRes()

    await controller.splitOrder(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: 'itemIds es requerido' }))
  })

  // REGRESSION TEST — el controller no debe explotar si authContext falta userId
  it('propaga staffId undefined si authContext no trae userId (no revienta)', async () => {
    splitOrderItemsMock.mockResolvedValue({})
    const req: any = { params: { venueId: 'v', orderId: 'o' }, body: { itemIds: ['i'] }, authContext: {} }

    await controller.splitOrder(req, mockRes())

    expect(splitOrderItemsMock).toHaveBeenCalledWith('v', 'o', ['i'], undefined)
  })
})

describe('order-table.tpv.controller — splitOrderBySeat', () => {
  it('pasa el staffId del authContext, NO el del body', async () => {
    splitOrderBySeatMock.mockResolvedValue({ source: {}, created: [] })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: { staffId: 'ATACANTE' },
      authContext: { userId: 'staff-real' },
    }

    await controller.splitOrderBySeat(req, mockRes())

    expect(splitOrderBySeatMock).toHaveBeenCalledWith('venue-a', 'orden-1', 'staff-real')
  })

  it('responde 400 en español cuando el servicio rechaza (menos de 2 asientos)', async () => {
    splitOrderBySeatMock.mockRejectedValue(new BadRequestError('Se necesitan al menos dos asientos con artículos para dividir por puesto'))
    const req: any = { params: { venueId: 'v', orderId: 'o' }, body: {}, authContext: { userId: 's' } }
    const res = mockRes()

    await controller.splitOrderBySeat(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringContaining('asientos') }))
  })
})

describe('order-table.tpv.controller — mergeOrders', () => {
  it('pasa el staffId del authContext, NO el del body', async () => {
    mergeOrdersMock.mockResolvedValue({ data: { id: 'orden-destino' }, tpvTableFreed: false })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-destino' },
      body: { sourceOrderId: 'orden-origen', staffId: 'ATACANTE' },
      authContext: { userId: 'staff-real' },
    }

    await controller.mergeOrders(req, mockRes())

    expect(mergeOrdersMock).toHaveBeenCalledWith(prismaMock, 'venue-a', 'orden-destino', 'orden-origen', 'staff-real')
  })

  it('delega los argumentos en el orden exacto (venueId, targetOrderId, sourceOrderId, staffId)', async () => {
    mergeOrdersMock.mockResolvedValue({ data: {}, tpvTableFreed: false })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-destino' },
      body: { sourceOrderId: 'orden-origen' },
      authContext: { userId: 'staff-real' },
    }

    await controller.mergeOrders(req, mockRes())

    expect(mergeOrdersMock.mock.calls[0]).toEqual([prismaMock, 'venue-a', 'orden-destino', 'orden-origen', 'staff-real'])
  })

  // 🔴 El guard importante: sourceOrderId ausente se rechaza EN EL CONTROLLER,
  // antes de tocar el servicio — un `undefined` sin validar dejaría que Prisma
  // matcheara cualquier orden del venue (ver comentario en el controller).
  it('responde 400 en español cuando falta sourceOrderId, y NUNCA llama al servicio', async () => {
    const req: any = { params: { venueId: 'v', orderId: 'o' }, body: {}, authContext: { userId: 's' } }
    const res = mockRes()

    await controller.mergeOrders(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'sourceOrderId es requerido' })
    expect(mergeOrdersMock).not.toHaveBeenCalled()
  })

  it('responde 400 en español cuando sourceOrderId no es un string (p.ej. un array), y NUNCA llama al servicio', async () => {
    const req: any = { params: { venueId: 'v', orderId: 'o' }, body: { sourceOrderId: ['x'] }, authContext: { userId: 's' } }
    const res = mockRes()

    await controller.mergeOrders(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mergeOrdersMock).not.toHaveBeenCalled()
  })

  // The single transaction returns the legacy TPV value; only delivery runs after commit.
  it('uses the captured TPV tableFreed after one transaction and publishes the typed merge result', async () => {
    mergeOrdersMock.mockResolvedValue({
      data: { target: { id: 't' }, merged: { id: 'orden-origen' }, tableFreed: false },
      tpvTableFreed: true,
    })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-destino' },
      body: { sourceOrderId: 'orden-origen' },
      authContext: { userId: 'staff-real' },
    }
    const res = mockRes()

    await controller.mergeOrders(req, res)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(publishMergedOrdersMock).toHaveBeenCalledWith('venue-a', await mergeOrdersMock.mock.results[0].value, 'staff-real')
    // TPV preserves its captured own-table boolean, distinct from the shared DTO.
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { target: { id: 't' }, merged: { id: 'orden-origen' }, tableFreed: true },
    })
  })

  it('never lets a publication failure turn an already-committed merge into a 500 — retains captured tableFreed', async () => {
    mergeOrdersMock.mockResolvedValue({
      data: { target: { id: 't' }, merged: { id: 'orden-origen' }, tableFreed: false },
      tpvTableFreed: false,
    })
    publishMergedOrdersMock.mockRejectedValue(new Error('Delivery blip'))
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-destino' },
      body: { sourceOrderId: 'orden-origen' },
      authContext: { userId: 'staff-real' },
    }
    const res = mockRes()

    await controller.mergeOrders(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { target: { id: 't' }, merged: { id: 'orden-origen' }, tableFreed: false },
    })
  })
})

describe('order-table.tpv.controller — cancelOrder', () => {
  it('pasa el staffId del authContext, NO el del body', async () => {
    cancelOrderMock.mockResolvedValue({ tpvTableFreed: false })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: { reason: 'Cliente se fue', staffId: 'ATACANTE' },
      authContext: { userId: 'staff-real' },
    }

    await controller.cancelOrder(req, mockRes())

    expect(cancelOrderMock).toHaveBeenCalledWith(prismaMock, 'venue-a', 'orden-1', 'Cliente se fue', 'staff-real')
  })

  it('delega los argumentos en el orden exacto (venueId, orderId, reason, staffId)', async () => {
    cancelOrderMock.mockResolvedValue({ tpvTableFreed: false })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: { reason: 'Cliente se fue' },
      authContext: { userId: 'staff-real' },
    }

    await controller.cancelOrder(req, mockRes())

    expect(cancelOrderMock.mock.calls[0]).toEqual([prismaMock, 'venue-a', 'orden-1', 'Cliente se fue', 'staff-real'])
  })

  it('pasa reason undefined (no un string vacío ni null) cuando el body no trae reason', async () => {
    cancelOrderMock.mockResolvedValue({ tpvTableFreed: false })
    const req: any = { params: { venueId: 'v', orderId: 'o' }, body: {}, authContext: { userId: 's' } }

    await controller.cancelOrder(req, mockRes())

    expect(cancelOrderMock).toHaveBeenCalledWith(prismaMock, 'v', 'o', undefined, 's')
  })

  it('responde 400 en español cuando el servicio rechaza (p.ej. cuenta ya pagada)', async () => {
    cancelOrderMock.mockRejectedValue(new BadRequestError('Cannot cancel a paid order'))
    const req: any = { params: { venueId: 'v', orderId: 'o' }, body: {}, authContext: { userId: 's' } }
    const res = mockRes()

    await controller.cancelOrder(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: 'Cannot cancel a paid order' }))
    // A rejected transaction never publishes a successful cancellation.
    expect(publishCancelledOrderMock).not.toHaveBeenCalled()
  })

  // Cancellation publishes the captured result after its one transaction commits.
  it('uses the captured TPV tableFreed after one transaction and publishes the typed cancellation result', async () => {
    cancelOrderMock.mockResolvedValue({ tpvTableFreed: false })
    cancelOrderMock.mockResolvedValue({ tpvTableFreed: true })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: { reason: 'Cliente se fue' },
      authContext: { userId: 'staff-real' },
    }
    const res = mockRes()

    await controller.cancelOrder(req, res)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(publishCancelledOrderMock).toHaveBeenCalledWith('venue-a', { tpvTableFreed: true }, 'staff-real', 'Cliente se fue')
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { tableFreed: true } })
  })

  it('never lets a publication failure turn an already-committed cancel into a 500 — retains captured tableFreed', async () => {
    cancelOrderMock.mockResolvedValue({ tpvTableFreed: false })
    publishCancelledOrderMock.mockRejectedValue(new Error('Delivery blip'))
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: {},
      authContext: { userId: 'staff-real' },
    }
    const res = mockRes()

    await controller.cancelOrder(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { tableFreed: false } })
  })
})

// Diseño §C.6: las rutas /tpv devuelven `code` y `details` de forma ADITIVA cuando el error de dominio los trae. Antes
// los descartaban y la TPV recibía un 409 mudo; un error sin código sigue saliendo byte a byte igual.
describe('order-table.tpv.controller — code y details aditivos en el cuerpo de error', () => {
  beforeEach(() => jest.clearAllMocks())

  it('cancelOrder: el 409 de un cobro vivo llega con su código y el requestId que bloquea', async () => {
    cancelOrderMock.mockRejectedValue(
      new ConflictError('Hay un cobro en curso', 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE', { requestId: 'REQ-1' }),
    )
    const res = mockRes()

    await controller.cancelOrder({ params: { venueId: 'v', orderId: 'o' }, body: {}, authContext: { userId: 's' } } as any, res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Hay un cobro en curso',
      code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE',
      details: { requestId: 'REQ-1' },
    })
  })

  it('mergeOrders: el 409 del origen trae requestId y orderId', async () => {
    mergeOrdersMock.mockRejectedValue(
      new ConflictError('La cuenta origen tiene un cobro en curso', 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE', {
        requestId: 'REQ-2',
        orderId: 'origen',
      }),
    )
    const res = mockRes()

    await controller.mergeOrders(
      { params: { venueId: 'v', orderId: 'destino' }, body: { sourceOrderId: 'origen' }, authContext: { userId: 's' } } as any,
      res,
    )

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE', details: { requestId: 'REQ-2', orderId: 'origen' } }),
    )
  })

  it('un error de dominio SIN código sale exactamente como antes: { success, message }', async () => {
    cancelOrderMock.mockRejectedValue(new BadRequestError('Cannot cancel a paid order'))
    const res = mockRes()

    await controller.cancelOrder({ params: { venueId: 'v', orderId: 'o' }, body: {}, authContext: { userId: 's' } } as any, res)

    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Cannot cancel a paid order' })
  })

  it('el `code` de un error de Prisma NO se filtra al cuerpo (no es contrato)', async () => {
    cancelOrderMock.mockRejectedValue(Object.assign(new Error('Transaction already closed'), { code: 'P2028' }))
    const res = mockRes()

    await controller.cancelOrder({ params: { venueId: 'v', orderId: 'o' }, body: {}, authContext: { userId: 's' } } as any, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Transaction already closed' })
  })
})

describe('order-table.tpv.controller — applyServiceCharge', () => {
  it('pasa el staffId del authContext, NO el del body', async () => {
    applyServiceChargeMock.mockResolvedValue({ total: 150 })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: { serviceChargeId: 'sc-1', staffId: 'ATACANTE' },
      authContext: { userId: 'staff-real' },
    }

    await controller.applyServiceCharge(req, mockRes())

    expect(applyServiceChargeMock).toHaveBeenCalledWith('venue-a', 'orden-1', 'sc-1', 'staff-real')
  })

  it('delega los argumentos en el orden exacto (venueId, orderId, serviceChargeId, staffId)', async () => {
    applyServiceChargeMock.mockResolvedValue({})
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: { serviceChargeId: 'sc-1' },
      authContext: { userId: 'staff-real' },
    }

    await controller.applyServiceCharge(req, mockRes())

    expect(applyServiceChargeMock.mock.calls[0]).toEqual(['venue-a', 'orden-1', 'sc-1', 'staff-real'])
  })

  // 🔴 Mismo guard que mergeOrders: serviceChargeId ausente se rechaza EN EL
  // CONTROLLER, antes de tocar el servicio.
  it('responde 400 en español cuando falta serviceChargeId, y NUNCA llama al servicio', async () => {
    const req: any = { params: { venueId: 'v', orderId: 'o' }, body: {}, authContext: { userId: 's' } }
    const res = mockRes()

    await controller.applyServiceCharge(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'serviceChargeId es requerido' })
    expect(applyServiceChargeMock).not.toHaveBeenCalled()
  })
})
