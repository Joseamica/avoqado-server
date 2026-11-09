import { prismaMock } from '@tests/__helpers__/setup'
import { aceptarCustodia, rechazarCustodia } from '@/controllers/tpv/campo/custodiaDeCampo.controller'
import { simCustodyService } from '@/services/serialized-inventory/custody.service'
import { SimCustodyError } from '@/lib/sim-custody-error-codes'

jest.mock('@/services/serialized-inventory/custody.service', () => ({ simCustodyService: { accept: jest.fn(), reject: jest.fn() } }))

const svc = simCustodyService as unknown as { accept: jest.Mock; reject: jest.Mock }
const mkRes = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}
/** El token es de la organización o1; la dirección nombra la sucursal vB, de la organización oB. */
const req = (body: any, extra: Record<string, unknown> = {}): any => ({
  body,
  params: { venueId: 'vB' },
  authContext: { userId: 's1', orgId: 'o1', role: 'WAITER' },
  ...extra,
})
/** Cómo está hoy cada SIM (la lectura del controlador, por organización). */
let hoy: Record<string, { custodyState: string; assignedPromoterId: string | null; custodyVersion: number }>
const sim = (custodyState: string, custodyVersion = 1, assignedPromoterId: string | null = 's1') => ({
  custodyState,
  assignedPromoterId,
  custodyVersion,
})

beforeEach(() => {
  jest.clearAllMocks()
  hoy = {}
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'oB' })
  prismaMock.serializedItem.findFirst.mockImplementation(async ({ where }: any) =>
    where.organizationId === 'oB' ? (hoy[where.serialNumber.equals] ?? null) : null,
  )
})

describe('custodia de campo: la organización sale de la sucursal de la dirección (Codex C2)', () => {
  it('aceptar y rechazar operan en la organización de :venueId (no la del token) con el rol que resolvió checkPermission', async () => {
    hoy.A = sim('PROMOTER_PENDING')
    svc.accept.mockResolvedValue({ results: [{ serialNumber: 'A', status: 'ok', event: 'PROMOTER_ACCEPTED' }] })
    svc.reject.mockResolvedValue({ custodyState: 'PROMOTER_REJECTED' })

    await aceptarCustodia(req({ sims: [{ serialNumber: 'A', custodyVersion: 1 }] }, { resolvedRole: 'MANAGER' }), mkRes(), jest.fn())
    await rechazarCustodia(req({ serialNumber: 'A', custodyVersion: 1 }), mkRes(), jest.fn())

    expect(prismaMock.venue.findUnique).toHaveBeenCalledWith({ where: { id: 'vB' }, select: { organizationId: true } })
    expect(svc.accept).toHaveBeenCalledWith({
      actor: { staffId: 's1', organizationId: 'oB', role: 'MANAGER' },
      serialNumbers: ['A'],
      idempotencyRequestId: null,
    })
    expect(svc.reject).toHaveBeenCalledWith({ actor: { staffId: 's1', organizationId: 'oB', role: 'WAITER' }, serialNumber: 'A' })
  })

  it('una sucursal que no existe → 404 por next, sin llamar al servicio', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)
    const next = jest.fn()
    await aceptarCustodia(req({ sims: [{ serialNumber: 'A', custodyVersion: 1 }] }), mkRes(), next)
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 })
    expect(svc.accept).not.toHaveBeenCalled()
  })
})

describe('aceptar: cada SIM con la versión que vio el celular (Codex C3, C6)', () => {
  it('ya aceptada → repetida; reasignada (otra versión) → ASIGNACION_CAMBIO; la de su versión → al servicio, y el orden se respeta', async () => {
    hoy.A = sim('PROMOTER_HELD', 2)
    hoy.B = sim('PROMOTER_PENDING', 4) // la recolectaron y se la volvieron a asignar
    hoy.C = sim('PROMOTER_PENDING', 1)
    svc.accept.mockResolvedValue({ results: [{ serialNumber: 'C', status: 'ok', event: 'PROMOTER_ACCEPTED', eventId: 'e1' }] })
    const res = mkRes()

    await aceptarCustodia(
      req({
        sims: [
          { serialNumber: 'A', custodyVersion: 1 },
          { serialNumber: 'B', custodyVersion: 1 },
          { serialNumber: 'C', custodyVersion: 1 },
        ],
      }),
      res,
      jest.fn(),
    )

    expect(svc.accept.mock.calls[0][0].serialNumbers).toEqual(['C'])
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      summary: { total: 3, succeeded: 2, failed: 1 },
      results: [
        { serialNumber: 'A', status: 'ok', repetida: true },
        { serialNumber: 'B', status: 'error', code: 'ASIGNACION_CAMBIO', message: expect.stringContaining('volvió a asignar') },
        { serialNumber: 'C', status: 'ok', repetida: false },
      ],
    })
  })

  it('las filas del servicio salen como { serialNumber, status, code, message }; ALREADY_ACCEPTED (carrera) es ok repetida', async () => {
    hoy.A = sim('PROMOTER_PENDING')
    svc.accept.mockResolvedValue({
      results: [
        { serialNumber: 'A', status: 'error', code: 'ALREADY_ACCEPTED', message: 'x' },
        { serialNumber: 'Z', status: 'error', code: 'NOT_FOUND', message: 'no existe' },
      ],
    })
    const res = mkRes()
    await aceptarCustodia(
      req({
        sims: [
          { serialNumber: 'A', custodyVersion: 1 },
          { serialNumber: 'Z', custodyVersion: 0 },
        ],
      }),
      res,
      jest.fn(),
    )
    expect(res.json.mock.calls[0][0].results).toEqual([
      { serialNumber: 'A', status: 'ok', repetida: true },
      { serialNumber: 'Z', status: 'error', code: 'NOT_FOUND', message: 'no existe' },
    ])
  })

  it('VERSION_CONFLICT y al releer ya quedó aceptada por ella → ok repetida (200)', async () => {
    hoy.A = sim('PROMOTER_PENDING')
    svc.accept.mockImplementation(async () => {
      hoy.A = sim('PROMOTER_HELD', 2) // la otra entrega ganó la escritura
      return { results: [{ serialNumber: 'A', status: 'error', code: 'VERSION_CONFLICT', message: 'x' }] }
    })
    const res = mkRes()
    await aceptarCustodia(req({ sims: [{ serialNumber: 'A', custodyVersion: 1 }] }), res, jest.fn())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json.mock.calls[0][0].results).toEqual([{ serialNumber: 'A', status: 'ok', repetida: true }])
  })

  it('VERSION_CONFLICT sin resolver → 409 CUSTODIA_EN_PROCESO (reintentable) con las filas', async () => {
    hoy.A = sim('PROMOTER_PENDING')
    hoy.B = sim('PROMOTER_PENDING')
    svc.accept.mockResolvedValue({
      results: [
        { serialNumber: 'A', status: 'error', code: 'VERSION_CONFLICT', message: 'x' },
        { serialNumber: 'B', status: 'ok' },
      ],
    })
    const res = mkRes()
    await aceptarCustodia(
      req({
        sims: [
          { serialNumber: 'A', custodyVersion: 1 },
          { serialNumber: 'B', custodyVersion: 1 },
        ],
      }),
      res,
      jest.fn(),
    )
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      code: 'CUSTODIA_EN_PROCESO',
      message: expect.any(String),
      summary: { total: 2, succeeded: 1, failed: 1 },
      results: [
        { serialNumber: 'A', status: 'error', code: 'CUSTODIA_EN_PROCESO', message: expect.any(String) },
        { serialNumber: 'B', status: 'ok', repetida: false },
      ],
    })
  })
})

describe('rechazar: con la versión que vio el celular', () => {
  it('ya rechazada por ella → 200 repetida sin llamar al servicio', async () => {
    hoy.A = sim('PROMOTER_REJECTED', 2)
    const res = mkRes()
    await rechazarCustodia(req({ serialNumber: 'A', custodyVersion: 1 }), res, jest.fn())
    expect(svc.reject).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ custodyState: 'PROMOTER_REJECTED', repetida: true })
  })

  it('recolectada y reasignada (otra versión) → 409 ASIGNACION_CAMBIO sin llamar al servicio', async () => {
    hoy.A = sim('PROMOTER_PENDING', 4)
    const res = mkRes()
    await rechazarCustodia(req({ serialNumber: 'A', custodyVersion: 1 }), res, jest.fn())
    expect(svc.reject).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ code: 'ASIGNACION_CAMBIO', message: expect.any(String) })
  })

  it('la primera vez: repetida false', async () => {
    hoy.A = sim('PROMOTER_PENDING')
    svc.reject.mockResolvedValue({ custodyState: 'PROMOTER_REJECTED' })
    const res = mkRes()
    await rechazarCustodia(req({ serialNumber: 'A', custodyVersion: 1 }), res, jest.fn())
    expect(res.json).toHaveBeenCalledWith({ custodyState: 'PROMOTER_REJECTED', repetida: false })
  })

  it('ALREADY_REJECTED (carrera) → 200 repetida', async () => {
    hoy.A = sim('PROMOTER_PENDING')
    svc.reject.mockRejectedValue(new SimCustodyError('ALREADY_REJECTED'))
    const res = mkRes()
    await rechazarCustodia(req({ serialNumber: 'A', custodyVersion: 1 }), res, jest.fn())
    expect(res.json).toHaveBeenCalledWith({ custodyState: 'PROMOTER_REJECTED', repetida: true })
  })

  it.each([
    [
      'ya quedó rechazada por ella',
      () => (hoy.A = sim('PROMOTER_REJECTED', 2)),
      200,
      { custodyState: 'PROMOTER_REJECTED', repetida: true },
    ],
    ['sigue sin resolver', () => undefined, 409, { code: 'CUSTODIA_EN_PROCESO', message: expect.any(String) }],
  ])('VERSION_CONFLICT y al releer %s', async (_n, cambiar, status, cuerpo) => {
    hoy.A = sim('PROMOTER_PENDING')
    svc.reject.mockImplementation(async () => {
      cambiar()
      throw new SimCustodyError('VERSION_CONFLICT')
    })
    const res = mkRes()
    await rechazarCustodia(req({ serialNumber: 'A', custodyVersion: 1 }), res, jest.fn())
    expect(res.status).toHaveBeenCalledWith(status)
    expect(res.json).toHaveBeenCalledWith(cuerpo)
  })

  it('una aceptada: INVALID_STATE como hoy, con { code, message }', async () => {
    hoy.A = sim('PROMOTER_HELD')
    svc.reject.mockRejectedValue(new SimCustodyError('INVALID_STATE'))
    const res = mkRes()
    await rechazarCustodia(req({ serialNumber: 'A', custodyVersion: 1 }), res, jest.fn())
    expect(res.status).toHaveBeenCalledWith(new SimCustodyError('INVALID_STATE').httpStatus)
    expect(res.json).toHaveBeenCalledWith({ code: 'INVALID_STATE', message: new SimCustodyError('INVALID_STATE').message })
  })
})
