import { resolveCommandTerminal, issueCommandCredential } from '@/services/tpv/command-credential.service'
import prisma from '@/utils/prismaClient'
import { createHash } from 'crypto'
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { terminal: { findFirst: jest.fn(), update: jest.fn() }, tpvCommandQueue: { findFirst: jest.fn() } },
}))
const terminal = {
  id: 't1',
  venueId: 'v1',
  serialNumber: 'AVQD-123',
  type: 'TPV_ANDROID',
  commandTokenHash: createHash('sha256').update('a'.repeat(64)).digest('hex'),
}
beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.terminal.findFirst as jest.Mock).mockResolvedValue(terminal)
})
it('P1 serial alone never grants command access', async () => {
  expect(await resolveCommandTerminal({ headers: {} } as any, '123')).toBeNull()
})
it('device secret works independently of the employee PIN session and venue change', async () => {
  expect(await resolveCommandTerminal({ headers: { 'x-tpv-command-token': 'a'.repeat(64) } } as any, '123')).toEqual(terminal)
})
it('rejects a forged secret even with the correct serial', async () => {
  expect(await resolveCommandTerminal({ headers: { 'x-tpv-command-token': 'b'.repeat(64) } } as any, '123')).toBeNull()
})
it('legacy authenticated APK must match signed terminal serial and venue', async () => {
  expect(
    await resolveCommandTerminal({ headers: {}, authContext: { terminalSerialNumber: '999', venueId: 'v1' } } as any, '123'),
  ).toBeNull()
  expect(await resolveCommandTerminal({ headers: {}, authContext: { terminalSerialNumber: '123', venueId: 'v1' } } as any, '123')).toEqual(
    terminal,
  )
})
it('stores only the digest of an issued device credential', async () => {
  const token = await issueCommandCredential('t1')
  expect(token).toMatch(/^[a-f0-9]{64}$/)
  expect(prisma.terminal.update).toHaveBeenCalledWith({
    where: { id: 't1' },
    data: { commandTokenHash: createHash('sha256').update(token).digest('hex') },
  })
})

it('legacy signed origin session survives an active migration, but serial alone still does not', async () => {
  ;(prisma.tpvCommandQueue.findFirst as jest.Mock).mockResolvedValue({ id: 'migration1' })
  expect(await resolveCommandTerminal({ headers: {}, authContext: { terminalSerialNumber: '123', venueId: 'old' } } as any, '123')).toEqual(
    terminal,
  )
  ;(prisma.tpvCommandQueue.findFirst as jest.Mock).mockResolvedValue(null)
  expect(
    await resolveCommandTerminal({ headers: {}, authContext: { terminalSerialNumber: '123', venueId: 'old' } } as any, '123'),
  ).toBeNull()
})
it('enrollment retries keep the same device credential instead of rotating another request', async () => {
  expect(await issueCommandCredential('t1', 'a'.repeat(64))).toBe('a'.repeat(64))
  expect(prisma.terminal.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { commandTokenHash: terminal.commandTokenHash } })
})
