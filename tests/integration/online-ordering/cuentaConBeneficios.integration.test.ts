/**
 * D16: `cuentaConBeneficios` (el campo de `/ordering/info` que decide si la tienda invita a «Entrar») contra Postgres REAL.
 *  - Cada fuente prendida dice `true`; apagada, vencida, gastada o de OTRO negocio, `false`.
 *  - Los cupones dicen exactamente lo mismo que la oferta de la tienda (`ofertaDeBeneficios().cupon`), caso por caso.
 *  - Con `false`, «Mi cuenta» (`getCustomerPortal`) y la oferta de una clienta no tienen nada VIVO que enseñar (sus pedidos, sus
 *    reservas y lo ya muerto no cuentan): el campo nunca esconde algo que se pueda usar.
 */
import cuid from 'cuid'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cuentaConBeneficios } from '@/services/online-ordering/cuentaConBeneficios'
import { ofertaDeBeneficios } from '@/services/online-ordering/beneficios.service'
import { getCustomerPortal } from '@/services/public/customerPortal.public.service'

jest.setTimeout(120000)

const run = cuid()
const D = (v: number) => new Prisma.Decimal(v)
const DIA = 86_400_000
const ayer = () => new Date(Date.now() - DIA)
const manana = () => new Date(Date.now() + DIA)
let orgId: string
let n = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: run, email: `${run}@example.test`, phone: '5550000000' } })).id
})

/** Un negocio nuevo y vacío, con una clienta. */
async function negocio() {
  n += 1
  const venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `${run}-${n}`, slug: `${run}-${n}` } })).id
  const customerId = (
    await prisma.customer.create({ data: { venueId, firstName: 'Ana', phone: `+5255${String(30000000 + n * 7919).slice(0, 8)}` } })
  ).id
  return { venueId, customerId }
}

const descuento = (venueId: string, extra: Partial<Prisma.DiscountUncheckedCreateInput> = {}) =>
  prisma.discount.create({ data: { venueId, name: `D${++n}`, type: 'PERCENTAGE', value: D(10), ...extra } })

async function cupon(
  venueId: string,
  d: Partial<Prisma.DiscountUncheckedCreateInput> = {},
  c: Partial<Prisma.CouponCodeUncheckedCreateInput> = {},
) {
  const { id } = await descuento(venueId, d)
  await prisma.couponCode.create({ data: { discountId: id, code: `C${run}${++n}`.toUpperCase(), ...c } })
}

async function tarjeta(venueId: string, customerId: string | null = null, extra: Partial<Prisma.GiftCardUncheckedCreateInput> = {}) {
  n += 1
  await prisma.giftCard.create({
    data: {
      venueId,
      organizationId: orgId,
      customerId,
      codeHash: `${run}-h-${n}`,
      codeEnc: `${run}-e-${n}`,
      codeLast4: '0000',
      pageToken: `${run}-p-${n}`,
      initialAmount: D(100),
      balance: D(100),
      status: 'ACTIVE',
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
      ...extra,
    },
  })
}

async function paquete(venueId: string, customerId: string, extra: Partial<Prisma.CreditPackPurchaseUncheckedCreateInput> = {}) {
  const pack = await prisma.creditPack.create({ data: { venueId, name: `P${++n}`, price: D(500) } })
  await prisma.creditPackPurchase.create({ data: { venueId, customerId, creditPackId: pack.id, amountPaid: D(500), ...extra } })
}

describe('D16 · cuentaConBeneficios', () => {
  it('un negocio sin nada: false, y la clienta no tendría nada en «Mi cuenta» ni en la oferta de la tienda', async () => {
    const { venueId, customerId } = await negocio()
    expect(await cuentaConBeneficios(venueId)).toBe(false)
    const portal: any = await getCustomerPortal(venueId, customerId, { contactos: [] })
    expect(portal.puntos).toBeNull()
    expect(portal.stampCard.enabled).toBe(false)
    expect(portal.premioDisponible).toBeNull()
    expect(portal.descuentos.items).toHaveLength(0)
    expect(portal.saldoAFavor).toBeNull()
    expect(portal.tarjetas.items).toHaveLength(0)
    expect(portal.credits.purchases).toHaveLength(0)
    expect(await ofertaDeBeneficios(venueId, customerId)).toEqual({ premio: null, puntos: null, cupon: false })
  })

  describe('lealtad', () => {
    it('la configuración existe pero puntos y sellos apagados: false', async () => {
      const { venueId } = await negocio()
      await prisma.loyaltyConfig.create({ data: { venueId, active: false, stampsEnabled: false } })
      expect(await cuentaConBeneficios(venueId)).toBe(false)
    })
    it('puntos prendidos: true (el portal enseña sus puntos)', async () => {
      const { venueId, customerId } = await negocio()
      await prisma.loyaltyConfig.create({ data: { venueId, active: true, stampsEnabled: false } })
      expect(await cuentaConBeneficios(venueId)).toBe(true)
      expect(((await getCustomerPortal(venueId, customerId, { contactos: [] })) as any).puntos).not.toBeNull()
    })
    it('sólo sellos (puntos apagados): true (el portal enseña la cartilla)', async () => {
      const { venueId, customerId } = await negocio()
      await prisma.loyaltyConfig.create({ data: { venueId, active: false, stampsEnabled: true } })
      expect(await cuentaConBeneficios(venueId)).toBe(true)
      expect(((await getCustomerPortal(venueId, customerId, { contactos: [] })) as any).stampCard.enabled).toBe(true)
    })
  })

  describe('tarjetas de regalo y saldo a favor', () => {
    it('prendidas aunque no se haya vendido ninguna: true; apagadas y sin tarjetas: false', async () => {
      const a = await negocio()
      await prisma.giftCardSettings.create({ data: { venueId: a.venueId, enabled: true } })
      expect(await cuentaConBeneficios(a.venueId)).toBe(true)
      const b = await negocio()
      await prisma.giftCardSettings.create({ data: { venueId: b.venueId, enabled: false } })
      expect(await cuentaConBeneficios(b.venueId)).toBe(false)
    })
    it('apagadas pero con una tarjeta (o un sobre de saldo a favor) vivo: true, porque ese saldo se honra', async () => {
      const { venueId, customerId } = await negocio()
      await prisma.giftCardSettings.create({ data: { venueId, enabled: false } })
      await tarjeta(venueId, customerId)
      expect(await cuentaConBeneficios(venueId)).toBe(true)
    })
    it('una tarjeta de nadie, viva y con dinero, se puede guardar: true; bloqueada con dinero y con dueña: true', async () => {
      const a = await negocio()
      await tarjeta(a.venueId)
      expect(await cuentaConBeneficios(a.venueId)).toBe(true)
      const b = await negocio()
      await tarjeta(b.venueId, b.customerId, { status: 'BLOCKED' })
      expect(await cuentaConBeneficios(b.venueId)).toBe(true)
    })
    it('bloqueada con dinero pero SIN dueña (nadie la ve ni la puede guardar): false (codex-r2 #3)', async () => {
      const { venueId } = await negocio()
      await prisma.giftCardSettings.create({ data: { venueId, enabled: false } })
      await tarjeta(venueId, null, { status: 'BLOCKED' })
      expect(await cuentaConBeneficios(venueId)).toBe(false)
    })
    it.each<[string, Partial<Prisma.GiftCardUncheckedCreateInput>]>([
      ['una venta cancelada antes de cobrar (sin dueña, desactivada y en $0)', { status: 'DEACTIVATED', balance: D(0) }],
      ['una venta sin cobrar (PENDING)', { status: 'PENDING', balance: D(0) }],
      ['una tarjeta gastada ($0)', { balance: D(0) }],
      ['una tarjeta vencida', { expiresAt: ayer() }],
      ['una tarjeta desactivada con saldo', { status: 'DEACTIVATED' }],
    ])('con la función apagada, sólo %s: false (codex-r1 #2)', async (_n, extra) => {
      const { venueId } = await negocio()
      await prisma.giftCardSettings.create({ data: { venueId, enabled: false } })
      await tarjeta(venueId, null, extra)
      expect(await cuentaConBeneficios(venueId)).toBe(false)
    })
  })

  describe('paquetes', () => {
    it('uno vigente: true', async () => {
      const { venueId, customerId } = await negocio()
      await paquete(venueId, customerId, { expiresAt: manana() })
      expect(await cuentaConBeneficios(venueId)).toBe(true)
    })
    it.each([
      ['vencido', { expiresAt: ayer() }],
      ['gastado', { status: 'EXHAUSTED' as const }],
      ['reembolsado', { status: 'REFUNDED' as const }],
    ])('sólo uno %s: false', async (_n, extra) => {
      const { venueId, customerId } = await negocio()
      await paquete(venueId, customerId, extra)
      expect(await cuentaConBeneficios(venueId)).toBe(false)
    })
  })

  describe('descuentos de cliente', () => {
    it('de un grupo: true, y la clienta del grupo lo ve en «Mi cuenta»', async () => {
      const { venueId, customerId } = await negocio()
      const grupo = await prisma.customerGroup.create({ data: { venueId, name: `G${++n}` } })
      await prisma.customer.update({ where: { id: customerId }, data: { customerGroupId: grupo.id } })
      await descuento(venueId, { scope: 'CUSTOMER_GROUP', customerGroupId: grupo.id })
      expect(await cuentaConBeneficios(venueId)).toBe(true)
      expect(((await getCustomerPortal(venueId, customerId, { contactos: [] })) as any).descuentos.items).toHaveLength(1)
    })
    it('asignado a una clienta: true', async () => {
      const { venueId, customerId } = await negocio()
      const d = await descuento(venueId)
      await prisma.customerDiscount.create({ data: { customerId, discountId: d.id } })
      expect(await cuentaConBeneficios(venueId)).toBe(true)
      expect(((await getCustomerPortal(venueId, customerId, { contactos: [] })) as any).descuentos.items).toHaveLength(1)
    })
    it.each([
      ['sin grupo ni asignación (de caja)', {}, false],
      ['asignado pero vencido', { validUntil: ayer() }, true],
      ['asignado pero todavía no empieza', { validFrom: manana() }, true],
      ['asignado pero apagado', { active: false }, true],
    ])('%s: false', async (_n, extra, asignado) => {
      const { venueId, customerId } = await negocio()
      const d = await descuento(venueId, extra)
      if (asignado) await prisma.customerDiscount.create({ data: { customerId, discountId: d.id } })
      expect(await cuentaConBeneficios(venueId)).toBe(false)
    })
    it.each<[string, Partial<Prisma.CustomerDiscountUncheckedCreateInput>, Partial<Prisma.DiscountUncheckedCreateInput>]>([
      ['la asignación apagada', { active: false }, {}],
      ['la asignación vencida (codex-r1 #3)', { validUntil: ayer() }, {}],
      ['la asignación que todavía no empieza', { validFrom: manana() }, {}],
      ['la asignación agotada', { maxUses: 1, usageCount: 1 }, {}],
      ['el descuento agotado para todas', {}, { maxTotalUses: 5, currentUses: 5 }],
    ])('con %s: false, y el portal tampoco lo enseña', async (_n, asignacion, extra) => {
      const { venueId, customerId } = await negocio()
      const d = await descuento(venueId, extra)
      await prisma.customerDiscount.create({ data: { customerId, discountId: d.id, ...asignacion } })
      expect(await cuentaConBeneficios(venueId)).toBe(false)
      expect(((await getCustomerPortal(venueId, customerId, { contactos: [] })) as any).descuentos.items).toHaveLength(0)
    })
    it('de un grupo sin nadie: false', async () => {
      const { venueId } = await negocio()
      const grupo = await prisma.customerGroup.create({ data: { venueId, name: `G${++n}` } })
      await descuento(venueId, { scope: 'CUSTOMER_GROUP', customerGroupId: grupo.id })
      expect(await cuentaConBeneficios(venueId)).toBe(false)
    })
  })

  // codex-r2 #1: en la tienda, el motor aplica los automáticos sólo con sesión (`cotizarConBeneficios` → `aplicarBeneficiosEnTx`).
  describe('descuentos automáticos (los que el motor aplica con sesión)', () => {
    it('uno vigente, sin grupo ni asignación: true', async () => {
      const { venueId } = await negocio()
      await descuento(venueId, { isAutomatic: true })
      expect(await cuentaConBeneficios(venueId)).toBe(true)
    })
    it('uno con horario (happy hour) cuenta aunque ahora no sea su hora: true', async () => {
      const { venueId } = await negocio()
      await descuento(venueId, { isAutomatic: true, daysOfWeek: [((new Date().getDay() + 3) % 7) as number] })
      expect(await cuentaConBeneficios(venueId)).toBe(true)
    })
    it.each<[string, Partial<Prisma.DiscountUncheckedCreateInput>]>([
      ['vencido', { validUntil: ayer() }],
      ['que todavía no empieza', { validFrom: manana() }],
      ['apagado', { active: false }],
      ['agotado para todas', { maxTotalUses: 3, currentUses: 3 }],
    ])('sólo uno %s: false', async (_n, extra) => {
      const { venueId } = await negocio()
      await descuento(venueId, { isAutomatic: true, ...extra })
      expect(await cuentaConBeneficios(venueId)).toBe(false)
    })
  })

  describe('cupones de la tienda: lo mismo que la oferta (ofertaDeBeneficios.cupon)', () => {
    it.each<[string, Partial<Prisma.DiscountUncheckedCreateInput>, Partial<Prisma.CouponCodeUncheckedCreateInput>, boolean]>([
      ['vigente', {}, {}, true],
      ['el código vencido', {}, { validUntil: ayer() }, false],
      ['el descuento vencido y el código sin fecha', { validUntil: ayer() }, {}, false],
      ['el código con fecha propia que gana a la del descuento', { validUntil: ayer() }, { validUntil: manana() }, true],
      ['el código todavía no empieza', {}, { validFrom: manana() }, false],
      ['el descuento todavía no empieza y el código sin fecha', { validFrom: manana() }, {}, false],
      ['el código apagado', {}, { active: false }, false],
      ['el descuento apagado', { active: false }, {}, false],
      ['pide aprobación', { requiresApproval: true }, {}, false],
      ['es cortesía', { type: 'COMP' }, {}, false],
      ['es de producto', { scope: 'ITEM' }, {}, false],
    ])('%s ⇒ %s', async (_n, d, c, esperado) => {
      const { venueId, customerId } = await negocio()
      await cupon(venueId, d, c)
      expect((await ofertaDeBeneficios(venueId, customerId)).cupon).toBe(esperado)
      expect(await cuentaConBeneficios(venueId)).toBe(esperado)
    })
  })

  // codex-r2 #2: la oferta enseña el campo de cupón sin mirar los límites, pero el canje los rechaza (`validateCoupon`, USAGE_LIMIT).
  it.each<[string, Partial<Prisma.DiscountUncheckedCreateInput>, Partial<Prisma.CouponCodeUncheckedCreateInput>]>([
    ['el código agotado', {}, { maxUses: 1, currentUses: 1 }],
    ['el descuento del cupón agotado', { maxTotalUses: 2, currentUses: 2 }, {}],
  ])('cupones: sólo uno con %s: false', async (_n, d, c) => {
    const { venueId } = await negocio()
    await cupon(venueId, d, c)
    expect(await cuentaConBeneficios(venueId)).toBe(false)
  })
  it('cupones: un código con usos todavía disponibles: true', async () => {
    const { venueId } = await negocio()
    await cupon(venueId, { maxTotalUses: 2, currentUses: 1 }, { maxUses: 5, currentUses: 4 })
    expect(await cuentaConBeneficios(venueId)).toBe(true)
  })

  it('lo de OTRO negocio no cuenta', async () => {
    const otro = await negocio()
    await prisma.loyaltyConfig.create({ data: { venueId: otro.venueId, active: true, stampsEnabled: true } })
    await prisma.giftCardSettings.create({ data: { venueId: otro.venueId, enabled: true } })
    await tarjeta(otro.venueId, otro.customerId)
    await paquete(otro.venueId, otro.customerId)
    await cupon(otro.venueId)
    const { venueId } = await negocio()
    expect(await cuentaConBeneficios(otro.venueId)).toBe(true)
    expect(await cuentaConBeneficios(venueId)).toBe(false)
  })
})
