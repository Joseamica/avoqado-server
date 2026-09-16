import express from 'express'
import request from 'supertest'

jest.mock('../../../src/config/env', () => ({
  ...jest.requireActual('../../../src/config/env'),
  NODE_ENV: 'production',
}))

import { ConflictError } from '../../../src/errors/AppError'
import { globalErrorHandler } from '../../../src/app'
import { AFILIACION_EN_VARIOS_SLOTS } from '../../../src/services/shared/slotsDeAfiliacion'

describe('AppError recoverable details', () => {
  it('keeps a stable 409 code and structured recovery details', () => {
    const error = new ConflictError('La duración cambió', 'APPOINTMENT_WINDOW_CHANGED', {
      expectedBaseDurationMin: 60,
      expectedBaseEndsAt: '2026-07-21T18:00:00.000Z',
    })

    expect(error).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_WINDOW_CHANGED' })
    expect(error.details).toEqual({
      expectedBaseDurationMin: 60,
      expectedBaseEndsAt: '2026-07-21T18:00:00.000Z',
    })
  })

  it('serializes only the whitelisted production envelope through the global handler', async () => {
    const app = express()
    app.get('/conflict', () => {
      throw new ConflictError('La duración cambió', 'APPOINTMENT_WINDOW_CHANGED', {
        expectedBaseDurationMin: 60,
        expectedBaseEndsAt: '2026-07-21T18:00:00.000Z',
      })
    })
    app.use(globalErrorHandler)

    const response = await request(app).get('/conflict')

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      message: 'La duración cambió',
      code: 'APPOINTMENT_WINDOW_CHANGED',
      details: {
        expectedBaseDurationMin: 60,
        expectedBaseEndsAt: '2026-07-21T18:00:00.000Z',
      },
    })
  })

  // Codex R12-2: el CHECK `*PaymentConfig_slots_distintos` es el respaldo de concurrencia de los escritores de slots. Cuando
  // dispara (o cuando un escritor no validó antes), Prisma lo envuelve en un error crudo que el handler traduce UNA sola vez, para
  // TODOS los escritores HTTP, al mismo 400 + código que devuelven los que sí validan — nunca un 500 anónimo (CI 16-sep-2026).
  it('translates the slots-distintos CHECK violation into the same 400 + code the writers use, with the production envelope', async () => {
    const app = express()
    app.get('/slots', () => {
      throw new Error(
        'Invalid `prisma.venuePaymentConfig.update()` invocation:\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"VenuePaymentConfig\\" violates check constraint \\"VenuePaymentConfig_slots_distintos\\"", severity: "ERROR", detail: Some("Failing row contains (a, b, m, m, null, {}, AUTO, 2026-09-16 03:04:11.422, 2026-09-16 03:04:11.567)."), column: None, hint: None }), transient: false })',
      )
    })
    app.get('/otro-check', () => {
      throw new Error(
        'PostgresError { code: "23514", message: "new row for relation \\"Shift\\" violates check constraint \\"Shift_status_endTime\\"" }',
      )
    })
    app.use(globalErrorHandler)

    const traducida = await request(app).get('/slots')
    expect(traducida.status).toBe(400)
    expect(traducida.body).toEqual({
      message: 'Una afiliación no puede ocupar dos slots a la vez.',
      code: AFILIACION_EN_VARIOS_SLOTS,
    })

    // Cualquier otro CHECK sigue siendo un error inesperado: 500 con el sobre de producción, sin filtrar el texto de la base.
    const otra = await request(app).get('/otro-check')
    expect(otra.status).toBe(500)
    expect(otra.body).toEqual({ message: 'Ocurrió un error inesperado en el servidor.' })
  })
})
