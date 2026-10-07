import express from 'express'
import { api, startApiServer } from '../__helpers__/apiServer'

jest.mock('../../src/config/env', () => ({
  ...jest.requireActual('../../src/config/env'),
  NODE_ENV: 'production',
}))

import { globalErrorHandler } from '@/app'
import { isJsonBodyParseError } from '@/utils/httpErrors'

describe('isJsonBodyParseError', () => {
  it('detects malformed JSON errors emitted by express.json()', () => {
    const error = new SyntaxError('Unexpected end of JSON input') as SyntaxError & { status: number; type: string; body: string }
    error.status = 400
    error.type = 'entity.parse.failed'
    error.body = '{"message":'

    expect(isJsonBodyParseError(error)).toBe(true)
  })

  it('does not classify unrelated syntax errors as request body parse failures', () => {
    const error = new SyntaxError('Unexpected token')

    expect(isJsonBodyParseError(error)).toBe(false)
  })
})

describe('HTTP body limits', () => {
  const app = express()
  const consumer = jest.fn((_req: express.Request, res: express.Response) => {
    res.json({ ok: true })
  })

  beforeAll(() => {
    app.use(express.json({ limit: '1kb' }))
    app.post('/FULLTEST/body-limit', consumer)
    app.get('/FULLTEST/internal-error', () => {
      throw Object.assign(new Error('FULLTEST internal error'), { status: 413 })
    })
    app.use(globalErrorHandler)
  })
  startApiServer(() => app)
  beforeEach(() => consumer.mockClear())

  it('rejects an oversized upload with 413 before the consumer runs', async () => {
    const response = await api().post('/FULLTEST/body-limit').send({ xml: 'FULLTEST-'.repeat(256) })

    expect(response.status).toBe(413)
    expect(response.body).toEqual({ message: 'La solicitud excede el tamaño máximo permitido.', code: 'PAYLOAD_TOO_LARGE' })
    expect(consumer).not.toHaveBeenCalled()
  })

  it('still accepts a small JSON body', async () => {
    const response = await api().post('/FULLTEST/body-limit').send({ xml: 'FULLTEST' })

    expect(response.status).toBe(200)
    expect(consumer).toHaveBeenCalledTimes(1)
  })

  it('still rejects malformed JSON with 400 before the consumer runs', async () => {
    const response = await api().post('/FULLTEST/body-limit').set('Content-Type', 'application/json').send('{"xml":')

    expect(response.status).toBe(400)
    expect(consumer).not.toHaveBeenCalled()
  })

  it('does not classify an unrelated internal status field as a body size error', async () => {
    const response = await api().get('/FULLTEST/internal-error')

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ message: 'Ocurrió un error inesperado en el servidor.' })
  })
})
