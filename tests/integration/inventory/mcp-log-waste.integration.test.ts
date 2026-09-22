/**
 * MCP de clientes — `log_waste` y `list_waste_reports` contra Postgres real, por el camino
 * completo: `resolveScope` → guard → servicios reales → base. Sin mocks de servicio.
 *
 * Qué fija, y por qué:
 *   - 🔴 Vista previa → confirmación escribe UNA merma, con `source: 'MCP'`, y deja UNA sola fila
 *     de auditoría (la del servicio). La tool no agrega `auditMcpWrite`: sería el mismo evento dos
 *     veces en la pantalla de auditoría del dueño.
 *   - 🔴 Repetir la confirmación con el mismo folio no descuenta otra vez.
 *   - 🔴 Confirmar con una cantidad distinta a la previsualizada no escribe nada.
 *   - La vista previa no mueve existencias.
 *   - Un local sin el plan responde `planRequired` con el resolver REAL, sin escribir.
 *   - El listado recibe el día LOCAL del negocio y encuentra el folio de hoy, con el costo en pesos.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { resolveScope } from '@/mcp/scope'
import { registerInventoryWasteTools } from '@/mcp/tools/inventoryWaste'

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const TZ = 'America/Mexico_City'
const fixture = `mcp-waste-${randomUUID()}`

let organizationId = ''
let venueId = ''
let planlessVenueId = ''
let staffId = ''
let categoryId = ''

function assertTestDatabase(): void {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const effective = new URL(process.env.DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')
  expect(effective.toString()).toBe(declared.toString())
}

async function clearVenue(id: string): Promise<void> {
  if (!id) return
  await prisma.activityLog.deleteMany({ where: { venueId: id } })
  await prisma.rawMaterialMovement.deleteMany({ where: { venueId: id } })
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId: id } } })
  await prisma.inventoryWasteReport.deleteMany({ where: { venueId: id } })
  await prisma.lowStockAlert.deleteMany({ where: { venueId: id } })
  await prisma.inventory.deleteMany({ where: { venueId: id } })
  await prisma.product.deleteMany({ where: { venueId: id } })
  await prisma.rawMaterial.deleteMany({ where: { venueId: id } })
}

async function clearAll(): Promise<void> {
  await clearVenue(venueId)
  await clearVenue(planlessVenueId)
}

beforeAll(async () => {
  assertTestDatabase()
  const organization = await prisma.organization.create({
    data: { name: fixture, email: `${fixture}@example.test`, phone: '5500000000' },
  })
  organizationId = organization.id
  // Exento de plan (grandfathered): el resolver real le concede INVENTORY_TRACKING.
  const venue = await prisma.venue.create({
    data: { organizationId, name: fixture, slug: fixture, timezone: TZ, currency: 'MXN', seatCapExempt: true },
  })
  venueId = venue.id
  const planless = await prisma.venue.create({
    data: { organizationId, name: `${fixture}-sin-plan`, slug: `${fixture}-sin-plan`, timezone: TZ, currency: 'MXN' },
  })
  planlessVenueId = planless.id
  const staff = await prisma.staff.create({
    data: { email: `staff-${fixture}@example.test`, firstName: 'Prueba', lastName: 'Asistente' },
  })
  staffId = staff.id
  await prisma.staffVenue.createMany({
    data: [
      { staffId, venueId, role: 'MANAGER', active: true },
      { staffId, venueId: planlessVenueId, role: 'MANAGER', active: true },
    ],
  })
  const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
  categoryId = category.id
})

beforeEach(clearAll)

afterAll(async () => {
  assertTestDatabase()
  await clearAll()
  if (categoryId) await prisma.menuCategory.deleteMany({ where: { id: categoryId, venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: [venueId, planlessVenueId].filter(Boolean) } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, planlessVenueId].filter(Boolean) }, organizationId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
})

async function product(stock: number, cost: number, targetVenueId: string = venueId) {
  return prisma.product.create({
    data: {
      venueId: targetVenueId,
      categoryId,
      name: `Taza ${randomUUID()}`,
      sku: randomUUID(),
      price: D(100),
      cost: D(cost),
      unit: 'UNIT',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      inventory: { create: { venueId: targetVenueId, currentStock: D(stock) } },
    },
  })
}

/** Insumo sin lotes (se descuenta directo) con su punto de reorden: la merma lo puede dejar abajo. */
async function ingredient(stock: number, reorderPoint: number) {
  return prisma.rawMaterial.create({
    data: {
      venueId,
      name: `Leche ${randomUUID()}`,
      sku: randomUUID(),
      category: 'OTHER',
      unit: 'PIECE',
      unitType: 'COUNT',
      currentStock: D(stock),
      minimumStock: D(0),
      reorderPoint: D(reorderPoint),
      costPerUnit: D(1),
      avgCostPerUnit: D(1),
      notifyOnLowStock: false,
    },
  })
}

type Handler = (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>

async function tools(): Promise<Record<string, Handler>> {
  const scope = await resolveScope(staffId, organizationId)
  scope.scopes = ['mcp:read', 'mcp:write']
  const handlers: Record<string, Handler> = {}
  registerInventoryWasteTools({ tool: (n: string, _d: string, _s: unknown, h: Handler) => (handlers[n] = h) } as never, scope)
  return handlers
}

const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)
const stockOf = async (productId: string) =>
  (await prisma.inventory.findFirstOrThrow({ where: { productId, venueId }, select: { currentStock: true } })).currentStock.toString()

describe('log_waste por el MCP, contra la base real', () => {
  test('🔴 vista previa → confirmación: UNA merma con source MCP, UNA fila de auditoría, y repetir no descuenta otra vez', async () => {
    const taza = await product(5, 12.5)
    const t = await tools()
    const entrada = { venueId, itemType: 'PRODUCT', itemId: taza.id, quantity: 2, reasonCode: 'DROPPED' }

    const previa = json(await t.log_waste(entrada))
    expect(previa.requiresConfirmation).toBe(true)
    expect(previa.preview).toMatchObject({ articulo: taza.name, cantidad: '2 unidades', motivo: 'Se cayó / derramó' })
    // La vista previa no mueve nada.
    expect(await stockOf(taza.id)).toBe('5')
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)

    const hecho = json(await t.log_waste(previa.confirmationPayload))
    expect(hecho.ok).toBe(true)
    expect(hecho.report).toMatchObject({ declared: '2', deducted: '2', unrecorded: '0' })
    expect(await stockOf(taza.id)).toBe('3')

    const reportes = await prisma.inventoryWasteReport.findMany({ where: { venueId } })
    expect(reportes).toHaveLength(1)
    expect(reportes[0]).toMatchObject({ source: 'MCP', reportedByStaffId: staffId, idempotencyKey: previa.preview.folio })

    const auditoria = await prisma.activityLog.findMany({ where: { venueId } })
    expect(auditoria).toHaveLength(1)
    expect(auditoria[0]).toMatchObject({ action: 'INVENTORY_WASTE_LOGGED', entityId: reportes[0].id, staffId })
    expect(auditoria[0].data).toMatchObject({ source: 'MCP' })

    // El asistente reintenta la misma confirmación (timeout del cliente, doble clic…).
    const otraVez = json(await t.log_waste(previa.confirmationPayload))
    expect(otraVez.report.reportId).toBe(hecho.report.reportId)
    expect(await stockOf(taza.id)).toBe('3')
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { venueId } })).toBe(1)
  })

  test('🔴 confirmar con otra cantidad que la previsualizada no escribe nada', async () => {
    const taza = await product(5, 12.5)
    const t = await tools()
    const previa = json(await t.log_waste({ venueId, itemType: 'PRODUCT', itemId: taza.id, quantity: 2, reasonCode: 'DROPPED' }))

    await expect(t.log_waste({ ...previa.confirmationPayload, quantity: '4' })).rejects.toMatchObject({ code: 'WASTE_PREVIEW_MISMATCH' })
    expect(await stockOf(taza.id)).toBe('5')
    expect(await prisma.inventoryWasteReport.count({ where: { venueId } })).toBe(0)
    expect(await prisma.activityLog.count({ where: { venueId } })).toBe(0)
  })

  test('🔴 la merma de un insumo por el MCP crea la alerta de existencia baja, como el POS y el dashboard', async () => {
    const leche = await ingredient(6, 5)
    const t = await tools()
    const previa = json(await t.log_waste({ venueId, itemType: 'RAW_MATERIAL', itemId: leche.id, quantity: 3, reasonCode: 'SPOILED' }))
    const hecho = json(await t.log_waste(previa.confirmationPayload))
    expect(hecho.report).toMatchObject({ declared: '3', deducted: '3', unrecorded: '0' })

    const alertas = await prisma.lowStockAlert.findMany({ where: { venueId, rawMaterialId: leche.id } })
    expect(alertas).toHaveLength(1)
    expect(alertas[0]).toMatchObject({ status: 'ACTIVE', alertType: 'LOW_STOCK' })
    expect(alertas[0].currentLevel.toString()).toBe('3')
  })

  test('un local sin el plan responde planRequired con el resolver real y no escribe', async () => {
    const t = await tools()
    const out = json(
      await t.log_waste({ venueId: planlessVenueId, itemType: 'PRODUCT', itemId: 'cualquiera', quantity: 1, reasonCode: 'DROPPED' }),
    )
    expect(out).toMatchObject({ ok: false, planRequired: true, featureCode: 'INVENTORY_TRACKING' })
    expect(await prisma.inventoryWasteReport.count({ where: { venueId: planlessVenueId } })).toBe(0)
  })
})

describe('list_waste_reports por el MCP, contra la base real', () => {
  test('el día LOCAL de hoy trae el folio, con el costo en pesos; el día anterior no', async () => {
    const taza = await product(5, 12.5)
    const t = await tools()
    const previa = json(await t.log_waste({ venueId, itemType: 'PRODUCT', itemId: taza.id, quantity: 2, reasonCode: 'DROPPED' }))
    const hecho = json(await t.log_waste(previa.confirmationPayload))

    const creado = await prisma.inventoryWasteReport.findUniqueOrThrow({
      where: { id: hecho.report.reportId },
      select: { createdAt: true },
    })
    const hoy = formatInTimeZone(creado.createdAt, TZ, 'yyyy-MM-dd')
    const ayer = formatInTimeZone(new Date(creado.createdAt.getTime() - 24 * 60 * 60 * 1000), TZ, 'yyyy-MM-dd')

    const deHoy = json(await t.list_waste_reports({ venueId, fromDate: hoy, toDate: hoy }))
    expect(deHoy).toMatchObject({ ok: true, total: 1, timezone: TZ })
    expect(deHoy.reports[0]).toMatchObject({
      reportId: hecho.report.reportId,
      item: taza.name,
      reason: 'Se cayó / derramó',
      declared: 2,
      deducted: 2,
      withoutStock: 0,
      costPesos: 25,
      source: 'Asistente (MCP)',
      reportedBy: 'Prueba Asistente',
    })

    const deAyer = json(await t.list_waste_reports({ venueId, fromDate: ayer, toDate: ayer }))
    expect(deAyer).toMatchObject({ ok: true, total: 0, reports: [] })
  })
})
