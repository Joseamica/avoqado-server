import crypto from 'crypto'

import { prismaMock } from '@tests/__helpers__/setup'
import { handlePassWebhook } from '@/controllers/aggregators/passWebhook.controller'
import * as registry from '@/services/aggregators/core/adapterRegistry'
import { processInboundEvent } from '@/services/aggregators/core/eventProcessor.service'
import { fakeAdapter } from '../../services/aggregators/fakeAdapter'

jest.mock('@/services/aggregators/core/eventProcessor.service', () => ({ processInboundEvent: jest.fn().mockResolvedValue(undefined) }))

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.end = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}
const conn = { id: 'c1', venueId: 'v1', provider: 'TOTALPASS', webhookToken: 'tok-ok', status: 'ACTIVE', externalPlaceId: 'place-1' }
const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

describe('handlePassWebhook', () => {
  beforeEach(() => {
    jest
      .spyOn(registry, 'adapterFor')
      .mockReturnValue(fakeAdapter({ parseWebhook: jest.fn().mockReturnValue({ kind: 'IGNORED', reason: 'x' }) }))
    ;(processInboundEvent as jest.Mock).mockClear()
  })

  // nuevo
  it('token desconocido ⇒ 404 y no guarda nada', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(null)
    const r = res()
    await handlePassWebhook({ params: { provider: 'totalpass', token: 'malo', kind: 'booking' }, body: Buffer.from('{}') } as any, r)
    expect(r.status).toHaveBeenCalledWith(404)
    expect(prismaMock.aggregatorInboundEvent.create).not.toHaveBeenCalled()
  })
  // nuevo
  it('proveedor o tipo desconocidos ⇒ 404 sin consultar la base', async () => {
    const r1 = res()
    await handlePassWebhook({ params: { provider: 'otro', token: 'tok-ok', kind: 'booking' }, body: Buffer.from('{}') } as any, r1)
    const r2 = res()
    await handlePassWebhook({ params: { provider: 'totalpass', token: 'tok-ok', kind: 'otro' }, body: Buffer.from('{}') } as any, r2)
    expect(r1.status).toHaveBeenCalledWith(404)
    expect(r2.status).toHaveBeenCalledWith(404)
    expect(prismaMock.aggregatorConnection.findUnique).not.toHaveBeenCalled()
  })
  // nuevo
  it('cuerpo que no es JSON ⇒ 400', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn as any)
    const r = res()
    await handlePassWebhook({ params: { provider: 'totalpass', token: 'tok-ok', kind: 'booking' }, body: Buffer.from('no-json') } as any, r)
    expect(r.status).toHaveBeenCalledWith(400)
    expect(prismaMock.aggregatorInboundEvent.create).not.toHaveBeenCalled()
  })
  // nuevo
  it('evento válido ⇒ se guarda y se contesta 200 antes de procesar', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn as any)
    prismaMock.aggregatorInboundEvent.create.mockResolvedValueOnce({ id: 'e1' } as any)
    const r = res()
    await handlePassWebhook(
      { params: { provider: 'totalpass', token: 'tok-ok', kind: 'checkin' }, body: Buffer.from('{"type":"CHECK_IN_CREATED"}') } as any,
      r,
    )
    expect(prismaMock.aggregatorInboundEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ connectionId: 'c1', venueId: 'v1', kind: 'CHECKIN', payload: { type: 'CHECK_IN_CREATED' } }),
      }),
    )
    expect(r.status).toHaveBeenCalledWith(200)
    const ackOrder = (r.status as jest.Mock).mock.invocationCallOrder[0]
    const processOrder = (processInboundEvent as jest.Mock).mock.invocationCallOrder[0]
    expect(processInboundEvent).toHaveBeenCalledWith('e1')
    expect(ackOrder).toBeLessThan(processOrder)
  })
  // nuevo
  it('webhook repetido ⇒ 200 y no se vuelve a procesar', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn as any)
    prismaMock.aggregatorInboundEvent.create.mockRejectedValueOnce(p2002())
    prismaMock.aggregatorInboundEvent.findUnique.mockResolvedValueOnce({ id: 'e1' } as any)
    const r = res()
    await handlePassWebhook({ params: { provider: 'totalpass', token: 'tok-ok', kind: 'booking' }, body: Buffer.from('{"a":1}') } as any, r)
    expect(r.status).toHaveBeenCalledWith(200)
    expect(processInboundEvent).not.toHaveBeenCalled()
  })
  // nuevo
  it('si no se puede guardar ⇒ 503 para que el proveedor reintente', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn as any)
    prismaMock.aggregatorInboundEvent.create.mockRejectedValueOnce(new Error('se cayó la base'))
    const r = res()
    await handlePassWebhook({ params: { provider: 'totalpass', token: 'tok-ok', kind: 'booking' }, body: Buffer.from('{"a":1}') } as any, r)
    expect(r.status).toHaveBeenCalledWith(503)
    expect(processInboundEvent).not.toHaveBeenCalled()
  })
  // nuevo
  it('conexión en pausa ⇒ 200 sin guardar (no queremos reintentos del proveedor)', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce({ ...conn, status: 'PAUSED' } as any)
    const r = res()
    await handlePassWebhook({ params: { provider: 'totalpass', token: 'tok-ok', kind: 'booking' }, body: Buffer.from('{}') } as any, r)
    expect(r.status).toHaveBeenCalledWith(200)
    expect(prismaMock.aggregatorInboundEvent.create).not.toHaveBeenCalled()
  })
  // nuevo — fix ronda 1: sin bytes crudos no se guarda un `{}` con 200
  it('cuerpo que no es Buffer (otro Content-Type o sin cuerpo) ⇒ 415 sin guardar', async () => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn as any)
    const r = res()
    await handlePassWebhook(
      { params: { provider: 'totalpass', token: 'tok-ok', kind: 'booking' }, headers: { 'content-type': 'text/plain' }, body: {} } as any,
      r,
    )
    expect(r.status).toHaveBeenCalledWith(415)
    expect(prismaMock.aggregatorInboundEvent.create).not.toHaveBeenCalled()
    expect(processInboundEvent).not.toHaveBeenCalled()
  })
  // nuevo — fix ronda 1 (R7): JSON válido que no es un objeto
  it.each([['null'], ['42'], ['[1,2]'], ['"texto"']])('JSON que no es objeto (%s) ⇒ 400 sin guardar', async cuerpo => {
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn as any)
    const r = res()
    await handlePassWebhook({ params: { provider: 'totalpass', token: 'tok-ok', kind: 'booking' }, body: Buffer.from(cuerpo) } as any, r)
    expect(r.status).toHaveBeenCalledWith(400)
    expect(prismaMock.aggregatorInboundEvent.create).not.toHaveBeenCalled()
  })
  // nuevo — fix ronda 1 (R7): persistir-antes-del-ACK aunque la llave del adaptador truene
  it('si dedupKey del adaptador truena ⇒ se guarda igual con el hash del cuerpo crudo y se contesta 200', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        dedupKey: jest.fn(() => {
          throw new Error('forma inesperada')
        }),
      }),
    )
    prismaMock.aggregatorConnection.findUnique.mockResolvedValueOnce(conn as any)
    prismaMock.aggregatorInboundEvent.create.mockResolvedValueOnce({ id: 'e3' } as any)
    const crudo = '{"raro":true}'
    const r = res()
    await handlePassWebhook({ params: { provider: 'totalpass', token: 'tok-ok', kind: 'checkin' }, body: Buffer.from(crudo) } as any, r)
    const esperada = `TOTALPASS:CHECKIN:${crypto.createHash('sha256').update(crudo).digest('hex')}`
    expect(prismaMock.aggregatorInboundEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dedupKey: esperada, payload: { raro: true } }) }),
    )
    expect(r.status).toHaveBeenCalledWith(200)
    expect(processInboundEvent).toHaveBeenCalledWith('e3')
  })
})
