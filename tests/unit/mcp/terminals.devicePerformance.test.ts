/**
 * `get_device_performance` (hz:a5fa2439:D1): cómo dibuja su pantalla la computadora de un POS de Windows, según su último reporte.
 * Sólo lectura, sólo en el MCP libre, con el mismo alcance y permiso (`tpv:read`) que `list_devices`. Lo guardado pasa por
 * `parseStoredDeviceDiagnostics`: sin reporte, o con uno ilegible, la respuesta es «sin medir», nunca un error.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { prismaMock } from '@tests/__helpers__/setup'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TIERS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import { registerAllTools } from '@/mcp/server'
import { registerTerminalTools } from '@/mcp/tools/terminals'

const NOMBRE = 'get_device_performance'
const PC = 'cterminal0000000000000001'
const GUARDADO = {
  proc: '3fa9c1d2',
  rev: 2,
  api: 'SOFTWARE_FAST',
  paintMs: 712,
  performance: 'LIGHT',
  drawingMode: 'FAST',
  forced: true,
  failed: false,
  manual: false,
  light: true,
  cpu: 'Intel(R) Core(TM) i5-3470 CPU @ 3.20GHz',
  cores: 4,
  ramGb: 7.9,
  screen: '1920x1080',
  receivedAt: '2026-11-25T18:00:00.000Z',
  prevProc: 'aaaaaaaa',
}

const SCOPE = {
  staffId: 's',
  activeOrg: 'org',
  scopes: ['mcp:read'],
  allowedVenueIds: ['centro', 'norte'],
  perVenueAccess: new Map([
    ['centro', { role: 'MANAGER', corePermissions: ['tpv:read'] }],
    ['norte', { role: 'WAITER', corePermissions: [] }],
  ]),
} as unknown as McpScope

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<any>>()
const llamar = async (args: Record<string, unknown>) => JSON.parse((await handlers.get(NOMBRE)!(args)).content[0].text)
const fila = (deviceDiagnostics: unknown) => ({ id: PC, name: 'Caja PC', deviceDiagnostics, venue: { name: 'Centro' } })

beforeEach(() => {
  jest.clearAllMocks()
  handlers.clear()
  registerTerminalTools({ tool: (...a: any[]) => handlers.set(a[0], a.at(-1)) } as never, SCOPE)
})

/** El catálogo como lo arma `server.ts`, listado y llamado por el protocolo real. */
async function conectar(perfil: 'manual' | 'directory') {
  const server = new McpServer({ name: 'rendimiento', version: '1' })
  configureToolCatalog(server, SCOPE, perfil)
  registerAllTools(server, SCOPE, { serializedEnabled: false, whiteLabelEnabled: false, catalogEnabled: false })
  const client = new Client({ name: 'prueba', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    client,
    cerrar: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('get_device_performance', () => {
  it('el servidor MCP real la anuncia en el perfil libre, como lectura, y no en el certificado', async () => {
    const libre = await conectar('manual')
    const certificado = await conectar('directory')
    try {
      const herramienta = (await libre.client.listTools()).tools.find(t => t.name === NOMBRE)
      expect(herramienta?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect((await certificado.client.listTools()).tools.map(t => t.name)).not.toContain(NOMBRE)
      expect((await certificado.client.callTool({ name: NOMBRE, arguments: { terminalId: PC } })).isError).toBe(true)
    } finally {
      await libre.cerrar()
      await certificado.cerrar()
    }
    expect(TOOL_EFFECTS[NOMBRE]).toBe('read')
    expect(DIRECTORY_TIERS.flatMap(t => t.tools)).not.toContain(NOMBRE)
  })

  it('«sin medir» por el protocolo real es un resultado, no un error', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(fila(null) as never)
    const libre = await conectar('manual')
    try {
      const r = await libre.client.callTool({ name: NOMBRE, arguments: { terminalId: PC } })
      expect(r.isError).not.toBe(true)
      expect(r.structuredContent).toMatchObject({ status: 'success', data: { measured: false } })
    } finally {
      await libre.cerrar()
    }
  })

  it('una sucursal sin tpv:read ⇒ rechazada igual que list_devices, antes de consultar', async () => {
    await expect(handlers.get('list_devices')!({ venueId: 'norte' })).rejects.toThrow(/permission/i)
    await expect(llamar({ venueId: 'norte', terminalId: PC })).rejects.toThrow(/permission/i)
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
  })

  it('una sucursal fuera del alcance ⇒ el mismo rechazo que list_devices', async () => {
    const deLista = await handlers.get('list_devices')!({ venueId: 'ajena' }).catch((e: Error) => e)
    const deRendimiento = await llamar({ venueId: 'ajena', terminalId: PC }).catch((e: Error) => e)
    expect(deLista).toBeInstanceOf(Error)
    expect(deRendimiento).toEqual(deLista)
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
  })

  it('un aparato de otra sucursal no se encuentra: la consulta va acotada a las sucursales con tpv:read, con select explícito', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)
    const r = await llamar({ terminalId: PC })
    expect(r).toMatchObject({ found: false, coverage: { requested: 2, included: 1, complete: false } })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(1)
    const [consulta] = prismaMock.terminal.findFirst.mock.calls[0] as [any]
    expect(consulta.where).toEqual({ venueId: { in: ['centro'] }, id: PC })
    expect(consulta.select).toMatchObject({ id: true, deviceDiagnostics: true })
    expect(consulta).not.toHaveProperty('include')
  })

  it('con un reporte legible devuelve sólo los ocho campos, sin la marca interna ni los datos de la PC', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(fila(GUARDADO) as never)
    const r = await llamar({ venueId: 'centro', terminalId: PC })
    expect(r).toEqual({
      coverage: expect.objectContaining({ requested: 1, included: 1, complete: true }),
      device: { id: PC, venue: 'Centro', name: 'Caja PC' },
      measured: true,
      performance: 'LIGHT',
      api: 'SOFTWARE_FAST',
      paintMs: 712,
      drawingMode: 'FAST',
      forced: true,
      failed: false,
      manual: false,
      receivedAt: '2026-11-25T18:00:00.000Z',
    })
  })

  it.each([
    ['sin reporte', null],
    ['un texto', 'basura'],
    ['un rendimiento desconocido', { ...GUARDADO, performance: 'OTRO' }],
    ['sin la hora en que llegó', { ...GUARDADO, receivedAt: undefined }],
  ])('%s ⇒ «sin medir», sin error', async (_caso, guardado) => {
    prismaMock.terminal.findFirst.mockResolvedValue(fila(guardado) as never)
    const r = await llamar({ terminalId: PC })
    expect(r).toEqual({
      coverage: expect.any(Object),
      device: { id: PC, venue: 'Centro', name: 'Caja PC' },
      measured: false,
      message: expect.stringMatching(/^Sin medir/),
    })
  })
})
