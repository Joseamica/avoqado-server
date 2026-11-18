import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { createProductStep1, createProductWithInventory } from '@/services/dashboard/productWizard.service'

// Tarjeta `hz:nube0000:na1d52b5` (17-nov-2026): «Nuevo producto» deja contar piezas en todos los planes. El alta del asistente son
// tres pasos (producto, método, saldo): con inventario, el producto nace OCULTO y se publica al final, ya con su saldo, para que el POS
// (que sólo lista activos) no lo venda antes (Codex r2 #3 y r3 #1). Un tipo que no lleva inventario no puede nacer con él (r3 #3).
// Arnés de `product-wizard-campos-del-alta.integration.test.ts`.
const fixture = `wiz-piezas-${randomUUID()}`
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

const altaConPiezas = (
  product: Record<string, unknown> = {},
  simpleStock: Record<string, unknown> | undefined = { initialStock: 10, reorderPoint: 2, costPerUnit: 5 },
) =>
  createProductWithInventory(
    ids.venue,
    {
      product: { name: `Libreta ${randomUUID()}`, price: 85, categoryId: ids.category, type: 'REGULAR', ...product } as never,
      inventory: { useInventory: true, inventoryMethod: 'QUANTITY' },
      ...(simpleStock ? { simpleStock: simpleStock as never } : {}),
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
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId: { in: venues } } } })
  await prisma.inventory.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.product.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.modifierGroup.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.activityLog.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: { in: [ids.org, ids.otraOrg].filter(Boolean) } } })
  if (ids.staff) await prisma.staff.deleteMany({ where: { id: ids.staff } })
})

describe('na1d52b5 · alta con piezas por el asistente', () => {
  // NEW FEATURE TESTS
  it('el producto termina PUBLICADO, por piezas y con su saldo inicial y su movimiento', async () => {
    const { productId } = await altaConPiezas()
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { inventory: true } })
    expect(p.active).toBe(true)
    expect(p.trackInventory).toBe(true)
    expect(p.inventoryMethod).toBe('QUANTITY')
    expect(Number(p.inventory?.currentStock)).toBe(10)
    const movimientos = await prisma.inventoryMovement.findMany({ where: { inventoryId: p.inventory!.id }, take: 5 })
    expect(movimientos.map(m => Number(m.quantity))).toEqual([10])
  })

  it('el paso 1 con «nacer oculto» crea el producto INACTIVO (el POS sólo lista activos)', async () => {
    const r = await createProductStep1(
      ids.venue,
      { name: `Oculto ${randomUUID()}`, price: 10, categoryId: ids.category, type: 'REGULAR' } as never,
      actor(),
      { nacerOculto: true },
    )
    expect((await prisma.product.findUniqueOrThrow({ where: { id: r.productId } })).active).toBe(false)
  })

  it('por piezas SIN saldo inicial: también termina publicado, con su fila en cero', async () => {
    const { productId } = await altaConPiezas({}, undefined)
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { inventory: true } })
    expect(p.active).toBe(true)
    expect(p.inventoryMethod).toBe('QUANTITY')
    expect(Number(p.inventory?.currentStock)).toBe(0)
  })

  it('una CLASE con piezas se rechaza (aunque no traiga saldo inicial) y no se crea nada', async () => {
    const antes = await prisma.product.count({ where: { venueId: ids.venue } })
    await expect(altaConPiezas({ type: 'CLASS' }, undefined)).rejects.toMatchObject({ statusCode: 400 })
    expect(await prisma.product.count({ where: { venueId: ids.venue } })).toBe(antes)
  })

  // REGRESSION TESTS
  it('sin inventario: nace publicado desde el principio, como siempre', async () => {
    const { productId } = await createProductWithInventory(
      ids.venue,
      {
        product: { name: `Sin ${randomUUID()}`, price: 10, categoryId: ids.category, type: 'REGULAR' } as never,
        inventory: { useInventory: false },
      },
      actor(),
    )
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(p.active).toBe(true)
    expect(p.trackInventory).toBe(false)
  })

  it('una CLASE sin inventario se sigue dando de alta', async () => {
    const { productId } = await createProductWithInventory(
      ids.venue,
      {
        product: { name: `Clase ${randomUUID()}`, price: 10, categoryId: ids.category, type: 'CLASS' } as never,
        inventory: { useInventory: false },
      },
      actor(),
    )
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).active).toBe(true)
  })
})
