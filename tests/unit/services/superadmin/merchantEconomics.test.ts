import { saveMerchantEconomics } from '@/services/superadmin/merchantRevenueShare.service'
import { prismaMock } from '@tests/__helpers__/setup'

const input = {
  costId: 'c1',
  revenueShareId: 'rs1',
  cost: {
    debitRate: 0.008,
    creditRate: 0.0064,
    amexRate: 0.028,
    internationalRate: 0.0325,
    includesTax: false,
    taxRate: 0.16,
    fixedCostPerTransaction: null,
  },
  revenueShare: {
    aggregatorPrice: { DEBIT: 0.007, CREDIT: 0.007, AMEX: 0.028, INTERNATIONAL: 0.0325 },
    aggregatorPriceIncludesTax: false,
    avoqadoShareOfProviderMargin: 0.5,
    avoqadoShareOfAggregatorMargin: 1,
    intermediaryFeeRate: 0.02,
    taxRate: 0.16,
    active: true,
  },
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'm1', providerId: 'p1' })
  prismaMock.providerCostStructure.findUnique.mockResolvedValue({ id: 'c1', merchantAccountId: 'm1', active: true })
  prismaMock.providerCostStructure.findFirst.mockResolvedValue({ id: 'c1', merchantAccountId: 'm1', active: true })
  prismaMock.providerCostStructure.update.mockResolvedValue({ id: 'c1', merchantAccountId: 'm1', ...input.cost })
  prismaMock.providerCostStructure.create.mockResolvedValue({ id: 'newcost', merchantAccountId: 'm1', ...input.cost })
  prismaMock.merchantRevenueShare = {
    findUnique: jest.fn().mockResolvedValue({ id: 'rs1', merchantAccountId: 'm1' }),
    update: jest.fn().mockResolvedValue({ id: 'rs1', merchantAccountId: 'm1', ...input.revenueShare }),
    create: jest.fn().mockResolvedValue({ id: 'newshare', merchantAccountId: 'm1' }),
  }
})

describe('guardar economía completa', () => {
  it('busca el costo vigente por fecha, para que uno futuro no bloquee el alta', async () => {
    prismaMock.merchantRevenueShare.findUnique.mockResolvedValue(null)
    prismaMock.providerCostStructure.findFirst.mockResolvedValue(null)
    await saveMerchantEconomics('m1', { ...input, costId: null, revenueShareId: null })
    expect(prismaMock.providerCostStructure.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          merchantAccountId: 'm1',
          active: true,
          effectiveFrom: { lte: expect.any(Date) },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: expect.any(Date) } }],
        }),
        orderBy: expect.anything(),
      }),
    )
  })

  it('pasa ambas escrituras por la misma transacción y propaga el fallo de la segunda', async () => {
    prismaMock.merchantRevenueShare.update.mockRejectedValue(new Error('segunda escritura falló'))
    await expect(saveMerchantEconomics('m1', input)).rejects.toThrow('segunda escritura falló')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.providerCostStructure.update).toHaveBeenCalledWith(expect.objectContaining({ data: input.cost }))
  })
  it('devuelve las dos configuraciones guardadas sin cambiar la tarifa por el manejo', async () => {
    const result = await saveMerchantEconomics('m1', input)
    expect(result).toMatchObject({
      cost: { debitRate: 0.008 },
      revenueShare: { intermediaryFeeRate: 0.02, aggregatorPrice: { DEBIT: 0.007 }, avoqadoShareOfProviderMargin: 0.5 },
    })
  })
  it.each(['cost', 'share'])('rechaza un id de %s de otro merchant antes de escribir', async kind => {
    if (kind === 'cost') prismaMock.providerCostStructure.findFirst.mockResolvedValue(null)
    await expect(saveMerchantEconomics('m1', kind === 'share' ? { ...input, revenueShareId: 'foreign-share' } : input)).rejects.toThrow()
    expect(prismaMock.providerCostStructure.update).not.toHaveBeenCalled()
    expect(prismaMock.merchantRevenueShare.update).not.toHaveBeenCalled()
  })
  it('crea ambas configuraciones cuando faltan, con el reparto del 100 % intacto', async () => {
    prismaMock.merchantRevenueShare.findUnique.mockResolvedValue(null)
    prismaMock.providerCostStructure.findFirst.mockResolvedValue(null)
    await saveMerchantEconomics('m1', {
      ...input,
      costId: null,
      revenueShareId: null,
      revenueShare: { ...input.revenueShare, avoqadoShareOfProviderMargin: 1 },
    })
    expect(prismaMock.merchantRevenueShare.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ merchantAccountId: 'm1', avoqadoShareOfProviderMargin: 1 }),
    })
  })
})
