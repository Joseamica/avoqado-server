/**
 * IVA por producto, plan 4 — el MCP del cliente dice cuándo la contabilidad está PAUSADA por IVA mixto.
 *
 * Por el protocolo MCP real (McpServer + Client en memoria) y con la instrumentación de producción
 * (conexión de cliente, no superadmin), porque es la instrumentación la que decide si el mensaje de un
 * error llega tal cual al asistente o se cambia por uno genérico.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { instrumentTools } from '@/mcp/instrument'
import type { McpScope } from '@/mcp/scope'
import { contabilidadPausadaError, MOTIVO_CONTABILIDAD_IVA_MIXTO } from '@/services/fiscal/exclusionContable'
import { planGateMessage } from '@/mcp/planGate'

const mockReadiness = jest.fn()
const mockCreateManual = jest.fn()
const mockClosePeriod = jest.fn()
const mockAudit = jest.fn()
const mockEstado = jest.fn()
const mockExcluidas = jest.fn()
const mockEmisores = jest.fn()

jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: jest.fn(), requirePermission: jest.fn() }) }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn(async () => null) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/fiscal/fiscalReadiness.service', () => ({ getFiscalReadiness: (...a: unknown[]) => mockReadiness(...(a as [])) }))
// Plan 6b (D20): el estado del IVA por producto y las ventas fuera de la global se prueban en sus propios servicios.
jest.mock('@/services/fiscal/encendidoIva.service', () => ({ estadoIvaPorProducto: (...a: unknown[]) => mockEstado(...(a as [])) }))
jest.mock('@/services/fiscal/cfdiGlobal.service', () => ({ listarExcluidasDeLaGlobal: (...a: unknown[]) => mockExcluidas(...(a as [])) }))
jest.mock('@/services/fiscal/journalEntry.service', () => ({
  listEntries: jest.fn(),
  createManualEntry: (...a: unknown[]) => mockCreateManual(...(a as [])),
}))
jest.mock('@/services/fiscal/accountingPeriodLock.service', () => ({
  listPeriodLocks: jest.fn(),
  reopenPeriod: jest.fn(),
  closePeriod: (...a: unknown[]) => mockClosePeriod(...(a as [])),
}))

import { registerAccountingTools } from '@/mcp/tools/accounting'

const findOrg = (prisma as unknown as { organization: { findUnique: jest.Mock } }).organization.findUnique
const scope = { staffId: 'staff-1', activeOrg: 'org-1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope

const ivaApagado = {
  encendido: false,
  habilitadoAt: null,
  contabilidad: false,
  bloqueos: [{ codigo: 'APARATO_VIEJO', mensaje: 'Caja 2 imprime el IVA de forma incorrecta', comoArreglar: 'Actualiza la app' }],
  avisos: [],
  facturasSinSello: [],
  revisado: true,
}
const listado = {
  periodo: { meses: '09', anio: 2026 },
  estadoDelPeriodo: 'SIN_GLOBAL',
  totales: { porMotivo: { NO_APARECE: 2 }, total: 2, completo: true, revisadas: 2 },
  corregidasPendientes: null,
  ultimaCaptura: null,
  excluidas: [{ orderId: 'o1' }],
  siguiente: 'o1',
  revisadas: 1,
  globalApagada: false,
}

const readiness = (organizationId: string) => ({
  needsFiscalSetup: false,
  organizationId,
  rfc: 'TESC900101AAA',
  legalName: 'Café de Prueba',
  regimenFiscal: '601',
  checks: [{ label: 'RFC', status: 'ok', detail: 'Configurado' }],
  capabilities: { puedeFacturar: true, puedeTimbrarNomina: false, contabilidadElectronicaLista: true },
  resumen: { ok: 1, warn: 0, missing: 0 },
})

let client: Client
let server: McpServer

beforeAll(async () => {
  server = new McpServer({ name: 'accounting-test', version: '1.0.0' })
  client = new Client({ name: 'accounting-client-test', version: '1.0.0' })
  instrumentTools(server, { staffId: scope.staffId, org: scope.activeOrg, isSuperAdmin: false })
  registerAccountingTools(server, scope)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterAll(async () => {
  await client.close()
  await server.close()
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma as unknown as { fiscalEmisor: { findMany: jest.Mock } }).fiscalEmisor = { findMany: mockEmisores }
  mockEstado.mockResolvedValue(ivaApagado)
  mockEmisores.mockResolvedValue([{ id: 'e1' }])
  mockExcluidas.mockResolvedValue(listado)
  findOrg.mockImplementation(async (a: { where: { id: string } }) => ({ ivaMixtoAlgunaVez: a.where.id === 'org-marcada' }))
})

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> }
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

describe('fiscal_readiness — contabilidad pausada por IVA mixto', () => {
  it('organización marcada ⇒ pausada:true con el motivo en español, leída de la organización del RFC', async () => {
    mockReadiness.mockResolvedValue(readiness('org-marcada'))
    const out = body(await call('fiscal_readiness', { venueId: 'v1' }))
    expect(out.ok).toBe(true)
    expect(out.contabilidad).toEqual({ pausada: true, motivo: MOTIVO_CONTABILIDAD_IVA_MIXTO })
    expect(findOrg).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'org-marcada' } }))
  })

  it('organización sin marca ⇒ pausada:false, motivo:null', async () => {
    mockReadiness.mockResolvedValue(readiness('org-limpia'))
    const out = body(await call('fiscal_readiness', { venueId: 'v1' }))
    expect(out.contabilidad).toEqual({ pausada: false, motivo: null })
  })

  // REGRESIÓN — el resto de la respuesta no cambia
  it('conserva rfc, capacidades y checklist', async () => {
    mockReadiness.mockResolvedValue(readiness('org-limpia'))
    const out = body(await call('fiscal_readiness', { venueId: 'v1' }))
    expect(out).toMatchObject({
      rfc: 'TESC900101AAA',
      razonSocial: 'Café de Prueba',
      capacidades: { puedeFacturar: true, puedeTimbrarNomina: false, contabilidadElectronicaLista: true },
      checklist: [{ punto: 'RFC', estatus: 'ok', detalle: 'Configurado' }],
    })
  })

  it('sin RFC sigue respondiendo needsFiscalSetup (sin organización que consultar)', async () => {
    mockReadiness.mockResolvedValue({ needsFiscalSetup: true, organizationId: null })
    const out = body(await call('fiscal_readiness', { venueId: 'v1' }))
    // Plan 6b (Codex r1 P3-11): con Facturación pero sin emisor, el estado del IVA por producto también se ve.
    expect(out).toEqual({
      ok: true,
      needsFiscalSetup: true,
      mensaje: 'Este local aún no tiene RFC/emisor fiscal configurado.',
      ivaPorProducto: { encendido: false, bloqueos: ivaApagado.bloqueos, avisos: [], facturasSinSello: [] },
    })
    expect(findOrg).not.toHaveBeenCalled()
  })
})

describe('fiscal_readiness — IVA por producto y ventas fuera de la global (plan 6b, D20)', () => {
  it('con Facturación: el estado del IVA por producto (con la revisión completa) y las ventas fuera de la global, de su único emisor', async () => {
    mockReadiness.mockResolvedValue(readiness('org-limpia'))
    const out = body(await call('fiscal_readiness', { venueId: 'v1' }))
    expect(out.ivaPorProducto).toEqual({ encendido: false, bloqueos: ivaApagado.bloqueos, avisos: [], facturasSinSello: [] })
    expect(out.ventasFueraDeLaGlobal).toEqual({ periodo: listado.periodo, totales: listado.totales, globalApagada: false })
    expect(mockEstado).toHaveBeenCalledWith('v1', expect.any(Date), { conRevision: true })
    expect(mockEmisores).toHaveBeenCalledWith({ where: { venueId: 'v1' }, select: { id: true }, take: 2 })
    expect(mockExcluidas).toHaveBeenCalledWith({ venueId: 'v1', emisorId: 'e1', now: expect.any(Date), limite: 1 })
  })

  it('con dos o más emisores no adivina cuál: ventasFueraDeLaGlobal es null y no consulta', async () => {
    mockReadiness.mockResolvedValue(readiness('org-limpia'))
    mockEmisores.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }])
    const out = body(await call('fiscal_readiness', { venueId: 'v1' }))
    expect(out.ventasFueraDeLaGlobal).toBeNull()
    expect(out.ivaPorProducto.encendido).toBe(false)
    expect(mockExcluidas).not.toHaveBeenCalled()
  })

  it('si el listado de excluidas truena, el diagnóstico sigue: ventasFueraDeLaGlobal null y lo demás intacto', async () => {
    mockReadiness.mockResolvedValue(readiness('org-limpia'))
    mockExcluidas.mockRejectedValue(new Error('boom'))
    const out = body(await call('fiscal_readiness', { venueId: 'v1' }))
    expect(out.ok).toBe(true)
    expect(out.ventasFueraDeLaGlobal).toBeNull()
    expect(out.rfc).toBe('TESC900101AAA')
    expect(out.ivaPorProducto.bloqueos).toEqual(ivaApagado.bloqueos)
    // T9-a: la falla no se confunde con «0 o varios emisores»: queda registrada con el negocio y el motivo.
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ venueId: 'v1', error: 'boom' }))
  })

  it('Minor T9-3: si el estado del IVA por producto truena, el diagnóstico sigue: ivaPorProducto null + warn con el negocio', async () => {
    mockReadiness.mockResolvedValue(readiness('org-limpia'))
    mockEstado.mockRejectedValue(new Error('estado roto'))
    const r = await call('fiscal_readiness', { venueId: 'v1' })
    expect(r.content[0].text).toMatch(/^\{/) // la respuesta del diagnóstico, no el texto de error de la herramienta
    const out = body(r)
    expect(out.ok).toBe(true)
    expect(out.ivaPorProducto).toBeNull()
    expect(out.rfc).toBe('TESC900101AAA')
    expect(out.ventasFueraDeLaGlobal).toEqual({ periodo: listado.periodo, totales: listado.totales, globalApagada: false })
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ venueId: 'v1', error: 'estado roto' }))
  })

  it('Minor T9-3: sin emisor (needsFiscalSetup) y el estado del IVA truena ⇒ igual responde, con ivaPorProducto null', async () => {
    mockReadiness.mockResolvedValue({ needsFiscalSetup: true, organizationId: null })
    mockEstado.mockRejectedValue(new Error('estado roto'))
    const r = await call('fiscal_readiness', { venueId: 'v1' })
    expect(r.content[0].text).toMatch(/^\{/)
    const out = body(r)
    expect(out).toEqual({
      ok: true,
      needsFiscalSetup: true,
      mensaje: 'Este local aún no tiene RFC/emisor fiscal configurado.',
      ivaPorProducto: null,
    })
  })

  it('sin falla (varios emisores, o uno solo) no registra ninguna advertencia', async () => {
    mockReadiness.mockResolvedValue(readiness('org-limpia'))
    await call('fiscal_readiness', { venueId: 'v1' })
    mockEmisores.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }])
    await call('fiscal_readiness', { venueId: 'v1' })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('sin Facturación sigue pidiendo el plan y no calcula nada (el IVA por producto se ve con set_product_iva)', async () => {
    ;(planGateMessage as jest.Mock).mockResolvedValueOnce('CFDI no está activo')
    const out = body(await call('fiscal_readiness', { venueId: 'v1' }))
    expect(out).toMatchObject({ ok: false, planRequired: true, feature: 'CFDI' })
    expect(mockEstado).not.toHaveBeenCalled()
    expect(mockExcluidas).not.toHaveBeenCalled()
  })
})

describe('escrituras contables con la organización marcada: el 409 llega TAL CUAL al asistente', () => {
  it('add_journal_entry', async () => {
    mockCreateManual.mockRejectedValue(contabilidadPausadaError())
    const r = await call('add_journal_entry', {
      venueId: 'v1',
      date: '2026-09-28',
      concept: 'Ajuste',
      lines: [
        { ledgerAccountId: 'a1', debitCents: 100, creditCents: 0 },
        { ledgerAccountId: 'a2', debitCents: 0, creditCents: 100 },
      ],
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe(MOTIVO_CONTABILIDAD_IVA_MIXTO)
  })

  it('close_accounting_period (confirmado) no deja rastro de cierre', async () => {
    mockClosePeriod.mockRejectedValue(contabilidadPausadaError())
    const r = await call('close_accounting_period', { venueId: 'v1', period: '2026-08', confirm: true })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe(MOTIVO_CONTABILIDAD_IVA_MIXTO)
    expect(mockAudit).not.toHaveBeenCalled()
  })

  // CONTROL — un error inesperado SÍ se reemplaza: prueba que el pase de arriba no es un paso ciego
  it('un error interno no operacional se cambia por el mensaje genérico', async () => {
    mockClosePeriod.mockRejectedValue(new Error('Invalid `prisma.accountingPeriodLock.upsert()` invocation'))
    const r = await call('close_accounting_period', { venueId: 'v1', period: '2026-08', confirm: true })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/error interno de Avoqado/)
  })
})
