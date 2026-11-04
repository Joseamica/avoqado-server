/**
 * «Duplicar tienda» por MCP: la misma capacidad que el botón, atravesando el catálogo REAL.
 * Sólo en el modo libre; vista previa no crea nada; confirmar (dos veces) no crea dos; sólo el dueño.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerOrganizationTools } from '@/mcp/tools/organizations'

const mockOpciones = jest.fn()
const mockDuplicar = jest.fn()
const mockEsDueno = jest.fn()
jest.mock('@/services/organization-dashboard/venueDuplication.service', () => ({
  getVenueDuplicationOptions: (...a: unknown[]) => mockOpciones(...a),
  duplicateVenue: (...a: unknown[]) => mockDuplicar(...a),
}))
jest.mock('@/services/access/duenoDeEstaOrganizacion', () => ({
  esDuenoDeEstaOrganizacionOSuperadmin: (...a: unknown[]) => mockEsDueno(...a),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

const org = 'cm52345678901234567890123'
const staffId = 'cm42345678901234567890123'
const modeloId = 'cm12345678901234567890123'
const supervisorId = 'cm22345678901234567890123'
const scopeCon = (scopes = ['mcp:read', 'mcp:write']): McpScope => ({
  staffId,
  activeOrg: org,
  scopes,
  allowedVenueIds: [],
  perVenueAccess: new Map(),
})
const args = {
  templateVenueId: modeloId,
  name: '  Sucursal Norte ',
  address: { address: 'Av. 1', city: 'CDMX', state: 'CDMX', zipCode: '01000', latitude: 19.4, longitude: -99.1 },
  supervisorStaffId: supervisorId,
}

let server: McpServer
let client: Client
async function abrir(scope: McpScope) {
  server = new McpServer({ name: 'dup', version: '1' })
  configureToolCatalog(server, scope)
  registerOrganizationTools(server, scope)
  client = new Client({ name: 'dup-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
}
const call = async (a: Record<string, unknown>) => {
  const r = await client.callTool({ name: 'duplicate_venue', arguments: a })
  const raw = (r.content as Array<{ text: string }>)[0].text
  try {
    return { isError: r.isError, ...JSON.parse(raw) }
  } catch {
    return { isError: true, error: raw }
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.ACCESS_TOKEN_SECRET = 'secreto-de-prueba'
  mockEsDueno.mockResolvedValue(true)
  mockOpciones.mockResolvedValue({
    enabled: true,
    templates: [{ id: modeloId, name: 'Sucursal Centro', city: 'CDMX' }],
    supervisors: [{ staffId: supervisorId, name: 'Ana Pérez' }],
  })
  mockDuplicar.mockResolvedValue({ venueId: 'cm92345678901234567890123', slug: 'sucursal-norte', name: 'Sucursal Norte' })
})
afterEach(async () => {
  await client?.close()
  await server?.close()
})

it('es de escritura y nace sólo en el modo libre (no está en el directorio certificado)', () => {
  expect(TOOL_EFFECTS.duplicate_venue).toBe('write')
  expect(DIRECTORY_TOOLS.has('duplicate_venue')).toBe(false)
})

it('una conexión libre la registra', async () => {
  await abrir(scopeCon())
  expect((await client.listTools()).tools.map(t => t.name)).toContain('duplicate_venue')
})

it('la vista previa no crea nada y explica qué se copia', async () => {
  await abrir(scopeCon())
  const r = await call(args)
  expect(r).toMatchObject({
    requiresConfirmation: true,
    change: { copiaDe: 'Sucursal Centro', supervisor: 'Ana Pérez', nombreNuevo: 'Sucursal Norte' },
  })
  expect(r.message).toContain('cuenta de cobro, tarifa, SIMs y ajustes')
  expect(r.message).toContain('No se copian ventas, terminales ni promotores')
  expect(typeof r.previewDigest).toBe('string')
  expect(mockDuplicar).not.toHaveBeenCalled()
})

it('con confirmar crea; el mismo folio dos veces usa la MISMA llave de idempotencia', async () => {
  await abrir(scopeCon())
  const { previewDigest } = await call(args)
  const a = await call({ ...args, previewDigest, confirm: true })
  const b = await call({ ...args, previewDigest, confirm: true })
  expect(a).toMatchObject({ ok: true, venueId: 'cm92345678901234567890123' })
  expect(b.ok).toBe(true)
  const [k1, k2] = mockDuplicar.mock.calls.map(c => c[0].idempotencyKey)
  expect(k1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(k1).toBe(k2)
  expect(mockDuplicar.mock.calls[0][0]).toMatchObject({ orgId: org, actorStaffId: staffId, name: 'Sucursal Norte' })
})

it('confirmar sin la huella, o cambiando un dato, no crea', async () => {
  await abrir(scopeCon())
  expect((await call({ ...args, confirm: true })).isError).toBe(true)
  const { previewDigest } = await call(args)
  expect((await call({ ...args, name: 'Otra tienda', previewDigest, confirm: true })).isError).toBe(true)
  expect(mockDuplicar).not.toHaveBeenCalled()
})

it('quien no es dueño de la organización (ADMIN, MEMBER) no pasa, ni a la vista previa', async () => {
  mockEsDueno.mockResolvedValue(false)
  await abrir(scopeCon())
  expect((await call(args)).isError).toBe(true)
  expect(mockOpciones).not.toHaveBeenCalled()
  expect(mockDuplicar).not.toHaveBeenCalled()
})

it('una conexión de sólo lectura no escribe', async () => {
  await abrir(scopeCon(['mcp:read']))
  expect((await call(args)).isError).toBe(true)
  expect(mockDuplicar).not.toHaveBeenCalled()
})

it('módulo apagado: error claro, nada se crea', async () => {
  mockOpciones.mockResolvedValue({ enabled: false, templates: [], supervisors: [] })
  await abrir(scopeCon())
  const r = await call(args)
  expect(r.ok).toBe(false)
  expect(r.error).toContain('no está activo')
  expect(mockDuplicar).not.toHaveBeenCalled()
})

it('rechaza campos de más (plan, tarifa, cuentas no llegan al servicio)', async () => {
  await abrir(scopeCon())
  const r = await call({ ...args, address: { ...args.address, planTier: 'PREMIUM' } })
  expect(r.isError).toBe(true)
  expect(mockDuplicar).not.toHaveBeenCalled()
})

it('la zona horaria entra a la vista previa y a la huella firmada', async () => {
  await abrir(scopeCon())
  const conZona = { ...args, address: { ...args.address, timezone: 'America/Tijuana' } }
  const r = await call(conZona)
  expect(r.change.direccion).toContain('America/Tijuana')
  const otra = { ...args, address: { ...args.address, timezone: 'America/Cancun' } }
  expect((await call({ ...otra, previewDigest: r.previewDigest, confirm: true })).isError).toBe(true)
  expect(mockDuplicar).not.toHaveBeenCalled()
  expect((await call({ ...conZona, previewDigest: r.previewDigest, confirm: true })).ok).toBe(true)
  expect(mockDuplicar.mock.calls[0][0].address.timezone).toBe('America/Tijuana')
})

it('rechaza una zona horaria inválida', async () => {
  await abrir(scopeCon())
  expect((await call({ ...args, address: { ...args.address, timezone: 'Nada/Nada' } })).isError).toBe(true)
})
