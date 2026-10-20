/**
 * `auditMcpWrite` — la bitácora de cada escritura del MCP dice QUÉ app la hizo (founder, 15-oct-2026).
 *
 * Si un cliente dice «yo no fui» de un cambio que hizo su propio ChatGPT, la fila ya decía «vino del MCP» y a nombre
 * de quién, pero no si fue ChatGPT, Claude u otra app conectada. Ahora guarda el id de la app (lo que permite verificarla
 * contra su registro OAuth) y el nombre con el que se registró, leído en ese momento.
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
// El mock global de Prisma no trae la tabla de apps del MCP: aquí sólo hace falta su búsqueda por id.
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { mcpOAuthClient: { findUnique: jest.fn() } } }))

import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { auditMcpWrite } from '../../../src/mcp/audit'
import type { McpScope } from '../../../src/mcp/scope'

const mockedLogAction = logAction as jest.Mock
const mockedPrisma = prisma as unknown as { mcpOAuthClient: { findUnique: jest.Mock } }

const scope = (extra: Partial<McpScope> = {}): McpScope => ({
  staffId: 'staff-1',
  activeOrg: 'org-1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map(),
  ...extra,
})
const write = { action: 'MENU_PRICES_SET_BULK', entity: 'Venue', entityId: 'v1', venueId: 'v1', data: { applied: [] } }

beforeEach(() => jest.clearAllMocks())

it('guarda el id y el nombre de la app que hizo el cambio', async () => {
  mockedPrisma.mcpOAuthClient.findUnique.mockResolvedValue({ clientName: 'ChatGPT' })
  await auditMcpWrite(scope({ clientId: 'mcp_abc' }), write)
  expect(mockedPrisma.mcpOAuthClient.findUnique).toHaveBeenCalledWith({ where: { clientId: 'mcp_abc' }, select: { clientName: true } })
  expect(mockedLogAction).toHaveBeenCalledWith(
    expect.objectContaining({
      staffId: 'staff-1',
      venueId: 'v1',
      action: 'MENU_PRICES_SET_BULK',
      data: { applied: [], source: 'customer-mcp', mcpClientId: 'mcp_abc', mcpClientName: 'ChatGPT' },
    }),
  )
})

it('sin app identificada no consulta nada y deja la bitácora como antes', async () => {
  await auditMcpWrite(scope(), write)
  expect(mockedPrisma.mcpOAuthClient.findUnique).not.toHaveBeenCalled()
  expect(mockedLogAction).toHaveBeenCalledWith(expect.objectContaining({ data: { applied: [], source: 'customer-mcp' } }))
})

it('si no se puede leer el nombre de la app, la bitácora se escribe igual con su id', async () => {
  mockedPrisma.mcpOAuthClient.findUnique.mockRejectedValue(new Error('db caída'))
  await expect(auditMcpWrite(scope({ clientId: 'mcp_abc' }), write)).resolves.toBeUndefined()
  expect(mockedLogAction).toHaveBeenCalledWith(
    expect.objectContaining({ data: { applied: [], source: 'customer-mcp', mcpClientId: 'mcp_abc' } }),
  )
})

it('una app registrada sin nombre deja sólo su id', async () => {
  mockedPrisma.mcpOAuthClient.findUnique.mockResolvedValue({ clientName: null })
  await auditMcpWrite(scope({ clientId: 'mcp_abc' }), write)
  expect(mockedLogAction).toHaveBeenCalledWith(
    expect.objectContaining({ data: { applied: [], source: 'customer-mcp', mcpClientId: 'mcp_abc' } }),
  )
})

it('la herramienta no puede hacerse pasar por otra app ni por otro origen desde sus datos', async () => {
  mockedPrisma.mcpOAuthClient.findUnique.mockResolvedValue({ clientName: 'ChatGPT' })
  await auditMcpWrite(scope({ clientId: 'mcp_abc' }), {
    ...write,
    data: { applied: [], source: 'dashboard', mcpClientId: 'otra', mcpClientName: 'Claude' },
  })
  expect(mockedLogAction).toHaveBeenCalledWith(
    expect.objectContaining({ data: { applied: [], source: 'customer-mcp', mcpClientId: 'mcp_abc', mcpClientName: 'ChatGPT' } }),
  )
})

// Codex 15-oct: la búsqueda del nombre de la app es contabilidad, no trabajo de la herramienta. Con la petición cortada
// (freno del 23-sep-2026) una lectura bajo el freno se rechaza y deja un corte pendiente, que haría responder como
// cancelada una escritura ya hecha. Prisma es un thenable perezoso: pasa por el freno en el momento de su `.then`.
describe('auditMcpWrite con la petición cortada', () => {
  const { runWithContext, getContext } = jest.requireActual(
    '@/observability/executionContext',
  ) as typeof import('@/observability/executionContext')
  const { RequestCancelledError, checkCancellation, pendingCancellation } = jest.requireActual(
    '@/utils/requestCancellation',
  ) as typeof import('@/utils/requestCancellation')

  it('busca el nombre fuera del freno: no deja un corte pendiente y no pierde el nombre', async () => {
    const controller = new AbortController()
    controller.abort(new RequestCancelledError('timeout', 25_000))
    const c = { signal: controller.signal, hasWritten: false, refused: false }
    mockedPrisma.mcpOAuthClient.findUnique.mockImplementationOnce(() => ({
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            checkCancellation('findUnique', getContext()?.cancellation)
            return { clientName: 'ChatGPT' }
          })
          .then(ok, ko),
    }))
    let pendiente: unknown = 'no se midió'
    await runWithContext(
      { correlationId: 'c-1', source: 'http', entrypoint: 'POST /mcp tools/call set_prices_by_code', cancellation: c },
      async () => {
        await auditMcpWrite(scope({ clientId: 'mcp_abc' }), write)
        pendiente = pendingCancellation()
      },
    )
    expect(pendiente).toBeNull()
    expect(c.refused).toBe(false)
    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mcpClientId: 'mcp_abc', mcpClientName: 'ChatGPT' }) }),
    )
  })
})
