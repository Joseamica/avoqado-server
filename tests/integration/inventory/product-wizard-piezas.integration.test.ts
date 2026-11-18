import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { createProductWithInventory } from '@/services/dashboard/productWizard.service'
import * as tiendaShopify from '@/services/commerce-channels/shopify/shopify.store.service'
import { logAction } from '@/services/dashboard/activity-log.service'

// Tarjeta `hz:nube0000:na1d52b5` (17-nov-2026): «Nuevo producto» deja contar piezas en todos los planes. El alta del asistente
// por piezas guarda producto, método y saldo en UNA transacción (Codex r4): nadie lo ve ni lo vende antes de tener sus piezas, y si algo
// falla no queda nada. Un tipo que no lleva inventario no puede nacer con él (r3 #3).
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
  simpleStock: Record<string, unknown> | null = { initialStock: 10, reorderPoint: 2, costPerUnit: 5 }, // «sin saldo» = null (un undefined activa este valor)
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

  it('mientras se guarda, OTRA conexión no encuentra el producto: nadie lo vende ni lo enciende antes de tener sus piezas (Codex r4 #1 y #3)', async () => {
    const nombre = `Invisible ${randomUUID()}`
    let visto: number | 'sin-conexion' | undefined
    // A media alta (después de crear el producto, antes de su saldo), otra conexión lo busca, como lo haría el POS o un agregador.
    const espia = jest.spyOn(tiendaShopify, 'pedirCuadreAlVolverACantidad').mockImplementation(async () => {
      visto = await Promise.race([
        prisma.product.count({ where: { venueId: ids.venue, name: nombre } }),
        new Promise<'sin-conexion'>(r => setTimeout(() => r('sin-conexion'), 3_000)),
      ])
    })
    try {
      await altaConPiezas({ name: nombre })
    } finally {
      espia.mockRestore()
    }
    expect(visto).toBe(0)
    expect(await prisma.product.count({ where: { venueId: ids.venue, name: nombre, active: true } })).toBe(1)
  })

  it('si algo falla a medio camino (aquí, el costo), NO queda nada: ni producto, ni inventario, ni movimiento (Codex r4 #2)', async () => {
    const antes = await prisma.product.count({ where: { venueId: ids.venue } })
    const filas = await prisma.inventory.count({ where: { venueId: ids.venue } })

    await expect(altaConPiezas({}, { initialStock: 10, reorderPoint: 2 })).rejects.toBeTruthy()

    expect(await prisma.product.count({ where: { venueId: ids.venue } })).toBe(antes)
    expect(await prisma.inventory.count({ where: { venueId: ids.venue } })).toBe(filas)
  })

  it('el producto nace PUBLICADO desde el principio: nunca existe sin sus piezas (una sola transacción)', async () => {
    const { productId } = await altaConPiezas({ name: `Uno ${randomUUID()}` })
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { inventory: true } })
    expect(p.active).toBe(true)
    expect(Number(p.inventory?.currentStock)).toBe(10)
    // El arnés de integración reemplaza la bitácora por un simulador (`integration-setup.ts`): se lee lo que se le pidió.
    const acciones = (logAction as jest.Mock).mock.calls.map(([a]) => a).filter(a => a.entityId === productId)
    expect(acciones.map(a => a.action).sort()).toEqual(['PRODUCT_CREATED', 'PRODUCT_INVENTORY_METHOD_SET'])
    expect(acciones.every(a => a.staffId === ids.staff && a.venueId === ids.venue)).toBe(true)
  })

  it('un SKU repetido da el 409 en español de siempre, y tampoco deja nada', async () => {
    const sku = `SKU-PZ-${randomUUID().slice(0, 8)}`
    await altaConPiezas({ sku })
    const antes = await prisma.product.count({ where: { venueId: ids.venue } })
    await expect(altaConPiezas({ sku })).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.product.count({ where: { venueId: ids.venue } })).toBe(antes)
  })

  it('por piezas SIN saldo inicial: también termina publicado, con su fila en cero', async () => {
    const { productId } = await altaConPiezas({}, null)
    const p = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { inventory: true } })
    expect(p.active).toBe(true)
    expect(p.inventoryMethod).toBe('QUANTITY')
    expect(Number(p.inventory?.currentStock)).toBe(0)
  })

  it('una CLASE con piezas se rechaza (aunque no traiga saldo inicial) y no se crea nada', async () => {
    const antes = await prisma.product.count({ where: { venueId: ids.venue } })
    await expect(altaConPiezas({ type: 'CLASS' }, null)).rejects.toMatchObject({ statusCode: 400 })
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
