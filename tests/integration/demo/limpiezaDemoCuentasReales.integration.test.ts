/**
 * Convertir un negocio demo NO borra sus cuentas de cobro reales ni sus tarifas (encargo fe2b91, tarjeta hz:87f4b879:D7).
 *
 * Antes: si la configuración de pagos del negocio tenía ALGUNA cuenta demo, `cleanDemoData` borraba la configuración ENTERA y
 * todas sus tarifas, aunque otra posición ya tuviera la cuenta real del negocio (la que dio de alta antes de convertirse). El
 * negocio se quedaba sin cuenta de cobro ni tarifa.
 *
 * Ahora, con la principal REAL se limpia sólo la posición con cuenta demo (y la tarifa de ESA posición). Con la principal DEMO
 * se borra la configuración como siempre (el negocio vuelve a heredar de su organización), pero las cuentas reales se conservan
 * y la bitácora dice cuáles quedaron sueltas. Una cuenta demo que siga en otra configuración no se borra.
 *
 * Contra base real. Correr (base desechable): npx jest --selectProjects=integration --runInBand --ci \
 *   --runTestsByPath tests/integration/demo/limpiezaDemoCuentasReales.integration.test.ts
 */
import { randomUUID } from 'crypto'
import { AccountType, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cleanDemoData } from '@/services/onboarding/demoCleanup.service'
import { assignProcessorAndApproveKyc } from '@/services/superadmin/kycReview.service'
// `integration-setup.ts` mockea la bitácora (fire-and-forget): se comprueba la llamada, no la fila.
import { logAction } from '@/services/dashboard/activity-log.service'

const D = (n: number) => new Prisma.Decimal(n)
const llave = `demo-cuentas-${randomUUID().slice(0, 8)}`
const negocios: string[] = []
const cuentas: string[] = []
let providerId: string

beforeAll(async () => {
  const p = await prisma.paymentProvider.create({
    data: { code: `${llave}-PROV`, name: 'Proveedor de prueba', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  providerId = p.id
})

afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { action: 'DEMO_CLEANUP_ECOMMERCE_CHANNEL_UNLINKED', venueId: { in: negocios } } })
  await prisma.ecommerceMerchant.deleteMany({ where: { venueId: { in: negocios } } })
  await prisma.organizationPaymentConfig.deleteMany({ where: { organization: { name: { startsWith: llave } } } })
  for (const venueId of negocios) {
    await prisma.venuePricingStructure.deleteMany({ where: { venueId } })
    await prisma.venuePaymentConfig.deleteMany({ where: { venueId } })
  }
  await prisma.providerCostStructure.deleteMany({ where: { merchantAccountId: { in: cuentas } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: cuentas } } })
  await prisma.venue.deleteMany({ where: { id: { in: negocios } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: llave } } })
  await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
})

async function negocioTrial(sufijo: string): Promise<string> {
  return (await negocioTrialConOrg(sufijo)).venueId
}

async function negocioTrialConOrg(sufijo: string): Promise<{ venueId: string; orgId: string }> {
  const org = await prisma.organization.create({
    data: { name: `${llave}-${sufijo}`, email: `${llave}-${sufijo}@example.test`, phone: '5500000000' },
  })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: `Prueba ${sufijo}`, slug: `${llave}-${sufijo}`, status: 'TRIAL' },
  })
  negocios.push(venue.id)
  return { venueId: venue.id, orgId: org.id }
}

/** Una cuenta como las que siembra `demoSeed` (externalMerchantId con «demo») o una real del negocio. */
async function cuenta(tipo: 'demo' | 'real', sufijo: string): Promise<string> {
  const m = await prisma.merchantAccount.create({
    data: {
      providerId,
      externalMerchantId: tipo === 'demo' ? `blumon_demo_${sufijo}` : `afiliacion-${sufijo}`,
      displayName: tipo === 'demo' ? 'Cuenta Blumon TPV' : 'Cuenta del negocio',
      credentialsEncrypted: {},
    },
  })
  cuentas.push(m.id)
  await prisma.providerCostStructure.create({
    data: {
      providerId,
      merchantAccountId: m.id,
      debitRate: D(0.015),
      creditRate: D(0.025),
      amexRate: D(0.035),
      internationalRate: D(0.04),
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
  })
  return m.id
}

async function tarifa(venueId: string, accountType: AccountType) {
  return prisma.venuePricingStructure.create({
    data: {
      venueId,
      accountType,
      debitRate: D(0.02),
      creditRate: D(0.03),
      amexRate: D(0.04),
      internationalRate: D(0.045),
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
  })
}

const bitacoraDelCanal = (canalId: string) =>
  prisma.activityLog.findMany({
    where: { action: 'DEMO_CLEANUP_ECOMMERCE_CHANNEL_UNLINKED', entityId: canalId },
    select: { venueId: true, entity: true, data: true },
    take: 5,
  })

const tiposDeTarifa = async (venueId: string) =>
  (await prisma.venuePricingStructure.findMany({ where: { venueId }, select: { accountType: true }, take: 10 }))
    .map(t => t.accountType)
    .sort()

describe('cleanDemoData × cuentas de cobro reales', () => {
  beforeEach(() => jest.mocked(logAction).mockClear())

  it('🔴 principal REAL + secundaria demo: sólo se limpia la secundaria; la real, su tarifa y su costo se quedan', async () => {
    const venueId = await negocioTrial('real-demo')
    const real = await cuenta('real', 'a1')
    const demo = await cuenta('demo', 'a2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: real, secondaryAccountId: demo } })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')

    const r = await cleanDemoData(venueId, null)

    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId } })
    expect(config).not.toBeNull()
    expect(config!.primaryAccountId).toBe(real)
    expect(config!.secondaryAccountId).toBeNull()
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY'])
    expect(await prisma.merchantAccount.findUnique({ where: { id: real } })).not.toBeNull()
    expect(await prisma.providerCostStructure.count({ where: { merchantAccountId: real } })).toBe(1)
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo } })).toBeNull()
    expect(r.deletedMerchantAccounts).toBe(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DEMO_PAYMENT_POSITIONS_CLEANED',
        venueId,
        data: expect.objectContaining({ limpiadas: ['SECONDARY'], configuracionBorrada: false, cuentasRealesDesligadas: [] }),
      }),
    )
  })

  it('🔴 principal y secundaria REALES + terciaria demo: sólo se limpia la terciaria', async () => {
    const venueId = await negocioTrial('real-real-demo')
    const real1 = await cuenta('real', 'b1')
    const real2 = await cuenta('real', 'b2')
    const demo = await cuenta('demo', 'b3')
    await prisma.venuePaymentConfig.create({
      data: { venueId, primaryAccountId: real1, secondaryAccountId: real2, tertiaryAccountId: demo },
    })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')
    await tarifa(venueId, 'TERTIARY')

    await cleanDemoData(venueId, null)

    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId } })
    expect(config).toMatchObject({ primaryAccountId: real1, secondaryAccountId: real2, tertiaryAccountId: null })
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY', 'SECONDARY'])
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo } })).toBeNull()
  })

  it('principal demo + secundaria REAL (Codex r3): como antes se borra la configuración, pero la cuenta real y su costo se conservan', async () => {
    const venueId = await negocioTrial('demo-real')
    const demo = await cuenta('demo', 'c1')
    const real = await cuenta('real', 'c2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: demo, secondaryAccountId: real } })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')

    const r = await cleanDemoData(venueId, null)

    // Sin configuración propia: el negocio vuelve a heredar las cuentas de su organización (como antes).
    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toBeNull()
    expect(await tiposDeTarifa(venueId)).toEqual([])
    expect(await prisma.merchantAccount.findUnique({ where: { id: real } })).not.toBeNull()
    expect(await prisma.providerCostStructure.count({ where: { merchantAccountId: real } })).toBe(1)
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo } })).toBeNull()
    expect(r.deletedMerchantAccounts).toBe(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DEMO_PAYMENT_POSITIONS_CLEANED',
        venueId,
        data: expect.objectContaining({ configuracionBorrada: true, cuentasRealesDesligadas: [{ posicion: 'SECONDARY', id: real }] }),
      }),
    )
  })

  it('[real, demo, demo]: se vacían las dos demo con sus tarifas; la principal real y su tarifa se quedan', async () => {
    const venueId = await negocioTrial('real-demo-demo')
    const real = await cuenta('real', 'f1')
    const demo1 = await cuenta('demo', 'f2')
    const demo2 = await cuenta('demo', 'f3')
    await prisma.venuePaymentConfig.create({
      data: { venueId, primaryAccountId: real, secondaryAccountId: demo1, tertiaryAccountId: demo2 },
    })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')
    await tarifa(venueId, 'TERTIARY')

    await cleanDemoData(venueId, null)

    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toMatchObject({
      primaryAccountId: real,
      secondaryAccountId: null,
      tertiaryAccountId: null,
    })
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY'])
    expect(await prisma.merchantAccount.count({ where: { id: { in: [demo1, demo2] } } })).toBe(0)
  })

  it('Codex r2 #1: la tarifa de una posición demo se borra aunque la use un canal en línea (el canal pierde el enlace, como antes)', async () => {
    const venueId = await negocioTrial('canal')
    const real = await cuenta('real', 'g1')
    const demo = await cuenta('demo', 'g2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: real, secondaryAccountId: demo } })
    await tarifa(venueId, 'PRIMARY')
    const secundaria = await tarifa(venueId, 'SECONDARY')
    const canal = await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: 'Tienda en línea de prueba',
        contactEmail: `${llave}-canal@example.test`,
        publicKey: `pk_test_${llave}`,
        secretKeyHash: `hash-${llave}`,
        providerId,
        providerCredentials: {},
        pricingStructureId: secundaria.id,
      },
    })

    const r = await cleanDemoData(venueId, null)

    expect((await prisma.venuePaymentConfig.findUnique({ where: { venueId } }))!.secondaryAccountId).toBeNull()
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY'])
    expect((await prisma.ecommerceMerchant.findUnique({ where: { id: canal.id } }))!.pricingStructureId).toBeNull()
    // hz:nube0000:na4b2c82: ya no es en silencio. El canal que perdió su tarifa sale en el resultado y en la bitácora.
    expect(r.canalesEnLineaSinTarifa).toEqual([
      { id: canal.id, venueId, channelName: 'Web Principal', perdio: ['tarifa'], pricingStructureId: secundaria.id },
    ])
    // La fila va DENTRO de la transacción de la limpieza (no por `logAction`): se busca en la base.
    expect(await bitacoraDelCanal(canal.id)).toEqual([
      expect.objectContaining({
        venueId,
        entity: 'EcommerceMerchant',
        data: expect.objectContaining({ perdio: ['tarifa'], pricingStructureId: secundaria.id }),
      }),
    ])
  })

  it('hz:nube0000:na4b2c82: el canal ligado al COSTO de la cuenta demo que se borra también queda en el resultado y la bitácora', async () => {
    const venueId = await negocioTrial('canal-costo')
    const demo = await cuenta('demo', 'k1')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: demo } })
    const tarifaDemo = await tarifa(venueId, 'PRIMARY')
    const costo = await prisma.providerCostStructure.findFirstOrThrow({ where: { merchantAccountId: demo } })
    const canal = await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        channelName: 'App',
        businessName: 'Canal con costo demo',
        contactEmail: `${llave}-canal-costo@example.test`,
        publicKey: `pk_test_${llave}_costo`,
        secretKeyHash: `hash-${llave}-costo`,
        providerId,
        providerCredentials: {},
        pricingStructureId: tarifaDemo.id,
        costStructureId: costo.id,
      },
    })

    const r = await cleanDemoData(venueId, null)

    const despues = await prisma.ecommerceMerchant.findUniqueOrThrow({ where: { id: canal.id } })
    expect(despues.pricingStructureId).toBeNull()
    expect(despues.costStructureId).toBeNull()
    expect(r.canalesEnLineaSinTarifa).toEqual([
      {
        id: canal.id,
        venueId,
        channelName: 'App',
        perdio: ['tarifa', 'costo'],
        pricingStructureId: tarifaDemo.id,
        costStructureId: costo.id,
      },
    ])
    expect(await bitacoraDelCanal(canal.id)).toEqual([
      expect.objectContaining({ venueId, data: expect.objectContaining({ perdio: ['tarifa', 'costo'], costStructureId: costo.id }) }),
    ])
  })

  it('Codex r1/r2 #2: una cuenta demo que también usa la organización no se borra y la limpieza NO se cae', async () => {
    const { venueId, orgId } = await negocioTrialConOrg('org-usa-demo')
    const demo1 = await cuenta('demo', 'h1')
    const demo2 = await cuenta('demo', 'h2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: demo1, secondaryAccountId: demo2 } })
    await prisma.organizationPaymentConfig.create({ data: { organizationId: orgId, primaryAccountId: demo2 } })
    await tarifa(venueId, 'PRIMARY')

    const r = await cleanDemoData(venueId, null)

    // La limpieza terminó (antes: RESTRICT de la organización tumbaba toda la transacción).
    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toBeNull()
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo1 } })).toBeNull()
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo2 } })).not.toBeNull()
    expect(r.deletedMerchantAccounts).toBe(1)
  })

  it('regresión · TODAS demo (como las siembra el demo): se borra la configuración, todas sus tarifas y las cuentas demo', async () => {
    const venueId = await negocioTrial('demo-demo')
    const demo1 = await cuenta('demo', 'd1')
    const demo2 = await cuenta('demo', 'd2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: demo1, secondaryAccountId: demo2 } })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')

    const r = await cleanDemoData(venueId, null)

    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toBeNull()
    expect(await tiposDeTarifa(venueId)).toEqual([])
    expect(await prisma.merchantAccount.count({ where: { id: { in: [demo1, demo2] } } })).toBe(0)
    expect(r.deletedMerchantAccounts).toBe(2)
  })

  it('regresión · TODAS reales: no se toca nada de pagos y no se escribe bitácora de pagos', async () => {
    const venueId = await negocioTrial('real-solo')
    const real = await cuenta('real', 'e1')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: real } })
    await tarifa(venueId, 'PRIMARY')

    await cleanDemoData(venueId, null)

    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toMatchObject({ primaryAccountId: real })
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY'])
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'DEMO_PAYMENT_POSITIONS_CLEANED' }))
  })

  it('Codex r3 #2: tras conservar la principal real, la aprobación de KYC con procesador dice qué hacer (antes: error de base sin texto)', async () => {
    const venueId = await negocioTrial('kyc')
    const real = await cuenta('real', 'k1')
    const demo = await cuenta('demo', 'k2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: real, secondaryAccountId: demo } })
    await cleanDemoData(venueId, null)
    const cuentasAntes = await prisma.merchantAccount.count({ where: { providerId } })

    await expect(
      assignProcessorAndApproveKyc(venueId, 'superadmin-kyc', {
        providerId,
        externalMerchantId: `kyc-${llave}`,
        displayName: 'KYC',
        credentials: {},
        clabeNumber: '012345678901234567',
        bankName: 'Banco',
        accountHolder: 'Titular',
        providerCosts: { debitRate: 0.01, creditRate: 0.01, amexRate: 0.01, internationalRate: 0.01, fixedCostPerTransaction: 0 },
        venuePricing: { debitRate: 0.02, creditRate: 0.02, amexRate: 0.02, internationalRate: 0.02, fixedFeePerTransaction: 0 },
      }),
    ).rejects.toThrow('Este negocio ya tiene su propia cuenta de cobro')

    // Nada se creó: ni cuenta, ni tarifa nueva, y la configuración sigue con la cuenta real.
    expect(await prisma.merchantAccount.count({ where: { providerId } })).toBe(cuentasAntes)
    expect(await tiposDeTarifa(venueId)).toEqual([])
    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toMatchObject({ primaryAccountId: real })
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venueId } })).kycStatus).not.toBe('VERIFIED')
  })
})
