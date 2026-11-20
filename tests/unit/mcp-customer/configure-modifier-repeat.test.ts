/**
 * `configure_modifier_repeat` (encargo a508f4) atravesando el catálogo REAL: lee el grupo, enseña el cambio y sólo escribe con la
 * confirmación firmada sobre el grupo que se VIO. Nunca adivina entre dos grupos ni entre dos opciones.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerMenuTools } from '@/mcp/tools/menu'

const mockUpdateModifier = jest.fn()
const mockUpdateModifierGroup = jest.fn()
const groupFindMany = jest.fn()
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({
  createMenuCategory: jest.fn(),
  createModifierGroup: jest.fn(),
  updateModifier: (...a: unknown[]) => mockUpdateModifier(...a),
  updateModifierGroup: (...a: unknown[]) => mockUpdateModifierGroup(...a),
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({
  updateProduct: jest.fn(),
  createProduct: jest.fn(),
  getProduct: jest.fn(),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    modifierGroup: { findMany: (...a: unknown[]) => groupFindMany(...a) },
    product: { findMany: jest.fn(), findFirst: jest.fn() },
    modifier: { findMany: jest.fn() },
    menuCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (access: { corePermissions: string[] }, permission: string) => access.corePermissions.includes(permission),
}))

const venueId = 'cm12345678901234567890123'
const scope = (perms: string[]): McpScope => ({
  staffId: 'cm32345678901234567890123',
  activeOrg: 'cm42345678901234567890123',
  scopes: ['mcp:read', 'mcp:write'],
  allowedVenueIds: [venueId],
  perVenueAccess: new Map([[venueId, { corePermissions: perms } as never]]),
})

const flautas = {
  id: 'g-flautas',
  name: 'Flautas (hasta 3)',
  allowMultiple: true,
  allowRepeat: false,
  minSelections: 3,
  maxSelections: 3,
  modifiers: [
    { id: 'm-cochinita', name: 'Flautas Cochinita', maxQuantity: null },
    { id: 'm-papa', name: 'Flautas Papa', maxQuantity: null },
    { id: 'm-papa-queso', name: 'Flautas Papa con Queso', maxQuantity: null },
  ],
}

let server: McpServer
let client: Client
async function conectar(perms = ['menu:read', 'menu:update']) {
  server = new McpServer({ name: 'menu', version: '1' })
  const s = scope(perms)
  configureToolCatalog(server, s)
  registerMenuTools(server, s)
  client = new Client({ name: 'repeat', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
}
const call = async (a: Record<string, unknown>) => {
  const r = await client.callTool({ name: 'configure_modifier_repeat', arguments: a })
  return JSON.parse((r.content as Array<{ text: string }>)[0].text)
}

beforeEach(async () => {
  jest.clearAllMocks()
  groupFindMany.mockResolvedValue([flautas])
  mockUpdateModifier.mockResolvedValue({})
  mockUpdateModifierGroup.mockResolvedValue({})
  await conectar()
})
afterEach(async () => {
  await client.close()
  await server.close()
})

it('sin cambios sólo lee: el grupo, si deja repetir y el tope de cada opción', async () => {
  const r = await call({ venueId, groupName: 'Flautas' })
  expect(r).toMatchObject({ ok: true, group: 'Flautas (hasta 3)', allowRepeat: false, max: 3 })
  expect(r.options).toEqual(expect.arrayContaining([{ name: 'Flautas Papa', maxTimes: null }]))
  expect(mockUpdateModifierGroup).not.toHaveBeenCalled()
})

it('prender «repetir» pide vista previa y con la confirmación firmada SÍ escribe', async () => {
  const preview = await call({ venueId, groupName: 'Flautas', allowRepeat: true })
  expect(preview).toMatchObject({ requiresConfirmation: true, confirmationToken: expect.any(String) })
  expect(preview.changes).toEqual([{ item: 'Flautas (hasta 3)', label: 'Repetir la misma opción', from: 'no', to: 'sí' }])
  expect(preview.confirmationArguments).toMatchObject({ resolvedGroupId: 'g-flautas' })
  expect(mockUpdateModifierGroup).not.toHaveBeenCalled()

  const r = await call({ ...preview.confirmationArguments, confirm: true, confirmationToken: preview.confirmationToken })
  expect(r).toMatchObject({ ok: true, allowRepeat: true })
  expect(mockUpdateModifierGroup).toHaveBeenCalledWith(venueId, 'g-flautas', { allowRepeat: true })
})

it('el tope por opción usa el nombre exacto antes que el parecido («Flautas Papa» no es ambiguo con «Papa con Queso»)', async () => {
  const preview = await call({ venueId, groupName: 'Flautas', optionLimits: [{ optionName: 'Flautas Papa', maxTimes: 2 }] })
  expect(preview.changes).toEqual([
    {
      item: 'Flautas (hasta 3) › Flautas Papa',
      label: 'Veces que se puede elegir',
      from: 'hasta el máximo del grupo',
      to: 'hasta 2 veces',
    },
  ])
  const r = await call({ ...preview.confirmationArguments, confirm: true, confirmationToken: preview.confirmationToken })
  expect(r.ok).toBe(true)
  expect(mockUpdateModifier).toHaveBeenCalledWith(venueId, 'g-flautas', 'm-papa', { maxQuantity: 2 })
})

it('una opción ambigua devuelve las candidatas y no escribe', async () => {
  const r = await call({ venueId, groupName: 'Flautas', optionLimits: [{ optionName: 'papa', maxTimes: 1 }] })
  expect(r).toMatchObject({ ok: false, ambiguous: true })
  expect(r.matches).toEqual(['Flautas Papa', 'Flautas Papa con Queso'])
})

it('dos grupos que coinciden: pregunta cuál', async () => {
  groupFindMany.mockResolvedValue([flautas, { ...flautas, id: 'g2', name: 'Flautas sencillo' }])
  const r = await call({ venueId, groupName: 'Flautas', allowRepeat: true })
  expect(r).toMatchObject({ ok: false, ambiguous: true, matches: ['Flautas (hasta 3)', 'Flautas sencillo'] })
})

it('un grupo de UNA sola opción no puede repetir: explica qué cambiar primero', async () => {
  groupFindMany.mockResolvedValue([{ ...flautas, allowMultiple: false, maxSelections: 1 }])
  const r = await call({ venueId, groupName: 'Flautas', allowRepeat: true })
  expect(r).toMatchObject({ ok: false, needsInput: true })
  expect(r.question).toContain('súbele el máximo')
})

it('si el grupo cambió entre la vista previa y la confirmación, no escribe', async () => {
  const preview = await call({ venueId, groupName: 'Flautas', allowRepeat: true })
  groupFindMany.mockResolvedValue([{ ...flautas, allowRepeat: true }])
  const r = await call({ ...preview.confirmationArguments, confirm: true, confirmationToken: preview.confirmationToken })
  expect(r).toMatchObject({ needsInput: true })
  expect(mockUpdateModifierGroup).not.toHaveBeenCalled()
})

it('sin menu:update no puede cambiar, aunque sí leer', async () => {
  await client.close()
  await server.close()
  await conectar(['menu:read'])
  expect((await call({ venueId, groupName: 'Flautas' })).ok).toBe(true)
  const r = await client.callTool({ name: 'configure_modifier_repeat', arguments: { venueId, groupName: 'Flautas', allowRepeat: true } })
  expect(r.isError || JSON.parse((r.content as Array<{ text: string }>)[0].text).ok === false).toBe(true)
  expect(mockUpdateModifierGroup).not.toHaveBeenCalled()
})
