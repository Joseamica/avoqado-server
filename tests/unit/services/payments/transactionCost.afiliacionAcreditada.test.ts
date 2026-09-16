/**
 * Codex R2 (P1-3) + R3 (P1-3): el costo y la liquidación se resuelven con la afiliación ACREDITADA en el Payment (por
 * dónde pasó el dinero) aunque el negocio ya la haya retirado de su configuración — y la TARIFA que se le cobra al
 * negocio es la del slot que esa afiliación ocupaba AL COBRAR (`processorData.pricingSlot`, congelado por el registrador).
 * Antes caía en silencio al PRIMARY: sobre $1,000 al 8 % calculaba $80 cuando M2 tenía contratado 2.5 % ($25). Sin slot
 * acreditable, el costo queda PENDIENTE (lanza con un motivo reconocible), nunca «nunca peor que PRIMARY».
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  createTransactionCost,
  leerTarifaCongelada,
  tarifaCongeladaDeLaAfiliacion,
  tarifaCongeladaDelPago,
} from '@/services/payments/transactionCost.service'
import { getEffectivePaymentConfig, getEffectivePricingForSlot } from '@/services/organization-payment-config.service'
import { calculatePaymentSettlement } from '@/services/payments/settlementCalculation.service'

jest.mock('@/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: jest.fn(),
  getEffectivePricing: jest.fn(),
  getEffectivePricingForSlot: jest.fn(),
}))
jest.mock('@/services/payments/settlementCalculation.service', () => ({
  calculatePaymentSettlement: jest.fn(),
}))

const prismaMock = prisma as any
const D = (n: number) => new Prisma.Decimal(n)
const configMock = getEffectivePaymentConfig as jest.Mock
// Codex R12-14: la captura y la unidad de costo resuelven UN slot con la consulta acotada (`take: 1`), no con la lista entera.
const pricingMock = getEffectivePricingForSlot as jest.Mock
const settlementMock = calculatePaymentSettlement as jest.Mock

const pago = (merchantAccountId: string | null, processorData: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  venueId: 'venue-1',
  merchantAccountId,
  method: 'CREDIT_CARD',
  cardBrand: 'VISA',
  amount: D(1000),
  tipAmount: D(0),
  type: 'REGULAR',
  originSystem: 'AVOQADO',
  processorData,
  createdAt: new Date('2026-09-13T20:00:00Z'),
  venue: { id: 'venue-1', organizationId: 'org-1' },
})
const estructura = (rate: number) => ({
  id: `s-${rate}`,
  creditRate: D(rate),
  debitRate: D(rate),
  amexRate: D(rate),
  internationalRate: D(rate),
  includesTax: true,
  fixedCostPerTransaction: D(0),
  fixedFeePerTransaction: D(0.5),
})
/** PRIMARY al 8 %, SECONDARY al 2.5 % — el caso de Codex. */
const tarifaPorSlot = (slot: string) => (slot === 'PRIMARY' ? estructura(0.08) : slot === 'SECONDARY' ? estructura(0.025) : null)
const liquidacion = { estimatedSettlementDate: new Date('2026-09-15T00:00:00Z'), netSettlementAmount: 974.5, settlementConfigId: 'cfg-M2' }

beforeEach(() => {
  jest.clearAllMocks()
  configMock.mockResolvedValue({ config: { primaryAccount: { id: 'M1' }, secondaryAccount: null, tertiaryAccount: null }, source: 'venue' })
  pricingMock.mockImplementation(async (_venueId: string, slot: string) => {
    const t = tarifaPorSlot(slot)
    return t ? { pricing: [t], source: 'venue' } : null
  })
  settlementMock.mockResolvedValue(liquidacion)
  prismaMock.providerCostStructure.findFirst.mockReset().mockResolvedValue(estructura(0.02))
  prismaMock.transactionCost.create
    .mockReset()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'tc-1', ...data }))
  prismaMock.venueTransaction.update.mockReset().mockResolvedValue({})
  // Codex R12-8: con snapshot VALIDO la afiliación se resuelve por `findUnique` (sin la configuración de hoy).
  prismaMock.merchantAccount.findUnique
    .mockReset()
    .mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, active: true }))
  prismaMock.providerCostStructure.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.venuePricingStructure.findUnique.mockReset().mockResolvedValue(null)
})

/** Codex R4-3: el snapshot que el registrador congela en `processorData.pricing` al cobrar por M2 como SECONDARY (2.5 %). */
const congeladaM2 = {
  slot: 'SECONDARY',
  frozenAt: '2026-09-13T20:00:00.000Z',
  merchantAccountId: 'M2',
  venue: {
    structureId: 's-0.025',
    source: 'venue',
    accountType: 'SECONDARY',
    debitRate: '0.025',
    creditRate: '0.025',
    amexRate: '0.025',
    internationalRate: '0.025',
    includesTax: true,
    taxRate: null,
    fixedFeePerTransaction: '0.5',
  },
  provider: {
    structureId: 'pc-M2',
    debitRate: '0.02',
    creditRate: '0.02',
    amexRate: '0.02',
    internationalRate: '0.02',
    includesTax: true,
    taxRate: null,
    fixedCostPerTransaction: '0',
  },
}

describe('Codex R4-3 · la TARIFA congelada al cobrar manda sobre la configuración de hoy', () => {
  it('M2 cobró como SECONDARY al 2.5 %; hoy M2 es PRIMARY al 8 % y el SECONDARY es M3 al 8 %: el costo es 2.5 % y NO se consulta la tarifa de hoy', async () => {
    configMock.mockResolvedValue({
      config: { primaryAccount: { id: 'M2' }, secondaryAccount: { id: 'M3' }, tertiaryAccount: null },
      source: 'venue',
    })
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricingSlot: 'SECONDARY', pricing: congeladaM2 }))

    const resultado = await createTransactionCost('pay-1')

    expect(pricingMock).not.toHaveBeenCalled()
    expect(prismaMock.providerCostStructure.findFirst).not.toHaveBeenCalled()
    const data = prismaMock.transactionCost.create.mock.calls[0][0].data
    expect(data).toMatchObject({ merchantAccountId: 'M2', transactionType: 'CREDIT' })
    expect(data.venueRate).toBeCloseTo(0.025, 6)
    expect(data.venueChargeAmount).toBeCloseTo(25, 6)
    expect(data.providerRate).toBeCloseTo(0.02, 6)
    expect(resultado!.feeAmount).toBeCloseTo(25.5, 6)
    // Los ids de estructura son trazabilidad: si esas filas ya no existen, van a null (nunca una FK rota).
    expect(data.venuePricingStructureId).toBeNull()
    expect(data.providerCostStructureId).toBeNull()
  })

  it('la tarifa editada EN SITIO después del cobro (misma fila, 8 %) tampoco cambia el costo: sigue 2.5 %', async () => {
    configMock.mockResolvedValue({
      config: { primaryAccount: { id: 'M1' }, secondaryAccount: { id: 'M2' }, tertiaryAccount: null },
      source: 'venue',
    })
    pricingMock.mockResolvedValue({ pricing: [estructura(0.08)], source: 'venue' })
    prismaMock.venuePricingStructure.findUnique.mockResolvedValue({ id: 's-0.025' })
    prismaMock.providerCostStructure.findUnique.mockResolvedValue({ id: 'pc-M2' })
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricingSlot: 'SECONDARY', pricing: congeladaM2 }))

    await createTransactionCost('pay-1')

    const data = prismaMock.transactionCost.create.mock.calls[0][0].data
    expect(data.venueRate).toBeCloseTo(0.025, 6)
    expect(data).toMatchObject({ venuePricingStructureId: 's-0.025', providerCostStructureId: 'pc-M2' })
    expect(pricingMock).not.toHaveBeenCalled()
  })

  it('Codex R7 (P2-d) · un snapshot de OTRA afiliación (merchantAccountId distinto) es un snapshot INVÁLIDO, no ausente: NO se cae a la configuración vigente — la obligación queda pendiente con su motivo', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(
      pago('M2', { pricingSlot: 'SECONDARY', pricing: { ...congeladaM2, merchantAccountId: 'M9' } }),
    )
    prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'M2', active: true })

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/^COST_PENDING_INVALID_PRICING_SNAPSHOT: .*AFILIACION_DISTINTA/)

    expect(pricingMock).not.toHaveBeenCalled()
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('Codex R7 (P2-d) · `includesTax` como cadena ("false") en el snapshot: inválido ⇒ pendiente, nunca «sin IVA» ni «configuración de hoy»', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(
      pago('M2', { pricingSlot: 'SECONDARY', pricing: { ...congeladaM2, venue: { ...congeladaM2.venue, includesTax: 'false' } } }),
    )
    prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'M2', active: true })
    await expect(createTransactionCost('pay-1')).rejects.toThrow(/^COST_PENDING_INVALID_PRICING_SNAPSHOT: .*INCLUDES_TAX_INVALIDO/)
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('sin snapshot, la tarifa se busca A LA FECHA DEL COBRO (no «hoy») — y la configuración y la tarifa se leen por EL cliente transaccional que recibe la unidad (Codex R7 (g)), nunca por el global', async () => {
    const p = pago('M2', { pricingSlot: 'SECONDARY' })
    prismaMock.payment.findUnique.mockResolvedValue(p)
    prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'M2', active: true })
    // Un cliente DISTINTO del global (misma superficie por prototipo, otra identidad): sólo él tiene que aparecer en las lecturas.
    const tx = Object.create(prismaMock) as typeof prismaMock

    await createTransactionCost('pay-1', tx)

    expect(configMock).toHaveBeenCalledTimes(1)
    expect(configMock.mock.calls[0][1]).toBe(tx)
    expect(pricingMock).toHaveBeenCalledWith('venue-1', 'SECONDARY', p.createdAt, expect.anything())
    expect(pricingMock.mock.calls[0][3]).toBe(tx)
  })

  it('Codex R8 (g) · el FALLBACK a PRIMARY (snapshot AUSENTE, afiliación en SECONDARY sin tarifa) también lee por EL cliente transaccional que recibe la unidad, nunca por el global', async () => {
    configMock.mockResolvedValue({
      config: { primaryAccount: { id: 'M1' }, secondaryAccount: { id: 'M2' }, tertiaryAccount: null },
      source: 'venue',
    })
    pricingMock.mockImplementation(async (_venueId: string, slot: string) =>
      slot === 'PRIMARY' ? { pricing: [estructura(0.08)], source: 'venue' } : null,
    )
    const p = pago('M2', {})
    prismaMock.payment.findUnique.mockResolvedValue(p)
    const tx = Object.create(prismaMock) as typeof prismaMock

    await createTransactionCost('pay-1', tx)

    const primaria = pricingMock.mock.calls.filter(c => c[1] === 'PRIMARY')
    expect(primaria).toHaveLength(1)
    expect(primaria[0][2]).toBe(p.createdAt)
    expect(primaria[0][3]).toBe(tx)
    for (const llamada of pricingMock.mock.calls) expect(llamada[3]).toBe(tx)
    expect(prismaMock.transactionCost.create.mock.calls[0][0].data.venueRate).toBeCloseTo(0.08, 6)
  })

  it('tarifaCongeladaDeLaAfiliacion: congela el slot, las tasas del negocio para ese slot A LA FECHA y el costo del proveedor de ESA afiliación', async () => {
    configMock.mockResolvedValue({
      config: { primaryAccount: { id: 'M1' }, secondaryAccount: { id: 'M2' }, tertiaryAccount: null },
      source: 'venue',
    })
    const at = new Date('2026-09-13T21:00:00Z')
    const r = await tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', at)
    expect(r.slot).toBe('SECONDARY')
    // Codex R11-1: el cuarto argumento es el cliente de la transacción de captura (lo fija el describe «Codex R11-1»).
    expect(pricingMock).toHaveBeenCalledWith('venue-1', 'SECONDARY', at, expect.anything())
    expect(prismaMock.providerCostStructure.findFirst.mock.calls[0][0].where).toMatchObject({
      merchantAccountId: 'M2',
      effectiveFrom: { lte: at },
    })
    expect(r.pricing).toMatchObject({
      slot: 'SECONDARY',
      merchantAccountId: 'M2',
      frozenAt: at.toISOString(),
      venue: { structureId: 's-0.025', accountType: 'SECONDARY', creditRate: '0.025', fixedFeePerTransaction: '0.5', includesTax: true },
      provider: { structureId: 's-0.02', creditRate: '0.02' },
    })
    // Y lo que se congeló se vuelve a leer tal cual del Payment.
    expect(tarifaCongeladaDelPago({ pricing: r.pricing }, 'M2')).toMatchObject({ venue: { creditRate: '0.025' } })
    expect(tarifaCongeladaDelPago({ pricing: r.pricing }, 'M1')).toBeNull()
  })

  it('tarifaCongeladaDeLaAfiliacion: una afiliación fuera de la configuración congela slot null y sin tarifa del negocio (el costo queda pendiente y visible)', async () => {
    const r = await tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', new Date())
    expect(r.slot).toBeNull()
    expect(r.pricing?.venue).toBeNull()
    expect(pricingMock).not.toHaveBeenCalled()
    expect(tarifaCongeladaDelPago({ pricing: r.pricing }, 'M2')).toBeNull()
  })
})

it('la afiliación acreditada (M2) que ya NO está en la configuración conserva el costo con SU tarifa congelada (SECONDARY 2.5 %) y la liquidación a SU nombre — no el PRIMARY al 8 %', async () => {
  prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricingSlot: 'SECONDARY' }))
  prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'M2', active: false })

  const resultado = await createTransactionCost('pay-1')

  expect(prismaMock.merchantAccount.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'M2' } }))
  // El costo del PROVEEDOR se busca para la afiliación que cobró…
  expect(prismaMock.providerCostStructure.findFirst.mock.calls[0][0].where).toMatchObject({ merchantAccountId: 'M2' })
  // …la TARIFA es la del slot congelado (nunca se pidió la PRIMARY)…
  expect(pricingMock).toHaveBeenCalledWith('venue-1', 'SECONDARY', expect.any(Date), expect.anything())
  expect(pricingMock).not.toHaveBeenCalledWith('venue-1', 'PRIMARY', expect.anything(), expect.anything())
  const data = prismaMock.transactionCost.create.mock.calls[0][0].data
  expect(data).toMatchObject({ paymentId: 'pay-1', merchantAccountId: 'M2' })
  expect(data.venueRate).toBeCloseTo(0.025, 6)
  expect(data.venueChargeAmount).toBeCloseTo(25, 6)
  expect(resultado!.feeAmount).toBeCloseTo(25.5, 6)
  // …y la liquidación se calcula y se escribe para M2, con lo que devuelve la configuración de liquidación.
  // Codex R6 (diseño B): la liquidación se calcula con el MISMO cliente de la unidad (`db`), nunca con el global.
  expect(settlementMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'pay-1' }), 'M2', 'CREDIT', expect.anything())
  expect(prismaMock.venueTransaction.update).toHaveBeenCalledWith({
    where: { paymentId: 'pay-1' },
    data: {
      estimatedSettlementDate: liquidacion.estimatedSettlementDate,
      netSettlementAmount: liquidacion.netSettlementAmount,
      settlementConfigId: 'cfg-M2',
    },
  })
})

it('sin slot congelado, una afiliación fuera de la configuración NO se cobra con otra tarifa: lanza un motivo reconocible (pendiente y visible) y no crea costo', async () => {
  prismaMock.payment.findUnique.mockResolvedValue(pago('M2', {}))
  prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'M2', active: true })

  await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
  expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  expect(pricingMock).not.toHaveBeenCalledWith('venue-1', 'PRIMARY', expect.anything(), expect.anything())
})

it('con slot congelado pero SIN tarifa vigente para ese slot, tampoco cae a PRIMARY: lanza el mismo motivo', async () => {
  prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricingSlot: 'TERTIARY' }))
  prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'M2', active: true })

  await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
  expect(pricingMock).toHaveBeenCalledWith('venue-1', 'TERTIARY', expect.any(Date), expect.anything())
  expect(pricingMock).not.toHaveBeenCalledWith('venue-1', 'PRIMARY', expect.anything(), expect.anything())
  expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
})

it('si la afiliación acreditada ya no existe, el costo NO se calcula con otra: lanza (queda pendiente y recuperable)', async () => {
  prismaMock.payment.findUnique.mockResolvedValue(pago('M-borrada', { pricingSlot: 'SECONDARY' }))
  prismaMock.merchantAccount.findUnique.mockResolvedValue(null)

  await expect(createTransactionCost('pay-1')).rejects.toThrow(/no longer exists/)
  expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
})

it('regresión: un Payment SIN afiliación registrada (manual/QR) sigue cayendo al PRIMARY', async () => {
  prismaMock.payment.findUnique.mockResolvedValue(pago(null))

  await createTransactionCost('pay-1')

  expect(prismaMock.merchantAccount.findUnique).not.toHaveBeenCalled()
  expect(prismaMock.transactionCost.create.mock.calls[0][0].data).toMatchObject({ merchantAccountId: 'M1' })
  expect(prismaMock.transactionCost.create.mock.calls[0][0].data.venueRate).toBeCloseTo(0.08, 6)
})

it('regresión: una afiliación que SÍ está en la configuración (SECONDARY) sigue resolviéndose por la configuración, sin exigir slot congelado', async () => {
  configMock.mockResolvedValue({
    config: { primaryAccount: { id: 'M1' }, secondaryAccount: { id: 'M2' }, tertiaryAccount: null },
    source: 'venue',
  })
  prismaMock.payment.findUnique.mockResolvedValue(pago('M2', {}))

  await createTransactionCost('pay-1')

  expect(prismaMock.merchantAccount.findUnique).not.toHaveBeenCalled()
  expect(pricingMock).toHaveBeenCalledWith('venue-1', 'SECONDARY', expect.any(Date), expect.anything())
  expect(prismaMock.transactionCost.create.mock.calls[0][0].data).toMatchObject({ merchantAccountId: 'M2' })
})

describe('Codex R8-2 / R9-1 · un snapshot SIN_TARIFA (legible, misma afiliación, `venue: null`) NUNCA se resuelve con PRIMARY, ni con el slot que la afiliación ocupe HOY, ni con una tarifa que apareció DESPUÉS del cobro', () => {
  /** El registrador congela esto cuando M2 ocupaba un slot SIN estructura vigente al cobrar (o ningún slot: `slot: null`). */
  const sinTarifa = (slot: string | null) => ({
    pricing: { slot, frozenAt: '2026-09-13T20:00:00.000Z', merchantAccountId: 'M2', venue: null, provider: null },
  })
  const soloPrimary = () =>
    pricingMock.mockImplementation(async (_venueId: string, slot: string) =>
      slot === 'PRIMARY' ? { pricing: [estructura(0.08)], source: 'venue' } : null,
    )
  const conM2En = (slot: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' | null) =>
    configMock.mockResolvedValue({
      config: {
        primaryAccount: { id: slot === 'PRIMARY' ? 'M2' : 'M1' },
        secondaryAccount: slot === 'SECONDARY' ? { id: 'M2' } : null,
        tertiaryAccount: slot === 'TERTIARY' ? { id: 'M2' } : null,
      },
      source: 'venue',
    })

  it('el escenario de Codex: M2 sigue en SECONDARY, SECONDARY no tiene tarifa y PRIMARY tiene 8 % ⇒ lanza AFFILIATION_PRICING_UNRESOLVED; PRIMARY ni se consulta y no nace costo', async () => {
    conM2En('SECONDARY')
    soloPrimary()
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', sinTarifa('SECONDARY')))

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
    // Codex R9-1: «sin tarifa al cobrar» es un hecho histórico — no se consulta NINGUNA tarifa de hoy (ni SECONDARY ni PRIMARY).
    expect(pricingMock).not.toHaveBeenCalled()
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('cambio posterior de slot: hoy M2 es PRIMARY (8 %); el slot HISTÓRICO era SECONDARY y sigue sin tarifa ⇒ sigue pendiente, no cobra el 8 % del slot de hoy', async () => {
    conM2En('PRIMARY')
    soloPrimary()
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', sinTarifa('SECONDARY')))

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
    expect(pricingMock).not.toHaveBeenCalledWith('venue-1', 'PRIMARY', expect.anything(), expect.anything())
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('M2 ya FUERA de la configuración y slot histórico SECONDARY sin tarifa ⇒ pendiente, nunca PRIMARY (y la afiliación se conserva: no se sustituye por M1)', async () => {
    conM2En(null)
    soloPrimary()
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', sinTarifa('SECONDARY')))
    prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'M2', active: false })

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
    expect(pricingMock).not.toHaveBeenCalledWith('venue-1', 'PRIMARY', expect.anything(), expect.anything())
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('Codex R9-1 · el slot histórico SECONDARY «vuelve a tener» una tarifa vigente A LA FECHA DEL COBRO (2.5 %) ⇒ SIGUE pendiente: la tarifa no existía al cobrar, así que la de hoy —creada, retrodatada, reactivada o editada después— no acredita el cargo; ni se consulta', async () => {
    conM2En('SECONDARY')
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', sinTarifa('SECONDARY')))

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
    expect(pricingMock).not.toHaveBeenCalled()
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('Codex R9-1 · el escenario de Codex: `slot: null` (M2 estaba FUERA al cobrar); hoy M2 es PRIMARY y PRIMARY tiene un 8 % vigente desde ANTES del cobro ⇒ sigue pendiente: que M2 ocupe PRIMARY hoy no demuestra que esa tarifa correspondiera a su cargo de ayer ($80 sobre $1,000 que nadie contrató)', async () => {
    conM2En('PRIMARY')
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', sinTarifa(null)))

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
    expect(pricingMock).not.toHaveBeenCalledWith('venue-1', 'PRIMARY', expect.anything(), expect.anything())
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('Codex R9-1 · `slot: null` y hoy M2 en OTRO slot con tarifa disponible (TERTIARY) ⇒ sigue pendiente, sin consultar esa tarifa', async () => {
    conM2En('TERTIARY')
    pricingMock.mockImplementation(async (_venueId: string, slot: string) =>
      slot === 'TERTIARY' ? { pricing: [estructura(0.03)], source: 'venue' } : null,
    )
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', sinTarifa(null)))

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
    expect(pricingMock).not.toHaveBeenCalled()
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('sin slot histórico (`slot: null`, M2 estaba FUERA al cobrar): hoy M2 vuelve como SECONDARY pero SECONDARY no tiene tarifa ⇒ pendiente, nunca PRIMARY', async () => {
    conM2En('SECONDARY')
    soloPrimary()
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', sinTarifa(null)))

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
    expect(pricingMock).not.toHaveBeenCalled()
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('sin slot histórico y M2 todavía FUERA de la configuración ⇒ pendiente sin consultar ninguna tarifa (la recuperación R3/R4 exige que M2 vuelva a la configuración)', async () => {
    conM2En(null)
    soloPrimary()
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', sinTarifa(null)))
    prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'M2', active: true })

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
    expect(pricingMock).not.toHaveBeenCalled()
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })
})

describe('Codex R10-1 · una lectura que FALLA al congelar la tarifa deja un marcador DURABLE (nunca `pricing: null`), conserva la evidencia obtenida y NUNCA habilita PRIMARY', () => {
  const fecha = new Date('2026-09-13T20:00:00Z')
  /** La captura NUNCA lanza (el cobro no se interrumpe): si lanzara, esta ASERCIÓN es la que cae — no un error suelto. */
  const capturada = async (p: ReturnType<typeof tarifaCongeladaDeLaAfiliacion>) => {
    const r = await p.then(
      v => ({ ok: true as const, v }),
      e => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
    )
    expect(r).toMatchObject({ ok: true })
    return (r as { ok: true; v: Awaited<ReturnType<typeof tarifaCongeladaDeLaAfiliacion>> }).v
  }
  beforeEach(() =>
    configMock.mockResolvedValue({
      config: { primaryAccount: { id: 'M1' }, secondaryAccount: { id: 'M2' }, tertiaryAccount: null },
      source: 'venue',
    }),
  )

  it('falla la consulta del PROVEEDOR: la tarifa del negocio ya leída se conserva (snapshot VALIDO con `provider: null` y `capturaFallida.proveedor`)', async () => {
    prismaMock.providerCostStructure.findFirst.mockRejectedValueOnce(new Error('ECONNRESET'))
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(t.slot).toBe('SECONDARY')
    expect(t.pricing).toMatchObject({
      slot: 'SECONDARY',
      venue: { accountType: 'SECONDARY', creditRate: '0.025' },
      provider: null,
      capturaFallida: { proveedor: 'ECONNRESET' },
    })
    expect(leerTarifaCongelada({ pricing: t.pricing }, 'M2')).toMatchObject({ estado: 'VALIDO' })
  })

  it('falla la lectura de la tarifa del NEGOCIO: el snapshot NO es «sin tarifa» ni «sin snapshot» — `capturaFallida.negocio`, y la lectura da CAPTURA_FALLIDA', async () => {
    pricingMock.mockRejectedValueOnce(new Error('connection terminated'))
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(t.slot).toBe('SECONDARY')
    expect(t.pricing).toMatchObject({ slot: 'SECONDARY', venue: null, capturaFallida: { negocio: 'connection terminated' } })
    expect(t.pricing?.provider).not.toBeNull() // la evidencia del proveedor sí se obtuvo y se conserva
    expect(leerTarifaCongelada({ pricing: t.pricing }, 'M2')).toEqual({
      estado: 'CAPTURA_FALLIDA',
      motivo: 'NEGOCIO: connection terminated',
    })
  })

  it('falla la lectura de la CONFIGURACIÓN: sin slot, `capturaFallida.configuracion`, y la lectura da CAPTURA_FALLIDA', async () => {
    configMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(t.pricing).toMatchObject({ slot: null, venue: null, capturaFallida: { configuracion: 'ECONNRESET' } })
    expect(leerTarifaCongelada({ pricing: t.pricing }, 'M2')).toEqual({ estado: 'CAPTURA_FALLIDA', motivo: 'CONFIGURACION: ECONNRESET' })
  })

  it('sin ninguna lectura fallida el snapshot NO lleva `capturaFallida` (el marcador sólo existe cuando hay algo que decir)', async () => {
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(t.pricing).not.toHaveProperty('capturaFallida')
  })

  it('el escenario de Codex: M2 en SECONDARY sin tarifa, PRIMARY al 8 %, y al cobrar falló la lectura del negocio ⇒ el costo queda PENDIENTE con PRICING_CAPTURE_FAILED, NUNCA se calcula con PRIMARY ni se relee la tarifa «a la fecha del cobro»', async () => {
    const snapshot = {
      slot: 'SECONDARY',
      frozenAt: fecha.toISOString(),
      merchantAccountId: 'M2',
      venue: null,
      provider: null,
      capturaFallida: { negocio: 'ECONNRESET' },
    }
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricingSlot: 'SECONDARY', pricing: snapshot }))

    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_PRICING_CAPTURE_FAILED/)
    expect(pricingMock).not.toHaveBeenCalled()
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('con sólo el proveedor fallido al cobrar, el costo converge con la tarifa del negocio CONGELADA (2.5 %) y el costo del proveedor de su configuración a la fecha — la evidencia obtenida no se tira', async () => {
    const snapshot = { ...congeladaM2, provider: null, capturaFallida: { proveedor: 'ECONNRESET' } }
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricingSlot: 'SECONDARY', pricing: snapshot }))

    // Que el costo CONVERJA es la aserción (si el marcador del proveedor invalidara la evidencia, esto rechazaría con
    // COST_PENDING_PRICING_CAPTURE_FAILED — y esa caída tiene que contar como aserción, no como error suelto).
    await expect(createTransactionCost('pay-1')).resolves.toBeDefined()

    const data = prismaMock.transactionCost.create.mock.calls[0][0].data
    expect(data).toMatchObject({ merchantAccountId: 'M2' })
    expect(data.venueRate).toBeCloseTo(0.025, 6)
    expect(data.providerRate).toBeCloseTo(0.02, 6)
    expect(pricingMock).not.toHaveBeenCalled()
  })

  it('el registrador guarda `pricing: null` con afiliación (un escritor viejo o un dato tocado a mano) ⇒ INVALIDO, pendiente, nunca PRIMARY', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricingSlot: 'SECONDARY', pricing: null }))
    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_INVALID_PRICING_SNAPSHOT.*PRICING_NULO_CON_AFILIACION/)
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })
})

describe('Codex R11-1 · la captura lee la configuración y la tarifa del negocio desde UNA MISMA vista consistente de la base (transacción REPEATABLE READ): dos lecturas correctas no pueden congelar una combinación afiliación→slot→tarifa que nunca existió', () => {
  const fecha = new Date('2026-09-13T20:00:00Z')
  const capturada = async (p: ReturnType<typeof tarifaCongeladaDeLaAfiliacion>) => {
    const r = await p.then(
      v => ({ ok: true as const, v }),
      e => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
    )
    expect(r).toMatchObject({ ok: true })
    return (r as { ok: true; v: Awaited<ReturnType<typeof tarifaCongeladaDeLaAfiliacion>> }).v
  }
  beforeEach(() => {
    prismaMock.$transaction.mockReset().mockImplementation((cb: any) => cb(prismaMock))
    configMock.mockResolvedValue({
      config: { primaryAccount: { id: 'M1' }, secondaryAccount: { id: 'M2' }, tertiaryAccount: null },
      source: 'venue',
    })
  })
  afterAll(() => prismaMock.$transaction.mockReset().mockImplementation((cb: any) => cb(prismaMock)))

  it('abre UNA transacción REPEATABLE READ y lee la configuración Y la tarifa del negocio por SU cliente (la misma vista); el costo del proveedor sigue aparte, por el cliente global', async () => {
    const tx = { marca: 'cliente de la transacción de captura' }
    let opciones: unknown = null
    prismaMock.$transaction.mockImplementationOnce(async (cb: any, o: unknown) => {
      opciones = o
      return cb(tx)
    })
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(opciones).toMatchObject({ isolationLevel: 'RepeatableRead' })
    expect(configMock).toHaveBeenCalledTimes(1)
    expect(configMock).toHaveBeenCalledWith('venue-1', tx)
    expect(pricingMock).toHaveBeenCalledTimes(1)
    expect(pricingMock).toHaveBeenCalledWith('venue-1', 'SECONDARY', fecha, tx)
    expect(prismaMock.providerCostStructure.findFirst).toHaveBeenCalledTimes(1)
    expect(t.pricing).toMatchObject({
      slot: 'SECONDARY',
      venue: { accountType: 'SECONDARY', creditRate: '0.025' },
      provider: { creditRate: '0.02' },
    })
    expect(t.pricing).not.toHaveProperty('capturaFallida')
  })

  it('la intercalación de Codex, simulada en el mock: la tarifa que se lee por OTRO cliente (la configuración de hoy) ya dice 8 %, pero la captura pide la tarifa por el cliente de SU transacción y congela lo que esa vista dice (2.5 %)', async () => {
    const tx = { marca: 'vista de la captura' }
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => cb(tx))
    pricingMock.mockImplementation(async (_venueId: string, slot: string, _at: Date, db: unknown) => {
      // Por el cliente global (la base de hoy) SECONDARY ya es de M3 al 8 %; por la vista de la captura sigue al 2.5 %.
      const t = db === tx ? tarifaPorSlot(slot) : estructura(0.08)
      return t ? { pricing: [t], source: 'venue' } : null
    })
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(t.pricing).toMatchObject({ merchantAccountId: 'M2', slot: 'SECONDARY', venue: { creditRate: '0.025' } })
    expect(leerTarifaCongelada({ pricing: t.pricing }, 'M2')).toMatchObject({
      estado: 'VALIDO',
      tarifa: { venue: { creditRate: '0.025' } },
    })
  })

  it('si la transacción de captura falla EN SÍ (no pudo abrirse o cerrarse), el snapshot lleva `capturaFallida.total` — nunca `pricing: null`, nunca lanza — y la evidencia del proveedor se conserva', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error('pool agotado'))
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(t.pricing).toMatchObject({ merchantAccountId: 'M2', slot: null, venue: null, capturaFallida: { total: 'pool agotado' } })
    expect(t.pricing?.provider).not.toBeNull()
    expect(leerTarifaCongelada({ pricing: t.pricing }, 'M2')).toEqual({ estado: 'CAPTURA_FALLIDA', motivo: 'TOTAL: pool agotado' })
  })

  it('Codex R13 (cobertura) · el CALLBACK de la captura termina bien (configuración y tarifa leídas: 2.5 %) y DESPUÉS `$transaction` rechaza (el cierre de la transacción falla): lo leído NO se congela como VALIDO — `capturaFallida.total`, `venue: null`, y la lectura da CAPTURA_FALLIDA', async () => {
    const tx = { marca: 'vista de la captura' }
    let leido: unknown = null
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => {
      leido = await cb(tx) // el callback COMPLETA sus lecturas…
      throw new Error('could not serialize access due to concurrent update') // …y la transacción falla al cerrarse
    })
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(leido).toMatchObject({ slot: 'SECONDARY' })
    expect(String((leido as { negocio: { pricing: { creditRate: unknown }[] } }).negocio.pricing[0].creditRate)).toBe('0.025')
    expect(t.slot).toBeNull()
    expect(t.pricing).toMatchObject({
      merchantAccountId: 'M2',
      slot: null,
      venue: null,
      capturaFallida: { total: expect.stringMatching(/could not serialize access/) },
    })
    expect(t.pricing?.provider).not.toBeNull()
    expect(leerTarifaCongelada({ pricing: t.pricing }, 'M2')).toMatchObject({ estado: 'CAPTURA_FALLIDA' })
  })

  it("Codex R11 (P3) · un error SIN mensaje (`new Error('')`) también deja marcador: `capturaFallida.negocio` es una cadena NO vacía y la lectura da CAPTURA_FALLIDA (no SIN_TARIFA)", async () => {
    pricingMock.mockRejectedValueOnce(new Error(''))
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(t.pricing?.capturaFallida?.negocio).toMatch(/\S/)
    expect(leerTarifaCongelada({ pricing: t.pricing }, 'M2')).toMatchObject({ estado: 'CAPTURA_FALLIDA' })
  })

  it("Codex R11 (P3) · el lector decide por la PRESENCIA del marcador, no por su «verdad»: `{ capturaFallida: { negocio: '' } }` con `venue: null` ⇒ CAPTURA_FALLIDA, nunca SIN_TARIFA", () => {
    const snapshot = { ...congeladaM2, venue: null, provider: null, capturaFallida: { negocio: '' } }
    expect(leerTarifaCongelada({ pricing: snapshot }, 'M2')).toMatchObject({ estado: 'CAPTURA_FALLIDA' })
    expect(leerTarifaCongelada({ pricing: { ...snapshot, capturaFallida: { configuracion: '' } } }, 'M2')).toMatchObject({
      estado: 'CAPTURA_FALLIDA',
    })
    expect(leerTarifaCongelada({ pricing: { ...snapshot, capturaFallida: { total: '' } } }, 'M2')).toMatchObject({
      estado: 'CAPTURA_FALLIDA',
    })
    // Sólo el proveedor fallido (aunque sea con mensaje vacío) sigue sin invalidar la evidencia del negocio.
    expect(leerTarifaCongelada({ pricing: { ...congeladaM2, provider: null, capturaFallida: { proveedor: '' } } }, 'M2')).toMatchObject({
      estado: 'VALIDO',
    })
  })
})

describe('Codex R12 (pasada exhaustiva) · la familia de la tarifa congelada: afiliación en dos slots, VALIDO sin configuración de hoy, campos monetarios omitidos, método provisional', () => {
  const fecha = new Date('2026-09-13T20:00:00Z')
  const capturada = async (p: ReturnType<typeof tarifaCongeladaDeLaAfiliacion>) => {
    const r = await p.then(
      v => ({ ok: true as const, v }),
      e => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
    )
    expect(r).toMatchObject({ ok: true })
    return (r as { ok: true; v: Awaited<ReturnType<typeof tarifaCongeladaDeLaAfiliacion>> }).v
  }
  beforeEach(() => prismaMock.$transaction.mockReset().mockImplementation((cb: any) => cb(prismaMock)))
  afterAll(() => prismaMock.$transaction.mockReset().mockImplementation((cb: any) => cb(prismaMock)))

  it('R12-2 · la afiliación aparece en DOS slots (PRIMARY al 8 % y SECONDARY al 2.5 %): la captura NO elige — `capturaFallida.configuracion` nombra los slots, no se lee ninguna tarifa y el lector da CAPTURA_FALLIDA', async () => {
    configMock.mockResolvedValue({
      config: { primaryAccount: { id: 'M2' }, secondaryAccount: { id: 'M2' }, tertiaryAccount: null },
      source: 'venue',
    })
    const t = await capturada(tarifaCongeladaDeLaAfiliacion('venue-1', 'M2', fecha))
    expect(t.slot).toBeNull()
    expect(t.pricing).toMatchObject({
      slot: null,
      venue: null,
      capturaFallida: { configuracion: expect.stringMatching(/AFILIACION_EN_VARIOS_SLOTS: PRIMARY,SECONDARY/) },
    })
    expect(pricingMock).not.toHaveBeenCalled()
    expect(leerTarifaCongelada({ pricing: t.pricing }, 'M2')).toMatchObject({ estado: 'CAPTURA_FALLIDA' })
  })

  it('R12-2 · sin snapshot (Payment anterior al registrador) y con la afiliación en DOS slots HOY, el costo no se calcula con ninguno de los dos: pendiente con PRICING_CAPTURE_FAILED', async () => {
    configMock.mockResolvedValue({
      config: { primaryAccount: { id: 'M2' }, secondaryAccount: { id: 'M2' }, tertiaryAccount: null },
      source: 'venue',
    })
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', {}))
    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_PRICING_CAPTURE_FAILED.*PRIMARY,SECONDARY/)
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })

  it('R12-8 · un snapshot VALIDO converge SIN la configuración de pagos de hoy: la afiliación se resuelve por `findUnique` con el cliente de la unidad y la configuración no se consulta', async () => {
    configMock.mockResolvedValue(null)
    prismaMock.merchantAccount.findUnique.mockResolvedValue({ id: 'M2', active: true })
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricingSlot: 'SECONDARY', pricing: congeladaM2 }))
    await expect(createTransactionCost('pay-1')).resolves.toBeDefined()
    expect(configMock).not.toHaveBeenCalled()
    const data = prismaMock.transactionCost.create.mock.calls[0][0].data
    expect(data).toMatchObject({ merchantAccountId: 'M2' })
    expect(data.venueRate).toBeCloseTo(0.025, 6)
    expect(pricingMock).not.toHaveBeenCalled()
  })

  it('R12-9 · un campo monetario OMITIDO en el snapshot del negocio (includesTax / taxRate / fixedFeePerTransaction) es INVALIDO, no un default silencioso; el null EXPLÍCITO sigue siendo válido', () => {
    for (const campo of ['includesTax', 'taxRate', 'fixedFeePerTransaction'] as const) {
      const venue = { ...congeladaM2.venue } as Record<string, unknown>
      delete venue[campo]
      expect(leerTarifaCongelada({ pricing: { ...congeladaM2, venue } }, 'M2')).toEqual({
        estado: 'INVALIDO',
        motivo: `VENUE_CAMPO_AUSENTE_${campo}`,
      })
      expect(leerTarifaCongelada({ pricing: { ...congeladaM2, venue: { ...congeladaM2.venue, [campo]: null } } }, 'M2')).toMatchObject({
        estado: 'VALIDO',
      })
    }
    for (const campo of ['structureId', 'accountType', 'debitRate'] as const) {
      const venue = { ...congeladaM2.venue } as Record<string, unknown>
      delete venue[campo]
      expect(leerTarifaCongelada({ pricing: { ...congeladaM2, venue } }, 'M2')).toMatchObject({ estado: 'INVALIDO' })
    }
    // El proveedor conserva la regla R7: un proveedor incompleto se DESCARTA (su costo sale de la configuración a la fecha).
    const provider = { ...congeladaM2.provider } as Record<string, unknown>
    delete provider.fixedCostPerTransaction
    expect(leerTarifaCongelada({ pricing: { ...congeladaM2, provider } }, 'M2')).toMatchObject({
      estado: 'VALIDO',
      tarifa: { provider: null },
    })
  })

  it('R12-9 · un marcador `capturaFallida` mal formado (no es objeto, o un campo que no es cadena) no habilita VALIDO: INVALIDO con motivo', () => {
    expect(leerTarifaCongelada({ pricing: { ...congeladaM2, capturaFallida: 'ECONNRESET' } }, 'M2')).toEqual({
      estado: 'INVALIDO',
      motivo: 'CAPTURA_FALLIDA_ILEGIBLE',
    })
    expect(leerTarifaCongelada({ pricing: { ...congeladaM2, capturaFallida: { negocio: 123 } } }, 'M2')).toEqual({
      estado: 'INVALIDO',
      motivo: 'CAPTURA_FALLIDA_ILEGIBLE',
    })
    expect(leerTarifaCongelada({ pricing: { ...congeladaM2, capturaFallida: { proveedor: null } } }, 'M2')).toEqual({
      estado: 'INVALIDO',
      motivo: 'CAPTURA_FALLIDA_ILEGIBLE',
    })
    expect(leerTarifaCongelada({ pricing: { ...congeladaM2, capturaFallida: {} } }, 'M2')).toMatchObject({ estado: 'VALIDO' })
  })

  it('R12-3 · un método PROVISIONAL (el webhook lo inventó; la terminal todavía no lo acreditó) NO calcula costo aunque el snapshot sea VALIDO: pendiente con AWAITING_ACCREDITED_CARD_DATA, sin consumir intentos', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricingSlot: 'SECONDARY', pricing: congeladaM2, methodProvisional: true }))
    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AWAITING_ACCREDITED_CARD_DATA/)
    expect(prismaMock.transactionCost.create).not.toHaveBeenCalled()
  })
})

describe('Codex R10 (P2) · el snapshot se clasifica ANTES de exigir la configuración de pagos: sin configuración (ni del venue ni de la organización) la obligación conserva su motivo en vez de morir como fallo operativo', () => {
  beforeEach(() => configMock.mockResolvedValue(null))
  const snapshotSinTarifa = {
    slot: 'SECONDARY',
    frozenAt: '2026-09-13T20:00:00.000Z',
    merchantAccountId: 'M2',
    venue: null,
    provider: null,
  }

  it('SIN_TARIFA sin configuración ⇒ AFFILIATION_PRICING_UNRESOLVED (no «has no payment configuration»)', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricing: snapshotSinTarifa }))
    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_AFFILIATION_PRICING_UNRESOLVED/)
    expect(configMock).not.toHaveBeenCalled()
  })
  it('CAPTURA_FALLIDA sin configuración ⇒ PRICING_CAPTURE_FAILED', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricing: { ...snapshotSinTarifa, capturaFallida: { negocio: 'x' } } }))
    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_PRICING_CAPTURE_FAILED/)
    expect(configMock).not.toHaveBeenCalled()
  })
  it('INVALIDO sin configuración ⇒ INVALID_PRICING_SNAPSHOT', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', { pricing: { ...snapshotSinTarifa, merchantAccountId: 'M9' } }))
    await expect(createTransactionCost('pay-1')).rejects.toThrow(/COST_PENDING_INVALID_PRICING_SNAPSHOT/)
    expect(configMock).not.toHaveBeenCalled()
  })
  it('AUSENTE sin configuración sigue siendo el error genérico de configuración (ese sí depende de ella)', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', {}))
    await expect(createTransactionCost('pay-1')).rejects.toThrow(/has no payment configuration/)
  })
})

describe('Codex R9 (P2) · una tarifa HEREDADA de la organización (otra tabla) nunca pone su id en la FK `venuePricingStructureId`', () => {
  beforeEach(() =>
    configMock.mockResolvedValue({
      config: { primaryAccount: { id: 'M1' }, secondaryAccount: { id: 'M2' }, tertiaryAccount: null },
      source: 'venue',
    }),
  )
  it('sin snapshot (AUSENTE) y con la tarifa SECONDARY heredada de la ORGANIZACIÓN: el costo se calcula con sus tasas y `venuePricingStructureId` queda null (la FK sólo admite estructuras del venue)', async () => {
    pricingMock.mockImplementation(async (_venueId: string, slot: string) =>
      slot === 'SECONDARY' ? { pricing: [{ ...estructura(0.025), id: 'org-ps-1' }], source: 'organization' } : null,
    )
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', {}))

    await createTransactionCost('pay-1')

    const data = prismaMock.transactionCost.create.mock.calls[0][0].data
    expect(data).toMatchObject({ merchantAccountId: 'M2', venuePricingStructureId: null })
    expect(data.venueRate).toBeCloseTo(0.025, 6)
  })
  it('la misma tarifa cuando SÍ es del venue conserva su id (trazabilidad)', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(pago('M2', {}))

    await createTransactionCost('pay-1')

    expect(prismaMock.transactionCost.create.mock.calls[0][0].data).toMatchObject({
      merchantAccountId: 'M2',
      venuePricingStructureId: 's-0.025',
    })
  })
})

describe('Codex R5 (P2): el validador del snapshot no acepta null, booleanos ni cadenas vacías como tasas', () => {
  const base = { slot: 'SECONDARY', frozenAt: '2026-09-13T00:00:00.000Z', merchantAccountId: 'M2' }
  const negocio = (over: Record<string, unknown> = {}) => ({
    structureId: 's-1',
    source: 'venue',
    accountType: 'SECONDARY',
    debitRate: '0.02',
    creditRate: '0.025',
    amexRate: '0.035',
    internationalRate: '0.045',
    includesTax: true,
    taxRate: null,
    fixedFeePerTransaction: '0.5',
    ...over,
  })
  const proveedor = (over: Record<string, unknown> = {}) => ({
    structureId: 's-p',
    debitRate: '0.015',
    creditRate: '0.02',
    amexRate: '0.03',
    internationalRate: '0.035',
    includesTax: true,
    taxRate: null,
    fixedCostPerTransaction: '0.3',
    ...over,
  })

  it.each([
    ['null', null],
    ['true', true],
    ['false', false],
    ['cadena vacía', ''],
    ['sólo espacios', '  '],
    ['texto', 'abc'],
    ['undefined', undefined],
    ['hexadecimal (Number() lo acepta como 16, parseFloat lo lee como 0)', '0x10'],
    ['infinito', 'Infinity'],
    ['infinito por longitud (400 dígitos: pasa la regex, no la finitud)', '1'.repeat(400)],
    ['binario (Number() lo acepta como 2)', '0b10'],
    ['número seguido de basura', '12abc'],
    ['con espacios internos', '0. 025'],
  ])('creditRate = %s en la tarifa del negocio ⇒ snapshot inválido (null), no una tasa de 0 o de 1', (_nombre, valor) => {
    expect(tarifaCongeladaDelPago({ pricing: { ...base, venue: negocio({ creditRate: valor }), provider: proveedor() } }, 'M2')).toBeNull()
  })

  it('una tasa numérica (número o cadena numérica) sigue siendo válida', () => {
    expect(
      tarifaCongeladaDelPago({ pricing: { ...base, venue: negocio({ creditRate: 0.025 }), provider: proveedor() } }, 'M2'),
    ).not.toBeNull()
    // Codex R6 (j): la notación científica como CADENA es un decimal válido (la misma cadena se valida y se convierte).
    expect(
      tarifaCongeladaDelPago({ pricing: { ...base, venue: negocio({ creditRate: '1e-2' }), provider: proveedor() } }, 'M2'),
    ).toMatchObject({
      venue: { creditRate: '1e-2' },
    })
    expect(tarifaCongeladaDelPago({ pricing: { ...base, venue: negocio(), provider: proveedor() } }, 'M2')).toMatchObject({
      venue: { creditRate: '0.025' },
    })
  })

  it('un costo fijo o un IVA que no son número ni null invalidan el snapshot; null sigue valiendo (sin cargo fijo)', () => {
    expect(
      tarifaCongeladaDelPago({ pricing: { ...base, venue: negocio({ fixedFeePerTransaction: true }), provider: proveedor() } }, 'M2'),
    ).toBeNull()
    expect(tarifaCongeladaDelPago({ pricing: { ...base, venue: negocio({ taxRate: '' }), provider: proveedor() } }, 'M2')).toBeNull()
    expect(
      tarifaCongeladaDelPago({ pricing: { ...base, venue: negocio({ fixedFeePerTransaction: null }), provider: proveedor() } }, 'M2'),
    ).not.toBeNull()
  })

  it('el proveedor con tasas inválidas se descarta (provider null) sin invalidar la tarifa del negocio', () => {
    const r = tarifaCongeladaDelPago({ pricing: { ...base, venue: negocio(), provider: proveedor({ debitRate: null }) } }, 'M2')
    expect(r).not.toBeNull()
    expect(r!.provider).toBeNull()
  })
})

describe('Codex R7 (P2-d) · el snapshot tiene estados DISTINTOS: AUSENTE, VALIDO, SIN_TARIFA e INVALIDO — un snapshot ilegible NO es un snapshot ausente', () => {
  const base = { slot: 'SECONDARY', frozenAt: new Date().toISOString(), merchantAccountId: 'M2' }
  const negocio = (over: Record<string, unknown> = {}) => ({
    structureId: 'vps-1',
    source: 'venue',
    accountType: 'SECONDARY',
    debitRate: '0.02',
    creditRate: '0.025',
    amexRate: '0.03',
    internationalRate: '0.035',
    includesTax: true,
    taxRate: null,
    fixedFeePerTransaction: '0.5',
    ...over,
  })
  it('sin `pricing` ⇒ AUSENTE (se calcula con la configuración vigente); `pricing: null` sólo es AUSENTE SIN afiliación registrada (manual/QR) — con afiliación es INVALIDO (Codex R10-1: el registrador nunca lo escribe así)', () => {
    expect(leerTarifaCongelada({ pricingSlot: 'PRIMARY' }, 'M2')).toEqual({ estado: 'AUSENTE' })
    expect(leerTarifaCongelada(null, 'M2')).toEqual({ estado: 'AUSENTE' })
    expect(leerTarifaCongelada({ pricing: null }, null)).toEqual({ estado: 'AUSENTE' })
    expect(leerTarifaCongelada({ pricing: null }, 'M2')).toEqual({ estado: 'INVALIDO', motivo: 'PRICING_NULO_CON_AFILIACION' })
  })
  it.each([
    ['la configuración', { configuracion: 'ECONNRESET' }, 'CONFIGURACION: ECONNRESET'],
    ['la tarifa del negocio', { negocio: 'connection terminated' }, 'NEGOCIO: connection terminated'],
    ['todo (ni siquiera se intentó)', { total: 'timeout' }, 'TOTAL: timeout'],
  ])(
    'Codex R10-1 · una captura FALLIDA de %s al cobrar ⇒ CAPTURA_FALLIDA con su motivo — aunque el snapshot tenga slot y `venue: null` (no es SIN_TARIFA: no se sabe qué había)',
    (_n, capturaFallida, motivo) => {
      const datos = { pricing: { ...base, venue: null, provider: null, capturaFallida } }
      expect(leerTarifaCongelada(datos, 'M2')).toEqual({ estado: 'CAPTURA_FALLIDA', motivo })
      expect(tarifaCongeladaDelPago(datos, 'M2')).toBeNull()
    },
  )
  it('Codex R10-1 · si SÓLO falló la consulta del proveedor, la evidencia del negocio se conserva y se usa: VALIDO (con la tarifa del negocio y `provider: null`) o SIN_TARIFA si al cobrar no había tarifa', () => {
    const conTarifa = { pricing: { ...base, venue: negocio(), provider: null, capturaFallida: { proveedor: 'ECONNRESET' } } }
    expect(leerTarifaCongelada(conTarifa, 'M2')).toMatchObject({
      estado: 'VALIDO',
      tarifa: { venue: { creditRate: '0.025' }, provider: null },
    })
    const sinTarifa = { pricing: { ...base, venue: null, provider: null, capturaFallida: { proveedor: 'ECONNRESET' } } }
    expect(leerTarifaCongelada(sinTarifa, 'M2')).toEqual({ estado: 'SIN_TARIFA', slot: 'SECONDARY' })
  })
  it('legible y de la misma afiliación ⇒ VALIDO', () => {
    expect(leerTarifaCongelada({ pricing: { ...base, venue: negocio(), provider: null } }, 'M2')).toMatchObject({ estado: 'VALIDO' })
  })
  it.each([
    ['de OTRA afiliación', { pricing: { ...base, merchantAccountId: 'M1', venue: negocio(), provider: null } }, 'AFILIACION_DISTINTA'],
    ['sin afiliación', { pricing: { ...base, merchantAccountId: undefined, venue: negocio(), provider: null } }, 'SIN_AFILIACION'],
    [
      '`includesTax` como CADENA ("false" no es «no incluye IVA»)',
      { pricing: { ...base, venue: negocio({ includesTax: 'false' }), provider: null } },
      'VENUE_INCLUDES_TAX_INVALIDO',
    ],
    [
      'una tasa hexadecimal',
      { pricing: { ...base, venue: negocio({ creditRate: '0x10' }), provider: null } },
      'VENUE_TASA_INVALIDA_creditRate',
    ],
    ['con tasas del negocio que no son un objeto', { pricing: { ...base, venue: 'SECONDARY', provider: null } }, 'VENUE_SIN_TASAS'],
    [
      'con tasas del negocio a las que les falta una tasa',
      { pricing: { ...base, venue: negocio({ debitRate: undefined }), provider: null } },
      // Codex R12-9: la OMISIÓN se denuncia antes que el formato (una tasa ausente no es una tasa inválida: falta).
      'VENUE_CAMPO_AUSENTE_debitRate',
    ],
    [
      'con una tasa del negocio con formato inválido',
      { pricing: { ...base, venue: negocio({ debitRate: 'x' }), provider: null } },
      'VENUE_TASA_INVALIDA_debitRate',
    ],
    ['slot desconocido', { pricing: { ...base, slot: 'CUARTO', venue: negocio(), provider: null } }, 'SLOT_INVALIDO'],
    // Codex R8 (P2): un campo `venue` OMITIDO no acredita el `venue: null` EXPLÍCITO que escribe el registrador.
    ['sin el campo `venue` (snapshot incompleto)', { pricing: { ...base, provider: null } }, 'VENUE_AUSENTE'],
    ['con `venue: undefined` (tampoco es el null explícito)', { pricing: { ...base, venue: undefined, provider: null } }, 'VENUE_AUSENTE'],
    ['`pricing` que no es un objeto', { pricing: 'PRIMARY' }, 'PRICING_NO_ES_OBJETO'],
  ])('%s ⇒ INVALIDO con motivo (nunca se lee como ausente)', (_n, datos, motivo) => {
    expect(leerTarifaCongelada(datos, 'M2')).toEqual({ estado: 'INVALIDO', motivo })
    // La lectura compatible (`tarifaCongeladaDelPago`) sigue devolviendo null para lo que no es VALIDO.
    expect(tarifaCongeladaDelPago(datos, 'M2')).toBeNull()
  })
  it.each([
    ['sin slot (la afiliación estaba FUERA de la configuración al cobrar)', null],
    ['con slot pero sin estructura vigente para ese slot al cobrar', 'SECONDARY'],
  ])(
    '`venue: null` %s ⇒ SIN_TARIFA: legible y de la misma afiliación, pero sin tarifa contratada — no es inválido ni ausente',
    (_n, slot) => {
      const datos = { pricing: { ...base, slot, venue: null, provider: null } }
      expect(leerTarifaCongelada(datos, 'M2')).toEqual({ estado: 'SIN_TARIFA', slot })
      expect(tarifaCongeladaDelPago(datos, 'M2')).toBeNull()
    },
  )
})
