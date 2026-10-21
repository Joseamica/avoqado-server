/**
 * 🔴 Auditoría 2026-09-30: el PIN llega del cuerpo sin esquema y va directo al `where` de Prisma.
 * `{ "pin": { "not": null } }` se volvía un FILTRO e identificaba al primer empleado con PIN, sin
 * saberlo. Estas rutas no llevan sesión (iOS las llama sin Authorization): el PIN es la única llave.
 */
jest.mock('@/services/mobile/time-entry.mobile.service')

import type { Request, Response } from 'express'
import * as service from '@/services/mobile/time-entry.mobile.service'
import { clockIn, clockOut, endBreak, identifyByPin, startBreak } from '@/controllers/mobile/time-entry.mobile.controller'

const svc = service as jest.Mocked<typeof service>
const SERVICE_FNS = ['identifyByPin', 'clockIn', 'clockOut', 'startBreak', 'endBreak'] as const
const HANDLERS = { identifyByPin, clockIn, clockOut, startBreak, endBreak }

async function call(handler: (req: Request, res: Response, next: any) => unknown, body: unknown) {
  const req = { params: { venueId: 'venue-1' }, body } as unknown as Request
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  await handler(req, res, jest.fn())
  return res
}

beforeEach(() => {
  jest.clearAllMocks()
  for (const fn of SERVICE_FNS) (svc[fn] as jest.Mock).mockResolvedValue({})
})

describe.each(Object.entries(HANDLERS))('%s', (_name, handler) => {
  it.each([
    ['un objeto (filtro de Prisma)', { not: null }],
    ['un arreglo', ['1234']],
    ['un número', 1234],
    ['texto vacío', ''],
    ['ausente', undefined],
  ])('rechaza el PIN cuando es %s, sin llegar al servicio', async (_label, pin) => {
    const res = await call(handler as any, { pin })
    expect(res.status).toHaveBeenCalledWith(400)
    for (const fn of SERVICE_FNS) expect(svc[fn]).not.toHaveBeenCalled()
  })

  it('un PIN de texto con ceros a la izquierda sí llega al servicio, tal cual', async () => {
    await call(handler as any, { pin: '0637' })
    const called = SERVICE_FNS.map(fn => svc[fn] as jest.Mock).find(m => m.mock.calls.length > 0)
    expect(called).toBeDefined()
    expect(JSON.stringify(called!.mock.calls[0])).toContain('"0637"')
  })
})
