import express from 'express'
import request from 'supertest'

jest.mock('../../../src/config/env', () => ({
  ...jest.requireActual('../../../src/config/env'),
  NODE_ENV: 'production',
}))

import { BadRequestError, ConflictError } from '../../../src/errors/AppError'
import { globalErrorHandler } from '../../../src/app'
import { AFILIACION_EN_VARIOS_SLOTS } from '../../../src/services/shared/slotsDeAfiliacion'
import { MENSAJE_PRODUCTO_CON_VENTAS, PRODUCTO_CON_VENTAS_NO_SE_BORRA } from '../../../src/services/dashboard/product.dashboard.service'

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

  // Plan 5 (D5): el trigger de "Product" rechaza borrar de verdad un producto con ventas. Hoy ninguna ruta llega; si una futura
  // llega, el handler lo traduce UNA vez a 409 con su mensaje, nunca un 500 anónimo.
  it('translates the product-with-sales delete barrier into a 409 with its Spanish message', async () => {
    const app = express()
    app.get('/borrar', () => {
      throw new Error(
        'Invalid `prisma.product.delete()` invocation:\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "P0001", message: "PRODUCTO_CON_VENTAS_NO_SE_BORRA", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
      )
    })
    app.use(globalErrorHandler)

    const r = await request(app).get('/borrar')

    expect(r.status).toBe(409)
    expect(r.body).toEqual({ message: MENSAJE_PRODUCTO_CON_VENTAS, code: PRODUCTO_CON_VENTAS_NO_SE_BORRA })
  })

  // Codex código C5-3: el traductor exige la forma de un error de Postgres (P0001), no sólo el texto. Una categoría que se llama
  // como el código no puede volverse un 409 que dice que un producto tiene ventas.
  it('does NOT turn an AppError or a non-Postgres error that merely mentions the trigger code into the 409', async () => {
    const app = express()
    app.get('/categoria', () => {
      throw new BadRequestError(`Ya existe una categoría llamada ${PRODUCTO_CON_VENTAS_NO_SE_BORRA}`, 'CATEGORIA_DUPLICADA')
    })
    app.get('/otro', () => {
      throw new Error(`Unique constraint failed on the fields: (\`name\`) — ${PRODUCTO_CON_VENTAS_NO_SE_BORRA}`)
    })
    app.use(globalErrorHandler)

    const categoria = await request(app).get('/categoria')
    expect(categoria.status).toBe(400)
    expect(categoria.body).toEqual({
      message: `Ya existe una categoría llamada ${PRODUCTO_CON_VENTAS_NO_SE_BORRA}`,
      code: 'CATEGORIA_DUPLICADA',
    })

    const otro = await request(app).get('/otro')
    expect(otro.status).toBe(500)
    expect(otro.body).toEqual({ message: 'Ocurrió un error inesperado en el servidor.' })
  })
})
