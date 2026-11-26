/**
 * D28 (hz:be99f328:D28) contra Postgres real: pausar y reactivar el programa de referidos no cambia NADA de lo guardado.
 *
 * Antes el panel reactivaba por `/activate` con los números de fábrica y un cupón de % por nivel: un nivel con producto
 * gratis se volvía cupón. `reactivateReferralProgram` sólo prende la fila en pausa (CAS), una vez aunque lleguen dos.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { activateReferralProgram, deactivateReferralProgram, reactivateReferralProgram } from '@/services/referrals/referralProgram.service'
import { cleanupReferralFixtureData, ReferralFixtureIds, teardownReferralFixture } from '../../__helpers__/referral-fixture-cleanup'

jest.setTimeout(60000)

const esperar = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('Referidos · reactivar sin reescribir (D28)', () => {
  const fixtureKey = `${process.pid}-${Date.now()}`
  const fixtureIds: ReferralFixtureIds = { venueId: undefined, organizationId: undefined, staffIds: [] }
  let venueId: string
  let productId: string

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Reactivar ${fixtureKey}`,
        slug: `reactivar-${fixtureKey}`,
        email: `reactivar-${fixtureKey}@example.test`,
        phone: '5500000000',
      },
    })
    fixtureIds.organizationId = organization.id
    const venue = await prisma.venue.create({
      data: { organizationId: organization.id, name: `Reactivar ${fixtureKey}`, slug: `reactivar-${fixtureKey}` },
    })
    venueId = venue.id
    fixtureIds.venueId = venue.id
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Bebidas', slug: `bebidas-${fixtureKey}` } })
    const product = await prisma.product.create({
      data: { venueId, sku: `SKU-${fixtureKey}`, name: 'Smoothie', categoryId: category.id, price: new Prisma.Decimal(80) },
    })
    productId = product.id
  })

  beforeEach(async () => {
    await cleanupReferralFixtureData(prisma, venueId)
  })

  afterAll(async () => {
    // Sin sucursal (falló la preparación) no se borra nada: `deleteMany({ where: { venueId: undefined } })` borraría todo.
    if (venueId) {
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
    }
    await teardownReferralFixture(prisma, fixtureIds)
  })

  async function armarYPausar() {
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 12,
      tier1ReferralsRequired: 5,
      tier2ReferralsRequired: 9,
      tier3ReferralsRequired: 15,
      rewardCouponExpiryDays: 30,
      codePrefix: 'TESTSMOKE',
      tiers: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
        { tierLevel: 2, rewardType: 'FREE_PRODUCT', rewardProductId: productId, rewardQuantity: 1 },
        { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
      ],
    })
    await deactivateReferralProgram({ venueId, reason: 'prueba D28' })
    return prisma.referralProgramConfig.findUniqueOrThrow({
      where: { venueId },
      include: { tierRewards: { where: { active: true }, orderBy: { tierLevel: 'asc' } } },
    })
  }

  it('reactivar deja el premio, los niveles, la vigencia y el producto gratis tal cual', async () => {
    const antes = await armarYPausar()
    expect(antes.active).toBe(false)

    const r = await reactivateReferralProgram({ venueId })

    expect(r).toEqual({ reactivated: true })
    const despues = await prisma.referralProgramConfig.findUniqueOrThrow({
      where: { venueId },
      include: { tierRewards: { where: { active: true }, orderBy: { tierLevel: 'asc' } } },
    })
    expect(despues.active).toBe(true)
    expect(Number(despues.newCustomerDiscountPercent)).toBe(12)
    expect([despues.tier1ReferralsRequired, despues.tier2ReferralsRequired, despues.tier3ReferralsRequired]).toEqual([5, 9, 15])
    expect(despues.rewardCouponExpiryDays).toBe(30)
    // Las MISMAS filas de premio (mismo id): no se versionaron ni se cambiaron por un cupón.
    expect(despues.tierRewards.map(t => [t.id, t.tierLevel, t.rewardType, t.rewardProductId])).toEqual(
      antes.tierRewards.map(t => [t.id, t.tierLevel, t.rewardType, t.rewardProductId]),
    )
    expect(despues.tierRewards.find(t => t.tierLevel === 2)).toMatchObject({ rewardType: 'FREE_PRODUCT', rewardProductId: productId })
  })

  it('dos reactivaciones a la vez prenden una sola vez y dejan un solo rastro', async () => {
    await armarYPausar()

    const resultados = await Promise.all([reactivateReferralProgram({ venueId }), reactivateReferralProgram({ venueId })])

    expect(resultados.filter(r => r.reactivated)).toHaveLength(1)
    const rastros = await prisma.activityLog.findMany({
      where: { venueId, action: 'REFERRAL_PROGRAM_ACTIVATED', data: { path: ['reactivated'], equals: true } },
    })
    expect(rastros).toHaveLength(1)
  })

  it('reparte código a la clienta dada de alta en la pausa y no toca el de quien ya tenía', async () => {
    await armarYPausar()
    const sinCodigo = await prisma.customer.create({
      data: { venueId, firstName: 'Nueva', lastName: 'Pausa', phone: `5599999${String(Date.now()).slice(-3)}` },
    })
    const conCodigo = await prisma.customer.create({
      data: { venueId, firstName: 'Ya', lastName: 'Tenia', phone: '5599999001', referralCode: 'TESTSMOKE-YATENIA' },
    })

    await reactivateReferralProgram({ venueId })

    let nueva = await prisma.customer.findUniqueOrThrow({ where: { id: sinCodigo.id } })
    for (let i = 0; i < 40 && !nueva.referralCode; i++) {
      await esperar(250)
      nueva = await prisma.customer.findUniqueOrThrow({ where: { id: sinCodigo.id } })
    }
    expect(nueva.referralCode).toEqual(expect.any(String))
    const ya = await prisma.customer.findUniqueOrThrow({ where: { id: conCodigo.id } })
    expect(ya.referralCode).toBe('TESTSMOKE-YATENIA')
  })

  it('sin configuración guardada no crea una', async () => {
    await expect(reactivateReferralProgram({ venueId })).rejects.toThrow('REFERRAL_PROGRAM_NOT_CONFIGURED')
    expect(await prisma.referralProgramConfig.findUnique({ where: { venueId } })).toBeNull()
  })
})
