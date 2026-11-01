/**
 * Herramientas MCP de «Menú del aparato». Mismo arnés que productVariants.tools.test.ts: catálogo real (confirmación en dos
 * pasos y permisos de la conexión), servicios y prisma mockeados.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { registerDeviceMenuTools } from '@/mcp/tools/deviceMenus'
import type { McpScope } from '@/mcp/scope'

const mockGate = jest.fn()
const mockAudit = jest.fn()
const mockList = jest.fn()
const mockOptions = jest.fn()
const mockSet = jest.fn()
const mockUpdateMenu = jest.fn()
const mockTerminals = jest.fn()
const mockMenus = jest.fn()
const mockMenuOne = jest.fn()
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockGate(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
jest.mock('@/services/devices/deviceMenus.service', () => ({
  DEVICE_MENUS_CODE: 'DEVICE_MENUS',
  MENU_NO_DISPONIBLE_MESSAGE: 'Ese menú no existe, está apagado o no es para aparatos.',
  POS_TERMINAL_TYPES: ['POS_ANDROID', 'POS_IOS', 'POS_DESKTOP'],
  listDeviceMenus: (...a: unknown[]) => mockList(...a),
  listDeviceMenuOptions: (...a: unknown[]) => mockOptions(...a),
  setTerminalMenus: (...a: unknown[]) => mockSet(...a),
}))
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({
  MENU_SIN_USO_MESSAGE:
    'Elige al menos un lugar donde se usa el menú (Aparatos o Tienda en línea). Para no usarlo en ningún lado, apágalo.',
  updateMenu: (...a: unknown[]) => mockUpdateMenu(...a),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findMany: (...a: unknown[]) => mockTerminals(...a) },
    menu: { findMany: (...a: unknown[]) => mockMenus(...a), findFirst: (...a: unknown[]) => mockMenuOne(...a) },
  },
}))

const OWNER = { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }
const T1 = 'cterminal0000000000000001'
const M1 = 'cmenu00000000000000000001'
const V1 = 'cvenue00000000000000000001'
let server: McpServer
let client: Client

async function connect(access: Record<string, unknown> = OWNER) {
  server = new McpServer({ name: 'aparatos', version: '1' })
  const scope = {
    staffId: 'owner',
    activeOrg: 'org',
    allowedVenueIds: [V1],
    scopes: ['mcp:read', 'mcp:write'],
    perVenueAccess: new Map([[V1, access]]),
  } as unknown as McpScope
  configureToolCatalog(server, scope, 'manual')
  registerDeviceMenuTools(server, scope)
  client = new Client({ name: 't', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
}
const call = async (name: string, args: Record<string, unknown>) =>
  JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text)
const reconnect = async (access: Record<string, unknown>) => {
  await client.close()
  await server.close()
  await connect(access)
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockGate.mockResolvedValue(null)
  mockList.mockResolvedValue({ everything: { categories: 3, products: 20 }, terminals: [], total: 120, page: 2, pageSize: 50 })
  mockOptions.mockResolvedValue({ menus: [], total: 7, page: 1, pageSize: 100 })
  mockTerminals.mockResolvedValue([{ id: T1, name: 'Caja 1', menus: [{ menu: { name: 'Cafetería' } }] }])
  mockMenus.mockResolvedValue([{ id: M1, name: 'Cremería' }])
  mockSet.mockResolvedValue({})
  mockMenuOne.mockResolvedValue({ id: M1, name: 'Cremería', appliesToDevices: true, appliesToOnline: true })
  mockUpdateMenu.mockResolvedValue({})
  await connect()
})
afterEach(async () => {
  await client.close()
  await server.close()
})

const confirmar = async (name: string, args: Record<string, unknown>) => {
  const preview = await call(name, args)
  return call(name, { ...preview.confirmationArguments, confirm: true, confirmationToken: preview.confirmationToken })
}

describe('list_device_menus', () => {
  it('listar requiere tpv:read', async () => {
    await reconnect({ role: 'CASHIER', corePermissions: ['menu:read'], isSuperAdmin: false })
    const r = await call('list_device_menus', { venueId: V1 })
    expect(r.ok).toBe(false)
    expect(mockList).not.toHaveBeenCalled()
  })

  it('listar pagina los aparatos con total', async () => {
    const r = await call('list_device_menus', { venueId: V1, page: 2, menuSearch: 'caf', menuPage: 1 })
    expect(mockList).toHaveBeenCalledWith(V1, 2, 50)
    expect(mockOptions).toHaveBeenCalledWith(V1, { search: 'caf', page: 1, pageSize: 100 })
    expect(r).toMatchObject({ ok: true, total: 120, page: 2, menuOptions: { total: 7 } })
  })
})

describe('set_device_menus', () => {
  const args = { venueId: V1, terminalIds: [T1], menuIds: [M1] }

  it('fijar sin confirm da vista previa y no escribe', async () => {
    const r = await call('set_device_menus', args)
    expect(r).toMatchObject({
      requiresConfirmation: true,
      preview: [{ device: 'Caja 1', current: 'Cafetería', new: 'Cremería' }],
    })
    expect(r.expectedSourceFingerprint).toEqual(expect.any(String))
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('fijar con huella vieja pide confirmar de nuevo', async () => {
    const preview = await call('set_device_menus', args)
    const r = await call('set_device_menus', {
      ...preview.confirmationArguments,
      expectedSourceFingerprint: 'vieja',
      confirm: true,
      confirmationToken: preview.confirmationToken,
    })
    expect(r).toMatchObject({ ok: false, needsInput: true })
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('fijar sin Pro responde planRequired', async () => {
    mockGate.mockResolvedValue('no incluido')
    const r = await call('set_device_menus', args)
    expect(r).toMatchObject({ ok: false, planRequired: true })
    expect(mockGate).toHaveBeenCalledWith(V1, 'DEVICE_MENUS', expect.any(String))
  })

  it('fijar sin tpv:update se rechaza', async () => {
    await reconnect({ role: 'CASHIER', corePermissions: ['tpv:read'], isSuperAdmin: false })
    const r = await call('set_device_menus', args)
    expect(r.ok).toBe(false)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('fijar con confirm guarda y audita', async () => {
    const r = await confirmar('set_device_menus', args)
    expect(r.ok).toBe(true)
    expect(mockSet).toHaveBeenCalledWith(V1, T1, [M1], 'owner')
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'TERMINAL_MENUS_UPDATED', entityId: T1, venueId: V1 }),
    )
  })

  it('un menú apagado o no disponible se rechaza con MENU_NO_DISPONIBLE', async () => {
    mockMenus.mockResolvedValue([])
    const r = await call('set_device_menus', args)
    expect(r).toMatchObject({ ok: false, code: 'MENU_NO_DISPONIBLE' })
  })
})

describe('set_menu_usage', () => {
  it('set_menu_usage con las dos apagadas regresa el mensaje MENU_SIN_USO', async () => {
    const r = await call('set_menu_usage', { venueId: V1, menuId: M1, appliesToDevices: false, appliesToOnline: false })
    expect(r).toMatchObject({
      ok: false,
      code: 'MENU_SIN_USO',
      error: 'Elige al menos un lugar donde se usa el menú (Aparatos o Tienda en línea). Para no usarlo en ningún lado, apágalo.',
    })
    expect(mockUpdateMenu).not.toHaveBeenCalled()
  })

  it('sin confirm muestra actual → nuevo; con confirm guarda y audita', async () => {
    const preview = await call('set_menu_usage', { venueId: V1, menuId: M1, appliesToOnline: false })
    expect(preview).toMatchObject({ requiresConfirmation: true, preview: { current: 'Aparatos, Tienda en línea', new: 'Aparatos' } })
    expect(mockUpdateMenu).not.toHaveBeenCalled()
    const r = await confirmar('set_menu_usage', { venueId: V1, menuId: M1, appliesToOnline: false })
    expect(r.ok).toBe(true)
    expect(mockUpdateMenu).toHaveBeenCalledWith(V1, M1, { appliesToDevices: true, appliesToOnline: false })
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'MENU_USAGE_UPDATED', entityId: M1 }))
  })

  it('requiere menu:update', async () => {
    await reconnect({ role: 'CASHIER', corePermissions: ['menu:read'], isSuperAdmin: false })
    const r = await call('set_menu_usage', { venueId: V1, menuId: M1, appliesToOnline: false })
    expect(r.ok).toBe(false)
  })
})
