import { TerminalStatus, TerminalType } from '@prisma/client'

import { prismaMock } from '@tests/__helpers__/setup'
import { deleteTerminal } from '@/services/dashboard/terminals.superadmin.service'

function terminal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'terminal-1',
    venueId: 'venue-1',
    serialNumber: 'AVQD-001',
    name: 'Caja 1',
    type: TerminalType.TPV_ANDROID,
    status: TerminalStatus.INACTIVE,
    activatedAt: null,
    selfRegistered: false,
    assignedMerchantIds: [],
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.terminal.delete.mockResolvedValue(terminal())
})

describe('central terminal hard-delete guard', () => {
  it.each([TerminalType.POS_ANDROID, TerminalType.POS_IOS, TerminalType.POS_DESKTOP])(
    'rejects %s regardless of activation or status with a stable retirement error',
    async type => {
      prismaMock.terminal.findUnique.mockResolvedValue(
        terminal({ type, status: TerminalStatus.RETIRED, activatedAt: null, selfRegistered: false }),
      )

      await expect(deleteTerminal('terminal-1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'POS_DEVICE_MUST_BE_RETIRED',
        message: expect.stringMatching(/retirad[oa].*no eliminad[oa]/i),
      })
      expect(prismaMock.terminal.delete).not.toHaveBeenCalled()
    },
  )

  it('rejects any self-registered device even when its type looks like a legacy TPV', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue(terminal({ selfRegistered: true }))

    await expect(deleteTerminal('terminal-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'POS_DEVICE_MUST_BE_RETIRED',
    })
    expect(prismaMock.terminal.delete).not.toHaveBeenCalled()
  })

  it('continues hard-deleting a legacy unactivated TPV', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue(terminal())

    await expect(deleteTerminal('terminal-1')).resolves.toEqual({ success: true })
    expect(prismaMock.terminal.delete).toHaveBeenCalledWith({ where: { id: 'terminal-1' } })
  })
})
