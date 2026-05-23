/**
 * MerchantRevenueShare CRUD — integration tests against a REAL PostgreSQL DB.
 * Spec: docs/superpowers/specs/2026-05-22-revenue-share-fee-model-design.md
 */
import prisma from '@/utils/prismaClient'
import {
  createMerchantRevenueShare,
  getMerchantRevenueShareByMerchant,
  updateMerchantRevenueShare,
  deleteMerchantRevenueShare,
  listMerchantRevenueShares,
} from '@/services/superadmin/merchantRevenueShare.service'

jest.setTimeout(60000)

const TEST_EXT_ID = 'TEST_MRS_INT_999'

describe('MerchantRevenueShare CRUD (integration)', () => {
  let providerId = ''
  let merchantAccountId = ''

  async function cleanup() {
    if (merchantAccountId) {
      await prisma.merchantRevenueShare.deleteMany({ where: { merchantAccountId } })
      await prisma.merchantAccount.deleteMany({ where: { id: merchantAccountId } })
    }
  }

  beforeAll(async () => {
    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'ANGELPAY' },
      update: {},
      create: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    providerId = provider.id

    // Limpiar de corridas previas (la unique vive en (providerId, externalMerchantId, angelpayUserAccountId)).
    await prisma.merchantAccount.deleteMany({ where: { providerId, externalMerchantId: TEST_EXT_ID } })
    const merchant = await prisma.merchantAccount.create({
      data: {
        providerId,
        externalMerchantId: TEST_EXT_ID,
        alias: 'TEST MRS',
        credentialsEncrypted: {},
      },
    })
    merchantAccountId = merchant.id
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('crea un revenue-share directo (sin agregador → aggregatorPrice null)', async () => {
    const row = await createMerchantRevenueShare({
      merchantAccountId,
      aggregatorPrice: null,
      aggregatorPriceIncludesTax: false,
      avoqadoShareOfProviderMargin: 0.5,
      avoqadoShareOfAggregatorMargin: null,
      taxRate: 0.16,
      active: true,
    })
    expect(row.id).toBeTruthy()
    expect(row.aggregatorPrice).toBeNull()
    expect(Number(row.avoqadoShareOfProviderMargin)).toBeCloseTo(0.5)
  })

  it('rechaza un duplicado (un merchant solo puede tener un revenue-share)', async () => {
    await expect(
      createMerchantRevenueShare({
        merchantAccountId,
        aggregatorPriceIncludesTax: false,
        avoqadoShareOfProviderMargin: 0.5,
        taxRate: 0.16,
        active: true,
      }),
    ).rejects.toThrow(/ya tiene un revenue-share/i)
  })

  it('rechaza un merchant inexistente', async () => {
    await expect(
      createMerchantRevenueShare({
        merchantAccountId: 'nonexistent-merchant-id',
        aggregatorPriceIncludesTax: false,
        avoqadoShareOfProviderMargin: 0.5,
        taxRate: 0.16,
        active: true,
      }),
    ).rejects.toThrow(/no existe/i)
  })

  it('getByMerchant devuelve la fila; un merchant desconocido devuelve null', async () => {
    const found = await getMerchantRevenueShareByMerchant(merchantAccountId)
    expect(found?.merchantAccountId).toBe(merchantAccountId)
    expect(await getMerchantRevenueShareByMerchant('nonexistent-merchant-id')).toBeNull()
  })

  it('list incluye la fila recién creada', async () => {
    const rows = await listMerchantRevenueShares({ active: true })
    expect(rows.find(r => r.merchantAccountId === merchantAccountId)).toBeDefined()
  })

  it('update cambia a "con agregador" (aggregatorPrice + share del margen 2)', async () => {
    const existing = await getMerchantRevenueShareByMerchant(merchantAccountId)
    expect(existing).not.toBeNull()

    const updated = await updateMerchantRevenueShare(existing!.id, {
      aggregatorPrice: { DEBIT: 0.04, CREDIT: 0.04, AMEX: 0.04, INTERNATIONAL: 0.04 },
      avoqadoShareOfAggregatorMargin: 0.5,
    })
    expect((updated.aggregatorPrice as { DEBIT: number }).DEBIT).toBe(0.04)
    expect(Number(updated.avoqadoShareOfAggregatorMargin)).toBeCloseTo(0.5)
  })

  it('update vuelve a "directo" poniendo aggregatorPrice = null', async () => {
    const existing = await getMerchantRevenueShareByMerchant(merchantAccountId)
    const updated = await updateMerchantRevenueShare(existing!.id, {
      aggregatorPrice: null,
    })
    expect(updated.aggregatorPrice).toBeNull()
  })

  it('delete elimina la fila', async () => {
    const existing = await getMerchantRevenueShareByMerchant(merchantAccountId)
    await deleteMerchantRevenueShare(existing!.id)
    expect(await getMerchantRevenueShareByMerchant(merchantAccountId)).toBeNull()
  })
})
