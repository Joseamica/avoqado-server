import express from 'express'
import request from 'supertest'

jest.mock('../../../src/config/env', () => ({
  ...jest.requireActual('../../../src/config/env'),
  NODE_ENV: 'production',
}))

import { ConflictError } from '../../../src/errors/AppError'
import { globalErrorHandler } from '../../../src/app'

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
})
