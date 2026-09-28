/**
 * M-2 (full-testing 27-sep): los 3 handlers NUEVOS de la fase 3 (listRecentKdsOrders, recallKdsOrder,
 * bumpKdsOrdersBatch) hacían `logger.error` de CUALQUIER fallo, incluido el 404 esperado de «no hay
 * comanda terminada». El manejador global ya registra los 4xx como `warn` (`logControllerError`);
 * duplicarlo a `error` hace que un rechazo esperado suene como una caída real.
 */
import type { NextFunction, Request, Response } from 'express'

import { bumpKdsOrdersBatch, listRecentKdsOrders, recallKdsOrder } from '@/controllers/mobile/kds.mobile.controller'
import * as kdsService from '@/services/mobile/kds.mobile.service'
import logger from '@/config/logger'
import { NotFoundError } from '@/errors/AppError'

jest.mock('@/services/mobile/kds.mobile.service', () => ({
  KDS_BUMP_BATCH_MAX: 100,
  listRecentKdsOrders: jest.fn(),
  recallKdsOrder: jest.fn(),
  bumpKdsOrdersBatch: jest.fn(),
}))

const recallMock = kdsService.recallKdsOrder as unknown as jest.Mock
const recentMock = kdsService.listRecentKdsOrders as unknown as jest.Mock
const batchMock = kdsService.bumpKdsOrdersBatch as unknown as jest.Mock
const errorLog = logger.error as jest.Mock
const warnLog = logger.warn as jest.Mock

function respuesta() {
  const res = { status: jest.fn(), json: jest.fn() }
  res.status.mockReturnValue(res)
  return res
}

beforeEach(() => {
  recallMock.mockReset()
  recentMock.mockReset()
  batchMock.mockReset()
  errorLog.mockClear()
  warnLog.mockClear()
})

describe('recall que lanza un 404 esperado NO suena como caída real', () => {
  it('next(error) recibe el NotFoundError y logger.error NO se llama', async () => {
    const notFound = new NotFoundError('No hay una comanda terminada con ese id para regresar')
    recallMock.mockRejectedValue(notFound)
    const req = { params: { venueId: 'v1', id: 'k1' } } as unknown as Request
    const res = respuesta()
    const next = jest.fn() as unknown as NextFunction

    await recallKdsOrder(req, res as unknown as Response, next)

    expect(next).toHaveBeenCalledWith(notFound)
    expect(errorLog).not.toHaveBeenCalled()
  })

  // Regresión: una excepción de verdad (no un AppError 4xx) sigue sonando como error.
  it('un fallo inesperado en recall SÍ se registra como error', async () => {
    const falla = new TypeError('boom')
    recallMock.mockRejectedValue(falla)
    const req = { params: { venueId: 'v1', id: 'k1' } } as unknown as Request
    const res = respuesta()
    const next = jest.fn() as unknown as NextFunction

    await recallKdsOrder(req, res as unknown as Response, next)

    expect(next).toHaveBeenCalledWith(falla)
    expect(errorLog).toHaveBeenCalledTimes(1)
  })

  it('listRecentKdsOrders: un 404 esperado tampoco suena como caída real', async () => {
    const notFound = new NotFoundError('sin comandas recientes')
    recentMock.mockRejectedValue(notFound)
    const req = { params: { venueId: 'v1' }, query: {} } as unknown as Request
    const res = respuesta()
    const next = jest.fn() as unknown as NextFunction

    await listRecentKdsOrders(req, res as unknown as Response, next)

    expect(next).toHaveBeenCalledWith(notFound)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('bumpKdsOrdersBatch: un rechazo 4xx del servicio tampoco suena como caída real', async () => {
    const notFound = new NotFoundError('comanda no encontrada')
    batchMock.mockRejectedValue(notFound)
    const req = { params: { venueId: 'v1' }, body: { ids: ['k1'] } } as unknown as Request
    const res = respuesta()
    const next = jest.fn() as unknown as NextFunction

    await bumpKdsOrdersBatch(req, res as unknown as Response, next)

    expect(next).toHaveBeenCalledWith(notFound)
    expect(errorLog).not.toHaveBeenCalled()
  })
})
