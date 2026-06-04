// tests/unit/services/fiscal/fiscalConfig.service.test.ts

import {
  upsertEmisor,
  upsertMerchantFiscalConfig,
  getFiscalConfig,
  FiscalConfigDeps,
} from '../../../../src/services/fiscal/fiscalConfig.service'

function deps(over: Partial<FiscalConfigDeps> = {}): FiscalConfigDeps {
  return {
    upsertEmisorRow: jest.fn().mockImplementation(async d => ({ id: 'e1', ...d })),
    findEmisor: jest.fn().mockResolvedValue({ id: 'e1', venueId: 'v1' }),
    // New signature: (venueId, merchantAccountId?, ecommerceMerchantId?) → venueId | null
    findMerchantVenue: jest.fn().mockResolvedValue('v1'),
    upsertMerchantConfigRow: jest.fn().mockImplementation(async d => ({ id: 'mc1', ...d })),
    listEmisores: jest.fn().mockResolvedValue([{ id: 'e1', rfc: 'EKU9003173C9', csdStatus: 'NONE' }]),
    listMerchantConfigs: jest.fn().mockResolvedValue([{ id: 'mc1', merchantAccountId: 'ma1', facturacionEnabled: true }]),
    ...over,
  }
}

// ==========================================
// upsertEmisor
// ==========================================

describe('upsertEmisor', () => {
  it('creates an emisor scoped to the venue (csdStatus stays NONE until provisioned)', async () => {
    const d = deps()
    const r = await upsertEmisor({ venueId: 'v1', rfc: 'EKU9003173C9', legalName: 'X', regimenFiscal: '601', lugarExpedicion: '64000' }, d)
    expect(r.id).toBe('e1')
    expect((d.upsertEmisorRow as jest.Mock).mock.calls[0][0].venueId).toBe('v1')
  })

  it('does NOT call findEmisor when creating (no emisorId)', async () => {
    const d = deps()
    await upsertEmisor({ venueId: 'v1', rfc: 'EKU9003173C9', legalName: 'X', regimenFiscal: '601', lugarExpedicion: '64000' }, d)
    expect(d.findEmisor).not.toHaveBeenCalled()
  })

  it('tenant guard on update: throws when the emisor belongs to another venue', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ id: 'e1', venueId: 'OTHER' }) })
    await expect(
      upsertEmisor(
        { venueId: 'v1', emisorId: 'e1', rfc: 'EKU9003173C9', legalName: 'X', regimenFiscal: '601', lugarExpedicion: '64000' },
        d,
      ),
    ).rejects.toThrow(/not found/)
  })

  it('tenant guard on update: throws when the emisor is not found', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue(null) })
    await expect(
      upsertEmisor(
        { venueId: 'v1', emisorId: 'e1', rfc: 'EKU9003173C9', legalName: 'X', regimenFiscal: '601', lugarExpedicion: '64000' },
        d,
      ),
    ).rejects.toThrow(/not found/)
  })

  it('calls upsertEmisorRow with the emisorId on update', async () => {
    const d = deps()
    await upsertEmisor(
      { venueId: 'v1', emisorId: 'e1', rfc: 'EKU9003173C9', legalName: 'X', regimenFiscal: '601', lugarExpedicion: '64000' },
      d,
    )
    const [_data, emisorId] = (d.upsertEmisorRow as jest.Mock).mock.calls[0]
    expect(emisorId).toBe('e1')
  })

  it('defaults defaultUsoCfdi to G03 when not provided', async () => {
    const d = deps()
    await upsertEmisor({ venueId: 'v1', rfc: 'EKU9003173C9', legalName: 'X', regimenFiscal: '601', lugarExpedicion: '64000' }, d)
    expect((d.upsertEmisorRow as jest.Mock).mock.calls[0][0].defaultUsoCfdi).toBe('G03')
  })

  it('defaults globalPeriodicity to MENSUAL when not provided', async () => {
    const d = deps()
    await upsertEmisor({ venueId: 'v1', rfc: 'EKU9003173C9', legalName: 'X', regimenFiscal: '601', lugarExpedicion: '64000' }, d)
    expect((d.upsertEmisorRow as jest.Mock).mock.calls[0][0].globalPeriodicity).toBe('MENSUAL')
  })
})

// ==========================================
// upsertMerchantFiscalConfig
// ==========================================

describe('upsertMerchantFiscalConfig', () => {
  const base = {
    venueId: 'v1',
    fiscalEmisorId: 'e1',
    facturacionEnabled: true,
    autofacturaEnabled: true,
    includeInGlobal: true,
  }

  it('upserts a merchant config when merchant + emisor both belong to the venue', async () => {
    const d = deps()
    const r = await upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1' }, d)
    expect(r.id).toBe('mc1')
  })

  it('passes venueId as first arg to findMerchantVenue (scoped query fix)', async () => {
    const d = deps()
    await upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1' }, d)
    // Guard: venueId must be the first arg so shared merchants can't leak across venues
    expect((d.findMerchantVenue as jest.Mock).mock.calls[0][0]).toBe('v1')
    expect((d.findMerchantVenue as jest.Mock).mock.calls[0][1]).toBe('ma1')
  })

  it('upserts with ecommerceMerchantId when provided instead', async () => {
    const d = deps()
    const r = await upsertMerchantFiscalConfig({ ...base, ecommerceMerchantId: 'em1' }, d)
    expect(r.id).toBe('mc1')
    // New signature: (venueId, merchantAccountId?, ecommerceMerchantId?)
    expect((d.findMerchantVenue as jest.Mock).mock.calls[0][0]).toBe('v1')   // venueId
    expect((d.findMerchantVenue as jest.Mock).mock.calls[0][1]).toBeUndefined() // merchantAccountId
    expect((d.findMerchantVenue as jest.Mock).mock.calls[0][2]).toBe('em1')   // ecommerceMerchantId
  })

  it('rejects when neither merchant FK is set (XOR — neither)', async () => {
    const d = deps()
    await expect(upsertMerchantFiscalConfig({ ...base }, d)).rejects.toThrow(/merchant/i)
  })

  it('rejects when both merchant FKs are set (XOR — both)', async () => {
    const d = deps()
    await expect(upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1', ecommerceMerchantId: 'em1' }, d)).rejects.toThrow(
      /merchant/i,
    )
  })

  it('tenant guard: rejects a merchant that belongs to another venue', async () => {
    const d = deps({ findMerchantVenue: jest.fn().mockResolvedValue('OTHER') })
    await expect(upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1' }, d)).rejects.toThrow(/not found/)
  })

  it('tenant guard: rejects when findMerchantVenue returns null', async () => {
    const d = deps({ findMerchantVenue: jest.fn().mockResolvedValue(null) })
    await expect(upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1' }, d)).rejects.toThrow(/not found/)
  })

  it('tenant guard: rejects when the fiscalEmisor belongs to another venue', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ id: 'e1', venueId: 'OTHER' }) })
    await expect(upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1' }, d)).rejects.toThrow(/not found/)
  })

  it('tenant guard: rejects when the fiscalEmisor is not found', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue(null) })
    await expect(upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1' }, d)).rejects.toThrow(/not found/)
  })
})

// ==========================================
// getFiscalConfig
// ==========================================

describe('getFiscalConfig', () => {
  it('returns emisores + merchant configs for the venue', async () => {
    const r = await getFiscalConfig({ venueId: 'v1' }, deps())
    expect(r.emisores).toHaveLength(1)
    expect(r.merchantConfigs).toHaveLength(1)
  })

  it('calls listEmisores and listMerchantConfigs with the venueId', async () => {
    const d = deps()
    await getFiscalConfig({ venueId: 'v1' }, d)
    expect(d.listEmisores).toHaveBeenCalledWith('v1')
    expect(d.listMerchantConfigs).toHaveBeenCalledWith('v1')
  })

  it('returns empty arrays when the venue has no fiscal config', async () => {
    const d = deps({
      listEmisores: jest.fn().mockResolvedValue([]),
      listMerchantConfigs: jest.fn().mockResolvedValue([]),
    })
    const r = await getFiscalConfig({ venueId: 'v1' }, d)
    expect(r.emisores).toHaveLength(0)
    expect(r.merchantConfigs).toHaveLength(0)
  })
})
