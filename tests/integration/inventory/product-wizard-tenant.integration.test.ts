import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import * as wizardController from '@/controllers/dashboard/inventory/productWizard.controller'

// 🔴 Aislamiento por negocio del asistente de inventario (auditoría de Codex, 29-sep-2026): las rutas
// `/venues/:venueId/inventory/products/:productId/...` autorizan el permiso en `:venueId`, pero el
// asistente buscaba el producto SÓLO por id. Con `inventory:update` en el negocio A se configuraba —y
// hasta se le creaba inventario— a un producto del negocio B. Se prueba en el controlador, que es lo que
// llega por HTTP, contra Postgres real.
const fixture = `wiz-tenant-${randomUUID()}`
const ids = { orgA: '', venueA: '', orgB: '', venueB: '', categoryB: '', productB: '' }

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

beforeAll(async () => {
  assertTestDatabase()
  const a = await venue('a')
  const b = await venue('b')
  Object.assign(ids, { orgA: a.orgId, venueA: a.venueId, orgB: b.orgId, venueB: b.venueId })
  ids.categoryB = (await prisma.menuCategory.create({ data: { venueId: ids.venueB, name: fixture, slug: fixture } })).id
})

beforeEach(async () => {
  await prisma.inventory.deleteMany({ where: { venueId: { in: [ids.venueA, ids.venueB] } } })
  await prisma.product.deleteMany({ where: { venueId: ids.venueB } })
  ids.productB = (
    await prisma.product.create({
      data: { venueId: ids.venueB, categoryId: ids.categoryB, name: 'Pan de B', sku: randomUUID(), price: 45 },
    })
  ).id
})

afterAll(async () => {
  assertTestDatabase()
  const venues = [ids.venueA, ids.venueB].filter(Boolean)
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId: { in: venues } } } })
  await prisma.inventory.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.product.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.activityLog.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: { in: [ids.orgA, ids.orgB].filter(Boolean) } } })
})

type Handler = (req: any, res: any, next: (error?: unknown) => void) => Promise<unknown>

/** El controlador real con los `params` que deja la validación de la ruta. */
async function call(handler: Handler, params: Record<string, string>, body: Record<string, unknown> = {}) {
  const out: { status: number; body: any; error: any } = { status: 200, body: undefined, error: undefined }
  const res = {
    status(code: number) {
      out.status = code
      return this
    },
    json(payload: unknown) {
      out.body = payload
      return this
    },
  }
  await handler({ params, body }, res, error => {
    out.error = error
  })
  return out
}

const desdeA = () => ({ venueId: ids.venueA, productId: ids.productB })
const desdeB = () => ({ venueId: ids.venueB, productId: ids.productB })

async function productoBIntacto() {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: ids.productB } })
  expect(p.trackInventory).toBe(false)
  expect(p.inventoryMethod).toBeNull()
  expect(await prisma.inventory.count({ where: { productId: ids.productB } })).toBe(0)
}

describe('desde el negocio A, un producto del negocio B no existe', () => {
  it('🔴 PUT inventory-method', async () => {
    const out = await call(wizardController.setProductInventoryMethod, desdeA(), { inventoryMethod: 'QUANTITY' })
    expect(out.error?.statusCode).toBe(404)
    await productoBIntacto()
  })

  it('🔴 paso 2 del asistente', async () => {
    const out = await call(wizardController.configureInventoryStep2, desdeA(), { useInventory: true, inventoryMethod: 'QUANTITY' })
    expect(out.error?.statusCode).toBe(404)
    await productoBIntacto()
  })

  it('🔴 paso 3 del asistente (no crea inventario de A para el producto de B)', async () => {
    const out = await call(wizardController.setupSimpleStockStep3, desdeA(), { initialStock: 12, reorderPoint: 2, costPerUnit: 20 })
    expect(out.error?.statusCode).toBe(404)
    await productoBIntacto()
  })

  it('🔴 lecturas: progreso del asistente, método y estado de inventario (receta y existencias)', async () => {
    expect((await call(wizardController.getWizardProgress, desdeA())).error?.statusCode).toBe(404)
    expect((await call(wizardController.getProductInventoryMethod, desdeA())).error?.statusCode).toBe(404)
    expect((await call(wizardController.getProductInventoryStatus, desdeA())).error?.statusCode).toBe(404)
  })
})

describe('control positivo: el propio negocio B sí puede', () => {
  it('PUT inventory-method, paso 2 y lecturas', async () => {
    const put = await call(wizardController.setProductInventoryMethod, desdeB(), { inventoryMethod: 'QUANTITY' })
    expect(put.error).toBeUndefined()
    expect(await prisma.inventory.count({ where: { productId: ids.productB, venueId: ids.venueB } })).toBe(1)

    expect(
      (await call(wizardController.configureInventoryStep2, desdeB(), { useInventory: true, inventoryMethod: 'QUANTITY' })).error,
    ).toBeUndefined()
    expect((await call(wizardController.getWizardProgress, desdeB())).error).toBeUndefined()
    expect((await call(wizardController.getProductInventoryStatus, desdeB())).error).toBeUndefined()
    const metodo = await call(wizardController.getProductInventoryMethod, desdeB())
    expect(metodo.error).toBeUndefined()
    expect(metodo.body.data).toEqual({ inventoryMethod: 'QUANTITY' })
  })

  it('paso 3 del asistente', async () => {
    const out = await call(wizardController.setupSimpleStockStep3, desdeB(), { initialStock: 12, reorderPoint: 2, costPerUnit: 20 })
    expect(out.error).toBeUndefined()
    const fila = await prisma.inventory.findUniqueOrThrow({ where: { productId: ids.productB } })
    expect(fila.venueId).toBe(ids.venueB)
    expect(fila.currentStock.toString()).toBe('12')
  })
})
