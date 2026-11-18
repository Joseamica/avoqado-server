/**
 * Guardar la tarifa (o el costo) de una cuenta desde el panel del superadmin NUNCA deja a la posición sin tarifa
 * (hz:nube0000:naeba3d5).
 *
 * La tarjeta de tarifa del DASHBOARD (`PricingCard`) y la de costo (`CostCard`) llaman a
 * `POST /dashboard/superadmin/pricing-structures/venue` y `/cost-structures/provider`. Antes, esos dos guardados desactivaban
 * la tarifa vigente y DESPUÉS creaban la nueva, sin transacción:
 * - volver a guardar con la fecha que enseña la tarjeta chocaba con la llave única `(…, effectiveFrom)` → la vigente ya estaba
 *   apagada y la nueva no existía (hueco);
 * - una fecha futura apagaba la vigente YA y la nueva empezaba días después (hueco);
 * - el costo pedía en su `include` un campo que la cuenta no tiene: el `create` tronaba SIEMPRE, después de apagar el vigente.
 * Medición en la rama vieja (17-nov): con la fecha UTC que mandaba la tarjeta vacía, la nueva regía al instante (su medianoche
 * UTC ya pasó): ese caso solo no dejaba hueco.
 *
 * Se mide con los LECTORES reales del cobro (`findActiveVenuePricingStructure` / `findActiveProviderCostStructure`), que piden
 * `active` + `effectiveFrom <= fecha <= effectiveTo`. La hora es FIJA (Codex r2 #11 y r3 #7): las 20:00 del 17-nov en CDMX
 * (02:00 UTC del 18), la franja en la que la fecha UTC ya es mañana.
 *
 * Contra base real (en la nube por avq-verify): npx jest --selectProjects=integration --runInBand --ci \
 *   --runTestsByPath tests/integration/dashboard/tarifaDelPanelSinHueco.integration.test.ts
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { upsertVenuePricingStructure } from '@/controllers/dashboard/cost-management.controller'
import { guardarCostoDeLaCuenta, guardarTarifaDelNegocio } from '@/services/dashboard/cost-management.service'
import { findActiveProviderCostStructure, findActiveVenuePricingStructure } from '@/services/payments/transactionCost.service'

const D = (n: number) => new Prisma.Decimal(n)
const llave = `tarifa-panel-${randomUUID().slice(0, 8)}`
let orgId: string
let venueId: string
let providerId: string
let cuentaId: string

/** 17-nov 20:00 en CDMX = 18-nov 02:00 UTC. */
const AHORA = new Date('2026-11-18T02:00:00Z')
const HOY = '2026-11-17' // hoy en México a esa hora (lo que manda la tarjeta vacía tras el arreglo)
const MANANA = '2026-11-18' // ya empezó en UTC, pero en México es mañana
const DIA_PASADO = '2026-02-01'

const tasas = (base: number) => ({ debitRate: base, creditRate: base + 0.01, amexRate: base + 0.02, internationalRate: base + 0.03 })

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: llave, email: `${llave}@example.test`, phone: '5500000000' } })
  orgId = org.id
  venueId = (await prisma.venue.create({ data: { organizationId: org.id, name: 'Tarifa panel', slug: llave } })).id
  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `${llave}-P`, name: 'Proveedor prueba', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
  ).id
  cuentaId = (await prisma.merchantAccount.create({ data: { providerId, externalMerchantId: `${llave}-m`, credentialsEncrypted: {} } })).id
})

beforeEach(async () => {
  await prisma.venuePricingStructure.deleteMany({ where: { venueId } })
  await prisma.providerCostStructure.deleteMany({ where: { merchantAccountId: cuentaId } })
  // La vigente de siempre: desde enero, sin fin.
  await prisma.venuePricingStructure.create({
    data: { venueId, accountType: 'PRIMARY', ...tasas(0.02), effectiveFrom: new Date('2026-01-01T00:00:00Z') },
  })
  await prisma.providerCostStructure.create({
    data: { providerId, merchantAccountId: cuentaId, ...tasas(0.01), effectiveFrom: new Date('2026-01-01T00:00:00Z') },
  })
})

afterAll(async () => {
  if (!venueId || !cuentaId) return // si `beforeAll` falló, un filtro `undefined` borraría de toda la base
  await prisma.venuePricingStructure.deleteMany({ where: { venueId } })
  await prisma.providerCostStructure.deleteMany({ where: { merchantAccountId: cuentaId } })
  await prisma.merchantAccount.deleteMany({ where: { id: cuentaId } })
  await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

/** Guarda como la tarjeta, a la hora fija; devuelve el error (o null). */
async function guardarTarifa(body: Record<string, unknown>): Promise<any> {
  try {
    await guardarTarifaDelNegocio({ venueId, accountType: 'PRIMARY', ...body }, null, AHORA)
    return null
  } catch (e) {
    return e
  }
}
async function guardarCosto(body: Record<string, unknown>): Promise<any> {
  try {
    await guardarCostoDeLaCuenta({ providerId, merchantAccountId: cuentaId, ...body }, null, AHORA)
    return null
  } catch (e) {
    return e
  }
}
const tarifa = (fecha: string, base: number) => ({ ...tasas(base), effectiveFrom: fecha })
const tarifaVigente = async (en = AHORA) => findActiveVenuePricingStructure(venueId, 'PRIMARY', en)
const costoVigente = async (en = AHORA) => findActiveProviderCostStructure(cuentaId, en)
const activas = () => prisma.venuePricingStructure.count({ where: { venueId, accountType: 'PRIMARY', active: true } })

describe('tarifa del negocio desde el panel (PricingCard)', () => {
  it('fecha vacía (hoy en México): la nueva rige al instante, sin hueco ni doble tarifa', async () => {
    expect(await guardarTarifa(tarifa(HOY, 0.025))).toBeNull()
    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.025)
    expect(await activas()).toBe(1)
  })

  it('cableado: el controlador de la ruta usa este guardado (hora real, hoy en México)', async () => {
    let error: unknown = null
    const hoyReal = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
    const res: any = { json: () => undefined, status: () => res }
    await upsertVenuePricingStructure(
      { body: { venueId, accountType: 'PRIMARY', ...tarifa(hoyReal, 0.025) }, authContext: { userId: null } } as any,
      res,
      (e: unknown) => (error = e ?? null),
    )
    expect(error).toBeNull()
    expect(Number((await tarifaVigente(new Date()))!.debitRate)).toBeCloseTo(0.025)
  })

  it('🔴 volver a guardar HOY con la misma fecha corrige esa versión; nunca deja la posición sin tarifa ni con dos vigentes', async () => {
    expect(await guardarTarifa(tarifa(HOY, 0.025))).toBeNull()

    expect(await guardarTarifa(tarifa(HOY, 0.027))).toBeNull()

    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.027)
    expect(await activas()).toBe(1)
  })

  it('🔴 Codex r3 #2: un cargo fijo que la tarjeta ya no manda (lo borró) queda vacío también al corregir la de hoy', async () => {
    expect(await guardarTarifa({ ...tarifa(HOY, 0.025), fixedFeePerTransaction: 3 })).toBeNull()

    expect(await guardarTarifa(tarifa(HOY, 0.025))).toBeNull()

    expect((await tarifaVigente())!.fixedFeePerTransaction).toBeNull()
  })

  it('🔴 Codex r6: la versión de HOY (medianoche UTC) guardada AYER en la noche ya rigió ⇒ 409, no se reescribe', async () => {
    // Guardada el 16 a las 19:00 de CDMX con inicio «17» (medianoche UTC = 18:00 del 16 en CDMX): rigió esa noche.
    await prisma.venuePricingStructure.updateMany({ where: { venueId }, data: { active: false } })
    await prisma.venuePricingStructure.create({
      data: {
        venueId,
        accountType: 'PRIMARY',
        ...tasas(0.023),
        effectiveFrom: new Date('2026-11-17T00:00:00Z'),
        createdAt: new Date('2026-11-17T01:00:00Z'),
      },
    })

    expect(await guardarTarifa(tarifa(HOY, 0.04))).toMatchObject({ statusCode: 409, code: 'VERSION_QUE_YA_RIGIO' })
    expect(Number((await tarifaVigente(new Date('2026-11-17T03:00:00Z')))!.debitRate)).toBeCloseTo(0.023) // la noche del 16
    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.023)
  })

  it('🔴 Codex r7: la versión de hoy que otro guardado ya APAGÓ rigió un rato ⇒ 409, no se reactiva reescrita', async () => {
    expect(await guardarTarifa(tarifa(HOY, 0.025))).toBeNull() // la de hoy
    expect(await guardarTarifa(tarifa('2026-11-16', 0.03))).toBeNull() // otra con fecha de ayer: apaga la de hoy

    expect(await guardarTarifa(tarifa(HOY, 0.04))).toMatchObject({ statusCode: 409, code: 'VERSION_QUE_YA_RIGIO' })
    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.03)
    expect(await activas()).toBe(1)
  })

  it('🔴 la misma fecha que una versión que YA RIGIÓ (la que enseña la tarjeta al abrir) ⇒ 409 y no se apaga nada', async () => {
    expect(await guardarTarifa(tarifa('2026-01-01', 0.03))).toMatchObject({ statusCode: 409, code: 'VERSION_QUE_YA_RIGIO' })
    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.02)
  })

  it('🔴 Codex r2 #2: MAÑANA en México ⇒ 400 aunque en UTC ya haya empezado', async () => {
    expect(await guardarTarifa(tarifa(MANANA, 0.03))).toMatchObject({ statusCode: 400, code: 'VIGENCIA_FUTURA' })
    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.02)
  })

  it('🔴 una fecha FUTURA ⇒ 400 y la de hoy sigue vigente (antes se apagaba ya y quedaba un hueco hasta esa fecha)', async () => {
    expect(await guardarTarifa(tarifa('2026-11-21', 0.03))).toMatchObject({ statusCode: 400, code: 'VIGENCIA_FUTURA' })
    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.02)
    expect(Number((await tarifaVigente(new Date('2026-11-22T12:00:00Z')))!.debitRate)).toBeCloseTo(0.02)
  })

  it('🔴 Codex r2 #3 / r4 #4 / r5 #3: con fecha de fin ⇒ 400 y no se apaga nada (al vencer dejaría la posición sin tarifa)', async () => {
    for (const effectiveTo of ['2026-03-01', '2026-11-18T12:00:00Z', '2027-01-01']) {
      expect(await guardarTarifa({ ...tarifa(HOY, 0.03), effectiveTo })).toMatchObject({ statusCode: 400, code: 'VIGENCIA_CON_FIN' })
    }
    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.02)
    expect(await activas()).toBe(1)
  })

  it('una versión guardada CON HORA (alta de AngelPay) hoy: guardar desde la tarjeta crea otra y nunca deja hueco', async () => {
    await prisma.venuePricingStructure.create({
      data: { venueId, accountType: 'PRIMARY', ...tasas(0.021), effectiveFrom: new Date('2026-11-17T15:00:00Z') },
    })
    expect(await guardarTarifa(tarifa(HOY, 0.026))).toBeNull()
    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.026)
    expect(await activas()).toBe(1)
  })

  it('🔴 si la escritura nueva falla, no se apaga la vigente (todo o nada)', async () => {
    // Decimal(5,4) no cabe 12345: la base rechaza la fila nueva DESPUÉS de que el guardado viejo ya había apagado la vigente.
    expect(await guardarTarifa(tarifa(DIA_PASADO, 12345))).not.toBeNull()
    expect(Number((await tarifaVigente())!.debitRate)).toBeCloseTo(0.02)
  })

  it('🔴 Codex r1 #9: sin IVA en la petición (las tarjetas no lo mandan) se conserva el de la vigente; si viene, manda', async () => {
    await prisma.venuePricingStructure.updateMany({ where: { venueId }, data: { includesTax: false, taxRate: D(0.08) } })

    expect(await guardarTarifa(tarifa(DIA_PASADO, 0.025))).toBeNull()
    const heredada = await tarifaVigente()
    expect(heredada!.includesTax).toBe(false)
    expect(Number(heredada!.taxRate)).toBeCloseTo(0.08)

    expect(await guardarTarifa({ ...tarifa(HOY, 0.025), includesTax: true })).toBeNull()
    expect((await tarifaVigente())!.includesTax).toBe(true)
  })

  it('🔴 Codex r2 #4: la primera tarifa propia de un negocio que HEREDA «+ IVA» de su organización sigue siendo + IVA', async () => {
    await prisma.venuePricingStructure.deleteMany({ where: { venueId } })
    const deLaOrg = await prisma.organizationPricingStructure.create({
      data: {
        organizationId: orgId,
        accountType: 'PRIMARY',
        ...tasas(0.02),
        includesTax: false,
        taxRate: D(0.16),
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
    })
    try {
      expect(await guardarTarifa(tarifa(HOY, 0.025))).toBeNull()
      const propia = await tarifaVigente()
      expect(propia!.source).toBe('venue')
      expect(propia!.includesTax).toBe(false)
    } finally {
      await prisma.organizationPricingStructure.delete({ where: { id: deLaOrg.id } })
    }
  })
})

describe('costo de la cuenta desde el panel (CostCard)', () => {
  const costo = (fecha: string, base: number) => ({ ...tasas(base), effectiveFrom: fecha })

  it('🔴 guardar el costo funciona y el nuevo rige; la cuenta nunca se queda sin costo', async () => {
    expect(await guardarCosto(costo(HOY, 0.012))).toBeNull()
    expect(Number((await costoVigente())!.debitRate)).toBeCloseTo(0.012)
  })

  it('🔴 volver a guardar el costo HOY con la misma fecha corrige esa versión', async () => {
    expect(await guardarCosto(costo(HOY, 0.012))).toBeNull()
    expect(await guardarCosto(costo(HOY, 0.013))).toBeNull()
    expect(Number((await costoVigente())!.debitRate)).toBeCloseTo(0.013)
    expect(await prisma.providerCostStructure.count({ where: { merchantAccountId: cuentaId, active: true } })).toBe(1)
  })

  it('🔴 un costo con fecha de mañana en México ⇒ 400 y el de hoy sigue vigente', async () => {
    expect(await guardarCosto(costo(MANANA, 0.014))).toMatchObject({ statusCode: 400, code: 'VIGENCIA_FUTURA' })
    expect(Number((await costoVigente())!.debitRate)).toBeCloseTo(0.01)
  })

  it('🔴 Codex r1 #9: un costo «+ IVA» guardado desde la tarjeta (sin IVA en la petición) sigue siendo + IVA', async () => {
    await prisma.providerCostStructure.updateMany({ where: { merchantAccountId: cuentaId }, data: { includesTax: false } })
    expect(await guardarCosto(costo(DIA_PASADO, 0.02))).toBeNull()
    expect((await costoVigente())!.includesTax).toBe(false)
  })
})
