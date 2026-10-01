import { Request, Response } from 'express'
import * as controller from '@/controllers/dashboard/terminals.superadmin.controller'
import * as terminals from '@/services/dashboard/terminals.superadmin.service'
import { tpvHealthService } from '@/services/tpv/tpv-health.service'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/services/dashboard/terminals.superadmin.service')
jest.mock('@/services/tpv/tpv-health.service', () => ({ tpvHealthService: { sendCommand: jest.fn() } }))
jest.mock('@/services/tpv/command-queue.service', () => ({ tpvCommandQueueService: { getCommandHistory: jest.fn() } }))
jest.mock('@/services/dashboard/tpv.dashboard.service')
jest.mock('@/services/dashboard/terminal-fleet.service')
jest.mock('@/services/terminal-payment.service', () => ({ terminalPaymentService: {} }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const req = {
  params: { terminalId: 't1' },
  body: { command: 'RESTART' },
  authContext: { userId: 'actual-admin' },
  get: jest.fn(),
} as unknown as Request
const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response
const next = jest.fn()
beforeEach(() => jest.clearAllMocks())

it.each(['generateActivationCode', 'sendRemoteActivation'] as const)('%s registra al administrador autenticado', async action => {
  await controller[action](req, res, next)
  const service = action === 'generateActivationCode' ? terminals.generateActivationCodeForTerminal : terminals.sendRemoteActivation
  expect(service).toHaveBeenCalledWith('t1', 'actual-admin')
  expect(next).not.toHaveBeenCalled()
})
it('responde con el identificador real de la cola y registra el actor', async () => {
  jest.mocked(terminals.getTerminalById).mockResolvedValue({ id: 't1', venueId: 'v1' } as never)
  jest.mocked(tpvHealthService.sendCommand).mockResolvedValue({ commandId: 'cmd-real', status: 'PENDING' } as never)
  await controller.sendCommand(req, res, next)
  expect(res.json).toHaveBeenCalledWith({ data: { commandId: 'cmd-real', status: 'PENDING' } })
  expect(logAction).toHaveBeenCalledWith(
    expect.objectContaining({ staffId: 'actual-admin', data: { command: 'RESTART', commandId: 'cmd-real' } }),
  )
})
it('un error al encolar nunca responde como éxito', async () => {
  jest.mocked(tpvHealthService.sendCommand).mockRejectedValue(new Error('queue failed'))
  await controller.sendCommand(req, res, next)
  expect(res.json).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'queue failed' }))
})
