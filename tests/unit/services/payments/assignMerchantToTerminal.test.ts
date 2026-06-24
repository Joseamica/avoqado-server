/**
 * assignMerchantToTerminal — single choke-point (PR-2 · T6).
 *
 * Roster ensure + terminal link upsert + legacy dual-write, idempotent, one-default
 * per terminal. venueId is derived from the terminal; a venue with no payment config
 * degrades to a legacy-only write (never throws) so it's a safe drop-in.
 */
import { assignMerchantToTerminal } from '@/services/payments/assignMerchantToTerminal.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { AccountType } from '@prisma/client'

const VENUE = 'v1'
const TERMINAL = 't1'
const M_NEW = 'm-new'
const M_PRIMARY = 'm-pri'

describe('assignMerchantToTerminal (T6)', () => {
  beforeEach(() => {
    prismaMock.terminal.findUnique.mockResolvedValue({ id: TERMINAL, venueId: VENUE, assignedMerchantIds: [] } as any)
    prismaMock.terminal.update.mockResolvedValue({} as any)
    prismaMock.venuePaymentConfig.findUnique.mockResolvedValue({
      id: 'cfg1',
      primaryAccountId: M_PRIMARY,
      secondaryAccountId: null,
      tertiaryAccountId: null,
    } as any)
    prismaMock.venueMerchantAccount.findUnique.mockResolvedValue(null)
    prismaMock.venueMerchantAccount.findFirst.mockResolvedValue({ priority: 2 } as any)
    prismaMock.venueMerchantAccount.create.mockResolvedValue({ id: 'vma-new' } as any)
    prismaMock.terminalMerchantAccount.updateMany.mockResolvedValue({ count: 0 } as any)
    prismaMock.terminalMerchantAccount.findUnique.mockResolvedValue(null)
    prismaMock.terminalMerchantAccount.create.mockResolvedValue({ id: 'tma-new' } as any)
    prismaMock.terminalMerchantAccount.update.mockResolvedValue({ id: 'tma-upd' } as any)
  })

  it('new account: derives venueId from terminal, adds to roster at next priority + link + legacy push', async () => {
    const res = await assignMerchantToTerminal({ terminalId: TERMINAL, merchantAccountId: M_NEW })

    expect(res.venueId).toBe(VENUE)
    expect(res.addedToRoster).toBe(true)
    expect(res.addedToTerminal).toBe(true)
    expect(res.legacyOnly).toBe(false)
    expect(prismaMock.venueMerchantAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ venueId: VENUE, merchantAccountId: M_NEW, priority: 3, legacySlotType: null }) }),
    )
    expect(prismaMock.terminalMerchantAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ terminalId: TERMINAL, venueId: VENUE, merchantAccountId: M_NEW }) }),
    )
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ data: { assignedMerchantIds: { push: M_NEW } } }))
  })

  it('infers the legacy slot anchor from the config slots (primary account → PRIMARY)', async () => {
    await assignMerchantToTerminal({ terminalId: TERMINAL, merchantAccountId: M_PRIMARY })
    expect(prismaMock.venueMerchantAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ merchantAccountId: M_PRIMARY, legacySlotType: AccountType.PRIMARY }) }),
    )
  })

  it('existing roster account: does NOT create a roster row, upserts the existing link', async () => {
    prismaMock.venueMerchantAccount.findUnique.mockResolvedValue({ id: 'vma-exist' } as any)
    prismaMock.terminalMerchantAccount.findUnique.mockResolvedValue({ id: 'tma-exist' } as any)

    const res = await assignMerchantToTerminal({ terminalId: TERMINAL, merchantAccountId: M_NEW })

    expect(res.addedToRoster).toBe(false)
    expect(prismaMock.venueMerchantAccount.create).not.toHaveBeenCalled()
    expect(prismaMock.terminalMerchantAccount.update).toHaveBeenCalled()
    expect(prismaMock.terminalMerchantAccount.create).not.toHaveBeenCalled()
  })

  it('isDefault clears any other default on the terminal first', async () => {
    await assignMerchantToTerminal({ terminalId: TERMINAL, merchantAccountId: M_NEW, isDefault: true })

    expect(prismaMock.terminalMerchantAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ terminalId: TERMINAL, isDefault: true, NOT: { merchantAccountId: M_NEW } }), data: { isDefault: false } }),
    )
    expect(prismaMock.terminalMerchantAccount.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isDefault: true }) }))
  })

  it('does not duplicate assignedMerchantIds when the account is already there', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue({ id: TERMINAL, venueId: VENUE, assignedMerchantIds: [M_NEW] } as any)

    const res = await assignMerchantToTerminal({ terminalId: TERMINAL, merchantAccountId: M_NEW })

    expect(res.addedToTerminal).toBe(false)
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })

  it('degrades to a legacy-only write when the venue has no VenuePaymentConfig (never throws)', async () => {
    prismaMock.venuePaymentConfig.findUnique.mockResolvedValue(null)

    const res = await assignMerchantToTerminal({ terminalId: TERMINAL, merchantAccountId: M_NEW })

    expect(res.legacyOnly).toBe(true)
    expect(res.addedToRoster).toBe(false)
    expect(res.addedToTerminal).toBe(true) // legacy write still happened
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ data: { assignedMerchantIds: { push: M_NEW } } }))
    expect(prismaMock.venueMerchantAccount.create).not.toHaveBeenCalled()
  })

  it('throws when the terminal does not exist', async () => {
    prismaMock.terminal.findUnique.mockResolvedValue(null)
    await expect(assignMerchantToTerminal({ terminalId: TERMINAL, merchantAccountId: M_NEW })).rejects.toThrow(/Terminal .* not found/)
  })
})
