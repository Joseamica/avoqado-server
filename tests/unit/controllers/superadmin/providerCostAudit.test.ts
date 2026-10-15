import type { Request, Response } from 'express'
import { createProviderCostStructure, updateProviderCostStructure } from '@/controllers/superadmin/providerCostStructure.controller'
import * as service from '@/services/superadmin/providerCostStructure.service'
import { logAction } from '@/services/dashboard/activity-log.service'
jest.mock('@/services/superadmin/providerCostStructure.service')
jest.mock('@/services/dashboard/activity-log.service')
it.each(['create', 'update'])('audita %s de costos con el actor de authContext', async kind => {
  jest.clearAllMocks()
  const row = { id: 'c1', merchantAccountId: 'm1', debitRate: 0.0064, creditRate: 0.0064, amexRate: 0.028, internationalRate: 0.0325 }
  jest
    .mocked(service.createProviderCostStructure)
    .mockResolvedValue(row as unknown as Awaited<ReturnType<typeof service.createProviderCostStructure>>)
  jest
    .mocked(service.updateProviderCostStructure)
    .mockResolvedValue(row as unknown as Awaited<ReturnType<typeof service.updateProviderCostStructure>>)
  const req = {
    params: { id: 'c1' },
    body: { ...row, effectiveFrom: new Date().toISOString() },
    authContext: { userId: 'staff1' },
    headers: {},
  } as unknown as Request
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response
  const next = jest.fn()
  await (kind === 'create' ? createProviderCostStructure : updateProviderCostStructure)(req, res, next)
  expect(next).not.toHaveBeenCalled()
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'staff1', entity: 'ProviderCostStructure', entityId: 'c1' }))
})
