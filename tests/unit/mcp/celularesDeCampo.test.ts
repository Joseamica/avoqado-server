/**
 * App de campo, bloque 1, Tarea 9: tools del MCP de celulares de campo, atravesando el catálogo REAL (confirmación firmada).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerCelularesDeCampoTools } from '@/mcp/tools/celularesDeCampo'
import AppError from '@/errors/AppError'

const mockModulo = jest.fn()
const mockSupervisor = jest.fn()
const mockListar = jest.fn()
const mockCodigos = jest.fn()
const mockDesvincular = jest.fn()
const mockRetenidos = jest.fn()
const mockResolver = jest.fn()
const mockCelular = jest.fn()
const mockAudit = jest.fn()
jest.mock('@/services/modules/module.service', () => ({
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
  moduleService: { isModuleEnabled: (...a: unknown[]) => mockModulo(...a) },
}))
jest.mock('@/services/access/supervisorDeLaOrganizacion', () => ({
  esSupervisorOMasDeLaOrganizacion: (...a: unknown[]) => mockSupervisor(...a),
}))
jest.mock('@/services/tpv/campo/celular/celularesDeLaOrganizacion.service', () => ({
  listarCelularesDeCampo: (...a: unknown[]) => mockListar(...a),
}))
jest.mock('@/services/tpv/campo/celular/codigoDeCelular.service', () => ({ generarCodigos: (...a: unknown[]) => mockCodigos(...a) }))
jest.mock('@/services/tpv/campo/celular/desvincularCelular.service', () => ({
  desvincularCelular: (...a: unknown[]) => mockDesvincular(...a),
}))
jest.mock('@/services/tpv/campo/celular/graciaDelCelular.service', () => ({
  listarRetenidos: (...a: unknown[]) => mockRetenidos(...a),
  resolverRetenido: (...a: unknown[]) => mockResolver(...a),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { celularDeCampo: { findFirst: (...a: unknown[]) => mockCelular(...a) } },
}))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (access: { corePermissions: string[] }, permission: string) => access.corePermissions.includes(permission),
}))

const venueId = 'cm12345678901234567890123'
const orgId = 'cm52345678901234567890123'
const staffId = 'cm42345678901234567890123'
const promotor = 'cm62345678901234567890123'
const scopeCon = (permisos: string[], scopes = ['mcp:read', 'mcp:write']): McpScope => ({
  staffId,
  activeOrg: orgId,
  scopes,
  allowedVenueIds: [venueId],
  perVenueAccess: new Map([[venueId, { corePermissions: permisos, organizationId: orgId, role: 'MANAGER' } as never]]),
})
const TODOS = ['teams:read', 'teams:update']

let server: McpServer
let client: Client
async function abrir(scope: McpScope) {
  server = new McpServer({ name: 'campo', version: '1' })
  configureToolCatalog(server, scope)
  registerCelularesDeCampoTools(server, scope)
  client = new Client({ name: 'campo-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
}
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args })
  const raw = (r.content as Array<{ text: string }>)[0].text
  try {
    return { isError: r.isError, ...JSON.parse(raw) }
  } catch {
    return { isError: true, error: raw }
  }
}
/** vista previa -> confirmar con el token firmado, como lo haría el cliente */
async function aplicar(name: string, args: Record<string, unknown>) {
  const p = await call(name, args)
  expect(p.requiresConfirmation).toBe(true)
  return call(name, { ...p.confirmationArguments, confirm: true, confirmationToken: p.confirmationToken })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockModulo.mockResolvedValue(true)
  mockSupervisor.mockResolvedValue(true)
  mockListar.mockResolvedValue({ disponible: true, items: [{ staffId: promotor, nombre: 'Ana Pérez' }], total: 1 })
  mockRetenidos.mockResolvedValue({ items: [], total: 0 })
  mockCodigos.mockResolvedValue({ generados: [{ staffId: promotor, codigo: 'ABCD1234' }], omitidos: [], restantes: 0 })
  mockDesvincular.mockResolvedValue({ yaEstaba: false, porSubir: 2 })
  mockResolver.mockResolvedValue({ estado: 'APLICADO', repetida: false })
  mockCelular.mockResolvedValue({ id: 'cel1' })
})
afterEach(async () => {
  await client?.close()
  await server?.close()
})

it('nacen sólo en el modo libre: ninguna está en el catálogo certificado', () => {
  for (const n of ['promoter_phones', 'promoter_phone_held_uploads', 'manage_promoter_phone']) expect(DIRECTORY_TOOLS.has(n)).toBe(false)
})

describe('lectura (teams:read, supervisor, módulo)', () => {
  it('un WAITER (sin teams:read) no lee', async () => {
    await abrir(scopeCon([]))
    expect((await call('promoter_phones', { venueId })).isError).toBe(true)
    expect((await call('promoter_phone_held_uploads', { venueId })).isError).toBe(true)
    expect(mockListar).not.toHaveBeenCalled()
    expect(mockRetenidos).not.toHaveBeenCalled()
  })
  it('con el permiso pero sin ser supervisor no lee', async () => {
    mockSupervisor.mockResolvedValue(false)
    await abrir(scopeCon(TODOS))
    expect((await call('promoter_phones', { venueId })).ok).toBe(false)
    expect(mockListar).not.toHaveBeenCalled()
  })
  it('sin el módulo no lee', async () => {
    mockModulo.mockResolvedValue(false)
    await abrir(scopeCon(TODOS))
    expect(await call('promoter_phones', { venueId })).toMatchObject({ ok: false, moduleRequired: true })
  })
  it('lista con filtros y pagina; los retenidos sólo los sin resolver', async () => {
    await abrir(scopeCon(TODOS))
    expect(await call('promoter_phones', { venueId, q: 'ana', estado: 'ACTIVO', page: 2 })).toMatchObject({ ok: true, page: 2 })
    expect(mockListar).toHaveBeenCalledWith(orgId, { q: 'ana', estado: 'ACTIVO', page: 2, pageSize: 25 })
    await call('promoter_phone_held_uploads', { venueId, staffId: promotor })
    expect(mockRetenidos).toHaveBeenCalledWith(orgId, { staffId: promotor, estado: ['PENDIENTE', 'APLICANDO'], page: 1, pageSize: 25 })
  })
})

describe('manage_promoter_phone (teams:update, confirmación firmada)', () => {
  it('un WAITER no escribe, ni la vista previa', async () => {
    await abrir(scopeCon(['teams:read']))
    expect((await call('manage_promoter_phone', { venueId, accion: 'GENERAR_CODIGO', staffId: promotor })).isError).toBe(true)
    expect(mockCodigos).not.toHaveBeenCalled()
  })
  it('un token sin mcp:write no escribe', async () => {
    await abrir(scopeCon(TODOS, ['mcp:read']))
    expect((await call('manage_promoter_phone', { venueId, accion: 'GENERAR_CODIGO', staffId: promotor })).isError).toBe(true)
    expect(mockCodigos).not.toHaveBeenCalled()
  })
  it('sin confirm sólo hay vista previa: no escribe', async () => {
    await abrir(scopeCon(TODOS))
    for (const a of [
      { accion: 'GENERAR_CODIGO', staffId: promotor },
      { accion: 'DESVINCULAR', staffId: promotor },
      { accion: 'APLICAR_RETENIDO', retenidoId: 'r1' },
      { accion: 'DESCARTAR_RETENIDO', retenidoId: 'r1' },
    ])
      expect(await call('manage_promoter_phone', { venueId, ...a })).toMatchObject({ requiresConfirmation: true })
    expect(mockCodigos).not.toHaveBeenCalled()
    expect(mockDesvincular).not.toHaveBeenCalled()
    expect(mockResolver).not.toHaveBeenCalled()
  })
  it('con confirm genera el código de esa persona y lo devuelve', async () => {
    await abrir(scopeCon(TODOS))
    const r = await aplicar('manage_promoter_phone', { venueId, accion: 'GENERAR_CODIGO', staffId: promotor })
    expect(r.ok).toBe(true)
    expect(mockCodigos).toHaveBeenCalledWith({ organizationId: orgId, generadoPor: staffId, staffIds: [promotor] })
    expect(r.generados[0].codigo).toBe('ABCD1234')
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('ABCD1234') // el código nunca va a la bitácora
  })
  it('con confirm desvincula con motivo MCP y a nombre de quien lo pide', async () => {
    await abrir(scopeCon(TODOS))
    expect((await aplicar('manage_promoter_phone', { venueId, accion: 'DESVINCULAR', staffId: promotor })).ok).toBe(true)
    expect(mockCelular).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: orgId, staffIdVinculado: promotor } }))
    expect(mockDesvincular).toHaveBeenCalledWith({ celularId: 'cel1', organizationId: orgId, motivo: 'MCP', porStaffId: staffId })
  })
  it('desvincular por celularId no busca a la persona', async () => {
    await abrir(scopeCon(TODOS))
    await aplicar('manage_promoter_phone', { venueId, accion: 'DESVINCULAR', celularId: 'celX' })
    expect(mockDesvincular).toHaveBeenCalledWith(expect.objectContaining({ celularId: 'celX', organizationId: orgId }))
    expect(mockCelular).not.toHaveBeenCalled()
  })
  it('aplicar y descartar retenidos llaman resolverRetenido con su organización', async () => {
    await abrir(scopeCon(TODOS))
    await aplicar('manage_promoter_phone', { venueId, accion: 'APLICAR_RETENIDO', retenidoId: 'r1', nota: 'ok' })
    expect(mockResolver).toHaveBeenLastCalledWith({
      retenidoId: 'r1',
      organizationId: orgId,
      accion: 'APLICAR',
      nota: 'ok',
      porStaffId: staffId,
    })
    await aplicar('manage_promoter_phone', { venueId, accion: 'DESCARTAR_RETENIDO', retenidoId: 'r2' })
    expect(mockResolver).toHaveBeenLastCalledWith(expect.objectContaining({ retenidoId: 'r2', accion: 'DESCARTAR', porStaffId: staffId }))
  })
  it('un nombre ambiguo devuelve los candidatos y no escribe', async () => {
    mockListar.mockResolvedValue({
      items: [
        { staffId: 'a', nombre: 'Ana Pérez' },
        { staffId: 'b', nombre: 'Ana López' },
      ],
      total: 2,
    })
    await abrir(scopeCon(TODOS))
    const r = await call('manage_promoter_phone', { venueId, accion: 'GENERAR_CODIGO', promoterName: 'Ana' })
    expect(r).toMatchObject({ ok: false, ambiguous: true })
    expect(r.candidates).toHaveLength(2)
    expect(mockCodigos).not.toHaveBeenCalled()
  })
  it('un nombre sin coincidencias no inventa', async () => {
    mockListar.mockResolvedValue({ items: [], total: 0 })
    await abrir(scopeCon(TODOS))
    expect(await call('manage_promoter_phone', { venueId, accion: 'GENERAR_CODIGO', promoterName: 'Nadie' })).toMatchObject({ ok: false })
  })
  it('un error de negocio del servicio se devuelve como respuesta', async () => {
    mockResolver.mockRejectedValue(new AppError('Este envío ya se descartó.', 409, true, 'YA_RESUELTO'))
    await abrir(scopeCon(TODOS))
    expect(await aplicar('manage_promoter_phone', { venueId, accion: 'APLICAR_RETENIDO', retenidoId: 'r1' })).toMatchObject({
      ok: false,
      code: 'YA_RESUELTO',
    })
  })
})
