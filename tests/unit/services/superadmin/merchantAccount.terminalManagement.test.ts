/**
 * setTerminalServesMerchant — toggle terminal↔merchant preserving venue-slot
 * inheritance.
 *
 * effective(T) = T.assignedMerchantIds if non-empty, else the venue's slot merchants.
 *  - serves=true  → set := unique(effective ∪ {M})  (pre-seeds inherited terminals)
 *  - serves=false → set := effective \ {M}, NEVER emptying when that re-inherits M.
 *
 * Prisma is mocked; $transaction invokes its callback with the same mock client.
 */

import prisma from '@/utils/prismaClient'
import { setTerminalServesMerchant } from '@/services/superadmin/merchantAccount.service'
import { assertMerchantTerminalCompatible } from '@/lib/providerDeviceCompatibility'

jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    merchantAccount: { findUnique: jest.fn() },
    terminal: { findUnique: jest.fn(), update: jest.fn() },
    venuePaymentConfig: { findUnique: jest.fn() },
  }
  client.$transaction = jest.fn(async (cb: any) => cb(client))
  return { __esModule: true, default: client }
})

jest.mock('@/lib/providerDeviceCompatibility', () => ({
  assertMerchantTerminalCompatible: jest.fn(),
  assertVenueHasCompatibleTerminal: jest.fn(),
  PROVIDER_DEVICE_COMPATIBILITY: { BLUMON: ['PAX'], ANGELPAY: ['NEXGO'] },
}))

const p = prisma as any
const mockedCompat = assertMerchantTerminalCompatible as jest.Mock

function setup(opts: { assignedMerchantIds: string[]; slots: Array<string | null> }) {
  p.merchantAccount.findUnique.mockResolvedValue({ id: 'M' })
  p.terminal.findUnique.mockResolvedValue({ id: 'T', venueId: 'V', assignedMerchantIds: opts.assignedMerchantIds })
  p.venuePaymentConfig.findUnique.mockResolvedValue({
    primaryAccountId: opts.slots[0] ?? null,
    secondaryAccountId: opts.slots[1] ?? null,
    tertiaryAccountId: opts.slots[2] ?? null,
  })
  p.terminal.update.mockResolvedValue({})
}

const expectSet = (ids: string[]) =>
  expect(p.terminal.update).toHaveBeenCalledWith({ where: { id: 'T' }, data: { assignedMerchantIds: { set: ids } } })

describe('setTerminalServesMerchant — preserve venue-slot inheritance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedCompat.mockResolvedValue(undefined)
  })

  it('assign to an INHERITED terminal pre-seeds with the venue slots (nothing dropped)', async () => {
    setup({ assignedMerchantIds: [], slots: ['A'] }) // inherits [A]; M not slotted
    const res = await setTerminalServesMerchant({ merchantAccountId: 'M', terminalId: 'T', serves: true })
    expectSet(['A', 'M'])
    expect(res).toEqual({ terminalId: 'T', assignedMerchantIds: ['A', 'M'], inherited: false })
  })

  it('assign to an EXPLICIT terminal unions M in', async () => {
    setup({ assignedMerchantIds: ['X'], slots: ['A'] })
    await setTerminalServesMerchant({ merchantAccountId: 'M', terminalId: 'T', serves: true })
    expectSet(['X', 'M'])
  })

  it('detach from an EXPLICIT terminal removes only M', async () => {
    setup({ assignedMerchantIds: ['M', 'X'], slots: ['M', 'X'] })
    await setTerminalServesMerchant({ merchantAccountId: 'M', terminalId: 'T', serves: false })
    expectSet(['X'])
  })

  it('detach from an INHERITED terminal restricts it to the venue slots minus M', async () => {
    setup({ assignedMerchantIds: [], slots: ['M', 'A'] }) // inherits [M, A]
    await setTerminalServesMerchant({ merchantAccountId: 'M', terminalId: 'T', serves: false })
    expectSet(['A'])
  })

  it('detach IS allowed to empty (re-inherit) when M is NOT in the venue slots', async () => {
    setup({ assignedMerchantIds: ['M'], slots: ['A'] }) // explicit [M], M not slotted
    const res = await setTerminalServesMerchant({ merchantAccountId: 'M', terminalId: 'T', serves: false })
    expectSet([])
    expect(res.inherited).toBe(true)
  })

  it('BLOCKS detach when it would empty AND M is the only venue slot (would re-inherit M)', async () => {
    setup({ assignedMerchantIds: [], slots: ['M'] }) // inherits [M]; only slot is M
    await expect(setTerminalServesMerchant({ merchantAccountId: 'M', terminalId: 'T', serves: false })).rejects.toThrow(
      /única cuenta del venue/,
    )
    expect(p.terminal.update).not.toHaveBeenCalled()
  })

  it('rejects an incompatible assignment (brand gate) without updating', async () => {
    setup({ assignedMerchantIds: ['X'], slots: ['A'] })
    mockedCompat.mockRejectedValue(new Error('incompatible'))
    await expect(setTerminalServesMerchant({ merchantAccountId: 'M', terminalId: 'T', serves: true })).rejects.toThrow('incompatible')
    expect(p.terminal.update).not.toHaveBeenCalled()
  })
})
