/**
 * `handleMcpRequest` ante una petición CANCELADA por el freno del 23-sep-2026 (tope vencido o cliente que
 * se fue) mientras se arma el alcance, antes de que el SDK del MCP pueda contestar.
 *
 * Antes caía en el mismo cajón que una falla del servidor: `logger.error('[MCP] connect failed')` y un 500
 * `server_error` sin explicación. Un corte es el freno funcionando, no una falla: se avisa como warn y se le
 * explica al asistente en español qué pasó, para que pregunte algo más acotado en vez de reintentar a ciegas.
 */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: new Proxy({}, { get: () => () => undefined }) }))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('../../../src/mcp/scope', () => ({ resolveScope: jest.fn() }))
jest.mock('../../../src/mcp/instrument', () => ({
  ...jest.requireActual('../../../src/mcp/instrument'),
  recordCancelledToolCall: jest.fn(),
}))
jest.mock('@/services/modules/module.service', () => ({
  ...jest.requireActual('@/services/modules/module.service'),
  moduleService: { anyVenueHasModule: jest.fn(async () => false) },
}))

import type { Request, Response } from 'express'
import logger from '@/config/logger'
import { getContext, runWithContext, type RequestCancellation } from '@/observability/executionContext'
import { RequestCancelledError } from '@/utils/requestCancellation'
import { handleMcpRequest } from '../../../src/mcp/server'
import { recordCancelledToolCall } from '../../../src/mcp/instrument'
import { resolveScope } from '../../../src/mcp/scope'

const mockedLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock }
const mockResolveScope = resolveScope as jest.Mock

function makeReq(body: unknown) {
  return { auth: { extra: { staffId: 'staff-1', activeOrg: 'org-1' } }, body, headers: {} } as unknown as Request
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as any,
    headersSent: false,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      res.headersSent = true
      return res
    },
    on: jest.fn(),
  }
  return res
}

const toolCall = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'org_confirmed_sales_report', arguments: {} } }

beforeEach(() => jest.clearAllMocks())

it('un tools/call cancelado se contesta como resultado de herramienta con el motivo en español (el modelo lo LEE)', async () => {
  mockResolveScope.mockRejectedValue(new RequestCancelledError('timeout', 25_000))
  const res = makeRes()

  await handleMcpRequest(makeReq(toolCall), res as unknown as Response)

  expect(res.statusCode).toBe(200)
  expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 7, result: { isError: true } })
  expect(res.body.result.content[0].text).toMatch(/25 s/)
  expect(mockedLogger.warn).toHaveBeenCalledWith('[MCP] petición cancelada', expect.objectContaining({ mcp: true, reason: 'timeout' }))
  expect(mockedLogger.error).not.toHaveBeenCalled()
})

it('cualquier otro método cancelado recibe un error JSON-RPC con el motivo, no un 500 mudo', async () => {
  mockResolveScope.mockRejectedValue(new RequestCancelledError('client-closed'))
  const res = makeRes()

  await handleMcpRequest(makeReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), res as unknown as Response)

  expect(res.statusCode).toBe(503)
  expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32000 } })
  expect(res.body.error.message).toMatch(/se cerró la conexión/)
  expect(mockedLogger.error).not.toHaveBeenCalled()
})

it('si ya se respondió, no intenta escribir otra respuesta', async () => {
  mockResolveScope.mockRejectedValue(new RequestCancelledError('timeout', 25_000))
  const res = makeRes()
  res.headersSent = true

  await handleMcpRequest(makeReq(toolCall), res as unknown as Response)

  expect(res.statusCode).toBe(0)
  expect(res.body).toBeUndefined()
})

// REGRESIÓN — una falla de verdad sigue siendo un 500 que se registra como error
it('REGRESIÓN: una falla del servidor sigue siendo 500 server_error con logger.error', async () => {
  mockResolveScope.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'))
  const res = makeRes()

  await handleMcpRequest(makeReq(toolCall), res as unknown as Response)

  expect(res.statusCode).toBe(500)
  expect(res.body).toEqual({ error: 'server_error' })
  expect(mockedLogger.error).toHaveBeenCalledWith('[MCP] connect failed', expect.objectContaining({ status: 500 }))
})

function enPeticion<T>(c: RequestCancellation, fn: () => T): T {
  return runWithContext({ correlationId: 'c-h', source: 'http', entrypoint: 'POST /mcp tools/call x', cancellation: c }, fn)
}
const vivo = (): RequestCancellation => ({ signal: new AbortController().signal, hasWritten: false, refused: false, activeWork: 0 })

// Codex P2-4: un `catch` en el camino del armado (catálogo, acceso por venue) puede tragarse el corte de una
// lectura y devolver "sin acceso": el servidor quedaría armado con herramientas de menos y tools/list lo
// entregaría como bueno. Si durante el armado se cortó cualquier lectura, NO se entrega el servidor.
it('si durante el armado se cortó una lectura (aunque un catch se la haya tragado), no se entrega el servidor', async () => {
  const c = vivo()
  mockResolveScope.mockImplementation(async () => {
    const cancelacion = getContext()?.cancellation
    if (cancelacion) cancelacion.refused = true // una lectura se cortó y alguien se lo tragó
    return { staffId: 'staff-1', activeOrg: 'org-1', allowedVenueIds: [], perVenueAccess: new Map() }
  })
  const res = makeRes()

  await enPeticion(c, () => handleMcpRequest(makeReq(toolCall), res as unknown as Response))

  expect(res.statusCode).toBe(200)
  expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 7, result: { isError: true } })
  expect(mockedLogger.warn).toHaveBeenCalledWith('[MCP] petición cancelada', expect.objectContaining({ mcp: true }))
})

// Codex P1-2: el manejador cuenta como trabajo en vuelo; el cupo de la persona no se libera mientras corre.
it('el manejador cuenta como trabajo en vuelo mientras arma y atiende, y lo suelta al terminar', async () => {
  const c = vivo()
  let enVueloDuranteElArmado = -1
  mockResolveScope.mockImplementation(async () => {
    enVueloDuranteElArmado = getContext()?.cancellation?.activeWork ?? -1
    throw new RequestCancelledError('timeout', 25_000)
  })
  await enPeticion(c, () => handleMcpRequest(makeReq(toolCall), makeRes() as unknown as Response))
  expect(enVueloDuranteElArmado).toBe(1)
  expect(c.activeWork).toBe(0)
})

// Hallado en /full-testing contra el app real: con el corte durante el armado, la herramienta nunca corre y la
// bitácora (`mcp_tool_calls`, la que lee la auditoría de 12 h) no se enteraba del intento.
it('un tools/call cortado durante el armado deja su fila en la bitácora, con la herramienta y el motivo', async () => {
  mockResolveScope.mockRejectedValue(new RequestCancelledError('timeout', 25_000))
  await handleMcpRequest(makeReq(toolCall), makeRes() as unknown as Response)
  expect(recordCancelledToolCall).toHaveBeenCalledWith(
    expect.objectContaining({ toolName: 'org_confirmed_sales_report', staffId: 'staff-1', orgId: 'org-1', reason: 'timeout' }),
  )
})

it('un método que no es de herramienta cortado durante el armado NO inventa una fila de herramienta', async () => {
  mockResolveScope.mockRejectedValue(new RequestCancelledError('timeout', 25_000))
  await handleMcpRequest(makeReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), makeRes() as unknown as Response)
  expect(recordCancelledToolCall).not.toHaveBeenCalled()
})
