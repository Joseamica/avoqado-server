// tests/unit/services/fiscal/fiscalOnboarding.service.test.ts

import {
  provisionEmisor,
  uploadEmisorCsd,
  getEmisorProviderStatus,
  EmisorOnboardingDeps,
} from '../../../../src/services/fiscal/fiscalOnboarding.service'

const emisor = {
  id: 'e1',
  venueId: 'v1',
  legalName: 'X SA',
  regimenFiscal: '601',
  lugarExpedicion: '64000',
  providerOrgId: null,
  csdStatus: 'NONE',
}

function deps(over: Partial<EmisorOnboardingDeps> = {}): EmisorOnboardingDeps {
  return {
    findEmisor: jest.fn().mockResolvedValue(emisor),
    accountProvider: {
      createOrganization: jest.fn().mockResolvedValue({ providerOrgId: 'org1', liveKey: 'sk_live_x', testKey: 'sk_test_x' }),
      updateOrgLegal: jest.fn().mockResolvedValue(undefined),
      uploadCsd: jest.fn().mockResolvedValue({ csdExpiresAt: new Date('2030-01-01') }),
      getOrganizationStatus: jest.fn().mockResolvedValue({ isProductionReady: false, pendingSteps: ['manifiesto'] }),
    } as any,
    updateEmisor: jest.fn().mockImplementation(async (_id, data) => ({ ...emisor, ...data })),
    encryptKey: jest.fn().mockReturnValue('ENC'),
    ...over,
  }
}

// ─── provisionEmisor ─────────────────────────────────────────────────────────

describe('provisionEmisor', () => {
  it('creates the org, sets legal info, stores providerOrgId + encrypted key', async () => {
    const d = deps()
    const r = await provisionEmisor({ emisorId: 'e1', expectedVenueId: 'v1' }, d)

    expect(d.accountProvider.createOrganization).toHaveBeenCalled()
    expect(d.accountProvider.updateOrgLegal).toHaveBeenCalledWith(
      expect.objectContaining({ providerOrgId: 'org1', taxSystem: '601', zip: '64000' }),
    )
    const upd = (d.updateEmisor as jest.Mock).mock.calls[0][1]
    expect(upd.providerOrgId).toBe('org1')
    expect(upd.providerKeyEnc).toBe('ENC') // live key encrypted, never plaintext
    expect(r.providerOrgId).toBe('org1')
  })

  it('encrypts the liveKey before persisting — plaintext liveKey never appears in the DB write', async () => {
    const d = deps()
    await provisionEmisor({ emisorId: 'e1', expectedVenueId: 'v1' }, d)

    expect(d.encryptKey).toHaveBeenCalledWith('sk_live_x')
    const upd = (d.updateEmisor as jest.Mock).mock.calls[0][1]
    // The raw liveKey must NOT be stored directly
    expect(upd.providerKeyEnc).toBe('ENC')
    expect(upd).not.toHaveProperty('liveKey')
  })

  it('persists providerOrgId + encrypted key BEFORE updateOrgLegal — a legal-info failure cannot orphan the org', async () => {
    // Real prod failure (2026-09-01): updateOrgLegal rejected, the org id was thrown
    // away, and every retry created ANOTHER orphaned org in the facturapi account.
    const d = deps({
      accountProvider: {
        createOrganization: jest.fn().mockResolvedValue({ providerOrgId: 'org1', liveKey: 'sk_live_x', testKey: 'sk_test_x' }),
        updateOrgLegal: jest.fn().mockRejectedValue(new Error('El campo "name" es requerido.')),
        uploadCsd: jest.fn(),
      } as any,
    })
    await expect(provisionEmisor({ emisorId: 'e1', expectedVenueId: 'v1' }, d)).rejects.toThrow(/name/)
    const upd = (d.updateEmisor as jest.Mock).mock.calls[0][1]
    expect(upd.providerOrgId).toBe('org1')
    expect(upd.providerKeyEnc).toBe('ENC')
  })

  it('retry with an existing providerOrgId reuses the org: no new createOrganization, legal update on the SAME org', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...emisor, providerOrgId: 'org-existing' }) })
    const r = await provisionEmisor({ emisorId: 'e1', expectedVenueId: 'v1' }, d)

    expect(d.accountProvider.createOrganization).not.toHaveBeenCalled()
    expect(d.accountProvider.updateOrgLegal).toHaveBeenCalledWith(expect.objectContaining({ providerOrgId: 'org-existing' }))
    expect(r.providerOrgId).toBe('org-existing')
  })

  it('tenant guard: throws when emisor belongs to another venue', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...emisor, venueId: 'OTHER' }) })
    await expect(provisionEmisor({ emisorId: 'e1', expectedVenueId: 'v1' }, d)).rejects.toThrow(/not found/)
    expect(d.accountProvider.createOrganization).not.toHaveBeenCalled()
  })

  it('tenant guard: throws when emisor is not found (null)', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue(null) })
    await expect(provisionEmisor({ emisorId: 'e1', expectedVenueId: 'v1' }, d)).rejects.toThrow(/not found/)
    expect(d.accountProvider.createOrganization).not.toHaveBeenCalled()
  })
})

// ─── getEmisorProviderStatus ─────────────────────────────────────────────────

describe('getEmisorProviderStatus', () => {
  it('unprovisioned emisor: reports provisioned=false WITHOUT calling the provider', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...emisor, providerOrgId: null }) })
    const r = await getEmisorProviderStatus({ emisorId: 'e1', expectedVenueId: 'v1' }, d)
    expect(r).toEqual({ provisioned: false, isProductionReady: false, pendingSteps: [] })
    expect((d.accountProvider as any).getOrganizationStatus).not.toHaveBeenCalled()
  })

  it('provisioned emisor: asks the PAC for the org status and returns it', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...emisor, providerOrgId: 'org1' }) })
    const r = await getEmisorProviderStatus({ emisorId: 'e1', expectedVenueId: 'v1' }, d)
    expect((d.accountProvider as any).getOrganizationStatus).toHaveBeenCalledWith('org1')
    expect(r).toEqual({ provisioned: true, isProductionReady: false, pendingSteps: ['manifiesto'] })
  })

  it('tenant guard: throws not found when the emisor belongs to another venue', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...emisor, providerOrgId: 'org1', venueId: 'OTHER' }) })
    await expect(getEmisorProviderStatus({ emisorId: 'e1', expectedVenueId: 'v1' }, d)).rejects.toThrow(/not found/)
    expect((d.accountProvider as any).getOrganizationStatus).not.toHaveBeenCalled()
  })
})

// ─── uploadEmisorCsd ─────────────────────────────────────────────────────────

describe('uploadEmisorCsd', () => {
  const provisioned = { ...emisor, providerOrgId: 'org1' }

  it('uploads the CSD and marks the emisor ACTIVE with the expiry', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue(provisioned) })
    const r = await uploadEmisorCsd({ emisorId: 'e1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw', expectedVenueId: 'v1' }, d)

    expect(d.accountProvider.uploadCsd).toHaveBeenCalledWith(
      expect.objectContaining({ providerOrgId: 'org1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw' }),
    )
    const upd = (d.updateEmisor as jest.Mock).mock.calls[0][1]
    expect(upd.csdStatus).toBe('ACTIVE')
    expect(upd.csdExpiresAt).toBeInstanceOf(Date)
    expect(r.csdStatus).toBe('ACTIVE')
  })

  it('rejects uploading a CSD before the org is provisioned (providerOrgId null)', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...emisor, providerOrgId: null }) })
    await expect(
      uploadEmisorCsd({ emisorId: 'e1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw', expectedVenueId: 'v1' }, d),
    ).rejects.toThrow(/provision/i)
  })

  it('tenant guard on the emisor', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...provisioned, venueId: 'OTHER' }) })
    await expect(
      uploadEmisorCsd({ emisorId: 'e1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw', expectedVenueId: 'v1' }, d),
    ).rejects.toThrow(/not found/)
  })

  it('tenant guard: throws when emisor is not found (null)', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue(null) })
    await expect(
      uploadEmisorCsd({ emisorId: 'e1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw', expectedVenueId: 'v1' }, d),
    ).rejects.toThrow(/not found/)
  })

  it('csdStatus ACTIVE without null csdExpiresAt when provider returns null expiry', async () => {
    const d = deps({
      findEmisor: jest.fn().mockResolvedValue(provisioned),
      accountProvider: {
        createOrganization: jest.fn(),
        updateOrgLegal: jest.fn(),
        uploadCsd: jest.fn().mockResolvedValue({ csdExpiresAt: null }),
      } as any,
    })
    const r = await uploadEmisorCsd({ emisorId: 'e1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw', expectedVenueId: 'v1' }, d)
    expect(r.csdStatus).toBe('ACTIVE')
  })
})
