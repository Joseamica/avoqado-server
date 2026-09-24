/**
 * El saludo del MCP (`initialize`, `ping`) SIN armar el alcance — ronda 3 de Codex (P2-5).
 *
 * Con los dos cupos de una persona ocupados, el cliente real del SDK fallaba su `connect()`: el `initialize` esperaba
 * turno 15 s y recibía un 429 que el SDK no reintenta. Ahora el saludo no toma cupo, y para que eso sea barato no arma
 * el alcance (57 tiendas en la organización del incidente): sólo pregunta si la persona es superadmin, que es lo único
 * que cambia la respuesta. La trampa que fija la última prueba: el SDK declara «tengo herramientas» cuando se registra
 * la primera, así que un servidor ligero sin herramientas anunciaría que no tiene ninguna y el cliente jamás pediría
 * la lista. El saludo debe anunciar EXACTAMENTE lo mismo que el servidor completo.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffVenue: { findFirst: jest.fn() } },
}))
jest.mock('../../../src/mcp/scope', () => ({
  ...jest.requireActual('../../../src/mcp/scope'),
  resolveScope: jest.fn(async () => {
    throw new Error('el saludo no debe armar el alcance')
  }),
}))

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import prisma from '@/utils/prismaClient'
import { buildMcpInstructions } from '../../../src/mcp/instructions'
import { resolveScope, type McpScope } from '../../../src/mcp/scope'
import { buildHandshakeServer, createMcpServer, registerAllTools } from '../../../src/mcp/server'

const findFirst = (prisma as unknown as { staffVenue: { findFirst: jest.Mock } }).staffVenue.findFirst

async function conectar(server: McpServer): Promise<Client> {
  const [lado, otroLado] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'prueba', version: '0' })
  await server.connect(lado)
  await client.connect(otroLado)
  return client
}

beforeEach(() => jest.clearAllMocks())

it('anuncia sus herramientas y las instrucciones de cliente, con UNA consulta y sin armar el alcance', async () => {
  findFirst.mockResolvedValue(null)
  const client = await conectar(await buildHandshakeServer('staff-1'))

  expect(client.getServerCapabilities()?.tools).toBeDefined()
  expect(client.getInstructions()).toBe(buildMcpInstructions({ isSuperAdmin: false }))
  await expect(client.ping()).resolves.toEqual({})
  expect(findFirst).toHaveBeenCalledTimes(1)
  expect(resolveScope).not.toHaveBeenCalled()
})

it('a un superadmin activo le da sus instrucciones, con la misma regla que resolveScope', async () => {
  findFirst.mockResolvedValue({ id: 'sv-1' })
  const client = await conectar(await buildHandshakeServer('staff-9'))

  expect(client.getInstructions()).toBe(buildMcpInstructions({ isSuperAdmin: true }))
  // Rol SUPERADMIN activo en una cuenta activa: el mismo filtro que protege el bypass global (ver scope.ts).
  expect(findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { staffId: 'staff-9', role: 'SUPERADMIN', active: true, staff: { active: true } } }),
  )
})

it('anuncia EXACTAMENTE lo mismo que el servidor completo: capacidades, nombre, versión e instrucciones', async () => {
  findFirst.mockResolvedValue(null)
  const completo = createMcpServer(false)
  const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
  registerAllTools(completo, scope, { serializedEnabled: true, whiteLabelEnabled: true, catalogEnabled: true })

  const delCompleto = await conectar(completo)
  const delSaludo = await conectar(await buildHandshakeServer('s1'))

  expect(delSaludo.getServerCapabilities()).toEqual(delCompleto.getServerCapabilities())
  expect(delSaludo.getServerVersion()).toEqual(delCompleto.getServerVersion())
  expect(delSaludo.getInstructions()).toEqual(delCompleto.getInstructions())
})

describe('handleMcpRequest elige el servidor ligero sólo para el saludo', () => {
  // HTTP de verdad (express + el transporte real del SDK): sin esto, volver a armar el alcance para `initialize` sólo
  // se notaría en el costo, nunca en una prueba.

  const request = require('supertest')

  const express = require('express')
  const { handleMcpRequest } = jest.requireActual('../../../src/mcp/server')

  function app() {
    const a = express()
    a.post(
      '/mcp',
      express.json(),
      (req: { auth?: unknown }, _res: unknown, next: () => void) => {
        req.auth = { extra: { staffId: 'staff-1', activeOrg: 'org-1' } }
        next()
      },
      handleMcpRequest,
    )
    return a
  }
  const enviar = (body: unknown) =>
    request(app()).post('/mcp').set('accept', 'application/json, text/event-stream').set('content-type', 'application/json').send(body)
  const leer = (res: { text: string }) => {
    const linea = res.text.split('\n').find(l => l.startsWith('data: '))
    return linea ? JSON.parse(linea.slice(6)) : JSON.parse(res.text)
  }

  it.each([
    [
      'initialize',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
    ],
    ['ping', { jsonrpc: '2.0', id: 2, method: 'ping' }],
  ])('%s se contesta sin armar el alcance', async (_metodo, cuerpo) => {
    findFirst.mockResolvedValue(null)
    const res = await enviar(cuerpo)
    expect(res.status).toBe(200)
    expect(leer(res).error).toBeUndefined()
    expect(resolveScope).not.toHaveBeenCalled()
  })

  it('cualquier otra petición SÍ arma el alcance (tools/list)', async () => {
    await enviar({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(resolveScope).toHaveBeenCalledTimes(1)
  })
})
