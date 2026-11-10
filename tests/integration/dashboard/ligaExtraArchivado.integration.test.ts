// tests/integration/dashboard/ligaExtraArchivado.integration.test.ts
/**
 * Founder 9-nov: archivar un extra no debe impedir editar una liga que ya lo traía, porque una liga enviada mantiene su
 * precio. Un archivado tampoco se puede agregar a una liga que no lo tenía. En Postgres real: la prueba unitaria simula el
 * filtro `OR` de la consulta.
 */
import prisma from '@/utils/prismaClient'
import { updatePaymentLink } from '@/services/dashboard/paymentLink.service'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from '../commission/_mundoComisiones'

const PROVEEDOR = 'LIGA_EXTRA_ARCHIVADO'
let m: MundoComisiones
let productoId: string
let otroProductoId: string
let queso: string
let tocino: string
let canalId: string

const nuevaLiga = async (conQueso: boolean) =>
  (
    await prisma.paymentLink.create({
      data: {
        shortCode: Math.random().toString(36).slice(2, 10),
        venueId: m.venueId,
        ecommerceMerchantId: canalId,
        createdById: m.owner,
        title: 'Liga',
        amountType: 'OPEN',
        purpose: 'ITEM',
        items: {
          create: [{ productId: productoId, quantity: 1, position: 0, ...(conQueso ? { modifiers: { create: [{ modifierId: queso, quantity: 1 }] } } : {}) }],
        },
      },
    })
  ).id

const editar = (ligaId: string, productId: string, modifierId: string) =>
  updatePaymentLink(m.venueId, ligaId, { items: [{ productId, quantity: 1, modifiers: [{ modifierId, quantity: 1 }] }] } as never)

beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('ligaextra')
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: PROVEEDOR },
    create: { code: PROVEEDOR, name: 'Liga extra (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  canalId = (
    await prisma.ecommerceMerchant.create({
      data: {
        venueId: m.venueId,
        businessName: 'Liga extra',
        contactEmail: `${m.key}-canal@example.test`,
        publicKey: `pk_test_${m.key}`,
        secretKeyHash: `hash-${m.key}`,
        providerId: proveedor.id,
        providerCredentials: {},
      },
    })
  ).id
  const categoryId = (await prisma.menuCategory.create({ data: { venueId: m.venueId, name: 'Extras', slug: `extras-${m.key}` } })).id
  const producto = (sku: string) => prisma.product.create({ data: { venueId: m.venueId, categoryId, sku, name: sku, price: 100 } })
  productoId = (await producto(`A-${m.key}`)).id
  otroProductoId = (await producto(`B-${m.key}`)).id
  const grupo = await prisma.modifierGroup.create({ data: { venueId: m.venueId, name: 'Extras' } })
  queso = (await prisma.modifier.create({ data: { groupId: grupo.id, name: 'Queso', price: 20 } })).id
  tocino = (await prisma.modifier.create({ data: { groupId: grupo.id, name: 'Tocino', price: 15 } })).id
  await prisma.productModifierGroup.createMany({
    data: [
      { productId: productoId, groupId: grupo.id },
      { productId: otroProductoId, groupId: grupo.id },
    ],
  })
})
afterEach(async () => {
  if (!m?.venueId) return
  await prisma.paymentLink.deleteMany({ where: { venueId: m.venueId } })
  await prisma.productModifierGroup.deleteMany({ where: { product: { venueId: m.venueId } } })
  await prisma.modifierGroup.deleteMany({ where: { venueId: m.venueId } })
  await prisma.product.deleteMany({ where: { venueId: m.venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId: m.venueId } })
  await borrarMundoComisiones(m)
})
afterAll(() => prisma.paymentProvider.deleteMany({ where: { code: PROVEEDOR } }))

const extrasDe = async (ligaId: string) =>
  (await prisma.paymentLinkItemModifier.findMany({ where: { paymentLinkItem: { paymentLinkId: ligaId } }, select: { modifierId: true } })).map(m => m.modifierId)

it('editar la liga conserva el extra archivado que ya traía', async () => {
  const liga = await nuevaLiga(true)
  await prisma.modifier.update({ where: { id: queso }, data: { active: false } })

  await expect(editar(liga, productoId, queso)).resolves.toBeDefined()

  expect(await extrasDe(liga)).toEqual([queso])
  expect(Number((await prisma.modifier.findUniqueOrThrow({ where: { id: queso } })).price)).toBe(20)
})

it('no se puede agregar un archivado a una liga que no lo traía', async () => {
  const liga = await nuevaLiga(false)
  await prisma.modifier.update({ where: { id: queso }, data: { active: false } })

  await expect(editar(liga, productoId, queso)).rejects.toThrow(/no pertenecen/)
  expect(await extrasDe(liga)).toEqual([])
})

it('tenerlo en un producto no permite ponerlo en otro', async () => {
  const liga = await nuevaLiga(true)
  await prisma.modifier.update({ where: { id: queso }, data: { active: false } })

  await expect(editar(liga, otroProductoId, queso)).rejects.toThrow(/no pertenecen/)
})

it('un extra activo se sigue pudiendo elegir', async () => {
  const liga = await nuevaLiga(false)

  await expect(editar(liga, productoId, tocino)).resolves.toBeDefined()
  expect(await extrasDe(liga)).toEqual([tocino])
})
