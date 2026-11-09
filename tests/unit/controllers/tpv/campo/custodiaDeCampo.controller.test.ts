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
const req = (body: any): any => ({ body, authContext: { userId: 's1', orgId: 'o1', role: 'WAITER' } })

describe('custodia de campo', () => {
  beforeEach(() => jest.clearAllMocks())

  it('aceptar: ALREADY_ACCEPTED sale ok con repetida; NOT_IN_YOUR_CUSTODY sigue error', async () => {
    svc.accept.mockResolvedValue({
      summary: { total: 3, succeeded: 1, failed: 2 },
      results: [
        { serialNumber: 'A', status: 'ok', event: 'PROMOTER_ACCEPTED' },
        { serialNumber: 'B', status: 'error', code: 'ALREADY_ACCEPTED', message: 'x' },
        { serialNumber: 'C', status: 'error', code: 'NOT_IN_YOUR_CUSTODY', message: 'y' },
      ],
    })
    const res = mkRes()
    await aceptarCustodia(req({ serialNumbers: ['A', 'B', 'C'] }), res, jest.fn())
    expect(svc.accept).toHaveBeenCalledWith({
      actor: { staffId: 's1', organizationId: 'o1', role: 'WAITER' },
      serialNumbers: ['A', 'B', 'C'],
      idempotencyRequestId: null,
    })
    const out = res.json.mock.calls[0][0]
    expect(out.summary).toEqual({ total: 3, succeeded: 2, failed: 1 })
    expect(out.results[0].repetida).toBeUndefined()
    expect(out.results[1]).toEqual({ serialNumber: 'B', status: 'ok', repetida: true })
    expect(out.results[2].code).toBe('NOT_IN_YOUR_CUSTODY')
  })

  it('rechazar dos veces: la segunda es 200 repetida', async () => {
    svc.reject.mockRejectedValue(new SimCustodyError('ALREADY_REJECTED'))
    const res = mkRes()
    await rechazarCustodia(req({ serialNumber: 'A' }), res, jest.fn())
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ custodyState: 'PROMOTER_REJECTED', repetida: true })
  })

  it('rechazar la primera vez: repetida false', async () => {
    svc.reject.mockResolvedValue({ custodyState: 'PROMOTER_REJECTED' })
    const res = mkRes()
    await rechazarCustodia(req({ serialNumber: 'A' }), res, jest.fn())
    expect(res.json).toHaveBeenCalledWith({ custodyState: 'PROMOTER_REJECTED', repetida: false })
  })

  it('rechazar una aceptada: INVALID_STATE como hoy', async () => {
    svc.reject.mockRejectedValue(new SimCustodyError('INVALID_STATE'))
    const res = mkRes()
    await rechazarCustodia(req({ serialNumber: 'A' }), res, jest.fn())
    expect(res.status).toHaveBeenCalledWith(new SimCustodyError('INVALID_STATE').httpStatus)
    expect(res.json.mock.calls[0][0].error).toBe('INVALID_STATE')
  })
})
