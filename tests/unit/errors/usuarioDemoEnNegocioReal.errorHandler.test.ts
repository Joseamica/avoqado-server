import express from 'express'
import { api, startApiServer } from '../../__helpers__/apiServer'

jest.mock('../../../src/config/env', () => ({
  ...jest.requireActual('../../../src/config/env'),
  NODE_ENV: 'production',
}))

import { globalErrorHandler } from '../../../src/app'
import { BadRequestError } from '../../../src/errors/AppError'
import { esUsuarioDemoEnNegocioReal, USUARIO_DEMO_EN_NEGOCIO_REAL } from '../../../src/services/demo/candadoDemo'

/**
 * hz:f26b3afc:D5: la base rechaza que un usuario demo (contraseña pública) quede en un negocio real. El trigger lanza P0001
 * con el código en el texto; quien lo intenta (el SUPERADMIN, el panel) ve un 400 claro, nunca un 500 anónimo.
 */
const deModelo = () =>
  new Error(
    `Error occurred during query execution:\nConnectorError(... PostgresError { code: "P0001", message: "${USUARIO_DEMO_EN_NEGOCIO_REAL}", severity: "ERROR" ...`,
  )
const deSqlCrudo = () =>
  Object.assign(new Error('Raw query failed.'), {
    code: 'P2010',
    meta: { code: 'P0001', message: `ERROR: ${USUARIO_DEMO_EN_NEGOCIO_REAL}` },
  })

describe('reconocer el rechazo de la base', () => {
  it('por las dos formas en que llega: un modelo de Prisma o SQL crudo', () => {
    expect(esUsuarioDemoEnNegocioReal(deModelo())).toBe(true)
    expect(esUsuarioDemoEnNegocioReal(deSqlCrudo())).toBe(true)
  })

  it('no confunde un error que sólo MENCIONA el código, ni un AppError', () => {
    expect(esUsuarioDemoEnNegocioReal(new Error(`la categoría ${USUARIO_DEMO_EN_NEGOCIO_REAL}`))).toBe(false)
    expect(esUsuarioDemoEnNegocioReal(new BadRequestError(USUARIO_DEMO_EN_NEGOCIO_REAL))).toBe(false)
    expect(esUsuarioDemoEnNegocioReal(Object.assign(new Error('x'), { code: 'P2010', meta: { code: 'P0001', message: 'otro' } }))).toBe(
      false,
    )
    expect(esUsuarioDemoEnNegocioReal(null)).toBe(false)
  })
})

describe('en el manejador general', () => {
  const app = express()
  beforeAll(() => {
    app.post('/asignar', () => {
      throw deModelo()
    })
    app.use(globalErrorHandler)
  })
  startApiServer(() => app)

  it('🔴 responde 400 con su código y un texto en español', async () => {
    const res = await api().post('/asignar')

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: USUARIO_DEMO_EN_NEGOCIO_REAL })
    expect(res.body.message).toMatch(/demostración/)
  })
})
