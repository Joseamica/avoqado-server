/**
 * Apartado de 15 minutos por talla contra Postgres real (candados y CAS). Base desechable, nunca av-db-25:
 * TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/dashboard/paymentLinkStockHold.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import {
  attachIntent,
  consumeHoldInTx,
  freezeIntentParams,
  takeOrReuseHold,
  variantAvailability,
} from '@/services/dashboard/paymentLinkStockHold.service'

const s = `hold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let venueId: string, orgId: string, staffId: string, linkId: string, groupId: string, categoryId: string

/** Talla de la familia con su existencia (la escritura de `productGroupId` pide la marca del escritor único). */
async function talla(nombre: string, stock: number): Promise<string> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('avoqado.product_group_writer', 'on', true)`
    const p = await tx.product.create({
      data: {
        venueId,
        categoryId,
        sku: `${nombre}-${s}`,
        name: `Blusa · ${nombre}`,
        price: 500,
        productGroupId: groupId,
        variantKey: `${nombre}-${s}`,
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
      } as any,
    })
    await tx.inventory.create({ data: { productId: p.id, venueId, currentStock: stock } })
    return p.id
  })
}

const tomar = (productId: string, browserToken: string) =>
  takeOrReuseHold({ paymentLinkId: linkId, venueId, productId, browserToken, amountCents: 50000 })

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Org ${s}`, email: `org-${s}@example.com`, phone: '5555555555' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Tienda ${s}`, slug: `tienda-${s}`, seatCapExempt: true } }))
    .id
  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Ropa ${s}`, slug: `ropa-${s}` } as any })).id
  staffId = (await prisma.staff.create({ data: { email: `staff-${s}@example.test`, firstName: 'Liga', lastName: 'Prueba' } })).id
  groupId = (await prisma.productGroup.create({ data: { venueId, name: 'Blusa', categoryId } })).id
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: 'TEST_PL_HOLD' },
    create: { code: 'TEST_PL_HOLD', name: 'Apartado de liga (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId,
      businessName: 'Liga por prenda',
      contactEmail: `${s}-canal@example.test`,
      publicKey: `pk_test_${s}`,
      secretKeyHash: `hash-${s}`,
      providerId: proveedor.id,
      providerCredentials: {},
    },
  })
  linkId = (
    await prisma.paymentLink.create({
      data: {
        shortCode: Math.random().toString(36).slice(2, 10),
        venueId,
        ecommerceMerchantId: canal.id,
        createdById: staffId,
        title: 'Blusa',
        amountType: 'FIXED',
        purpose: 'ITEM',
        productGroupId: groupId,
        isReusable: true,
      },
    })
  ).id
})

afterAll(async () => {
  if (!venueId) return
  await prisma.paymentLinkStockHold.deleteMany({ where: { venueId } })
  await prisma.paymentLink.deleteMany({ where: { venueId } })
  await prisma.ecommerceMerchant.deleteMany({ where: { venueId } })
  await prisma.inventory.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.productGroup.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const activas = (where: Record<string, unknown>) => prisma.paymentLinkStockHold.count({ where: { venueId, status: 'ACTIVE', ...where } })

it('dos aperturas simultáneas por la última pieza → una ficha y un 409', async () => {
  const ultima = await talla('U', 1)
  const r = await Promise.allSettled([tomar(ultima, 'tok-a'), tomar(ultima, 'tok-b')])
  expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1)
  const fallo = r.find(x => x.status === 'rejected') as PromiseRejectedResult
  expect(fallo.reason).toMatchObject({ statusCode: 409, code: 'PAYMENT_LINK_VARIANT_SOLD_OUT' })
  expect(await activas({ productId: ultima })).toBe(1)
})

it('mismo navegador, M y L a la vez → queda UNA sola ficha activa', async () => {
  const [m, l] = [await talla('M', 3), await talla('L', 3)]
  const r = await Promise.all([tomar(m, 'tok-ml'), tomar(l, 'tok-ml')])
  expect(await activas({ browserToken: 'tok-ml' })).toBe(1)
  // La que llegó después soltó a la primera y la devolvió para cancelar su intento.
  expect(r.flatMap(x => x.released.map(y => y.holdId)).length).toBe(1)
})

it('dos POST del MISMO token y talla a la vez → una sola ficha', async () => {
  const p = await talla('S', 3)
  const [a, b] = await Promise.all([tomar(p, 'tok-dup'), tomar(p, 'tok-dup')])
  expect(a.hold.id).toBe(b.hold.id)
  expect([a.reused, b.reused].sort()).toEqual([false, true])
  expect(await activas({ browserToken: 'tok-dup' })).toBe(1)
})

it('disponibilidad, congelar, ligar y consumir contra la base real', async () => {
  const p = await talla('XL', 1)
  const { hold } = await tomar(p, 'tok-pago')
  const para = async (t?: string) =>
    (await variantAvailability({ paymentLinkId: linkId, productGroupId: groupId, venueId, browserToken: t })).find(v => v.productId === p)
  expect(await para('tok-pago')).toMatchObject({ available: true, heldByYou: true })
  expect(await para('otro')).toMatchObject({ available: false, heldByYou: false, heldUntil: null })

  const congelada = await freezeIntentParams(hold.id, {
    amountCents: 50000,
    stripeAccountId: 'acct_x',
    intentParams: { amount: 50000 },
    checkoutSnapshot: { amount: 500 },
  })
  expect(congelada.intentParams).toEqual({ amount: 50000 })
  const otra = await freezeIntentParams(hold.id, {
    amountCents: 1,
    stripeAccountId: 'acct_y',
    intentParams: { amount: 1 },
    checkoutSnapshot: {},
  })
  expect(otra).toMatchObject({ amountCents: 50000, stripeAccountId: 'acct_x' })

  await attachIntent(hold.id, `pi_${s}`)
  await expect(attachIntent(hold.id, `pi_otro_${s}`)).rejects.toMatchObject({ statusCode: 409 })
  expect(await prisma.$transaction(tx => consumeHoldInTx(tx, `pi_${s}`))).toBe(1)
  expect(await para('otro')).toMatchObject({ available: true })
})

it('soltar entre el congelado y el ligado: la ficha suelta ni se congela ni acepta intento', async () => {
  const [m, l] = [await talla('M2', 2), await talla('L2', 2)]
  const congelar = (id: string) =>
    freezeIntentParams(id, { amountCents: 50000, stripeAccountId: 'acct_x', intentParams: { amount: 50000 }, checkoutSnapshot: {} })
  // Petición 1: aparta M y congela, pero todavía no liga su intento.
  const h1 = (await tomar(m, 'tok-carrera')).hold
  expect((await congelar(h1.id)).status).toBe('ACTIVE')
  // Petición 2 del mismo navegador (talla L): suelta H1 cuando aún no tenía intento.
  const r2 = await tomar(l, 'tok-carrera')
  expect(r2.released).toEqual([{ holdId: h1.id, stripePaymentIntentId: null, stripeAccountId: 'acct_x' }])
  // Petición 1 sigue: ligar su intento falla (quien llama lo cancela) y la ficha no lo guarda.
  await expect(attachIntent(h1.id, `pi_carrera_${s}`)).rejects.toMatchObject({ statusCode: 409 })
  const despues = await prisma.paymentLinkStockHold.findUniqueOrThrow({ where: { id: h1.id } })
  expect(despues).toMatchObject({ status: 'RELEASED', stripePaymentIntentId: null })

  // Variante: se suelta ANTES de congelar → freeze devuelve la ficha suelta sin congelarla (quien llama no crea el intento).
  const h3 = (await tomar(m, 'tok-carrera-2')).hold
  await tomar(l, 'tok-carrera-2')
  const r = await congelar(h3.id)
  expect(r).toMatchObject({ status: 'RELEASED', intentParams: null })
})
