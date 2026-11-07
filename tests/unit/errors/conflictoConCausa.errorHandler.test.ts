import express from 'express'
import { api, startApiServer } from '../../__helpers__/apiServer'

jest.mock('../../../src/config/env', () => ({
  ...jest.requireActual('../../../src/config/env'),
  NODE_ENV: 'production',
}))

import { globalErrorHandler } from '../../../src/app'
import { withSerializableRetry } from '../../../src/utils/serializableRetry'
import { prismaMock } from '../../__helpers__/setup'

/**
 * S5b (R74, r7 #2): el `ConflictError` que `withSerializableRetry` lanza al agotarse lleva `cause` = el error de la base (lo lee la
 * prueba de X11). La respuesta HTTP no cambia: el mismo 409, el mismo mensaje y ningún rastro de la causa (ni código de Postgres,
 * ni el texto de Prisma con la consulta).
 */
describe('ConflictError con causa en el manejador general', () => {
  const app = express()
  beforeAll(() => {
    app.post('/traba', async () => {
      await withSerializableRetry(async () => undefined, { reintentarInterbloqueo: true, maxRetries: 1, baseDelayMs: 0 })
    })
    app.use(globalErrorHandler)
  })
  startApiServer(() => app)

  it('responde el 409 de hoy, sin `cause` ni detalle de la base', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('Invalid `prisma.discount.update()` invocation: PostgresError { code: "40P01" }'), {
        code: 'P2010',
        meta: { code: '40P01' },
      }),
    )

    const res = await api().post('/traba')

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ message: 'Conflicto de concurrencia persistente, por favor intente de nuevo' })
    expect(JSON.stringify(res.body)).not.toMatch(/40P01|prisma|cause/i)
  })
})
