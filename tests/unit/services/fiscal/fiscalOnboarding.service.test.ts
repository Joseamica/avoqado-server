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
    findVenueLogo: jest.fn().mockResolvedValue(null),
    fetchBytes: jest.fn().mockResolvedValue(Buffer.alloc(0)),
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

// ─── syncEmisorLogo ──────────────────────────────────────────────────────────
// Testarudo (21-sep-2026): las facturas salían con el nombre en texto porque el logo del venue
// nunca se subía a la organización del PAC. El logo es un paso del onboarding, no un adorno.

import { syncEmisorLogo } from '../../../../src/services/fiscal/fiscalOnboarding.service'

describe('syncEmisorLogo', () => {
  const provisioned = { ...emisor, providerOrgId: 'org1' }
  const logoDeps = (over: Partial<EmisorOnboardingDeps> = {}) =>
    deps({
      findEmisor: jest.fn().mockResolvedValue(provisioned),
      findVenueLogo: jest.fn().mockResolvedValue('https://cdn/venues/testarudo/logo.jpg'),
      fetchBytes: jest.fn().mockResolvedValue(Buffer.from('JPEGBYTES')),
      accountProvider: { ...deps().accountProvider, uploadLogo: jest.fn().mockResolvedValue(undefined) } as any,
      ...over,
    })

  it('baja el logo del venue y lo sube a la organización del PAC', async () => {
    const d = logoDeps()
    const r = await syncEmisorLogo({ emisorId: 'e1', expectedVenueId: 'v1' }, d)
    expect(d.fetchBytes).toHaveBeenCalledWith('https://cdn/venues/testarudo/logo.jpg')
    expect(d.accountProvider.uploadLogo).toHaveBeenCalledWith('org1', Buffer.from('JPEGBYTES'))
    expect(r).toEqual({ synced: true })
  })

  it('sin logo en el venue: no llama al PAC y lo dice', async () => {
    const d = logoDeps({ findVenueLogo: jest.fn().mockResolvedValue(null) })
    const r = await syncEmisorLogo({ emisorId: 'e1', expectedVenueId: 'v1' }, d)
    expect(r).toEqual({ synced: false, reason: 'NO_LOGO' })
    expect(d.accountProvider.uploadLogo).not.toHaveBeenCalled()
  })

  it('emisor sin provisionar: no llama al PAC y lo dice', async () => {
    const d = logoDeps({ findEmisor: jest.fn().mockResolvedValue(emisor) })
    const r = await syncEmisorLogo({ emisorId: 'e1', expectedVenueId: 'v1' }, d)
    expect(r).toEqual({ synced: false, reason: 'NOT_PROVISIONED' })
    expect(d.accountProvider.uploadLogo).not.toHaveBeenCalled()
  })

  it('la subida al PAC tiene TIMEOUT: un uploadLogo que nunca contesta no cuelga el provisioning', async () => {
    const d = logoDeps({ accountProvider: { ...deps().accountProvider, uploadLogo: jest.fn(() => new Promise(() => {})) } as any })
    await expect(syncEmisorLogo({ emisorId: 'e1', expectedVenueId: 'v1', timeoutMs: 30 }, d)).rejects.toThrow(/tiempo/i)
  })

  it('tenant guard: emisor de otro venue → not found, sin tocar el PAC', async () => {
    const d = logoDeps()
    await expect(syncEmisorLogo({ emisorId: 'e1', expectedVenueId: 'OTRO' }, d)).rejects.toThrow(/not found/)
    expect(d.accountProvider.uploadLogo).not.toHaveBeenCalled()
  })
})

describe('provisionEmisor + logo', () => {
  it('al provisionar, sube el logo del venue en el mismo paso (best-effort: un fallo del logo no tumba el provisioning)', async () => {
    const d = deps({
      findVenueLogo: jest.fn().mockResolvedValue('https://cdn/logo.jpg'),
      fetchBytes: jest.fn().mockResolvedValue(Buffer.from('X')),
      accountProvider: { ...deps().accountProvider, uploadLogo: jest.fn().mockRejectedValue(new Error('PAC caído')) } as any,
    })
    const r = await provisionEmisor({ emisorId: 'e1', expectedVenueId: 'v1' }, d)
    expect(r.providerOrgId).toBe('org1')
    expect(d.accountProvider.uploadLogo).toHaveBeenCalledWith('org1', Buffer.from('X'))
  })
})
