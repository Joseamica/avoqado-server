/**
 * C1 · Tarea 11: la factura global se emite a mano también por el MCP (`emit_global_invoice`), en dos pasos y con el mismo permiso que el
 * botón del panel (`cfdi:configure`): la PRINCIPAL de un periodo cerrado reciente (por `desde`) o la COMPLEMENTARIA de una principal (por su id).
 * Online a propósito: es un timbrado ante el SAT.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerCfdiTools } from '../../../src/mcp/tools/cfdi'
import { configureToolCatalog } from '../../../src/mcp/catalog'
import type { McpScope } from '../../../src/mcp/scope'
import { conectarPorElCatalogo, pasoUnoYDos } from '../../__helpers__/mcp-por-el-catalogo'

const mockAudit = jest.fn()
const mockVenueFilter = jest.fn((v?: string) => ({ venueId: { in: [v ?? 'v1'] } }))
const mockRequirePermission = jest.fn()
const mockVenuesWithFeatureAccess = jest.fn()
const mockEmisorFindMany = jest.fn()
const mockVistaPreviaComplementaria = jest.fn()
const mockVistaPreviaPrincipal = jest.fn()
const mockIssueGlobalForEmisor = jest.fn()
const mockEmitirComplementaria = jest.fn()

jest.mock('@/services/fiscal/cfdiGlobal.service', () => ({
  vistaPreviaComplementaria: (...a: unknown[]) => mockVistaPreviaComplementaria(...a),
  vistaPreviaPrincipal: (...a: unknown[]) => mockVistaPreviaPrincipal(...a),
  issueGlobalForEmisor: (...a: unknown[]) => mockIssueGlobalForEmisor(...a),
  emitirGlobalComplementaria: (...a: unknown[]) => mockEmitirComplementaria(...a),
}))
// Viven en el mismo archivo: se mockean para que registrar las tools no cargue su cadena real (Storage, PAC…).
jest.mock('@/services/fiscal/cfdiEmail.service', () => ({ sendCfdiByEmail: jest.fn() }))
jest.mock('@/services/fiscal/cfdiCreditNote.service', () => ({ emitRefundCreditNote: jest.fn(), getRefundCreditNoteStatus: jest.fn() }))
jest.mock('@/services/fiscal/confirmarContratoDePrecio.service', () => ({
  vistaPreviaContrato: jest.fn(),
  confirmarContratoIvaIncluido: jest.fn(),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: jest.fn(() => true) }))
jest.mock('@/services/access/basePlan.service', () => ({
  venuesWithFeatureAccess: (...a: unknown[]) => mockVenuesWithFeatureAccess(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (...a: unknown[]) => mockVenueFilter(...(a as [string | undefined])),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    cfdi: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 }, _count: { _all: 0 } }),
    },
    fiscalEmisor: { findMany: (...a: unknown[]) => mockEmisorFindMany(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('emit_global_invoice')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  const reg = {
    tool: (...a: unknown[]) => {
      handlers.set(a[0] as string, a[a.length - 1] as never)
    },
  } as never
  registerCfdiTools(reg, scope)
})

const PERIODO = { desde: '2026-05-01T06:00:00.000Z', hasta: '2026-06-01T06:00:00.000Z', meses: '05', anio: 2026 }
const VISTA_COMPLEMENTARIA = {
  periodo: PERIODO,
  estadoPrincipal: 'TIMBRADA',
  corregidasPendientes: { n: 3, completo: true },
  siguienteLlave: 'k-c2',
  motivo: null,
}
const VISTA_PRINCIPAL = { periodo: PERIODO, estado: 'SIN_GLOBAL', cfdiId: null, ventas: { n: 7, completo: false }, motivo: null }
const TIMBRADA = {
  status: 'STAMPED',
  cfdi: { id: 'g-c2', uuid: 'U2', serie: 'G', folio: '7', entrada: { ajustes: [], complementariaDe: 'g1' } },
  period: { meses: '05', anio: 2026 },
  candidateCount: 3,
  excluidas: { PRODUCTO_POR_REVISAR: 1 },
  excluidasPorIvaMixto: 0,
  complementariaDe: 'g1',
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVenuesWithFeatureAccess.mockResolvedValue(new Set(['v1']))
  mockEmisorFindMany.mockResolvedValue([{ id: 'e1', rfc: 'AAA010101AAA', legalName: 'Café' }])
  mockVistaPreviaComplementaria.mockResolvedValue(VISTA_COMPLEMENTARIA)
  mockVistaPreviaPrincipal.mockResolvedValue(VISTA_PRINCIPAL)
  mockEmitirComplementaria.mockResolvedValue(TIMBRADA)
  mockIssueGlobalForEmisor.mockResolvedValue({ ...TIMBRADA, complementariaDe: undefined })
})

describe('emit_global_invoice — dos pasos, `cfdi:configure`, feature CFDI', () => {
  it('🔴 sin confirm: vista previa de la COMPLEMENTARIA (periodo, estado, cuántas ventas) y NADA se emite', async () => {
    const r = parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1' }))
    expect(r).toMatchObject({
      ok: true,
      requiresConfirmation: true,
      periodo: PERIODO,
      estado: 'TIMBRADA',
      ventas: { n: 3, completo: true },
      confirmationArgs: { venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1', confirm: true },
    })
    expect(r).not.toHaveProperty('needsConfirmation')
    expect(r.message).toMatch(/irreversible/)
    // OF-1 (T9 N-2): promete sólo lo que hace. El paso 2 recalcula la vista pero no la compara con la mostrada.
    expect(r.message).not.toMatch(/huella|Si algo cambia antes/)
    expect(r.message).toContain('con otros argumentos el token no sirve y no se hace nada')
    expect(mockVistaPreviaComplementaria).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'v1', emisorId: 'e1', principalId: 'g1' }),
    )
    expect(mockEmitirComplementaria).not.toHaveBeenCalled()
    expect(mockIssueGlobalForEmisor).not.toHaveBeenCalled()
  })
  it('🔴 sin confirm: la PRINCIPAL de un periodo reciente dice «al menos N» cuando la revisión no fue completa', async () => {
    const r = parse(await call({ venueId: 'v1', tipo: 'PRINCIPAL', desde: PERIODO.desde }))
    expect(r).toMatchObject({
      ok: true,
      requiresConfirmation: true,
      periodo: PERIODO,
      estado: 'SIN_GLOBAL',
      ventas: { n: 7, completo: false },
    })
    expect(r.message).toMatch(/al menos 7/)
    expect(mockVistaPreviaPrincipal).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1', emisorId: 'e1', desde: PERIODO.desde }))
    expect(mockIssueGlobalForEmisor).not.toHaveBeenCalled()
  })
  it('🔴 con confirm y COMPLEMENTARIA ⇒ `emitirGlobalComplementaria` con `principalId`; se audita CFDI_GLOBAL_ISSUED con su principal', async () => {
    const r = parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1', confirm: true }))
    expect(mockEmitirComplementaria).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'v1', emisorId: 'e1', principalId: 'g1', now: expect.any(Date), sandbox: true }),
    )
    expect(r).toMatchObject({ ok: true, status: 'STAMPED', folio: 'G7', excluidas: { PRODUCTO_POR_REVISAR: 1 } })
    expect(mockAudit).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        action: 'CFDI_GLOBAL_ISSUED',
        entityId: 'g-c2',
        venueId: 'v1',
        data: expect.objectContaining({ complementariaDe: 'g1' }),
      }),
    )
  })
  it('🔴 con confirm y PRINCIPAL ⇒ `issueGlobalForEmisor({ …, desde })`', async () => {
    await call({ venueId: 'v1', tipo: 'PRINCIPAL', desde: PERIODO.desde, confirm: true })
    expect(mockIssueGlobalForEmisor).toHaveBeenCalledWith(
      expect.objectContaining({ emisorId: 'e1', now: expect.any(Date), sandbox: true, desde: PERIODO.desde }),
    )
    expect(mockEmitirComplementaria).not.toHaveBeenCalled()
  })
  it('🔴 un periodo que no es reciente o un año fuera: el motivo, sin emitir', async () => {
    mockVistaPreviaPrincipal.mockResolvedValue({ ...VISTA_PRINCIPAL, motivo: 'Ese periodo ya no se emite desde aquí; pídelo a soporte.' })
    const r = parse(await call({ venueId: 'v1', tipo: 'PRINCIPAL', desde: '2026-01-01T06:00:00.000Z', confirm: true }))
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/soporte/) })
    mockVistaPreviaComplementaria.mockResolvedValue({ ...VISTA_COMPLEMENTARIA, motivo: 'año fuera; pídela a soporte.' })
    expect(parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1', confirm: true }))).toMatchObject({ ok: false })
    expect(mockIssueGlobalForEmisor).not.toHaveBeenCalled()
    expect(mockEmitirComplementaria).not.toHaveBeenCalled()
  })
  it('🔴 un resultado que no se timbró sale con su estado y su motivo (ok: false)', async () => {
    mockEmitirComplementaria.mockResolvedValue({ status: 'VALIDATION_FAILED', reasons: ['no cuadra'], excluidas: {} })
    expect(parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1', confirm: true }))).toMatchObject({
      ok: false,
      status: 'VALIDATION_FAILED',
      motivo: 'no cuadra',
    })
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('🔴 COMPLEMENTARIA sin `principalCfdiId` o PRINCIPAL sin `desde` ⇒ error claro, sin consultar', async () => {
    expect(parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA' }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/principalCfdiId/),
    })
    expect(parse(await call({ venueId: 'v1', tipo: 'PRINCIPAL' }))).toMatchObject({ ok: false, error: expect.stringMatching(/desde/) })
    expect(mockVistaPreviaComplementaria).not.toHaveBeenCalled()
    expect(mockVistaPreviaPrincipal).not.toHaveBeenCalled()
  })
  it('🔴 sin `cfdi:configure` ⇒ forbidden (el error del guard), sin emitir', async () => {
    mockRequirePermission.mockImplementationOnce(() => {
      throw new Error('forbidden: cfdi:configure')
    })
    await expect(call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1', confirm: true })).rejects.toThrow(/forbidden/)
    expect(mockRequirePermission).toHaveBeenCalledWith('cfdi:configure', 'v1')
    expect(mockEmitirComplementaria).not.toHaveBeenCalled()
  })
  it('🔴 sin la facturación (feature CFDI) ⇒ planRequired', async () => {
    mockVenuesWithFeatureAccess.mockResolvedValue(new Set())
    expect(parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1' }))).toMatchObject({
      ok: false,
      planRequired: true,
      feature: 'CFDI',
    })
  })
  it('🔴 varios RFC y sin `emisorId` ⇒ pregunta cuál (sin emitir)', async () => {
    mockEmisorFindMany.mockResolvedValue([
      { id: 'e1', rfc: 'AAA010101AAA', legalName: 'Café' },
      { id: 'e2', rfc: 'BBB010101BBB', legalName: 'Panadería' },
    ])
    const r = parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1', confirm: true }))
    expect(r).toMatchObject({ needsInput: true, field: 'emisorId' })
    expect(r.opciones.map((o: any) => o.emisorId)).toEqual(['e1', 'e2'])
    expect(mockEmitirComplementaria).not.toHaveBeenCalled()
  })
})

describe('emit_global_invoice — ronda 1 (I3, m4 de la revisión de la T11)', () => {
  it.each(['TIMBRADA', 'CANCELADA'])(
    '🔴 I3: PRINCIPAL de un periodo %s ⇒ error con su `principalCfdiId` (usa COMPLEMENTARIA), sin vista previa ni emisión, también con confirm',
    async estado => {
      mockVistaPreviaPrincipal.mockResolvedValue({ ...VISTA_PRINCIPAL, estado, cfdiId: 'g-mayo', ventas: { n: 3, completo: true } })
      for (const confirm of [undefined, true]) {
        const r = parse(await call({ venueId: 'v1', tipo: 'PRINCIPAL', desde: PERIODO.desde, ...(confirm ? { confirm } : {}) }))
        expect(r).toEqual({
          ok: false,
          error:
            'Ese periodo ya tiene su factura global principal; para las ventas que no entraron usa tipo COMPLEMENTARIA con principalCfdiId.',
          principalCfdiId: 'g-mayo',
        })
      }
      expect(mockIssueGlobalForEmisor).not.toHaveBeenCalled()
      expect(mockAudit).not.toHaveBeenCalled()
    },
  )
  it('🔴 m4: una complementaria que YA estaba timbrada no se audita ni se reporta como emisión nueva', async () => {
    mockEmitirComplementaria.mockResolvedValue({ ...TIMBRADA, yaTimbrada: true })
    const r = parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1', confirm: true }))
    expect(r).toMatchObject({
      ok: true,
      status: 'STAMPED',
      yaTimbrada: true,
      folio: 'G7',
      message: expect.stringMatching(/ya estaba timbrada/),
    })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('emit_global_invoice — el paso 2 a través del catálogo (token de confirmación)', () => {
  async function conectado() {
    const server = new McpServer({ name: 'emit-global-test', version: '1' })
    configureToolCatalog(server, { ...scope, scopes: ['mcp:read', 'mcp:write'] } as McpScope)
    registerCfdiTools(server, scope)
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return {
      call: async (args: Record<string, unknown>) =>
        JSON.parse(((await client.callTool({ name: 'emit_global_invoice', arguments: args })).content as Array<{ text: string }>)[0].text),
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }
  it('🔴 la vista previa emite un token; con él, `confirm: true` emite UNA vez; sin él, nada', async () => {
    const c = await conectado()
    try {
      const args = { venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1' }
      expect(await c.call({ ...args, confirm: true })).toMatchObject({ needsInput: true, field: 'confirmationToken' })
      expect(mockEmitirComplementaria).not.toHaveBeenCalled()
      const vista = await c.call(args)
      expect(vista.confirmationToken).toEqual(expect.any(String))
      expect(await c.call({ ...args, confirm: true, confirmationToken: vista.confirmationToken })).toMatchObject({
        ok: true,
        status: 'STAMPED',
      })
      expect(mockEmitirComplementaria).toHaveBeenCalledTimes(1)
      // El token no autoriza OTRA principal.
      expect(await c.call({ ...args, principalCfdiId: 'otra', confirm: true, confirmationToken: vista.confirmationToken })).toMatchObject({
        needsInput: true,
      })
      expect(mockEmitirComplementaria).toHaveBeenCalledTimes(1)
    } finally {
      await c.close()
    }
  })
})

// ─── C2 · T9 ronda 1 (los hermanos de I-2): con los confirmationArgs DE LA HERRAMIENTA tal cual (no los del catálogo) ───
describe('emit_global_invoice — T9 ronda 1 · por el catálogo, con los confirmationArgs de la herramienta', () => {
  it.each([
    ['COMPLEMENTARIA', { tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1' }],
    ['PRINCIPAL', { tipo: 'PRINCIPAL', desde: PERIODO.desde }],
  ])(
    'control — %s: paso 1 y paso 2 con los confirmationArgs de la herramienta y el token ⇒ emite UNA vez; alterados ⇒ no',
    async (tipo, extra) => {
      const c = await conectarPorElCatalogo(server => registerCfdiTools(server as never, scope), scope)
      try {
        const emitir = tipo === 'COMPLEMENTARIA' ? mockEmitirComplementaria : mockIssueGlobalForEmisor
        const { vista, resultado } = await pasoUnoYDos(c, 'emit_global_invoice', { venueId: 'v1', ...extra })
        expect(vista.requiresConfirmation).toBe(true)
        expect(vista.confirmationArgs).toEqual({ ...vista.confirmationArguments, confirm: true })
        expect(resultado).toMatchObject({ ok: true, status: 'STAMPED' })
        expect(emitir).toHaveBeenCalledTimes(1)
        const otro = tipo === 'COMPLEMENTARIA' ? { principalCfdiId: 'otra' } : { desde: '2026-04-01T06:00:00.000Z' }
        expect(
          await c.call('emit_global_invoice', { ...vista.confirmationArgs, ...otro, confirmationToken: vista.confirmationToken }),
        ).toMatchObject({ needsInput: true })
        expect(emitir).toHaveBeenCalledTimes(1)
      } finally {
        await c.close()
      }
    },
  )
})

// Ronda QA (hermanos): la global que quedó EN DUDA no se reporta como «El PAC rechazó el timbrado» ni con el error crudo.
describe('emit_global_invoice — ronda QA (hermanos): timbre en duda', () => {
  it('🔴 complementaria en duda ⇒ `enDuda: true` y el motivo «sin respuesta clara… no la vuelvas a emitir»', async () => {
    mockEmitirComplementaria.mockResolvedValue({
      status: 'STAMP_FAILED',
      cfdi: {
        status: 'STAMP_FAILED',
        protocoloIva: 1,
        enviadoAt: new Date('2026-10-05T18:00:00Z'),
        falloDefinitivo: false,
        lastError: 'fetch failed',
      },
      excluidas: {},
    })
    const r = parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1', confirm: true }))
    expect(r).toMatchObject({ ok: false, status: 'STAMP_FAILED', enDuda: true })
    expect(r.motivo).toMatch(/^No hubo respuesta clara del PAC: la factura global/)
    expect(r.motivo).not.toMatch(/fetch failed|rechaz/i)
  })
  it('control — un rechazo definitivo de la global sigue con el porqué del PAC', async () => {
    mockEmitirComplementaria.mockResolvedValue({
      status: 'STAMP_FAILED',
      cfdi: {
        ...{
          status: 'STAMP_FAILED',
          protocoloIva: 1,
          enviadoAt: new Date('2026-10-05T18:00:00Z'),
          falloDefinitivo: false,
          lastError: 'fetch failed',
        },
        falloDefinitivo: true,
        lastError: 'CFDI40999 rechazo',
      },
      excluidas: {},
    })
    const r = parse(await call({ venueId: 'v1', tipo: 'COMPLEMENTARIA', principalCfdiId: 'g1', confirm: true }))
    expect(r).toMatchObject({ ok: false, motivo: 'CFDI40999 rechazo' })
    expect(r).not.toHaveProperty('enDuda')
  })
})
