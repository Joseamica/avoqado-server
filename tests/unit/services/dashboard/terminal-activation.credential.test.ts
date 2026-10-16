import prisma from '@/utils/prismaClient'
import { activateTerminal } from '@/services/dashboard/terminal-activation.service'
import { createHash } from 'crypto'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  },
}))
jest.mock('@/communication/sockets', () => ({ broadcastSuperadminTerminalUpdate: jest.fn() }))
const db = prisma as any
const terminal = {
  id: 't1',
  serialNumber: 'AVQD-123',
  status: 'INACTIVE',
  activatedAt: null,
  activationAttempts: 0,
  activationCode: 'ABC123',
  activationCodeExpiry: new Date(Date.now() + 60_000),
  venueId: 'v1',
  venue: { id: 'v1', name: 'FULLTEST-venue', slug: 'fulltest-venue' },
}
beforeEach(() => {
  jest.clearAllMocks()
  db.terminal.findFirst.mockResolvedValue(terminal)
})
it('consumes the code once even when two requests read it concurrently', async () => {
  db.terminal.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
  const results = await Promise.allSettled([activateTerminal('AVQD-123', 'ABC123'), activateTerminal('AVQD-123', 'ABC123')])
  expect(results.filter(r => r.status === 'fulfilled').length).toBe(1)
  expect(results.filter(r => r.status === 'rejected').length).toBe(1)
  expect(db.terminal.update).not.toHaveBeenCalled()
  expect(db.terminal.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: 't1',
        venueId: 'v1',
        activationCode: 'ABC123',
        activatedAt: null,
        status: 'INACTIVE',
      }),
    }),
  )
  const success = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>
  expect(success.value.commandToken).toMatch(/^[a-f0-9]{64}$/)
  expect(db.terminal.updateMany.mock.calls[0][0].data.commandTokenHash).toBe(
    createHash('sha256').update(success.value.commandToken).digest('hex'),
  )
})
it('does not issue a secret from the public already-activated path', async () => {
  db.terminal.findFirst.mockResolvedValue({ ...terminal, status: 'ACTIVE', activatedAt: new Date() })
  expect(await activateTerminal('AVQD-123', 'anything')).not.toHaveProperty('commandToken')
  expect(db.terminal.updateMany).not.toHaveBeenCalled()
})
it('🔴 the public already-activated path (app reinstall, no code) never takes a terminal out of MAINTENANCE', async () => {
  // Sólo el dueño la saca de mantenimiento (EXIT_MAINTENANCE). Antes, cualquiera con el serial impreso la dejaba ACTIVA.
  db.terminal.findFirst.mockResolvedValue({ ...terminal, status: 'MAINTENANCE', activatedAt: new Date() })
  expect(await activateTerminal('AVQD-123', 'ZZZ999')).toMatchObject({ terminalId: 't1', venueId: 'v1' })
  expect(db.terminal.update).not.toHaveBeenCalled()
  expect(db.terminal.updateMany).not.toHaveBeenCalled()
})
it('🔴 the INACTIVE → ACTIVE re-sync only writes if the row is still INACTIVE (an owner MAINTENANCE saved meanwhile wins)', async () => {
  // Codex r1 P2: leer INACTIVE, el dueño guarda MAINTENANCE, y un update sólo por id lo pisaba con ACTIVE.
  db.terminal.findFirst.mockResolvedValue({ ...terminal, status: 'INACTIVE', activatedAt: new Date() })
  db.terminal.updateMany.mockResolvedValue({ count: 0 })
  expect(await activateTerminal('AVQD-123', 'ZZZ999')).toMatchObject({ terminalId: 't1' })
  expect(db.terminal.update).not.toHaveBeenCalled()
  expect(db.terminal.updateMany).toHaveBeenCalledWith({ where: { id: 't1', status: 'INACTIVE' }, data: { status: 'ACTIVE' } })
})
