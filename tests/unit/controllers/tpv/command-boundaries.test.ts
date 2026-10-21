import { processHeartbeat } from '@/controllers/tpv/heartbeat.tpv.controller'
import { tpvHealthService } from '@/services/tpv/tpv-health.service'
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { appUpdate: { findFirst: jest.fn(), findUnique: jest.fn() }, terminal: { findFirst: jest.fn() } },
}))
jest.mock('@/services/tpv/tpv-health.service', () => ({
  tpvHealthService: { processHeartbeat: jest.fn(), getPendingCommands: jest.fn(), getTerminalHealth: jest.fn() },
}))
jest.mock('@/communication/sockets/terminal-registry', () => ({ terminalRegistry: { register: jest.fn() } }))
const response = () => {
  const res: any = { status: jest.fn(), json: jest.fn() }
  res.status.mockReturnValue(res)
  return res
}
beforeEach(() => jest.clearAllMocks())
it('P2 empty heartbeat returns 400 before querying Prisma', async () => {
  const res = response()
  const next = jest.fn()
  await processHeartbeat({ body: {}, headers: {}, socket: {} } as any, res, next)
  expect(res.status).toHaveBeenCalledWith(400)
  expect(tpvHealthService.processHeartbeat).not.toHaveBeenCalled()
})
