/**
 * setTerminalMerchants — full-list replacement choke-point (PR-2 · T6).
 */
import { setTerminalMerchants } from '@/services/payments/assignMerchantToTerminal.service'
import { prismaMock } from '@tests/__helpers__/setup'

const TERMINAL = 't1'
const VENUE = 'v1'
const A = 'm-a'
const B = 'm-b'
const C = 'm-c'

describe('setTerminalMerchants (T6)', () => {
  beforeEach(() => {
    // Current terminal has [A, C]; nested assignMerchantToTerminal needs config + roster mocks.
    prismaMock.terminal.findUnique.mockResolvedValue({ id: TERMINAL, venueId: VENUE, assignedMerchantIds: [A, C] } as any)
    prismaMock.terminal.update.mockResolvedValue({} as any)
    prismaMock.venuePaymentConfig.findUnique.mockResolvedValue({ id: 'cfg', primaryAccountId: A, secondaryAccountId: null, tertiaryAccountId: null } as any)
    prismaMock.venueMerchantAccount.findUnique.mockResolvedValue(null)
    prismaMock.venueMerchantAccount.findFirst.mockResolvedValue({ priority: 0 } as any)
    prismaMock.venueMerchantAccount.create.mockResolvedValue({ id: 'vma' } as any)
    prismaMock.terminalMerchantAccount.findUnique.mockResolvedValue(null)
    prismaMock.terminalMerchantAccount.create.mockResolvedValue({ id: 'tma' } as any)
    prismaMock.terminalMerchantAccount.updateMany.mockResolvedValue({ count: 0 } as any)
    prismaMock.terminalMerchantAccount.deleteMany.mockResolvedValue({ count: 1 } as any)
  })

  it('adds new, removes dropped, and sets the legacy array authoritatively to the desired list', async () => {
    const res = await setTerminalMerchants({ terminalId: TERMINAL, merchantAccountIds: [A, B] }) // keep A, add B, drop C

    expect(res.added).toEqual([B])
    expect(res.removed).toEqual([C])
    expect(res.final).toEqual([A, B])

    // Dropped link removed.
    expect(prismaMock.terminalMerchantAccount.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ terminalId: TERMINAL, merchantAccountId: { in: [C] } }) }),
    )
    // Legacy array set to exactly the desired list.
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TERMINAL }, data: { assignedMerchantIds: { set: [A, B] } } }),
    )
  })

  it('deduplicates the desired list', async () => {
    const res = await setTerminalMerchants({ terminalId: TERMINAL, merchantAccountIds: [A, A, C] })
    expect(res.final).toEqual([A, C]) // no removals, no adds — already matches
    expect(res.added).toEqual([])
    expect(res.removed).toEqual([])
  })

  it('throws when the terminal does not exist', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue(null)
    await expect(setTerminalMerchants({ terminalId: TERMINAL, merchantAccountIds: [A] })).rejects.toThrow(/not found/)
  })
})
