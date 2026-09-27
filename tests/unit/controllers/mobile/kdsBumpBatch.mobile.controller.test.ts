/** «Marcar todas listas» acota su entrada: nada de lotes vacíos, gigantes o con basura. */
const mockBatch = jest.fn()
jest.mock('@/services/mobile/kds.mobile.service', () => ({
  KDS_BUMP_BATCH_MAX: 100,
  bumpKdsOrdersBatch: (...a: unknown[]) => mockBatch(...a),
}))

import { bumpKdsOrdersBatch } from '@/controllers/mobile/kds.mobile.controller'

function res() {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}
const req = (body: unknown) => ({ params: { venueId: 'v1' }, body }) as any

beforeEach(() => mockBatch.mockReset().mockResolvedValue({ completed: 2 }))

it.each([[{}], [{ ids: [] }], [{ ids: Array.from({ length: 101 }, (_, i) => `k${i}`) }], [{ ids: ['ok', 7] }]])('400 con %j', async body => {
  const r = res()
  await bumpKdsOrdersBatch(req(body), r, jest.fn())
  expect(r.status).toHaveBeenCalledWith(400)
  expect(mockBatch).not.toHaveBeenCalled()
})

it('200 con un lote válido', async () => {
  const r = res()
  await bumpKdsOrdersBatch(req({ ids: ['k1', 'k2'] }), r, jest.fn())
  expect(mockBatch).toHaveBeenCalledWith('v1', ['k1', 'k2'])
  expect(r.status).toHaveBeenCalledWith(200)
})
