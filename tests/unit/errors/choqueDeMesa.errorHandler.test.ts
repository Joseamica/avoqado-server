import express from 'express'
import { api, startApiServer } from '../../__helpers__/apiServer'

jest.mock('../../../src/config/env', () => ({
  ...jest.requireActual('../../../src/config/env'),
  NODE_ENV: 'production',
}))

import { globalErrorHandler } from '../../../src/app'
import { OrderTableTopologyChanged } from '../../../src/services/shared/tableOrderLock'

/**
 * D9 (26-oct): `OrderTableTopologyChanged` (la cuenta o la mesa cambiaron en el mismo instante; se resuelve reintentando)
 * no es un AppError y por las rutas sin protocolo de operación salía como 500 anónimo. Se responde 503 con su código:
 * - ANDROID: la cancelación durable trata 5xx como «reintenta» (un 409 la haría rendirse,
 *   `OrderRepository.leerCancelacionDeOrden`) y anular cuenta de mesa encola un 503. iOS 1.13+ no lo encola: enseña el texto
 *   y el mesero reintenta (Codex D9 r1 #2). Las rutas que responden `error.statusCode || 500` dan 503 por la clase misma.
 * - Sin `Retry-After`: OkHttp reenvía solo un 503 con `Retry-After: 0` (memoria del F2 de cliente postventa).
 */
describe('choque de cuenta o mesa en el manejador general', () => {
  const app = express()
  beforeAll(() => {
    app.delete('/orden', () => {
      throw new OrderTableTopologyChanged()
    })
    app.use(globalErrorHandler)
  })
  startApiServer(() => app)

  it('responde 503 con su código y un texto en español, sin Retry-After', async () => {
    const res = await api().delete('/orden')

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ code: 'ORDER_TABLE_TOPOLOGY_CHANGED' })
    expect(res.body.message).toMatch(/Intenta de nuevo/)
    expect(res.headers['retry-after']).toBeUndefined()
  })

  it('sigue siendo la misma clase, para la cola sin red y el protocolo de operación', () => {
    expect(new OrderTableTopologyChanged()).toBeInstanceOf(OrderTableTopologyChanged)
    expect(new OrderTableTopologyChanged().message).toBe('ORDER_TABLE_TOPOLOGY_CHANGED')
  })
})
