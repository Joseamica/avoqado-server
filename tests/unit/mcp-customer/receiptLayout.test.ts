/**
 * Las tools del MCP para el diseño del ticket en papel.
 *
 * 🔴 Lo que estas pruebas fijan, y ninguna es cosmética:
 *
 *  1. Leer exige `receipt-layout:read` y escribir `receipt-layout:manage` — ninguno lo tiene
 *     un rol de piso, y MANAGER tampoco (sí tiene `printers:manage`, que es otra cosa).
 *  2. Escribir es de DOS PASOS: la primera llamada no guarda nada.
 *  3. `requireWriteScopeAlways` corta una conexión de sólo lectura aunque la bandera de
 *     despliegue esté apagada — el ticket es lo que se le entrega a cada cliente.
 *  4. Un diseño que rompe el candado de integridad se rechaza ANTES de preguntar.
 *  5. La lectura devuelve el ticket EN TEXTO, no una lista de bloques ilegible.
 */
import { registerReceiptLayoutTools } from '../../../src/mcp/tools/receiptLayout'
import type { McpScope } from '../../../src/mcp/scope'
import { CANONICAL_LAYOUT } from '../../../src/services/shared/receiptLayout'

const mockGet = jest.fn()
const mockPut = jest.fn()
const mockAudit = jest.fn()
const mockWriteScope = jest.fn()
const permisosPedidos: string[] = []

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'ajeno') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      permisosPedidos.push(perm)
      if (v === 'sin-permiso') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({
  requireWriteScopeAlways: (...a: unknown[]) => mockWriteScope(...(a as [])),
}))
jest.mock('@/services/dashboard/receiptLayout/receiptLayout.service', () => ({
  getReceiptLayout: (...a: unknown[]) => mockGet(...(a as [])),
  putReceiptLayout: (...a: unknown[]) => mockPut(...(a as [])),
}))
jest.mock('@/services/dashboard/receiptLayout/readiness.service', () => ({
  getReceiptReadiness: jest.fn().mockResolvedValue({ fiscalEmisor: false, logo: false }),
  getReceiptDevices: jest
    .fn()
    .mockResolvedValue({ supporting: 0, notSupporting: [{ name: 'Caja 1', platform: 'POS_ANDROID', appVersion: null }] }),
  cargarVenueInfo: jest.fn().mockResolvedValue({
    name: 'Testarudo Cafe',
    address: null,
    city: null,
    state: null,
    zipCode: null,
    phone: null,
    hasLogo: false,
    fiscalEmisors: [],
    principalEmisorId: null,
    legacy: { legalName: null, rfc: null },
  }),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (tool: string, args: Record<string, unknown>) => handlers.get(tool)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const raw = () => JSON.parse(JSON.stringify(CANONICAL_LAYOUT)) as unknown[]

beforeAll(() => {
  registerReceiptLayoutTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  // 🔴 `clearAllMocks` borra las LLAMADAS, no las IMPLEMENTACIONES: sin esto, el mock que
  // lanza en la prueba del candado se filtra a la siguiente y la hace fallar por otro motivo.
  mockWriteScope.mockReset()
  permisosPedidos.length = 0
  mockGet.mockResolvedValue({ blocks: CANONICAL_LAYOUT, schemaVersion: 1, revision: 0, source: 'default', updatedAt: null })
  mockPut.mockResolvedValue({ blocks: CANONICAL_LAYOUT, schemaVersion: 1, revision: 1, source: 'custom', updatedAt: new Date() })
})

describe('receipt_layout (lectura)', () => {
  it('🔴 exige receipt-layout:read', async () => {
    await call('receipt_layout', { venueId: 'v1' })
    expect(permisosPedidos).toEqual(['receipt-layout:read'])
  })

  it('devuelve el ticket EN TEXTO, no una lista de bloques ilegible', async () => {
    const r = parse(await call('receipt_layout', { venueId: 'v1' }))
    expect(r.ticket).toContain('Powered by Avoqado')
    expect(r.revision).toBe(0)
    expect(r.bloques).toContain('signature')
  })

  it('🔴 dice qué datos le FALTAN al negocio y qué aparatos no lo aplican todavía', async () => {
    const r = parse(await call('receipt_layout', { venueId: 'v1' }))
    expect(r.datosQueFaltan.emisorFiscal).toMatch(/FALTA/)
    expect(r.aparatos.yaLoAplican).toBe(0)
    expect(r.aparatos.todaviaNo[0]).toContain('Caja 1')
  })

  it('🔴 un venue ajeno no se puede leer', async () => {
    await expect(call('receipt_layout', { venueId: 'ajeno' })).rejects.toThrow(/out of scope/)
  })
})

describe('configure_receipt_layout (escritura)', () => {
  it('🔴 exige receipt-layout:manage', async () => {
    await call('configure_receipt_layout', { venueId: 'v1', blocks: raw(), expectedRevision: 0 })
    expect(permisosPedidos).toEqual(['receipt-layout:manage'])
  })

  it('🔴 la PRIMERA llamada NO escribe: devuelve vista previa y pide confirmación', async () => {
    const r = parse(await call('configure_receipt_layout', { venueId: 'v1', blocks: raw(), expectedRevision: 0 }))
    expect(r.ok).toBe(false)
    expect(r.requiresConfirmation).toBe(true)
    expect(r.preview).toContain('Powered by Avoqado')
    expect(mockPut).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('con confirm:true sí escribe, con la revisión que le dieron, y deja rastro', async () => {
    const r = parse(await call('configure_receipt_layout', { venueId: 'v1', blocks: raw(), expectedRevision: 3, confirm: true }))
    expect(r.ok).toBe(true)
    expect(mockPut).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1', expectedRevision: 3, updatedById: 's1' }))
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'RECEIPT_LAYOUT_UPDATED', venueId: 'v1' }))
  })

  it('🔴 el candado de escritura sensible se consulta SIEMPRE, con su motivo', async () => {
    await call('configure_receipt_layout', { venueId: 'v1', blocks: raw(), expectedRevision: 0 })
    expect(mockWriteScope).toHaveBeenCalledWith(scope, 'receipt-layout:manage', expect.stringContaining('cliente'))
  })

  it('🔴 si el candado de escritura corta, NO se escribe ni se pregunta', async () => {
    mockWriteScope.mockImplementation(() => {
      throw new Error('Esta conexión es de solo lectura (falta el scope mcp:write).')
    })
    await expect(call('configure_receipt_layout', { venueId: 'v1', blocks: raw(), expectedRevision: 0, confirm: true })).rejects.toThrow(
      /solo lectura/i,
    )
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('🔴 un diseño sin un bloque obligatorio se rechaza ANTES de preguntar, con su código', async () => {
    const sinTotales = raw().filter(b => (b as { type: string }).type !== 'totals')
    const r = parse(await call('configure_receipt_layout', { venueId: 'v1', blocks: sinTotales, expectedRevision: 0, confirm: true }))
    expect(r.ok).toBe(false)
    expect(r.code).toBe('RECEIPT_LAYOUT_MISSING_BLOCK')
    expect(mockPut).not.toHaveBeenCalled()
  })

  // 🔴 FAIL-3 del full-testing del 12-sep: el MCP DESCARTABA el bloque inválido y guardaba el
  // resto con ok:true. La IA le decía al negocio «listo» sobre un texto que nunca se guardó.
  it('🔴 un bloque INVÁLIDO no se descarta en silencio: se rechaza con su posición y NO se guarda', async () => {
    const blocks = raw()
    const i = blocks.findIndex(b => (b as { type: string }).type === 'text')
    ;(blocks[i] as { lines: string[] }).lines = ['x'.repeat(60)]
    const r = parse(await call('configure_receipt_layout', { venueId: 'v1', blocks, expectedRevision: 0, confirm: true }))
    expect(r.ok).toBe(false)
    expect(r.code).toBe('RECEIPT_LAYOUT_INVALID_BLOCK')
    expect(r.index).toBe(i)
    expect(r.error).toContain(`Bloque ${i + 1}`)
    expect(mockPut).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('🔴 un tipo desconocido tampoco se descarta, ni siquiera en la vista previa', async () => {
    const r = parse(
      await call('configure_receipt_layout', { venueId: 'v1', blocks: [{ type: 'hologram' }, ...raw()], expectedRevision: 0 }),
    )
    expect(r.ok).toBe(false)
    expect(r.code).toBe('RECEIPT_LAYOUT_UNKNOWN_BLOCK')
    expect(r.index).toBe(0)
    expect(r.requiresConfirmation).toBeUndefined()
    expect(r.preview).toBeUndefined()
  })
})
