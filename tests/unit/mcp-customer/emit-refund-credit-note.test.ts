import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerCfdiTools } from '../../../src/mcp/tools/cfdi'
import { configureToolCatalog } from '../../../src/mcp/catalog'
import type { McpScope } from '../../../src/mcp/scope'
import { conectarPorElCatalogo, pasoUnoYDos } from '../../__helpers__/mcp-por-el-catalogo'

const mockStatus = jest.fn()
const mockEmit = jest.fn()
const mockVistaPreviaContrato = jest.fn()
const mockConfirmarContratoIvaIncluido = jest.fn()
const mockAudit = jest.fn()
const mockVenueFilter = jest.fn((v?: string) => ({ venueId: { in: [v ?? 'v1'] } }))
const mockRequirePermission = jest.fn()
const mockVenuesWithFeatureAccess = jest.fn()
const mockVenueFindUnique = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/services/fiscal/confirmarContratoDePrecio.service', () => ({
  vistaPreviaContrato: (...a: unknown[]) => mockVistaPreviaContrato(...(a as [])),
  confirmarContratoIvaIncluido: (...a: unknown[]) => mockConfirmarContratoIvaIncluido(...(a as [])),
}))
// El tool de nota de crédito vive en el mismo archivo — se mockea para que registrarlo no cargue
// su cadena real (Storage, PAC, etc.), aunque esta suite no llama a ese tool.
jest.mock('@/services/fiscal/cfdiCreditNote.service', () => ({
  emitRefundCreditNote: (...a: unknown[]) => mockEmit(...a),
  getRefundCreditNoteStatus: (...a: unknown[]) => mockStatus(...a),
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
  default: { venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) } },
}))
// F9: el tool loguea con `logger.error` si el servicio de confirmar lanza. `@/config/logger` ya
// está mockeado GLOBALMENTE en tests/__helpers__/setup.ts (default.error = jest.fn()) — aquí sólo
// tomamos una referencia a ESE mismo mock para poder inspeccionarlo por test.
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: (...a: unknown[]) => mockLoggerError(...(a as [])),
    warn: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  const reg = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never
  registerCfdiTools(reg, scope)
})

beforeEach(() => {
  jest.clearAllMocks()
  mockVenuesWithFeatureAccess.mockResolvedValue(new Set(['v1']))
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

const note = { id: 'n1', status: 'STAMP_FAILED', totalCents: 11600, receptorRfc: 'EKU9003173C9', receptorNombre: 'RECEPTOR CONGELADO' }
const recovery = {
  creditNote: note,
  recoveryOnly: true,
  eligibility: { eligible: false, reason: 'NO_ORIGINAL_CFDI', message: 'Original cancelada' },
  preview: null,
}
describe('emit_refund_credit_note', () => {
  it('preview de recuperación usa la nota congelada y nunca emite ni audita', async () => {
    mockStatus.mockResolvedValue(recovery)
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(JSON.stringify(out.preview)).toContain('RECEPTOR CONGELADO')
    expect(JSON.stringify(out.preview)).toContain('116')
    expect(out.message).toMatch(/consult/i)
    expect(mockEmit).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('confirmación recupera aunque original actual ya no sea elegible; lookupOnly impide recaptura', async () => {
    mockStatus.mockResolvedValue(recovery)
    mockEmit.mockResolvedValue({ status: 'STAMPED', cfdi: { ...note, uuid: 'uuid' } })
    // T9 ronda 1, cambio A PROPÓSITO: el paso 2 lleva los confirmationArgs de la vista previa (con la huella de lo que se iba a hacer).
    const vista = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    const out = parse(await call('emit_refund_credit_note', vista.confirmationArgs))
    expect(out.ok).toBe(true)
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1', refundPaymentId: 'r1', lookupOnly: true }))
    expect(mockRequirePermission).toHaveBeenCalledWith('cfdi:issue', 'v1')
    expect(mockAudit).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, true])('captura nueva mixta bloqueada con confirm=%s', async confirm => {
    mockStatus.mockResolvedValue({
      ...recovery,
      creditNote: null,
      recoveryOnly: false,
      eligibility: {
        eligible: false,
        reason: 'ORIGINAL_IVA_MIXTO',
        message: 'La factura original tiene productos con IVA distinto de 16 %.',
      },
    })
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1', confirm }))
    expect(out.reason).toBe('ORIGINAL_IVA_MIXTO')
    expect(out.error).toContain('16 %')
    expect(mockEmit).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('la feature sigue siendo obligatoria incluso para recuperar', async () => {
    mockVenuesWithFeatureAccess.mockResolvedValue(new Set())
    expect(parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1', confirm: true })).planRequired).toBe(true)
    expect(mockStatus).not.toHaveBeenCalled()
    expect(mockEmit).not.toHaveBeenCalled()
  })
})

// ─── C2 · Tarea 9: «acreditar por importe» por el MCP (dos pasos, con la huella del reparto) ───
const HUELLA = 'a'.repeat(64)
/** La vista del servidor cuando por artículos se detuvo por falta de evidencia y se ofrece «por importe». */
const sinEvidencia = {
  creditNote: null,
  recoveryOnly: false,
  eligibility: {
    eligible: false,
    reason: 'SIN_MONTO_POR_ARTICULO',
    message: 'Esta factura no registró cuánto se facturó de cada artículo, así que la nota no se puede emitir por artículos.',
  },
  preview: {
    facturaOriginal: { folio: 'F12', uuid: 'UUID-1', totalCents: 25800 },
    receptor: { rfc: 'EKU9003173C9', nombre: 'ESCUELA KEMPER' },
    amountToCreditCents: 5800,
    tipRefundCents: 0,
    alternativa: {
      modalidad: 'POR_IMPORTE',
      desglose: [
        { tratamiento: 'IVA_0', cents: 4496, baseCents: 4496, ivaCents: 0 },
        { tratamiento: 'IVA_16', cents: 1304, baseCents: 1124, ivaCents: 180 },
      ],
      redondeo: [],
      huella: HUELLA,
    },
  },
}
describe('emit_refund_credit_note — C2 · T9 · acreditar por importe', () => {
  it('🔴 sin modalidad: dice por qué no procede y OFRECE «por importe» con su reparto (sin confirmación ni emisión)', async () => {
    mockStatus.mockResolvedValue(sinEvidencia)
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out).toMatchObject({ ok: false, reason: 'SIN_MONTO_POR_ARTICULO' })
    expect(out.requiresConfirmation).toBeUndefined()
    expect(out.alternativa).toMatchObject({
      modalidad: 'POR_IMPORTE',
      importeMxn: 58,
      desglose: [
        { tratamiento: 'IVA_0', importeMxn: 44.96, baseMxn: 44.96, ivaMxn: 0 },
        { tratamiento: 'IVA_16', importeMxn: 13.04, baseMxn: 11.24, ivaMxn: 1.8 },
      ],
    })
    expect(out.sugerencia).toMatch(/modalidad: ?"?POR_IMPORTE/)
    expect(mockEmit).not.toHaveBeenCalled()
  })
  it('🔴 con modalidad y sin confirm: vista previa del reparto «por importe» y la huella en los argumentos de confirmación', async () => {
    mockStatus.mockResolvedValue(sinEvidencia)
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1', modalidad: 'POR_IMPORTE' }))
    expect(out).toMatchObject({ ok: false, requiresConfirmation: true, expectedSourceFingerprint: HUELLA })
    // T9 ronda 1 (I-2), cambio A PROPÓSITO: EXACTAMENTE lo que firma el catálogo (la entrada + la huella) y confirm; sin lookupOnly.
    expect(out.confirmationArgs).toEqual({
      venueId: 'v1',
      refundPaymentId: 'r1',
      modalidad: 'POR_IMPORTE',
      expectedSourceFingerprint: HUELLA,
      confirm: true,
    })
    expect(out.preview).toMatchObject({ modalidad: 'POR_IMPORTE', importeAcreditadoMxn: 58 })
    expect(out.preview.desglose).toHaveLength(2)
    expect(out.message).toMatch(/por importe/i)
    expect(out.message).toContain('$58.00')
    expect(out.message).toMatch(/IRREVERSIBLE/)
    // OF-1 (T9 N-2) control — ésta sí ata la huella y no hace nada si cambia: lo puede prometer.
    expect(out.message).toContain('la huella de esta vista previa')
    expect(out.message).toContain('Si algo cambia antes, no se hace nada')
    expect(mockEmit).not.toHaveBeenCalled()
  })
  it('🔴 con modalidad y confirm: emite con la modalidad y la huella, y audita la modalidad', async () => {
    mockStatus.mockResolvedValue(sinEvidencia)
    mockEmit.mockResolvedValue({ status: 'STAMPED', cfdi: { id: 'n2', uuid: 'U2', totalCents: 5800 } })
    const out = parse(
      await call('emit_refund_credit_note', {
        venueId: 'v1',
        refundPaymentId: 'r1',
        modalidad: 'POR_IMPORTE',
        expectedSourceFingerprint: HUELLA,
        confirm: true,
      }),
    )
    expect(out.ok).toBe(true)
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'v1',
        refundPaymentId: 'r1',
        modalidad: 'POR_IMPORTE',
        huellaDelReparto: HUELLA,
        lookupOnly: false,
      }),
    )
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ data: expect.objectContaining({ modalidad: 'POR_IMPORTE_ELEGIDO' }) }),
    )
  })
  it.each([
    [
      '🔴 con modalidad cuando no se ofrece (ya es elegible: por artículos con evidencia): no emite, ni con confirm',
      {
        ...sinEvidencia,
        eligibility: { eligible: true, reason: null, message: null },
        preview: { ...sinEvidencia.preview, alternativa: undefined },
      },
    ],
    [
      'control — con modalidad cuando no se ofrece (otro bloqueo: excede lo facturado): no emite, ni con confirm',
      {
        ...sinEvidencia,
        eligibility: { eligible: false, reason: 'ARTICULO_EXCEDE_LO_FACTURADO', message: 'excede' },
        preview: { ...sinEvidencia.preview, alternativa: undefined },
      },
    ],
  ])('%s', async (_n, st) => {
    mockStatus.mockResolvedValue(st)
    for (const confirm of [undefined, true]) {
      const out = parse(
        await call('emit_refund_credit_note', {
          venueId: 'v1',
          refundPaymentId: 'r1',
          modalidad: 'POR_IMPORTE',
          expectedSourceFingerprint: HUELLA,
          confirm,
        }),
      )
      expect(out.ok).toBe(false)
      expect(out.requiresConfirmation).toBeUndefined()
      expect(out.reason).toBe(st.eligibility.eligible ? 'MODALIDAD_NO_PERMITIDA' : 'ARTICULO_EXCEDE_LO_FACTURADO')
    }
    expect(mockEmit).not.toHaveBeenCalled()
  })
  it('🔴 la vista previa normal muestra el desglose por tasa, el redondeo y si la original es una global', async () => {
    mockStatus.mockResolvedValue({
      ...sinEvidencia,
      eligibility: { eligible: true, reason: null, message: null },
      preview: {
        ...sinEvidencia.preview,
        facturaOriginal: { folio: 'G7', uuid: 'UUID-G', totalCents: 31800, esGlobal: true },
        alternativa: undefined,
        desglose: [{ tratamiento: 'IVA_16', cents: 10000, baseCents: 8621, ivaCents: 1379 }],
        redondeo: [{ tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'TICKET' }],
      },
    })
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toMatchObject({
      facturaOriginal: { folio: 'G7', esGlobal: true },
      desglose: [{ tratamiento: 'IVA_16', importeMxn: 100, baseMxn: 86.21, ivaMxn: 13.79 }],
      redondeo: [{ tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'TICKET' }],
    })
    expect(out.message).toMatch(/factura global/)
  })
})

describe('emit_refund_credit_note — C2 · T9 · el paso 2 a través del catálogo (token de confirmación)', () => {
  async function conectado() {
    const server = new McpServer({ name: 'emit-refund-test', version: '1' })
    configureToolCatalog(server, { ...scope, scopes: ['mcp:read', 'mcp:write'] } as McpScope)
    registerCfdiTools(server, scope)
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return {
      call: async (args: Record<string, unknown>) =>
        JSON.parse(
          ((await client.callTool({ name: 'emit_refund_credit_note', arguments: args })).content as Array<{ text: string }>)[0].text,
        ),
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }
  it('🔴 la vista «por importe» emite un token atado a la huella; con él, `confirm: true` emite UNA vez con esa huella; con otra huella, nada', async () => {
    mockStatus.mockResolvedValue(sinEvidencia)
    mockEmit.mockResolvedValue({ status: 'STAMPED', cfdi: { id: 'n2', uuid: 'U2', totalCents: 5800 } })
    const c = await conectado()
    try {
      const args = { venueId: 'v1', refundPaymentId: 'r1', modalidad: 'POR_IMPORTE' }
      expect(await c.call({ ...args, confirm: true })).toMatchObject({ needsInput: true, field: 'confirmationToken' })
      const vista = await c.call(args)
      expect(vista.confirmationToken).toEqual(expect.any(String))
      expect(vista.confirmationArguments).toEqual({ ...args, expectedSourceFingerprint: HUELLA })
      expect(await c.call({ ...vista.confirmationArguments, confirm: true, confirmationToken: vista.confirmationToken })).toMatchObject({
        ok: true,
      })
      expect(mockEmit).toHaveBeenCalledTimes(1)
      expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ modalidad: 'POR_IMPORTE', huellaDelReparto: HUELLA }))
      // El token no autoriza OTRA huella (otro reparto).
      expect(
        await c.call({
          ...vista.confirmationArguments,
          expectedSourceFingerprint: 'b'.repeat(64),
          confirm: true,
          confirmationToken: vista.confirmationToken,
        }),
      ).toMatchObject({ needsInput: true })
      expect(mockEmit).toHaveBeenCalledTimes(1)
    } finally {
      await c.close()
    }
  })
})

// ─── C2 · T9 ronda 1 (I-2 y los hermanos): POR EL CATÁLOGO, siguiendo los confirmationArgs de la herramienta tal cual ───
describe('emit_refund_credit_note — T9 ronda 1 · por el catálogo, con los confirmationArgs de la herramienta', () => {
  const elegible = {
    creditNote: null,
    recoveryOnly: false,
    eligibility: { eligible: true, reason: null, message: null },
    preview: {
      facturaOriginal: { folio: 'F12', uuid: 'UUID-1', totalCents: 11600 },
      receptor: { rfc: 'EKU9003173C9', nombre: 'ESCUELA KEMPER' },
      amountToCreditCents: 11600,
      tipRefundCents: 0,
      desglose: [{ tratamiento: 'IVA_16', cents: 11600, baseCents: 10000, ivaCents: 1600 }],
      redondeo: [],
    },
  }
  const conNotaFallida = { ...elegible, creditNote: { id: 'n0', status: 'VALIDATION_FAILED', totalCents: 11600 } }
  const registrar = (server: any) => registerCfdiTools(server, scope)
  let c: Awaited<ReturnType<typeof conectarPorElCatalogo>>
  beforeEach(async () => {
    c = await conectarPorElCatalogo(registrar, scope)
    mockEmit.mockResolvedValue({ status: 'STAMPED', cfdi: { id: 'n1', uuid: 'U1', totalCents: 11600 } })
  })
  afterEach(async () => c.close())

  it.each([
    ['la emisión normal', elegible, {}, { lookupOnly: false }],
    ['el REINTENTO con una nota previa fallida (antes: la vista previa en bucle)', conNotaFallida, {}, { lookupOnly: false }],
    ['la consulta de una nota enviada en duda', recovery, {}, { lookupOnly: true }],
    [
      '«por importe» (I-2: antes, needsInput)',
      sinEvidencia,
      { modalidad: 'POR_IMPORTE' },
      { modalidad: 'POR_IMPORTE', huellaDelReparto: HUELLA },
    ],
  ])('🔴 %s: paso 1 y paso 2 con los confirmationArgs de la herramienta y el token ⇒ ejecuta UNA vez', async (_n, st, extra, esperado) => {
    mockStatus.mockResolvedValue(st)
    const { vista, resultado } = await pasoUnoYDos(c, 'emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1', ...extra })
    expect(vista.requiresConfirmation).toBe(true)
    expect(vista.confirmationToken).toEqual(expect.any(String))
    expect(vista.confirmationArgs).toEqual({ ...vista.confirmationArguments, confirm: true })
    expect(vista.message).toMatch(/confirmationArgs/)
    expect(resultado).toMatchObject({ ok: true })
    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1', refundPaymentId: 'r1', ...esperado }))
  })
  it('control — con los argumentos alterados (otro reembolso, otra huella, otra modalidad), el token no sirve y no se emite nada', async () => {
    mockStatus.mockResolvedValue(sinEvidencia)
    const vista = await c.call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1', modalidad: 'POR_IMPORTE' })
    for (const cambio of [
      { refundPaymentId: 'r2' },
      { expectedSourceFingerprint: 'b'.repeat(64) },
      { modalidad: undefined },
      { lookupOnly: false },
    ])
      expect(
        await c.call('emit_refund_credit_note', { ...vista.confirmationArgs, ...cambio, confirmationToken: vista.confirmationToken }),
      ).toMatchObject({ needsInput: true, field: 'confirmationToken' })
    expect(mockEmit).not.toHaveBeenCalled()
  })
  it('🔴 si lo que se iba a hacer cambió entre la vista previa y la confirmación (consultar ⇒ capturar de nuevo), no hace nada y pide otra vista', async () => {
    mockStatus.mockResolvedValueOnce(recovery).mockResolvedValue(conNotaFallida)
    const { vista, resultado } = await pasoUnoYDos(c, 'emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' })
    expect(vista.requiresConfirmation).toBe(true)
    expect(resultado).toMatchObject({ ok: false })
    expect(resultado.error).toMatch(/vista previa/)
    expect(resultado.requiresConfirmation).toBeUndefined() // nunca una vista previa sin token (el bucle)
    expect(mockEmit).not.toHaveBeenCalled()
  })
  it('🔴 la huella de la emisión normal ata la nota previa: si aparece un intento fallido entre los pasos, no recaptura', async () => {
    mockStatus.mockResolvedValueOnce(elegible).mockResolvedValue(conNotaFallida)
    const { resultado } = await pasoUnoYDos(c, 'emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' })
    expect(resultado).toMatchObject({ ok: false })
    expect(resultado.needsInput).toBeUndefined() // el catálogo SÍ aceptó el token: lo detiene la herramienta
    expect(resultado.error).toMatch(/vista previa/)
    expect(mockEmit).not.toHaveBeenCalled()
  })
})

// ─── C2 · Tarea 10: lo que el operador lee en la vista previa (desglose por IVA, redondeo declarado, factura global) ─────────────────
describe('emit_refund_credit_note — C2 · T10 · la vista previa en palabras', () => {
  const elegible = (preview: Record<string, unknown>) => ({
    ...sinEvidencia,
    eligibility: { eligible: true, reason: null, message: null },
    preview: { ...sinEvidencia.preview, alternativa: undefined, ...preview },
  })
  it('🔴 `desglosePorIva` con base, IVA y total por tasa; el aviso del redondeo dice componente y tasa; uso G02 siempre', async () => {
    mockStatus.mockResolvedValue(
      elegible({
        facturaOriginal: { folio: 'F12', uuid: 'UUID-1', totalCents: 25800, esGlobal: false },
        amountToCreditCents: 20000,
        desglose: [{ tratamiento: 'IVA_0', cents: 20000, baseCents: 20000, ivaCents: 0 }],
        redondeo: [{ tratamiento: 'IVA_16', componente: 'BASE', cents: 1, ambito: 'FACTURA' }],
        usoCfdi: 'G02',
      }),
    )
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview.desglosePorIva).toEqual([{ tasa: '0 %', mxn: 200, baseMxn: 200, ivaMxn: 0 }])
    expect(out.preview.avisosDeRedondeo).toEqual([expect.stringMatching(/incluye 1 ¢ de redondeo del SAT en la base del 16 %/)])
    expect(out.message).toMatch(/incluye 1 ¢ de redondeo del SAT en la base del 16 %/)
    expect(out.preview.usoCfdi).toBe('G02 (Devoluciones, descuentos o bonificaciones)')
    expect(out.preview.facturaGlobal).toBe(false)
    expect(out.message).not.toMatch(/Público en General/)
  })
  it('🔴 con `esGlobal: true` ⇒ `facturaGlobal: true` y el mensaje «relacionada a la factura global … (Público en General)»', async () => {
    mockStatus.mockResolvedValue(
      elegible({
        facturaOriginal: { folio: 'G7', uuid: 'UUID-G', totalCents: 31800, esGlobal: true },
        receptor: { rfc: 'XAXX010101000', nombre: 'PUBLICO EN GENERAL' },
        desglose: [{ tratamiento: 'IVA_16', cents: 10000, baseCents: 8621, ivaCents: 1379 }],
        redondeo: [],
      }),
    )
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out.preview.facturaGlobal).toBe(true)
    expect(out.message).toMatch(/relacionada a la factura global G7 \(Público en General\)/)
    expect(out.preview.desglosePorIva).toEqual([{ tasa: '16 %', mxn: 100, baseMxn: 86.21, ivaMxn: 13.79 }])
    expect(out.preview).not.toHaveProperty('avisosDeRedondeo')
  })
  it('🔴 T8 N4: el redondeo del documento global es una COTA ⇒ «hasta N ¢ … (de la factura global)»; el del ticket lo dice', async () => {
    mockStatus.mockResolvedValue(
      elegible({
        facturaOriginal: { folio: 'G7', uuid: 'UUID-G', totalCents: 31800, esGlobal: true },
        desglose: [{ tratamiento: 'IVA_16', cents: 10000, baseCents: 8621, ivaCents: 1379 }],
        redondeo: [
          { tratamiento: 'IVA_16', componente: 'IVA', cents: 1, ambito: 'TICKET' },
          { tratamiento: 'IVA_16', componente: 'IVA', cents: 3, ambito: 'DOCUMENTO_GLOBAL' },
        ],
      }),
    )
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out.preview.avisosDeRedondeo).toEqual([
      expect.stringMatching(/incluye 1 ¢ de redondeo del SAT en el IVA del 16 % \(del ticket en la factura global\)/),
      expect.stringMatching(/incluye hasta 3 ¢ de redondeo del SAT en el IVA del 16 % \(de la factura global\)/),
    ])
  })
  it('🔴 la vista «por importe» también dice `desglosePorIva`, `facturaGlobal` y el aviso del redondeo', async () => {
    mockStatus.mockResolvedValue({
      ...sinEvidencia,
      preview: {
        ...sinEvidencia.preview,
        alternativa: {
          ...sinEvidencia.preview.alternativa,
          redondeo: [{ tratamiento: 'IVA_16', componente: 'ARTICULO', cents: 1, ambito: 'FACTURA' }],
        },
      },
    })
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1', modalidad: 'POR_IMPORTE' }))
    expect(out.preview.desglosePorIva).toEqual([
      { tasa: '0 %', mxn: 44.96, baseMxn: 44.96, ivaMxn: 0 },
      { tasa: '16 %', mxn: 13.04, baseMxn: 11.24, ivaMxn: 1.8 },
    ])
    expect(out.preview.facturaGlobal).toBe(false)
    expect(out.preview.avisosDeRedondeo).toEqual([expect.stringMatching(/incluye 1 ¢ de redondeo del SAT en un artículo del 16 %/)])
  })
  it('control — se conservan los campos de antes (`desglose`, `redondeo`, `facturaOriginal`, `usoCfdi`)', async () => {
    mockStatus.mockResolvedValue(
      elegible({
        desglose: [{ tratamiento: 'IVA_16', cents: 11600, baseCents: 10000, ivaCents: 1600 }],
        redondeo: [],
      }),
    )
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out.preview).toMatchObject({
      desglose: [{ tratamiento: 'IVA_16', importeMxn: 116, baseMxn: 100, ivaMxn: 16 }],
      redondeo: [],
      facturaOriginal: { folio: 'F12', uuid: 'UUID-1', totalMxn: 258 },
      usoCfdi: 'G02 (Devoluciones, descuentos o bonificaciones)',
    })
  })
})

// ─── C2 · Tarea 10, ronda 1 (M5 y M9) ───────────────────────────────────────────────────────────────────────────────────────────────
describe('emit_refund_credit_note — C2 · T10 ronda 1 (M5): el aviso de facturación apagada, como el panel', () => {
  const AVISO = 'La facturación de este comercio está apagada; la nota se puede emitir igual porque corrige una factura que ya existe.'
  it('🔴 la vista previa normal trae `avisoFacturacionApagada` (y el mensaje lo dice) cuando el servidor lo manda', async () => {
    mockStatus.mockResolvedValue({
      creditNote: null,
      recoveryOnly: false,
      eligibility: { eligible: true, reason: null, message: null },
      preview: {
        facturaOriginal: { folio: 'F12', uuid: 'UUID-1', totalCents: 11600 },
        receptor: { rfc: 'EKU9003173C9', nombre: 'ESCUELA KEMPER' },
        amountToCreditCents: 11600,
        tipRefundCents: 0,
        desglose: [{ tratamiento: 'IVA_16', cents: 11600, baseCents: 10000, ivaCents: 1600 }],
        redondeo: [],
        avisoFacturacionApagada: AVISO,
      },
    })
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out.preview.avisoFacturacionApagada).toBe(AVISO)
    expect(out.message).toContain(AVISO)
  })
  it('control — sin aviso del servidor no aparece el campo', async () => {
    mockStatus.mockResolvedValue({
      creditNote: null,
      recoveryOnly: false,
      eligibility: { eligible: true, reason: null, message: null },
      preview: {
        facturaOriginal: { folio: 'F12', uuid: 'UUID-1', totalCents: 11600 },
        receptor: { rfc: 'EKU9003173C9', nombre: 'ESCUELA KEMPER' },
        amountToCreditCents: 11600,
        tipRefundCents: 0,
      },
    })
    const out = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    expect(out.preview).not.toHaveProperty('avisoFacturacionApagada')
  })
})

describe('emit_refund_credit_note — C2 · T10 ronda 1 (M9): la emisión normal lleva la huella del servidor hasta los candados', () => {
  const H1 = '1'.repeat(64)
  const H2 = '2'.repeat(64)
  const elegibleCon = (huella?: string) => ({
    creditNote: null,
    recoveryOnly: false,
    eligibility: { eligible: true, reason: null, message: null },
    preview: {
      facturaOriginal: { folio: 'F12', uuid: 'UUID-1', totalCents: 11600 },
      receptor: { rfc: 'EKU9003173C9', nombre: 'ESCUELA KEMPER' },
      amountToCreditCents: 11600,
      tipRefundCents: 0,
      desglose: [{ tratamiento: 'IVA_16', cents: 11600, baseCents: 10000, ivaCents: 1600 }],
      redondeo: [],
      ...(huella ? { huella } : {}),
    },
  })
  const registrar = (server: any) => registerCfdiTools(server, scope)
  let c: Awaited<ReturnType<typeof conectarPorElCatalogo>>
  beforeEach(async () => {
    c = await conectarPorElCatalogo(registrar, scope)
    mockEmit.mockResolvedValue({ status: 'STAMPED', cfdi: { id: 'n1', uuid: 'U1', totalCents: 11600 } })
  })
  afterEach(async () => c.close())

  it('🔴 con `preview.huella` del servidor, el paso 2 la manda al servicio (que la compara bajo los candados)', async () => {
    mockStatus.mockResolvedValue(elegibleCon(H1))
    const { resultado } = await pasoUnoYDos(c, 'emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' })
    expect(resultado).toMatchObject({ ok: true })
    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ lookupOnly: false, huellaDelReparto: H1 }))
    expect(mockEmit.mock.calls[0][0]).not.toHaveProperty('modalidad')
  })
  it('🔴 la huella del servidor cambió entre los pasos (lo visible es igual) ⇒ no emite y pide otra vista previa', async () => {
    mockStatus.mockResolvedValueOnce(elegibleCon(H1)).mockResolvedValue(elegibleCon(H2))
    const { resultado } = await pasoUnoYDos(c, 'emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' })
    expect(resultado).toMatchObject({ ok: false })
    expect(resultado.error).toMatch(/vista previa/)
    expect(mockEmit).not.toHaveBeenCalled()
  })
  it('control — un servidor sin `preview.huella` (anterior) emite como siempre, sin huella', async () => {
    mockStatus.mockResolvedValue(elegibleCon())
    const { resultado } = await pasoUnoYDos(c, 'emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' })
    expect(resultado).toMatchObject({ ok: true })
    expect(mockEmit.mock.calls[0][0]).not.toHaveProperty('huellaDelReparto')
  })
})

// Ronda QA (hermanos): un timbre EN DUDA (el PAC no contestó claro) no se reporta con el error crudo ni como rechazo.
describe('emit_refund_credit_note — ronda QA (hermanos): timbre en duda', () => {
  const enDuda = {
    ...note,
    ...{
      status: 'STAMP_FAILED',
      protocoloIva: 1,
      enviadoAt: new Date('2026-10-05T18:00:00Z'),
      falloDefinitivo: false,
      lastError: 'fetch failed',
    },
  }
  const emitirCon = async (cfdi: Record<string, unknown>) => {
    mockStatus.mockResolvedValue(recovery)
    mockEmit.mockResolvedValue({ status: 'STAMP_FAILED', cfdi })
    const vista = parse(await call('emit_refund_credit_note', { venueId: 'v1', refundPaymentId: 'r1' }))
    return parse(await call('emit_refund_credit_note', vista.confirmationArgs))
  }
  it('🔴 en duda ⇒ `enDuda: true` y el texto «sin respuesta clara… no la vuelvas a emitir… consulta su estado», nunca «fetch failed»', async () => {
    const out = await emitirCon(enDuda)
    expect(out).toMatchObject({ ok: false, status: 'STAMP_FAILED', enDuda: true })
    expect(out.error).toMatch(/^No hubo respuesta clara del PAC: la nota de crédito/)
    expect(out.error).not.toMatch(/fetch failed|rechaz/i)
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('control — un rechazo definitivo sigue diciendo el porqué del PAC, sin `enDuda`', async () => {
    const out = await emitirCon({ ...enDuda, falloDefinitivo: true, lastError: 'El RFC del receptor no existe' })
    expect(out).toMatchObject({ ok: false, error: 'El RFC del receptor no existe' })
    expect(out).not.toHaveProperty('enDuda')
  })
})
