/**
 * El flujo de DOS PASOS de las tres escrituras de la pantalla del cliente, atravesando el catálogo REAL.
 *
 * `customerDisplay.test.ts` llama a los manejadores sueltos; aquí van por un `McpServer` y un `Client` de verdad con
 * `configureToolCatalog`, que es lo que corre en producción: el catálogo agrega `confirmationToken` a toda escritura con
 * `confirm`, lo ata a los argumentos de la primera llamada y no deja pasar un `confirm:true` sin él. Ninguna suite genérica
 * recorre las herramientas registradas (confirmation.test.ts usa una tool falsa; confirmation-identity.test.ts, menú y personal).
 *
 * Por cada escritura: (1) la primera llamada enseña la vista previa con el token y NO escribe; (2) confirm sin token no
 * escribe; (3) confirm con argumentos cambiados no escribe; (4) los mismos argumentos + confirm + token sí escriben, una vez.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { configureToolCatalog } from '@/mcp/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerCustomerDisplayTools } from '../../../src/mcp/tools/customerDisplay'

const servicio = {
  get: jest.fn(),
  preview: jest.fn(),
  save: jest.fn(),
  previewCopy: jest.fn(),
  copy: jest.fn(),
  reset: jest.fn(),
}

jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: jest.fn(), requirePermission: jest.fn() }) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: jest.fn() }))
jest.mock('@/services/customer-display/customerDisplayDesign.service', () => ({
  MAX_COPY_TARGETS: 20,
  getCustomerDisplayForDashboard: (...a: unknown[]) => servicio.get(...a),
  listCustomerDisplayDevices: jest.fn(),
  previewCustomerDisplay: (...a: unknown[]) => servicio.preview(...a),
  saveCustomerDisplayDesign: (...a: unknown[]) => servicio.save(...a),
  previewCopyCustomerDisplay: (...a: unknown[]) => servicio.previewCopy(...a),
  copyCustomerDisplayDesign: (...a: unknown[]) => servicio.copy(...a),
  resetCustomerDisplayDesign: (...a: unknown[]) => servicio.reset(...a),
}))

const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map(),
  scopes: ['mcp:read', 'mcp:write'],
} as unknown as McpScope

let server: McpServer
let client: Client
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args })
  return JSON.parse((r.content as Array<{ text: string }>)[0].text)
}

beforeEach(async () => {
  for (const simulado of Object.values(servicio)) simulado.mockReset()
  servicio.get.mockResolvedValue({
    editToken: 'd1:4',
    design: { welcomeText: 'Hola', theme: 'LIGHT', slides: [] },
    ficha: { fingerprint: 'f' },
    entitlements: {},
    assetRejected: [],
    device: {},
  })
  servicio.preview.mockResolvedValue({ ficha: { fingerprint: 'g' }, assetRejected: [], previewSeq: 0 })
  servicio.save.mockResolvedValue({ editToken: 'd1:5', ficha: {} })
  servicio.previewCopy.mockResolvedValue({
    promosOmitted: false,
    origen: { editToken: 'd1:4', diseno: {} },
    destinos: [{ terminalId: 't2', nombre: 'Caja 2', conservaSusImagenes: false, imagenes: 1 }],
  })
  servicio.copy.mockResolvedValue({ copied: ['t2'], promosOmitted: false })
  servicio.reset.mockResolvedValue({ editToken: 'd1:5', ficha: {} })

  server = new McpServer({ name: 'pantalla-del-cliente', version: '1' })
  configureToolCatalog(server, scope)
  registerCustomerDisplayTools(server, scope)
  client = new Client({ name: 'two-step-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
})
afterEach(async () => {
  await client.close()
  await server.close()
})

const ESCRITURAS = [
  [
    'update_customer_display_design',
    { venueId: 'v1', terminalId: 't1', expectedEditToken: 'd1:4', design: { welcomeText: 'Pasa', accentColor: '#aabbcc' } },
    { design: { welcomeText: 'Otro' } },
    'save',
  ],
  [
    'copy_customer_display_design',
    { venueId: 'v1', sourceTerminalId: 't1', sourceEditToken: 'd1:4', targets: [{ terminalId: 't2', editToken: 'factory' }] },
    { targets: [{ terminalId: 't3', editToken: 'factory' }] },
    'copy',
  ],
  ['reset_customer_display_design', { venueId: 'v1', terminalId: 't1', expectedEditToken: 'd1:4' }, { terminalId: 't9' }, 'reset'],
] as const

describe.each(ESCRITURAS)('%s por el catálogo real', (tool, args, cambio, escribe) => {
  it('la primera llamada enseña la vista previa con su token y NO escribe', async () => {
    const r = await call(tool, args)
    expect(r).toMatchObject({ requiresConfirmation: true, confirmationToken: expect.any(String), expiresInSeconds: 600 })
    expect(r.confirmationArguments).toMatchObject({ venueId: 'v1' })
    expect(servicio[escribe]).not.toHaveBeenCalled()
  })

  it('confirm:true sin token NO escribe', async () => {
    expect(await call(tool, { ...args, confirm: true })).toMatchObject({ needsInput: true, field: 'confirmationToken' })
    expect(servicio[escribe]).not.toHaveBeenCalled()
  })

  it('confirm:true con los argumentos cambiados NO escribe: el token está atado a los de la primera llamada', async () => {
    const { confirmationToken } = await call(tool, args)
    expect(await call(tool, { ...args, ...cambio, confirm: true, confirmationToken })).toMatchObject({ needsInput: true })
    expect(servicio[escribe]).not.toHaveBeenCalled()
  })

  it('los mismos argumentos + confirm:true + el token sí escriben, una sola vez', async () => {
    const preview = await call(tool, args)
    const r = await call(tool, { ...preview.confirmationArguments, confirm: true, confirmationToken: preview.confirmationToken })
    expect(r.ok).toBe(true)
    expect(servicio[escribe]).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(servicio[escribe].mock.calls[0])).not.toContain('confirmationToken')
  })
})
