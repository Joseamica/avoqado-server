import type { Request, Response } from 'express'
import { updateMerchantRevenueShare, deleteMerchantRevenueShare } from '@/controllers/superadmin/merchantRevenueShare.controller'
import * as service from '@/services/superadmin/merchantRevenueShare.service'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/superadmin/merchantRevenueShare.service')
jest.mock('@/services/dashboard/activity-log.service')

it('audita el manejo final con el actor autenticado y el modo guardado', async () => {
  jest.mocked(service.updateMerchantRevenueShare).mockResolvedValue({
    id: 'rs1',
    merchantAccountId: 'm1',
    intermediaryFeeRate: 0.01,
    aggregatorPrice: { DEBIT: 0.007 },
  } as unknown as Awaited<ReturnType<typeof service.updateMerchantRevenueShare>>)
  const req = {
    params: { id: 'rs1' },
    body: { intermediaryFeeRate: 0.01 },
    authContext: { userId: 'staff1' },
    headers: {},
    ip: '127.0.0.1',
  } as unknown as Request
  const res = { json: jest.fn() } as unknown as Response
  const next = jest.fn()
  await updateMerchantRevenueShare(req, res, next)
  expect(next).not.toHaveBeenCalled()
  expect(logAction).toHaveBeenCalledWith(
    expect.objectContaining({
      staffId: 'staff1',
      action: 'REVENUE_SHARE_UPDATED',
      data: expect.objectContaining({ intermediaryFeeRate: 0.01, mode: 'aggregator' }),
    }),
  )
})

it('audita la eliminación con el actor real y sólo después del borrado', async () => {
  jest.clearAllMocks()
  jest.mocked(service.deleteMerchantRevenueShare).mockResolvedValue(undefined)
  const req = { params: { id: 'rs1' }, authContext: { userId: 'staff1' }, headers: {} } as unknown as Request
  const res = { json: jest.fn() } as unknown as Response
  const next = jest.fn()
  await deleteMerchantRevenueShare(req, res, next)
  expect(next).not.toHaveBeenCalled()
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'REVENUE_SHARE_DELETED', entityId: 'rs1', staffId: 'staff1' }))
})
