import express from 'express'
import { api, startApiServer } from '../../__helpers__/apiServer'

const app = express()
app.get('/socket', (req, res) => {
  res.json({ address: req.socket.localAddress, port: req.socket.localPort })
})
startApiServer(() => app)

it('owns an IPv4 loopback server and reuses it across requests', async () => {
  const first = await api().get('/socket')
  const second = await api().get('/socket')

  expect(first.status).toBe(200)
  expect(first.body.address).toBe('127.0.0.1')
  expect(second.body).toEqual(first.body)
})

describe('multiple app fixtures in one file', () => {
  const firstApp = express()
  firstApp.get('/identity', (_req, res) => res.json({ fixture: 'first' }))
  const secondApp = express()
  secondApp.get('/identity', (_req, res) => res.json({ fixture: 'second' }))
  const firstApi = startApiServer(() => firstApp)
  const secondApi = startApiServer(() => secondApp)

  it('keeps each returned client on its own app', async () => {
    const first = await firstApi().get('/identity')
    const second = await secondApi().get('/identity')
    const firstAgain = await firstApi().get('/identity')

    expect(first.body).toEqual({ fixture: 'first' })
    expect(second.body).toEqual({ fixture: 'second' })
    expect(firstAgain.body).toEqual(first.body)
  })
})
