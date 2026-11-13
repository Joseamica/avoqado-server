/**
 * Tarifa al comercio, pasos 1 y 2 (12-nov-2026) — contra una base REAL.
 * Promesa: `docs/audit/2026-11-12-tarifa-por-cuenta/promesa-pasos-1-y-2.md` del workspace.
 *
 * Paso 1 (candado al cambiar la cuenta de una posición): sin confirmar ⇒ 400; pantalla vieja ⇒ 409; confirmado ⇒ guarda; y
 * NUNCA escribe tarifas. Paso 2 (reporte): marca lo raro, pagina con tope y no escribe nada.
 * Regresión del camino de cobro: la tarifa que se congela al cobrar (`tarifaCongeladaDeLaAfiliacion`) es la misma antes y
 * después, sin tocar ese código.
 */
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import {
  CONFIRMAR_POSICION,
  POSICION_DESACTUALIZADA,
  exigirConfirmacionDePosiciones,
  SIN_TARIFA,
  type ConfirmacionDePosiciones,
} from '@/services/shared/candadoDePosiciones'
import * as venuePricing from '@/services/superadmin/venuePricing.service'
import * as venuePaymentConfig from '@/services/venuePaymentConfig.service'
import { approveDiscoveredAngelPayMerchant, reserveAngelPaySlot } from '@/services/superadmin/merchantAccount.service'
import { fullSetupAngelPayMerchant } from '@/services/superadmin/angelpayFullSetup.service'
import { tarifaCongeladaDeLaAfiliacion } from '@/services/payments/transactionCost.service'
import { reporteDePosiciones, reportePosicionesQuerySchema } from '@/services/superadmin/reportePosiciones.service'

jest.setTimeout(60000)

const sufijo = cuid().slice(-8)
let blumonId: string
let angelpayId: string
const creadas = { orgs: [] as string[], venues: [] as string[], cuentas: [] as string[] }

async function org(nombre: string) {
  const o = await prisma.organization.create({
    data: { name: `Candado ${nombre} ${sufijo}`, email: `${cuid()}@example.test`, phone: '5500000000' },
  })
  creadas.orgs.push(o.id)
  return o.id
}
async function negocio(organizationId: string, nombre: string) {
  const v = await prisma.venue.create({ data: { organizationId, name: `Candado ${nombre} ${sufijo}`, slug: `candado-${cuid()}` } })
  creadas.venues.push(v.id)
  return v.id
}
async function cuenta(providerId: string, nombre: string) {
  const m = await prisma.merchantAccount.create({
    data: { providerId, externalMerchantId: `cand-${cuid()}`, displayName: nombre, credentialsEncrypted: {}, active: true },
  })
  creadas.cuentas.push(m.id)
  return m.id
}
async function tarifa(
  venueId: string,
  accountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY',
  tasa: number,
  effectiveFrom = new Date('2026-01-01'),
) {
  return prisma.venuePricingStructure.create({
    data: {
      venueId,
      accountType,
      debitRate: tasa,
      creditRate: tasa,
      amexRate: tasa,
      internationalRate: tasa,
      effectiveFrom,
      includesTax: true,
    },
  })
}
async function terminal(venueId: string, brand: 'PAX' | 'NEXGO', assignedMerchantIds: string[] = []) {
  return prisma.terminal.create({
    data: {
      venueId,
      name: `T ${brand}`,
      serialNumber: `cand-${cuid()}`,
      type: 'TPV_ANDROID',
      brand,
      status: 'ACTIVE',
      assignedMerchantIds,
    },
  })
}

/** Corre la promesa y devuelve el error del candado (o falla si no lo hubo). */
async function errorDe(p: Promise<unknown>): Promise<AppError & { details: any }> {
  try {
    await p
  } catch (e) {
    if (e instanceof AppError) return e as AppError & { details: any }
    throw e
  }
  throw new Error('se esperaba un rechazo del candado')
}

/** Lo que la pantalla devuelve tras mostrar el diálogo: la cuenta que vio, la huella y el número de terminales del detalle. */
function confirmarDesde(details: any): ConfirmacionDePosiciones {
  const c: Record<string, any> = {}
  for (const p of details.positions) {
    c[p.slot] = {
      previousAccountId: p.currentAccount?.id ?? null,
      ...(p.needs.nextAccountId && { nextAccountId: p.nextAccount?.id ?? null }),
      ...(p.needs.rate && { rate: { mode: 'KEEP', fingerprint: p.pricingFingerprint } }),
      ...(p.needs.inheritingTerminals && { inheritingTerminals: p.inheritingTerminals.total }),
    }
  }
  return c as ConfirmacionDePosiciones
}

async function fotoDeTarifas(venueIds: string[], organizationIds: string[]) {
  const [v, o] = await Promise.all([
    prisma.venuePricingStructure.findMany({ where: { venueId: { in: venueIds } }, orderBy: { id: 'asc' }, take: 500 }),
    prisma.organizationPricingStructure.findMany({ where: { organizationId: { in: organizationIds } }, orderBy: { id: 'asc' }, take: 500 }),
  ])
  return JSON.stringify([v, o])
}

beforeAll(async () => {
  blumonId = (
    await prisma.paymentProvider.upsert({
      where: { code: 'BLUMON' },
      update: {},
      create: { code: 'BLUMON', name: 'Blumon', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
  ).id
  angelpayId = (
    await prisma.paymentProvider.upsert({
      where: { code: 'ANGELPAY' },
      update: {},
      create: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
  ).id
})

afterAll(async () => {
  await prisma.terminal.deleteMany({ where: { venueId: { in: creadas.venues } } })
  await prisma.venuePricingStructure.deleteMany({ where: { venueId: { in: creadas.venues } } })
  await prisma.organizationPricingStructure.deleteMany({ where: { organizationId: { in: creadas.orgs } } })
  await prisma.venuePaymentConfig.deleteMany({ where: { venueId: { in: creadas.venues } } })
  await prisma.organizationPaymentConfig.deleteMany({ where: { organizationId: { in: creadas.orgs } } })
  await prisma.angelPayUserAccount.deleteMany({ where: { venueId: { in: creadas.venues } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: creadas.cuentas } } })
  await prisma.venue.deleteMany({ where: { id: { in: creadas.venues } } })
  await prisma.organization.deleteMany({ where: { id: { in: creadas.orgs } } })
  await prisma.$disconnect()
})

describe('paso 1 · candado al cambiar la cuenta de una posición (configuración del negocio)', () => {
  let orgId: string
  let venueId: string
  let A: string
  let B: string

  beforeEach(async () => {
    orgId = await org('negocio')
    venueId = await negocio(orgId, 'Tienda')
    A = await cuenta(blumonId, 'Blumon A')
    B = await cuenta(blumonId, 'Blumon B')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: A } })
    await tarifa(venueId, 'PRIMARY', 0.025)
    await terminal(venueId, 'PAX')
    await terminal(venueId, 'PAX')
    await terminal(venueId, 'NEXGO', [A]) // asignación propia: no hereda
  })

  it('sin confirmar no guarda: 400 con la tarifa que quedaría y las 2 PAX que heredan', async () => {
    const antes = await fotoDeTarifas([venueId], [orgId])
    const e = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: B }))
    expect(e.statusCode).toBe(400)
    expect(e.code).toBe(CONFIRMAR_POSICION)
    const [p] = e.details.positions
    expect(p).toMatchObject({ slot: 'PRIMARY', currentAccount: { id: A }, nextAccount: { id: B } })
    expect(p.pricing).toMatchObject({ source: 'venue', debitRate: 0.025 })
    expect(p.inheritingTerminals).toMatchObject({ total: 2, byBrand: { PAX: 2 } })
    expect(p.needs).toMatchObject({ previousAccountId: true, rate: true, inheritingTerminals: true })
    expect((await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })).primaryAccountId).toBe(A)
    expect(await fotoDeTarifas([venueId], [orgId])).toBe(antes)
  })

  it('confirmada guarda, conserva la tarifa y NO escribe ninguna tarifa; la tarifa congelada al cobrar es la misma', async () => {
    const ahora = new Date()
    const congeladaAntes = await tarifaCongeladaDeLaAfiliacion(venueId, A, ahora)
    const antes = await fotoDeTarifas([venueId], [orgId])
    const e = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: B }))
    const r = await venuePricing.updateVenuePaymentConfig(venueId, {
      primaryAccountId: B,
      positionConfirmations: confirmarDesde(e.details),
    })
    expect(r.primaryAccountId).toBe(B)
    expect(r.positionChanges).toEqual([expect.objectContaining({ slot: 'PRIMARY', from: A, to: B, rate: 'KEEP', inheritingTerminals: 2 })])
    expect(await fotoDeTarifas([venueId], [orgId])).toBe(antes)
    const congeladaDespues = await tarifaCongeladaDeLaAfiliacion(venueId, B, ahora)
    expect(congeladaAntes.pricing?.venue).toMatchObject({ debitRate: '0.025' })
    expect(congeladaDespues.pricing?.venue).toEqual(congeladaAntes.pricing?.venue)
    expect(congeladaDespues.slot).toBe('PRIMARY')
  })

  it('pantalla vieja: si la cuenta de la posición ya cambió, 409 y no guarda', async () => {
    const C = await cuenta(blumonId, 'Blumon C')
    const e = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: B }))
    const confirmacion = confirmarDesde(e.details)
    await prisma.venuePaymentConfig.update({ where: { venueId }, data: { primaryAccountId: C } }) // otra persona
    const e2 = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: B, positionConfirmations: confirmacion }))
    expect(e2.statusCode).toBe(409)
    expect(e2.code).toBe(POSICION_DESACTUALIZADA)
    expect((await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })).primaryAccountId).toBe(C)
  })

  it('una tarifa editada en su misma fila cambia la huella: 409 (Codex p12-r1 #5)', async () => {
    const e = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: B }))
    const confirmacion = confirmarDesde(e.details)
    await prisma.venuePricingStructure.updateMany({ where: { venueId, accountType: 'PRIMARY' }, data: { debitRate: 0.08 } })
    const e2 = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: B, positionConfirmations: confirmacion }))
    expect(e2.code).toBe(POSICION_DESACTUALIZADA)
  })

  it('si cambió el número de terminales que heredan, 409', async () => {
    const e = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: B }))
    const confirmacion = confirmarDesde(e.details)
    await terminal(venueId, 'PAX')
    const e2 = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: B, positionConfirmations: confirmacion }))
    expect(e2.code).toBe(POSICION_DESACTUALIZADA)
  })

  it('llenar una posición vacía SIN tarifa sólo pide la cuenta anterior (vacía); con tarifa vieja, también la tarifa', async () => {
    const e = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { secondaryAccountId: B }))
    expect(e.details.positions[0].needs).toEqual({ previousAccountId: true, nextAccountId: false, rate: false, inheritingTerminals: false })
    await venuePricing.updateVenuePaymentConfig(venueId, {
      secondaryAccountId: B,
      positionConfirmations: { SECONDARY: { previousAccountId: null } },
    })

    await tarifa(venueId, 'TERTIARY', 0.04)
    const C = await cuenta(blumonId, 'Blumon C')
    const e2 = await errorDe(
      venuePricing.updateVenuePaymentConfig(venueId, {
        tertiaryAccountId: C,
        positionConfirmations: { TERTIARY: { previousAccountId: null } },
      }),
    )
    expect(e2.code).toBe(CONFIRMAR_POSICION)
    expect(e2.details.positions[0]).toMatchObject({ slot: 'TERTIARY', needs: { rate: true }, pricing: { debitRate: 0.04 } })
  })

  it('sin cambio de cuenta (sólo reglas de ruteo) no pide nada', async () => {
    const r = await venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: A, routingRules: { factura: 'primary' } })
    expect(r.positionChanges).toEqual([])
  })

  it('mover una cuenta de posición confirma las dos posiciones que cambian', async () => {
    await prisma.venuePaymentConfig.update({ where: { venueId }, data: { secondaryAccountId: B } })
    const e = await errorDe(venuePricing.updateVenuePaymentConfig(venueId, { primaryAccountId: B }))
    expect(e.details.positions.map((p: any) => p.slot).sort()).toEqual(['PRIMARY', 'SECONDARY'])
    const r = await venuePricing.updateVenuePaymentConfig(venueId, {
      primaryAccountId: B,
      positionConfirmations: confirmarDesde(e.details),
    })
    expect(r).toMatchObject({ primaryAccountId: B, secondaryAccountId: null })
  })

  it('borrar la configuración propia con una organización configurada: pide la cuenta nueva que calcula el SERVIDOR', async () => {
    const C = await cuenta(blumonId, 'Blumon C (organización)')
    await prisma.organizationPaymentConfig.create({ data: { organizationId: orgId, primaryAccountId: C } })
    const e = await errorDe(venuePricing.deleteVenuePaymentConfig(venueId))
    expect(e.details.positions[0]).toMatchObject({ currentAccount: { id: A }, nextAccount: { id: C }, needs: { nextAccountId: true } })
    // Otra persona cambia la cuenta de la organización: lo confirmado ya no aplica.
    const D = await cuenta(blumonId, 'Blumon D')
    const confirmacion = confirmarDesde(e.details)
    await prisma.organizationPaymentConfig.update({ where: { organizationId: orgId }, data: { primaryAccountId: D } })
    const e2 = await errorDe(venuePricing.deleteVenuePaymentConfig(venueId, confirmacion))
    expect(e2.code).toBe(POSICION_DESACTUALIZADA)
    const e3 = await errorDe(venuePricing.deleteVenuePaymentConfig(venueId))
    await venuePricing.deleteVenuePaymentConfig(venueId, confirmarDesde(e3.details))
    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toBeNull()
  })

  it('el escritor del DASHBOARD (`/dashboard/venues/:id/payment-config`) pasa por el mismo candado', async () => {
    const config = await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })
    const e = await errorDe(venuePaymentConfig.updateVenuePaymentConfig(config.id, { primaryAccountId: B }))
    expect(e.code).toBe(CONFIRMAR_POSICION)
    const r = await venuePaymentConfig.updateVenuePaymentConfig(config.id, {
      primaryAccountId: B,
      positionConfirmations: confirmarDesde(e.details),
    })
    expect(r.primaryAccountId).toBe(B)
  })
})

describe('paso 1 · organización y herencia (Codex p12-r1 #3 y #7)', () => {
  it('cambiar la cuenta de la organización cuenta las terminales de los negocios que heredan y su tarifa propia', async () => {
    const orgId = await org('organización')
    const hereda = await negocio(orgId, 'Hereda')
    const propio = await negocio(orgId, 'Propia')
    const A = await cuenta(blumonId, 'Org A')
    const B = await cuenta(blumonId, 'Org B')
    const X = await cuenta(blumonId, 'Propia X')
    await prisma.organizationPaymentConfig.create({ data: { organizationId: orgId, primaryAccountId: A } })
    await prisma.venuePaymentConfig.create({ data: { venueId: propio, primaryAccountId: X } })
    await tarifa(hereda, 'PRIMARY', 0.03) // tarifa propia de un negocio que hereda las cuentas
    await terminal(hereda, 'PAX')
    await terminal(propio, 'PAX') // no hereda de la organización

    const e = await errorDe(
      prisma.$transaction(tx => exigirConfirmacionDePosiciones(tx, { objetivo: { organizationId: orgId }, siguiente: { PRIMARY: B } })),
    )
    const [p] = e.details.positions
    expect(p.inheritingTerminals.total).toBe(1)
    expect(p.venuesWithOwnRate.total).toBe(1)
    expect(p.pricingFingerprint).not.toBe(SIN_TARIFA)
    const cambios = await prisma.$transaction(tx =>
      exigirConfirmacionDePosiciones(tx, {
        objetivo: { organizationId: orgId },
        siguiente: { PRIMARY: B },
        confirmaciones: confirmarDesde(e.details),
      }),
    )
    expect(cambios[0]).toMatchObject({ slot: 'PRIMARY', from: A, to: B, rate: 'KEEP' })
  })

  it('aprobar o reservar AngelPay en un negocio SIN configuración propia que hereda 3 cuentas pide confirmar las 3', async () => {
    const orgId = await org('herencia')
    const venueId = await negocio(orgId, 'Hereda tres')
    const [p, s, t] = [await cuenta(blumonId, 'P'), await cuenta(blumonId, 'S'), await cuenta(angelpayId, 'T')]
    await prisma.organizationPaymentConfig.create({
      data: { organizationId: orgId, primaryAccountId: p, secondaryAccountId: s, tertiaryAccountId: t },
    })
    const e = await errorDe(reserveAngelPaySlot({ venueId }))
    expect(e.code).toBe(CONFIRMAR_POSICION)
    expect(e.details.positions.map((x: any) => x.slot).sort()).toEqual(['PRIMARY', 'SECONDARY', 'TERTIARY'])
    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toBeNull()
    expect(await prisma.merchantAccount.count({ where: { externalMerchantId: { startsWith: `AWAITING_${venueId}_` } } })).toBe(0)
  })

  it('aprobar en un negocio con configuración propia y posición vacía sin tarifa sigue igual que hoy (sin confirmar nada)', async () => {
    const orgId = await org('aprobar')
    const venueId = await negocio(orgId, 'Aprobar')
    const P = await cuenta(blumonId, 'P')
    const descubierta = await prisma.merchantAccount.create({
      data: {
        providerId: angelpayId,
        externalMerchantId: `${Date.now() % 1_000_000_000}`,
        displayName: 'Descubierta',
        credentialsEncrypted: {},
        active: false,
      },
    })
    creadas.cuentas.push(descubierta.id)
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: P } })
    await approveDiscoveredAngelPayMerchant({ venueId, merchantAccountId: descubierta.id, slot: 'SECONDARY' })
    expect((await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })).secondaryAccountId).toBe(descubierta.id)
  })

  it('AngelPay «fill» en una posición vacía con tarifa vieja pide confirmarla; con `pricing` en la petición cuenta como capturada', async () => {
    const orgId = await org('angelpay')
    const venueId = await negocio(orgId, 'AngelPay')
    const P = await cuenta(blumonId, 'P')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: P } })
    await tarifa(venueId, 'SECONDARY', 0.05)
    const base = {
      venueId,
      login: { mode: 'new' as const, email: `cand-${cuid()}@avoqado.io`, pin: '123456', environment: 'QA' as const },
      merchant: {
        mode: 'create' as const,
        externalMerchantId: `${(Date.now() + 7) % 1_000_000_000}`,
        name: 'AP',
        affiliation: 'AF',
        displayName: 'AP',
      },
      slot: { accountType: 'SECONDARY' as const, mode: 'fill' as const },
    }
    const e = await errorDe(fullSetupAngelPayMerchant(base))
    expect(e.code).toBe(CONFIRMAR_POSICION)
    expect(await prisma.angelPayUserAccount.count({ where: { venueId } })).toBe(0) // la transacción completa se deshizo
    const r = await fullSetupAngelPayMerchant({ ...base, positionConfirmations: confirmarDesde(e.details) })
    creadas.cuentas.push(r.merchantAccountId)
    expect((await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId } })).secondaryAccountId).toBe(r.merchantAccountId)
  })
})

describe('paso 2 · reporte de posiciones (sólo lectura)', () => {
  let orgId: string
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    orgId = await org('reporte')
    const vieja = await cuenta(blumonId, 'Cuenta nueva sobre tarifa vieja')
    const sana = await cuenta(blumonId, 'Cuenta sana')
    const angel = await cuenta(angelpayId, 'AngelPay')
    ids.sano = await negocio(orgId, 'R sano')
    await prisma.venuePaymentConfig.create({ data: { venueId: ids.sano, primaryAccountId: sana } })
    await tarifa(ids.sano, 'PRIMARY', 0.02, new Date()) // empieza después de que existe la cuenta
    ids.anterior = await negocio(orgId, 'R tarifa anterior')
    await tarifa(ids.anterior, 'PRIMARY', 0.03, new Date('2025-01-01'))
    await prisma.venuePaymentConfig.create({ data: { venueId: ids.anterior, primaryAccountId: vieja } })
    ids.sinCuenta = await negocio(orgId, 'R sin cuenta con tarifa')
    await prisma.venuePaymentConfig.create({ data: { venueId: ids.sinCuenta, primaryAccountId: await cuenta(blumonId, 'otra') } })
    await prisma.venuePricingStructure.create({
      data: {
        venueId: ids.sinCuenta,
        accountType: 'PRIMARY',
        debitRate: 0.02,
        creditRate: 0.02,
        amexRate: 0.02,
        internationalRate: 0.02,
        effectiveFrom: new Date(),
      },
    })
    await tarifa(ids.sinCuenta, 'TERTIARY', 0.04)
    ids.otroProcesador = await negocio(orgId, 'R PAX con AngelPay')
    await prisma.venuePaymentConfig.create({ data: { venueId: ids.otroProcesador, primaryAccountId: angel } })
    await prisma.venuePricingStructure.create({
      data: {
        venueId: ids.otroProcesador,
        accountType: 'PRIMARY',
        debitRate: 0.02,
        creditRate: 0.02,
        amexRate: 0.02,
        internationalRate: 0.02,
        effectiveFrom: new Date(),
      },
    })
    await terminal(ids.otroProcesador, 'PAX')
  })

  const flagsDe = (r: Awaited<ReturnType<typeof reporteDePosiciones>>, venueId: string) =>
    r.data.find(v => v.venueId === venueId)?.flags ?? []

  it('marca cada caso raro y deja limpio el sano', async () => {
    const r = await reporteDePosiciones(reportePosicionesQuerySchema.parse({ organizationId: orgId }))
    expect(flagsDe(r, ids.sano)).toEqual([])
    expect(flagsDe(r, ids.anterior)).toContain('TARIFA_ANTERIOR_A_LA_CUENTA')
    expect(flagsDe(r, ids.sinCuenta)).toContain('SIN_CUENTA_CON_TARIFA')
    expect(flagsDe(r, ids.otroProcesador)).toContain('TERMINALES_DE_OTRO_PROCESADOR')
    expect(r.meta.total).toBe(4)
  })

  it('filtra por marca en la base antes de paginar, con total exacto', async () => {
    const r = await reporteDePosiciones(reportePosicionesQuerySchema.parse({ organizationId: orgId, flag: 'SIN_CUENTA_CON_TARIFA' }))
    expect(r.data.map(v => v.venueId)).toEqual([ids.sinCuenta])
    expect(r.meta.total).toBe(1)
    const todas = await reporteDePosiciones(reportePosicionesQuerySchema.parse({ organizationId: orgId, flag: 'CON_MARCAS' }))
    expect(todas.meta.total).toBe(3)
  })

  it('el tope de página lo pone el SERVIDOR y la segunda página trae el resto', async () => {
    const q = reportePosicionesQuerySchema.parse({ organizationId: orgId, pageSize: 10000 })
    expect(q.pageSize).toBe(100)
    const p1 = await reporteDePosiciones(reportePosicionesQuerySchema.parse({ organizationId: orgId, pageSize: 3, page: 1 }))
    const p2 = await reporteDePosiciones(reportePosicionesQuerySchema.parse({ organizationId: orgId, pageSize: 3, page: 2 }))
    expect(p1.data).toHaveLength(3)
    expect(p2.data).toHaveLength(1)
    expect(p2.meta.total).toBe(4)
    const p9 = await reporteDePosiciones(reportePosicionesQuerySchema.parse({ organizationId: orgId, pageSize: 3, page: 9 }))
    expect(p9).toMatchObject({ data: [], meta: { total: 4 } })
  })

  it('no escribe nada', async () => {
    const contar = () =>
      Promise.all([
        prisma.venuePaymentConfig.count(),
        prisma.organizationPaymentConfig.count(),
        prisma.venuePricingStructure.count(),
        prisma.organizationPricingStructure.count(),
        prisma.merchantAccount.count(),
        prisma.terminal.count(),
        prisma.activityLog.count(),
      ])
    const antes = await contar()
    const foto = await fotoDeTarifas(Object.values(ids), [orgId])
    await reporteDePosiciones(reportePosicionesQuerySchema.parse({}))
    expect(await contar()).toEqual(antes)
    expect(await fotoDeTarifas(Object.values(ids), [orgId])).toBe(foto)
  })
})
