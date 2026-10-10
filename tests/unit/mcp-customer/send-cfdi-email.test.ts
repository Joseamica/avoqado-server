/**
 * 🔴 H24 (auditoría 2026-09-30): las facturas nunca llegaban al correo del cliente. El MCP puede reenviarlas, en dos pasos,
 * con el mismo permiso que el botón del dashboard.
 */
import { z } from 'zod'
import { registerCfdiTools } from '../../../src/mcp/tools/cfdi'
import type { McpScope } from '../../../src/mcp/scope'
import { conectarPorElCatalogo, pasoUnoYDos } from '../../__helpers__/mcp-por-el-catalogo'

const mockSendCfdiByEmail = jest.fn()
const mockAudit = jest.fn()
const mockVenueFilter = jest.fn((v?: string) => ({ venueId: { in: [v ?? 'v1'] } }))
const mockRequirePermission = jest.fn()
const mockVenuesWithFeatureAccess = jest.fn()
const mockCfdiFindFirst = jest.fn()
const mockCfdiFindMany = jest.fn()

jest.mock('@/services/fiscal/cfdiEmail.service', () => ({
  sendCfdiByEmail: (...a: unknown[]) => mockSendCfdiByEmail(...a),
}))
// Viven en el mismo archivo: se mockean para que registrar las tools no cargue su cadena real (Storage, PAC…).
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
      findFirst: (...a: unknown[]) => mockCfdiFindFirst(...(a as [])),
      findMany: (...a: unknown[]) => mockCfdiFindMany(...(a as [])),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 }, _count: { _all: 0 } }),
      // Ronda QA (hermanos, cambia A PROPÓSITO): `cfdi_status` cuenta aparte los timbres en duda (`timbresEnDuda`).
      count: jest.fn().mockResolvedValue(0),
    },
    fiscalEmisor: { findMany: jest.fn().mockResolvedValue([]) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const schemas = new Map<string, Record<string, z.ZodTypeAny>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('send_cfdi_email')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  const reg = {
    tool: (...a: unknown[]) => {
      handlers.set(a[0] as string, a[a.length - 1] as never)
      schemas.set(a[0] as string, a[2] as never)
    },
  } as never
  registerCfdiTools(reg, scope)
})

const A36 = {
  status: 'STAMPED',
  serie: 'A',
  folio: '36',
  uuid: 'UUID-36',
  receptorNombre: 'MAVERICKS TELECOM',
  receptorRfc: 'MTE123456AB1',
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVenuesWithFeatureAccess.mockResolvedValue(new Set(['v1']))
  mockCfdiFindFirst.mockResolvedValue(A36)
  mockSendCfdiByEmail.mockResolvedValue({ folio: 'A-36', destination: 'correo registrado del receptor' })
})

describe('send_cfdi_email', () => {
  it('sin confirm sólo muestra qué se enviará y a dónde; no envía', async () => {
    const out = parse(await call({ venueId: 'v1', cfdiId: 'c1' }))

    expect(out).toMatchObject({ ok: false, requiresConfirmation: true, confirmationArgs: { venueId: 'v1', cfdiId: 'c1', confirm: true } })
    expect(out.preview).toMatchObject({ folio: 'A-36', receptor: { nombre: 'MAVERICKS TELECOM', rfc: 'MTE123456AB1' } })
    expect(out.message).toContain('A-36')
    // OF-1 (T9 N-2): promete sólo lo que hace. Sus confirmationArgs no llevan huella y entre los pasos no se compara nada.
    expect(out.message).not.toMatch(/huella|Si algo cambia antes/)
    expect(out.message).toContain('con otros argumentos el token no sirve y no se hace nada')
    expect(mockSendCfdiByEmail).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('con confirm envía como MCP, al correo indicado, y audita', async () => {
    mockSendCfdiByEmail.mockResolvedValue({ folio: 'A-36', destination: 'finanzas@cliente.mx' })

    const out = parse(await call({ venueId: 'v1', cfdiId: 'c1', email: 'finanzas@cliente.mx', confirm: true }))

    expect(mockSendCfdiByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ cfdiId: 'c1', venueId: 'v1', origin: 'MCP', staffId: 's1', email: 'finanzas@cliente.mx' }),
    )
    expect(mockAudit).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ action: 'CFDI_EMAIL_SENT_MCP', entity: 'Cfdi', entityId: 'c1', venueId: 'v1' }),
    )
    expect(out).toEqual({ ok: true, folio: 'A-36', destino: 'finanzas@cliente.mx' })
  })

  // Codex (ronda 2): el MCP rechazaba un correo con espacios que el dashboard sí acepta, y en inglés («Invalid email»).
  it('valida el correo como el dashboard: sin espacios de más y con mensaje en español', () => {
    const schema = z.object(schemas.get('send_cfdi_email')!)

    expect(schema.parse({ venueId: 'v1', cfdiId: 'c1', email: '  a@b.mx ' }).email).toBe('a@b.mx')
    const r = schema.safeParse({ venueId: 'v1', cfdiId: 'c1', email: 'no-es-correo' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('El correo no es válido')
  })

  it('pide cfdi:issue sobre ese negocio y lo limita a tus negocios', async () => {
    await call({ venueId: 'v1', cfdiId: 'c1' })

    expect(mockVenueFilter).toHaveBeenCalledWith('v1')
    expect(mockRequirePermission).toHaveBeenCalledWith('cfdi:issue', 'v1')
    expect(mockCfdiFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', venueId: 'v1' } }))
  })

  it('🔴 factura de otro negocio: no la encuentra y no envía', async () => {
    mockCfdiFindFirst.mockResolvedValue(null)

    const out = parse(await call({ venueId: 'v1', cfdiId: 'ajena', confirm: true }))

    expect(out.ok).toBe(false)
    expect(mockSendCfdiByEmail).not.toHaveBeenCalled()
  })

  it('🔴 factura no timbrada: no envía', async () => {
    mockCfdiFindFirst.mockResolvedValue({ ...A36, status: 'STAMP_FAILED' })

    const out = parse(await call({ venueId: 'v1', cfdiId: 'c1', confirm: true }))

    expect(out.ok).toBe(false)
    expect(mockSendCfdiByEmail).not.toHaveBeenCalled()
  })

  it('sin la función de facturación: planRequired y no envía', async () => {
    mockVenuesWithFeatureAccess.mockResolvedValue(new Set())

    const out = parse(await call({ venueId: 'v1', cfdiId: 'c1', confirm: true }))

    expect(out).toMatchObject({ ok: false, planRequired: true, feature: 'CFDI' })
    expect(mockSendCfdiByEmail).not.toHaveBeenCalled()
  })

  it('si el envío falla, lo dice sin auditar un envío que no ocurrió', async () => {
    mockSendCfdiByEmail.mockRejectedValue(new Error('No se pudo enviar la factura por correo: timeout'))

    const out = parse(await call({ venueId: 'v1', cfdiId: 'c1', confirm: true }))

    expect(out).toEqual({ ok: false, error: 'No se pudo enviar la factura por correo: timeout' })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

// Codex (ronda 1 del plan de correo): «reenvía mi última factura» necesita el id de la factura, y cfdi_status no lo daba.
describe('cfdi_status', () => {
  it('cada factura reciente trae su id y su negocio, que es lo que send_cfdi_email necesita', async () => {
    mockCfdiFindMany.mockResolvedValue([
      {
        id: 'c1',
        venueId: 'v1',
        serie: 'A',
        folio: '36',
        uuid: 'U',
        totalCents: 308200,
        receptorNombre: 'MAVERICKS',
        stampedAt: new Date(),
        cancelStatus: null,
        venue: { name: 'Testarudo' },
        replacedBy: [],
      },
    ])

    const out = parse(await handlers.get('cfdi_status')!({ venueId: 'v1', limit: 5 }, {}))

    expect(mockCfdiFindMany.mock.calls[0][0].select).toMatchObject({ id: true, venueId: true })
    expect(out.recentStamped[0]).toMatchObject({ id: 'c1', venueId: 'v1' })
  })

  // C2 · Tarea 2: una cancelación enviada sin respuesta clara queda EN DUDA (estado derivado). El operador tiene que leerlo, y que no
  // la pida otra vez: pulsar «Cancelar» sobre un intento abierto sólo consulta.
  it('🔴 C2: una cancelación enviada hace 2 min y sin acuse dice «Cancelación en duda…»; una acusada dice EN_TRAMITE', async () => {
    const base = {
      venueId: 'v1',
      serie: 'A',
      uuid: 'U',
      totalCents: 11600,
      receptorNombre: 'X',
      stampedAt: new Date(),
      venue: { name: 'T' },
      replacedBy: [],
    }
    mockCfdiFindMany.mockResolvedValue([
      {
        ...base,
        id: 'duda',
        folio: '1',
        cancelStatus: 'REQUESTED',
        cancelEnviadaAt: new Date(Date.now() - 2 * 60_000),
        cancelAcusadaAt: null,
      },
      { ...base, id: 'tramite', folio: '2', cancelStatus: 'REQUESTED', cancelEnviadaAt: new Date(), cancelAcusadaAt: new Date() },
      { ...base, id: 'vigente', folio: '3', cancelStatus: null, cancelEnviadaAt: null, cancelAcusadaAt: null },
    ])
    const out = parse(await handlers.get('cfdi_status')!({ venueId: 'v1', limit: 5 }, {}))
    expect(mockCfdiFindMany.mock.calls.at(-1)![0].select).toMatchObject({ cancelEnviadaAt: true, cancelAcusadaAt: true })
    const [duda, tramite, vigente] = out.recentStamped
    expect(duda).toMatchObject({ cancelacionEnTramite: true, estadoCancelacion: 'CANCELACION_EN_DUDA' })
    expect(duda.cancelacion).toMatch(/^Cancelación en duda: la estamos confirmando con el SAT/)
    expect(tramite).toMatchObject({ cancelacionEnTramite: true, estadoCancelacion: 'EN_TRAMITE' })
    expect(tramite).not.toHaveProperty('cancelacion')
    expect(vigente).toMatchObject({ cancelacionEnTramite: false, estadoCancelacion: null })
  })

  it('🔴 C2 ronda 1 (M2): una cancelación de ANTES de C2 (REQUESTED, intento 0, sin token) es legado ⇒ EN_TRAMITE, nunca «anotada»', async () => {
    const base = {
      venueId: 'v1',
      serie: 'A',
      uuid: 'U',
      totalCents: 11600,
      receptorNombre: 'X',
      stampedAt: new Date(),
      venue: { name: 'T' },
      replacedBy: [],
    }
    mockCfdiFindMany.mockResolvedValue([
      { ...base, id: 'legado', folio: '9', cancelStatus: 'REQUESTED', cancelIntento: 0, cancelEnviadaAt: null, cancelAcusadaAt: null },
    ])
    const out = parse(await handlers.get('cfdi_status')!({ venueId: 'v1', limit: 5 }, {}))
    expect(mockCfdiFindMany.mock.calls.at(-1)![0].select).toMatchObject({ cancelIntento: true })
    expect(out.recentStamped[0]).toMatchObject({ estadoCancelacion: 'EN_TRAMITE' })
  })
})

// ─── C2 · T9 ronda 1 (los hermanos de I-2): POR EL CATÁLOGO, con los confirmationArgs de la herramienta tal cual ───
describe('send_cfdi_email — por el catálogo (token de confirmación)', () => {
  it.each([{}, { email: 'otro@cliente.mx' }])(
    'control — paso 1 y paso 2 con los confirmationArgs de la herramienta y el token ⇒ envía UNA vez (%o); alterados ⇒ no',
    async extra => {
      const c = await conectarPorElCatalogo(server => registerCfdiTools(server as never, scope), scope)
      try {
        const { vista, resultado } = await pasoUnoYDos(c, 'send_cfdi_email', { venueId: 'v1', cfdiId: 'c36', ...extra })
        expect(vista.confirmationArgs).toEqual({ ...vista.confirmationArguments, confirm: true })
        expect(resultado).toMatchObject({ ok: true })
        expect(mockSendCfdiByEmail).toHaveBeenCalledTimes(1)
        expect(mockSendCfdiByEmail).toHaveBeenCalledWith(expect.objectContaining({ cfdiId: 'c36', venueId: 'v1', ...extra }))
        const alterado = await c.call('send_cfdi_email', {
          ...vista.confirmationArgs,
          email: 'ajeno@ejemplo.mx',
          confirmationToken: vista.confirmationToken,
        })
        expect(alterado).toMatchObject({ needsInput: true, field: 'confirmationToken' })
        expect(mockSendCfdiByEmail).toHaveBeenCalledTimes(1)
      } finally {
        await c.close()
      }
    },
  )
})
