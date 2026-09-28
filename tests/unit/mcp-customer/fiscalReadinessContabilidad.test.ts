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
import { instrumentTools } from '@/mcp/instrument'
import type { McpScope } from '@/mcp/scope'
import { contabilidadPausadaError, MOTIVO_CONTABILIDAD_IVA_MIXTO } from '@/services/fiscal/exclusionContable'

const mockReadiness = jest.fn()
const mockCreateManual = jest.fn()
const mockClosePeriod = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: jest.fn(), requirePermission: jest.fn() }) }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn(async () => null) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/fiscal/fiscalReadiness.service', () => ({ getFiscalReadiness: (...a: unknown[]) => mockReadiness(...(a as [])) }))
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
    expect(out).toEqual({ ok: true, needsFiscalSetup: true, mensaje: 'Este local aún no tiene RFC/emisor fiscal configurado.' })
    expect(findOrg).not.toHaveBeenCalled()
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
