import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { createProductWithInventory } from '@/services/dashboard/productWizard.service'

// 🔴 «Nuevo producto» del dashboard (asistente → /inventory/wizard/complete) creaba el producto SIN lo que el usuario
// eligió: grupos de modificadores, «Se vende por peso» y claves SAT (5-oct-2026, La Galeterie; el SKU y el GTIN se
// arreglaron antes). Por peso es dinero: un producto por kilo nacía por pieza y el POS lo cobraba como pieza. El alta
// del asistente ahora guarda lo mismo que el alta normal (`product.dashboard.service.createProduct`).
const fixture = `wiz-campos-${randomUUID()}`
const ids = { org: '', venue: '', otraOrg: '', otroVenue: '', category: '', staff: '', grupo1: '', grupo2: '', grupoAjeno: '' }

function assertTestDatabase(): void {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const effective = new URL(process.env.DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')
  expect(effective.toString()).toBe(declared.toString())
}

async function venue(label: string) {
  const org = await prisma.organization.create({
    data: { name: `${fixture}-${label}`, email: `${label}-${fixture}@example.test`, phone: '5500000000' },
  })
  const v = await prisma.venue.create({
    data: { organizationId: org.id, name: `${fixture}-${label}`, slug: `${fixture}-${label}`, timezone: 'America/Mexico_City' },
  })
  return { orgId: org.id, venueId: v.id }
}

const actor = () => ({ type: 'HUMAN' as const, staffId: ids.staff, impersonating: false })

const alta = (product: Record<string, unknown>) =>
  createProductWithInventory(
    ids.venue,
    {
      product: { name: `Pan ${randomUUID()}`, price: 73, categoryId: ids.category, type: 'FOOD_AND_BEV', ...product },
      inventory: { useInventory: false },
    },
    actor(),
  )

beforeAll(async () => {
  assertTestDatabase()
  const a = await venue('a')
  const b = await venue('b')
  Object.assign(ids, { org: a.orgId, venue: a.venueId, otraOrg: b.orgId, otroVenue: b.venueId })
  ids.category = (await prisma.menuCategory.create({ data: { venueId: ids.venue, name: fixture, slug: fixture } })).id
  ids.staff = (await prisma.staff.create({ data: { email: `${fixture}@example.test`, firstName: 'Wiz', lastName: 'Campos' } })).id
  ids.grupo1 = (await prisma.modifierGroup.create({ data: { venueId: ids.venue, name: 'Pan' } })).id
  ids.grupo2 = (await prisma.modifierGroup.create({ data: { venueId: ids.venue, name: 'Extras' } })).id
  ids.grupoAjeno = (await prisma.modifierGroup.create({ data: { venueId: ids.otroVenue, name: 'De otro negocio' } })).id
})

afterAll(async () => {
  assertTestDatabase()
  const venues = [ids.venue, ids.otroVenue].filter(Boolean)
  await prisma.productModifierGroup.deleteMany({ where: { product: { venueId: { in: venues } } } })
  await prisma.inventory.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.product.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.modifierGroup.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.activityLog.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: { in: [ids.org, ids.otraOrg].filter(Boolean) } } })
  if (ids.staff) await prisma.staff.deleteMany({ where: { id: ids.staff } })
})

const leer = (productId: string) =>
  prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: { modifierGroups: { orderBy: { displayOrder: 'asc' } } },
  })

describe('Asistente «Nuevo producto» — lo que eligió el usuario llega a la base', () => {
  it('P1 un producto por peso nace por peso, con unidad kilo', async () => {
    const { productId } = await alta({ soldByWeight: true })
    const p = await leer(productId)
    expect(p.soldByWeight).toBe(true)
    expect(p.unit).toBe('KILOGRAM')
  })

  it('liga los grupos de modificadores en el orden elegido', async () => {
    const { productId } = await alta({ modifierGroupIds: [ids.grupo2, ids.grupo1] })
    expect((await leer(productId)).modifierGroups.map(g => g.groupId)).toEqual([ids.grupo2, ids.grupo1])
  })

  it('un grupo de OTRO negocio no se liga y el producto no se crea', async () => {
    const antes = await prisma.product.count({ where: { venueId: ids.venue } })
    await expect(alta({ modifierGroupIds: [ids.grupo1, ids.grupoAjeno] })).rejects.toMatchObject({ statusCode: 404 })
    expect(await prisma.product.count({ where: { venueId: ids.venue } })).toBe(antes)
  })

  it('guarda las claves SAT; objetoImp 02 con el IVA por producto apagado no estorba', async () => {
    const { productId } = await alta({ satProductKey: '50181900', satUnitKey: 'H87', objetoImp: '02' })
    const p = await leer(productId)
    expect(p.satProductKey).toBe('50181900')
    expect(p.satUnitKey).toBe('H87')
    expect(p.objetoImp).toBe('02')
    expect(Number(p.taxRate)).toBe(0.16)
  })

  it('pedir otro objeto de impuesto con el IVA por producto apagado se rechaza y no crea nada', async () => {
    const antes = await prisma.product.count({ where: { venueId: ids.venue } })
    await expect(alta({ objetoImp: '01' })).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.product.count({ where: { venueId: ids.venue } })).toBe(antes)
  })

  // Regresión: sin extras el alta queda como siempre.
  it('sin extras: por pieza, sin modificadores, sin claves SAT', async () => {
    const { productId } = await alta({})
    const p = await leer(productId)
    expect(p.soldByWeight).toBe(false)
    expect(p.unit).toBeNull()
    expect(p.modifierGroups).toEqual([])
    expect(p.satProductKey).toBeNull()
    expect(Number(p.taxRate)).toBe(0.16)
  })
})
