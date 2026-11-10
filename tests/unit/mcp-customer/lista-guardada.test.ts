/**
 * D19 (10-nov-2026): la lista de herramientas del MCP (`tools/list`) sale de una copia guardada.
 *
 * Medido en producción (Better Stack, 7 al 10-nov): 5 de los 14 avisos de «hilo retenido» con el MCP en vuelo fueron un
 * `tools/list` (209–457 ms): cada uno vuelve a registrar las ~460 herramientas y a convertir sus esquemas. Ahora la MISMA
 * conexión (persona, organización, negocios, permisos, rol, scopes OAuth, app, módulos y perfil) reutiliza la lista 5 min.
 * Lo que no puede pasar: que dos conexiones con permisos distintos compartan lista, o que la copia diga otra cosa que el
 * servidor completo. Lo que contestan las herramientas (`tools/call`) nunca se guarda.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffVenue: { findFirst: jest.fn(async () => null) } },
}))
jest.mock('../../../src/mcp/scope', () => ({
  ...jest.requireActual('../../../src/mcp/scope'),
  resolveScope: jest.fn(),
}))
jest.mock('@/services/modules/module.service', () => {
  const actual = jest.requireActual('@/services/modules/module.service')
  return { ...actual, moduleService: { ...actual.moduleService, anyVenueHasModule: jest.fn(async () => false) } }
})
jest.mock('@/services/master-catalog/masterCatalogAccess.service', () => ({
  resolveMasterCatalogAccess: jest.fn(async () => ({ canRead: false })),
}))
// Cuenta cuántas veces se registran las herramientas: cada servidor completo pasa una vez por aquí.
jest.mock('../../../src/mcp/tools/venues', () => {
  const actual = jest.requireActual('../../../src/mcp/tools/venues')
  return { ...actual, registerVenueTools: jest.fn(actual.registerVenueTools) }
})

import express from 'express'
import request from 'supertest'
import { MCP_DIRECTORY_RESOURCE_URL, MCP_RESOURCE_URL } from '../../../src/mcp/oauth/config'
import { resolveScope, type McpScope } from '../../../src/mcp/scope'
import { handleDirectoryMcpRequest, handleMcpRequest } from '../../../src/mcp/server'
import { registerVenueTools } from '../../../src/mcp/tools/venues'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { resolveMasterCatalogAccess } from '@/services/master-catalog/masterCatalogAccess.service'
import {
  guardarListaMcp,
  listaMcpGuardada,
  llaveDeListaMcp,
  vaciarListasMcp,
  TOPE_DE_BYTES_DE_LISTAS,
  VIDA_DE_LA_LISTA_MS,
} from '../../../src/mcp/listaGuardada'

const armadas = registerVenueTools as jest.Mock
const resolver = resolveScope as jest.Mock
const conModulo = moduleService.anyVenueHasModule as jest.Mock

interface Conexion {
  staffId: string
  activeOrg: string
  scopes?: string[]
  clientId?: string
  perfil?: 'manual' | 'directory'
}

const BASE: Conexion = { staffId: 'staff-1', activeOrg: 'org-1', scopes: ['mcp:read', 'mcp:write'], clientId: 'app-1' }

function alcance(cambio: Partial<McpScope> = {}): McpScope {
  return {
    staffId: 'staff-1',
    activeOrg: 'org-1',
    organizationId: 'org-1',
    orgRole: 'OWNER' as any,
    allowedVenueIds: ['v1'],
    perVenueAccess: new Map([
      [
        'v1',
        {
          userId: 'staff-1',
          venueId: 'v1',
          organizationId: 'org-1',
          role: 'OWNER',
          corePermissions: ['*:*'],
          whiteLabelEnabled: false,
          enabledFeatures: [],
          featureAccess: {},
          featureMetadata: {},
        } as any,
      ],
    ]),
    isSuperAdmin: false,
    ...cambio,
  }
}

function app(c: Conexion) {
  const a = express()
  const directorio = c.perfil === 'directory'
  a.post(
    '/mcp',
    express.json(),
    (req: any, _res: unknown, next: () => void) => {
      req.auth = {
        resource: directorio ? MCP_DIRECTORY_RESOURCE_URL : MCP_RESOURCE_URL,
        extra: { staffId: c.staffId, activeOrg: c.activeOrg, scopes: c.scopes, clientId: c.clientId },
      }
      next()
    },
    directorio ? handleDirectoryMcpRequest : handleMcpRequest,
  )
  return a
}

let siguienteId = 1
async function enviar(c: Conexion, cuerpo: Record<string, unknown> | unknown[]) {
  const res = await request(app(c))
    .post('/mcp')
    .set('accept', 'application/json, text/event-stream')
    .set('content-type', 'application/json')
    .send(cuerpo)
  expect(res.status).toBe(200)
  const linea = res.text.split('\n').find((l: string) => l.startsWith('data: '))
  return linea ? JSON.parse(linea.slice(6)) : JSON.parse(res.text)
}
const lista = (c: Conexion = BASE) => enviar(c, { jsonrpc: '2.0', id: siguienteId++, method: 'tools/list' })

beforeEach(() => {
  jest.clearAllMocks()
  vaciarListasMcp()
  resolver.mockImplementation(async () => alcance())
  conModulo.mockResolvedValue(false)
})

describe('D19 — tools/list sale de la copia de la MISMA conexión', () => {
  it('dos listas iguales registran las herramientas UNA vez y la segunda responde idéntico a la primera', async () => {
    const primera = await lista()
    const segunda = await lista()
    expect(primera.result.tools.length).toBeGreaterThan(0)
    expect(segunda.result).toEqual(primera.result)
    expect(JSON.stringify(segunda.result)).toBe(JSON.stringify(primera.result))
    expect(armadas).toHaveBeenCalledTimes(1)
    // El alcance se sigue resolviendo en CADA petición: un permiso quitado cambia la llave al instante.
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  const cambios: Array<[string, () => void, Conexion]> = [
    ['otra persona', () => resolver.mockImplementation(async () => alcance({ staffId: 'staff-2' })), { ...BASE, staffId: 'staff-2' }],
    [
      'otra organización',
      () => resolver.mockImplementation(async () => alcance({ activeOrg: 'org-2', organizationId: 'org-2' })),
      { ...BASE, activeOrg: 'org-2' },
    ],
    ['otro rol en la organización', () => resolver.mockImplementation(async () => alcance({ orgRole: 'MEMBER' as any })), BASE],
    ['otro negocio', () => resolver.mockImplementation(async () => alcance({ allowedVenueIds: ['v1', 'v2'] })), BASE],
    [
      'un permiso menos en el negocio',
      () => {
        const a = alcance()
        a.perVenueAccess.set('v1', { ...a.perVenueAccess.get('v1')!, corePermissions: ['orders:read'] })
        resolver.mockImplementation(async () => a)
      },
      BASE,
    ],
    [
      'otro rol en el negocio',
      () => {
        const a = alcance()
        a.perVenueAccess.set('v1', { ...a.perVenueAccess.get('v1')!, role: 'WAITER' as any })
        resolver.mockImplementation(async () => a)
      },
      BASE,
    ],
    ['ya es superadmin', () => resolver.mockImplementation(async () => alcance({ isSuperAdmin: true })), BASE],
    ['sólo negocios demo', () => resolver.mockImplementation(async () => alcance({ soloNegociosDemo: true })), BASE],
    ['sólo lectura (scopes OAuth)', () => undefined, { ...BASE, scopes: ['mcp:read'] }],
    ['otra app (clientId)', () => undefined, { ...BASE, clientId: 'app-2' }],
    ['un módulo prendido', () => conModulo.mockResolvedValue(true), BASE],
    // Codex r2: cada bandera por separado y lo que trae cada negocio además del rol y los permisos.
    [
      'sólo inventario serializado',
      () => conModulo.mockImplementation(async (_ids: string[], codigo: string) => codigo === MODULE_CODES.SERIALIZED_INVENTORY),
      BASE,
    ],
    [
      'sólo marca blanca',
      () => conModulo.mockImplementation(async (_ids: string[], codigo: string) => codigo === MODULE_CODES.WHITE_LABEL_DASHBOARD),
      BASE,
    ],
    ['acceso al catálogo maestro', () => (resolveMasterCatalogAccess as jest.Mock).mockResolvedValue({ canRead: true }), BASE],
    [
      'otra función activa en el negocio',
      () => {
        const a = alcance()
        a.perVenueAccess.set('v1', { ...a.perVenueAccess.get('v1')!, enabledFeatures: ['SERIALIZED_STOCK'] })
        resolver.mockImplementation(async () => a)
      },
      BASE,
    ],
    [
      'otro acceso a una función',
      () => {
        const a = alcance()
        a.perVenueAccess.set('v1', { ...a.perVenueAccess.get('v1')!, featureAccess: { X: { hasAccess: true } } as any })
        resolver.mockImplementation(async () => a)
      },
      BASE,
    ],
    ['el perfil certificado', () => undefined, { ...BASE, perfil: 'directory' }],
  ]

  it.each(cambios)('%s: arma otra vez y da la lista que daría un servidor nuevo', async (_caso, cambiar, conexion) => {
    await lista()
    cambiar()
    const conCambio = await lista(conexion)
    expect(armadas).toHaveBeenCalledTimes(2)

    // La lista correcta para el cambio: la misma que arma un servidor sin ninguna copia guardada.
    vaciarListasMcp()
    const deCero = await lista(conexion)
    expect(conCambio.result).toEqual(deCero.result)
  })

  it('el perfil certificado también reutiliza SU copia, sin mezclarla con la del modo libre', async () => {
    const directorio = { ...BASE, perfil: 'directory' as const }
    const libre = await lista()
    const cert1 = await lista(directorio)
    const cert2 = await lista(directorio)
    expect(armadas).toHaveBeenCalledTimes(2)
    expect(cert2.result).toEqual(cert1.result)
    expect(cert1.result).not.toEqual(libre.result)
  })

  it('sólo lectura quita las herramientas de escritura: la copia de quien sí escribe no se le da', async () => {
    const escribe = await lista()
    const lee = await lista({ ...BASE, scopes: ['mcp:read'] })
    expect(lee.result.tools.length).toBeLessThan(escribe.result.tools.length)
  })

  it('tools/call nunca sale de la copia: arma el servidor completo', async () => {
    await lista()
    await enviar(BASE, { jsonrpc: '2.0', id: siguienteId++, method: 'tools/call', params: { name: 'no_existe', arguments: {} } })
    expect(armadas).toHaveBeenCalledTimes(2)
  })

  it('un lote con tools/list ni usa ni escribe la copia', async () => {
    await lista()
    await enviar(BASE, [{ jsonrpc: '2.0', id: siguienteId++, method: 'tools/list' }])
    expect(armadas).toHaveBeenCalledTimes(2)
    await lista()
    expect(armadas).toHaveBeenCalledTimes(2)
  })

  it('vence: a los 5 min vuelve a armar', async () => {
    const ahora = jest.spyOn(Date, 'now')
    ahora.mockReturnValue(1_000_000)
    await lista()
    ahora.mockReturnValue(1_000_000 + VIDA_DE_LA_LISTA_MS - 1)
    await lista()
    expect(armadas).toHaveBeenCalledTimes(1)
    ahora.mockReturnValue(1_000_000 + VIDA_DE_LA_LISTA_MS)
    await lista()
    expect(armadas).toHaveBeenCalledTimes(2)
    ahora.mockRestore()
  })
})

describe('D19 — la copia guarda sólo listas buenas y tiene tope', () => {
  const llave = (c: Record<string, unknown> = {}) => llaveDeListaMcp({ perfil: 'manual', banderas: {}, alcance: { a: 1, ...c } })

  it('la llave es estable aunque cambie el orden de las propiedades y de un Map', () => {
    const m1 = new Map([
      ['x', 1],
      ['y', 2],
    ])
    const m2 = new Map([
      ['y', 2],
      ['x', 1],
    ])
    expect(llaveDeListaMcp({ perfil: 'manual', banderas: { b: true, a: false }, alcance: { m: m1, z: 1, y: [1, 2] } })).toBe(
      llaveDeListaMcp({ banderas: { a: false, b: true }, alcance: { y: [1, 2], z: 1, m: m2 }, perfil: 'manual' }),
    )
  })

  it('el orden de una lista SÍ importa (los negocios permitidos)', () => {
    expect(llave({ v: ['a', 'b'] })).not.toBe(llave({ v: ['b', 'a'] }))
  })

  it('una fecha cuenta por su hora; algo que no se puede escribir estable no da llave (no se guarda nada)', () => {
    expect(llave({ d: new Date('2026-11-10T00:00:00Z') })).not.toBe(llave({ d: new Date('2026-11-11T00:00:00Z') }))
    expect(llave({ f: () => 1 })).toBeNull()
    expect(llave({ s: Symbol('x') })).toBeNull()
    expect(llave({ n: 1n })).toBeNull()
  })

  it('no se guarda una respuesta sin lista de herramientas (un error)', () => {
    guardarListaMcp('k', { error: 'x' } as any, 0)
    expect(listaMcpGuardada('k', 0)).toBeUndefined()
  })

  it('tope: al pasarse de bytes se suelta la más vieja; una lista más grande que el tope ni se guarda', () => {
    const tercio = { tools: [{ name: 'x'.repeat(Math.floor(TOPE_DE_BYTES_DE_LISTAS / 6)) }] }
    guardarListaMcp('a', tercio, 0)
    guardarListaMcp('b', tercio, 0)
    guardarListaMcp('c', tercio, 0)
    expect(listaMcpGuardada('a', 0)).toBeUndefined()
    expect(listaMcpGuardada('c', 0)).toEqual(tercio)
    guardarListaMcp('enorme', { tools: [{ name: 'x'.repeat(TOPE_DE_BYTES_DE_LISTAS) }] }, 0)
    expect(listaMcpGuardada('enorme', 0)).toBeUndefined()
  })

  it('devuelve una copia nueva cada vez: quien la reciba no puede cambiar la guardada', () => {
    guardarListaMcp('k', { tools: [{ name: 'a' }] }, 0)
    const una = listaMcpGuardada('k', 0) as any
    una.tools.push({ name: 'b' })
    expect(listaMcpGuardada('k', 0)).toEqual({ tools: [{ name: 'a' }] })
  })
})
