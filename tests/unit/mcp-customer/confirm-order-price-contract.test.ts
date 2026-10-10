/**
 * IVA por producto, plan 2, tarea 6: `confirm_order_price_contract` — calcado del arnés de
 * `write-confirm-gating.test.ts` (mocks de guard/audit/servicio). Cubre los 4 casos del brief:
 * (a) sin confirm ⇒ vista previa, el servicio de confirmar NO se llama, sin auditoría;
 * (b) confirm:true sin version ⇒ pide la versión, no confirma;
 * (c) confirm:true completo ⇒ llama al servicio con versionVista/motivo, y audita;
 * (d) sin la feature CFDI ⇒ no llama a nada (ni siquiera la vista previa).
 *
 * B3b, Tarea 2: la vista previa trae la `huella` de la venta y confirmar la EXIGE. Con
 * confirm:true sin huella no se escribe nada: sale una vista previa nueva con su huella.
 */
import { registerCfdiTools } from '../../../src/mcp/tools/cfdi'
import type { McpScope } from '../../../src/mcp/scope'
import { conectarPorElCatalogo, pasoUnoYDos } from '../../__helpers__/mcp-por-el-catalogo'

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
  emitRefundCreditNote: jest.fn(),
  getRefundCreditNoteStatus: jest.fn(),
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
const descripciones = new Map<string, { descripcion: string; esquema: Record<string, unknown> }>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  const reg = {
    tool: (...a: unknown[]) => {
      handlers.set(a[0] as string, a[a.length - 1] as never)
      descripciones.set(a[0] as string, { descripcion: a[1] as string, esquema: a[2] as Record<string, unknown> })
    },
  } as never
  registerCfdiTools(reg, scope)
})

beforeEach(() => {
  jest.clearAllMocks()
  // clearAllMocks no quita implementaciones: una prueba que deja un mockResolvedValue no puede filtrarse a la siguiente.
  mockVistaPreviaContrato.mockReset()
  mockConfirmarContratoIvaIncluido.mockReset()
  mockVenuesWithFeatureAccess.mockResolvedValue(new Set(['v1']))
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

const PREVIEW_CONFIRMABLE = {
  orderId: 'o1',
  orderNumber: 'ORD-1',
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  totalMxn: 150.5,
  taxAmountMxn: 0,
  source: 'TPV',
  contratoActual: 'DESCONOCIDO',
  version: 3,
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  paidAmountMxn: 150.5,
  confirmable: true,
  // Opaca para el tool (Codex B3b r1 P2 #4: el servidor la emite como SHA-256 en hex); sólo se devuelve tal cual.
  huella: '9f2c4e1ab0d37c55e8f1a6b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6',
}
const HUELLA = PREVIEW_CONFIRMABLE.huella

describe('confirm_order_price_contract — confirm-gated (IVA por producto, plan 2)', () => {
  // T9 ronda 1, cambio A PROPÓSITO: el motivo se da en el PASO 1 (el catálogo firma la entrada del paso 1; uno que llega hasta el
  // paso 2 cambia lo firmado). Sin motivo, la vista previa lo pide (ver «sin motivo» abajo).
  it('(a) sin confirm ⇒ devuelve la vista previa, NO llama al servicio de confirmar, sin auditoría', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce(PREVIEW_CONFIRMABLE)

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', motivo: 'x' }))

    expect(out.requiresConfirmation).toBe(true)
    // El transporte JSON serializa `createdAt` a ISO string; el resto viaja igual, MÁS
    // `fechaLocal` (F3), que el TOOL agrega porque el servicio no conoce el timezone del venue.
    expect(out.preview).toEqual({
      ...PREVIEW_CONFIRMABLE,
      createdAt: PREVIEW_CONFIRMABLE.createdAt.toISOString(),
      fechaLocal: '01/09/2026',
    })
    expect(out.message).toMatch(/ORD-1/)
    expect(out.message).toMatch(/version: 3/)
    // B3b: la huella viaja en la vista previa y el mensaje la pide de vuelta, tal cual.
    expect(out.preview.huella).toBe(HUELLA)
    expect(out.message).toContain(HUELLA)
    // F3: PAID ⇒ «pagada $X», nunca «cobrada» a secas.
    expect(out.message).toMatch(/pagada \$150\.50/)
    expect(out.message).not.toMatch(/\bcobrada\b/)
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('(F3) venta SIN COBRAR ⇒ el mensaje dice «sin cobrar (total $X)», nunca «cobrada» ni «pagada»', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce({ ...PREVIEW_CONFIRMABLE, paymentStatus: 'PENDING', paidAmountMxn: 0 })

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', motivo: 'x' }))

    expect(out.requiresConfirmation).toBe(true)
    expect(out.message).toMatch(/sin cobrar \(total \$150\.50\)/)
    expect(out.message).not.toMatch(/\bcobrada\b/)
    expect(out.message).not.toMatch(/\bpagada\b/)
  })

  it('sin confirm, no confirmable ⇒ devuelve el motivo y tampoco llama a nada más', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce({
      ...PREVIEW_CONFIRMABLE,
      confirmable: false,
      motivo: 'Esta venta ya tiene un contrato de precio definido.',
    })

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' }))

    expect(out.ok).toBe(false)
    expect(out.error).toBe('Esta venta ya tiene un contrato de precio definido.')
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('(b) confirm:true sin version ⇒ pide la versión, no confirma', async () => {
    const out = parse(
      await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, huella: HUELLA, motivo: 'x' }),
    )

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/version/)
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('confirm:true sin motivo ⇒ pide el motivo, no confirma', async () => {
    const out = parse(
      await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, version: 3, huella: HUELLA }),
    )

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/motivo/)
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('(c) confirm:true completo ⇒ llama al servicio con versionVista/motivo y audita', async () => {
    mockConfirmarContratoIvaIncluido.mockResolvedValueOnce({ ok: true })

    const out = parse(
      await call('confirm_order_price_contract', {
        venueId: 'v1',
        orderId: 'o1',
        confirm: true,
        version: 3,
        huella: HUELLA,
        motivo: 'El cliente lo confirmó por WhatsApp.',
      }),
    )

    expect(mockConfirmarContratoIvaIncluido).toHaveBeenCalledWith({
      venueId: 'v1',
      orderId: 'o1',
      versionVista: 3,
      huellaVista: HUELLA, // tal cual, sin interpretarla
      staffId: 's1',
      motivo: 'El cliente lo confirmó por WhatsApp.',
    })
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ORDER_PRICE_CONTRACT_CONFIRMED_MCP',
        entity: 'Order',
        entityId: 'o1',
        venueId: 'v1',
        data: { motivo: 'El cliente lo confirmó por WhatsApp.', version: 3 },
      }),
    )
    expect(out.ok).toBe(true)
  })

  it('confirm:true pero el servicio rechaza (p. ej. CAMBIO_DESDE_LA_VISTA) ⇒ no audita', async () => {
    mockConfirmarContratoIvaIncluido.mockResolvedValueOnce({
      ok: false,
      code: 'CAMBIO_DESDE_LA_VISTA',
      message: 'La venta cambió desde que la revisaste. Vuelve a pedir la vista previa.',
    })

    const out = parse(
      await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, version: 3, huella: HUELLA, motivo: 'x' }),
    )

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/cambió/)
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('(d) sin la feature CFDI ⇒ no llama a nada (ni la vista previa ni el servicio de confirmar)', async () => {
    mockVenuesWithFeatureAccess.mockResolvedValueOnce(new Set())

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' }))

    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(out.feature).toBe('CFDI')
    expect(mockVistaPreviaContrato).not.toHaveBeenCalled()
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('sin la feature CFDI y con confirm:true ⇒ tampoco confirma', async () => {
    mockVenuesWithFeatureAccess.mockResolvedValueOnce(new Set())

    const out = parse(
      await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, version: 3, huella: HUELLA, motivo: 'x' }),
    )

    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
  })

  it('(F4) guarda con cfdi:configure (del dueño/OWNER o superadmin), no cfdi:issue', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce(PREVIEW_CONFIRMABLE)

    await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' })

    expect(mockRequirePermission).toHaveBeenCalledWith('cfdi:configure', 'v1')
    expect(mockRequirePermission).not.toHaveBeenCalledWith('cfdi:issue', expect.anything())
  })

  it('(F10) guardas en orden REAL: venueFilter → requirePermission(cfdi:configure) → feature CFDI', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce(PREVIEW_CONFIRMABLE)

    await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' })

    expect(mockVenueFilter).toHaveBeenCalledWith('v1')
    expect(mockRequirePermission).toHaveBeenCalledWith('cfdi:configure', 'v1')
    expect(mockVenuesWithFeatureAccess).toHaveBeenCalledWith(['v1'], 'CFDI')

    // El orden de llamada, no sólo que las tres se llamaron: si alguna se adelanta o se atrasa,
    // una guarda deja de proteger a la siguiente.
    const ordenVenueFilter = mockVenueFilter.mock.invocationCallOrder[0]
    const ordenRequirePermission = mockRequirePermission.mock.invocationCallOrder[0]
    const ordenFeatureAccess = mockVenuesWithFeatureAccess.mock.invocationCallOrder[0]
    expect(ordenVenueFilter).toBeLessThan(ordenRequirePermission)
    expect(ordenRequirePermission).toBeLessThan(ordenFeatureAccess)
  })

  it('(F9) si el servicio de confirmar LANZA (no rechaza), el tool no truena: responde ok:false y loguea con logger.error', async () => {
    mockConfirmarContratoIvaIncluido.mockRejectedValueOnce(new Error('conexión perdida a media transacción'))

    const out = parse(
      await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, version: 3, huella: HUELLA, motivo: 'x' }),
    )

    expect(out.ok).toBe(false)
    expect(typeof out.error).toBe('string')
    expect(out.error.length).toBeGreaterThan(0)
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('🔴 (B3b) confirm:true con version y motivo pero SIN huella ⇒ NO escribe: vista previa nueva con su huella', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce(PREVIEW_CONFIRMABLE)
    // Si el tool escribiera, el servicio «confirmaría»: la prueba tiene que caer por la llamada, no por un undefined.
    mockConfirmarContratoIvaIncluido.mockResolvedValue({ ok: true })

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, version: 3, motivo: 'x' }))

    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
    expect(mockVistaPreviaContrato).toHaveBeenCalledWith('v1', 'o1')
    expect(out.ok).toBe(false)
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview.huella).toBe(HUELLA)
    expect(out.message).toContain(HUELLA)
    expect(out.message).toMatch(/huella/)
  })

  it('(B3b) confirm:true sin huella y la venta ya NO es confirmable ⇒ el motivo, sin escribir', async () => {
    mockVistaPreviaContrato.mockResolvedValueOnce({
      ...PREVIEW_CONFIRMABLE,
      confirmable: false,
      motivo: 'Esta venta está cancelada; no se factura.',
    })
    mockConfirmarContratoIvaIncluido.mockResolvedValue({ ok: true })

    const out = parse(await call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', confirm: true, version: 3, motivo: 'x' }))

    expect(out).toMatchObject({ ok: false, error: 'Esta venta está cancelada; no se factura.' })
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
  })

  it('(B3b) la descripción del tool y su esquema piden la huella', () => {
    const tool = descripciones.get('confirm_order_price_contract')!
    expect(tool.descripcion).toMatch(/huella/)
    expect(Object.keys(tool.esquema)).toContain('huella')
  })
})

// ─── C2 · T9 ronda 1: rota desde el 1-oct por el catálogo (medido en la revisión, B1/B2). Ahora sigue el patrón que el catálogo entiende ───
describe('confirm_order_price_contract — T9 ronda 1 · por el catálogo (token de confirmación)', () => {
  const MOTIVO = 'El cliente lo confirmó por WhatsApp.'
  let c: Awaited<ReturnType<typeof conectarPorElCatalogo>>
  beforeEach(async () => {
    c = await conectarPorElCatalogo(server => registerCfdiTools(server as never, scope), scope)
    mockVistaPreviaContrato.mockResolvedValue(PREVIEW_CONFIRMABLE)
    mockConfirmarContratoIvaIncluido.mockResolvedValue({ ok: true })
  })
  afterEach(async () => c.close())

  it('🔴 paso 1 con el motivo y paso 2 con los confirmationArgs de la herramienta y el token ⇒ confirma UNA vez, con la versión y la huella vistas', async () => {
    const { vista, resultado } = await pasoUnoYDos(c, 'confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', motivo: MOTIVO })
    expect(vista.requiresConfirmation).toBe(true)
    expect(vista.confirmationToken).toEqual(expect.any(String))
    expect(vista.confirmationArgs).toEqual({ ...vista.confirmationArguments, confirm: true })
    expect(resultado).toMatchObject({ ok: true })
    expect(mockConfirmarContratoIvaIncluido).toHaveBeenCalledTimes(1)
    expect(mockConfirmarContratoIvaIncluido).toHaveBeenCalledWith({
      venueId: 'v1',
      orderId: 'o1',
      versionVista: 3,
      huellaVista: HUELLA,
      staffId: 's1',
      motivo: MOTIVO,
    })
  })
  it('🔴 con los argumentos alterados (otra venta, otro motivo, otra huella), el token no sirve y no confirma', async () => {
    const vista = await c.call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', motivo: MOTIVO })
    for (const cambio of [{ orderId: 'o2' }, { motivo: 'otro' }, { expectedSourceFingerprint: `3:${'0'.repeat(64)}` }])
      expect(
        await c.call('confirm_order_price_contract', { ...vista.confirmationArgs, ...cambio, confirmationToken: vista.confirmationToken }),
      ).toMatchObject({ needsInput: true, field: 'confirmationToken' })
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
  })
  it('🔴 sin motivo en el paso 1: la vista previa lo PIDE (needsInput) y no ofrece una confirmación que no podría terminar', async () => {
    const vista = await c.call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' })
    expect(vista).toMatchObject({ ok: false, needsInput: true, field: 'motivo' })
    expect(vista.requiresConfirmation).toBeUndefined()
    expect(vista.confirmationToken).toBeUndefined()
    expect(vista.preview.huella).toBe(HUELLA)
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
  })
  it('🔴 si la venta cambió entre los pasos, el servicio lo rechaza con la versión y la huella que se VIERON (no las de ahora)', async () => {
    mockConfirmarContratoIvaIncluido.mockResolvedValue({ ok: false, code: 'CAMBIO_DESDE_LA_VISTA', message: 'La venta cambió.' })
    const vista = await c.call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', motivo: MOTIVO })
    expect(vista.expectedSourceFingerprint).toBe(`3:${HUELLA}`)
    // Entre el paso 1 y el paso 2 la venta cambió (otra versión): se confirma con lo que se VIO, y el servicio lo rechaza.
    mockVistaPreviaContrato.mockResolvedValue({ ...PREVIEW_CONFIRMABLE, version: 4, huella: 'f'.repeat(64) })
    const resultado = await c.call('confirm_order_price_contract', {
      ...vista.confirmationArgs,
      confirmationToken: vista.confirmationToken,
    })
    expect(resultado).toMatchObject({ ok: false, error: 'La venta cambió.' })
    expect(mockConfirmarContratoIvaIncluido).toHaveBeenCalledWith(expect.objectContaining({ versionVista: 3, huellaVista: HUELLA }))
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

// C2 · OF-2 (T9 N-1, `task-9-rereview-1.md`): el «rodeo» viejo (version/huella sueltas en el PASO 1) con valores de una vista ANTERIOR ya no se
// confirma en silencio contra la versión fresca: se dice que la venta cambió, se enseña la vista nueva y no se da token. Y el mensaje de
// `needsInput` ya no empuja a mandar version/huella (el paso 2 los toma de confirmationArgs).
describe('confirm_order_price_contract — OF-2 · T9 N-1: el rodeo con version/huella viejas', () => {
  const MOTIVO = 'El cliente lo confirmó por WhatsApp.'
  let c: Awaited<ReturnType<typeof conectarPorElCatalogo>>
  beforeEach(async () => {
    c = await conectarPorElCatalogo(server => registerCfdiTools(server as never, scope), scope)
    mockVistaPreviaContrato.mockResolvedValue({ ...PREVIEW_CONFIRMABLE, version: 4, huella: 'f'.repeat(64) })
    mockConfirmarContratoIvaIncluido.mockResolvedValue({ ok: true })
  })
  afterEach(async () => c.close())

  it('🔴 paso 1 con la version/huella de una vista VIEJA ⇒ ok:false «la venta cambió», con la vista nueva y SIN token', async () => {
    const r = await c.call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', motivo: MOTIVO, version: 3, huella: HUELLA })
    expect(r).toMatchObject({ ok: false, preview: { version: 4, huella: 'f'.repeat(64) } })
    expect(r.error).toMatch(/cambió desde la vista previa que mandaste/)
    expect(r.requiresConfirmation).toBeUndefined()
    expect(r.confirmationToken).toBeUndefined()
    expect(mockConfirmarContratoIvaIncluido).not.toHaveBeenCalled()
  })
  it('🔴 con sólo la huella vieja (version vigente) también', async () => {
    const r = await c.call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1', motivo: MOTIVO, version: 4, huella: HUELLA })
    expect(r).toMatchObject({ ok: false })
    expect(r.confirmationToken).toBeUndefined()
  })
  it('control — el rodeo con los valores VIGENTES sigue funcionando (paso 1 ⇒ token; paso 2 confirma una vez)', async () => {
    const vista = await c.call('confirm_order_price_contract', {
      venueId: 'v1',
      orderId: 'o1',
      motivo: MOTIVO,
      version: 4,
      huella: 'f'.repeat(64),
    })
    expect(vista.requiresConfirmation).toBe(true)
    const r = await c.call('confirm_order_price_contract', { ...vista.confirmationArgs, confirmationToken: vista.confirmationToken })
    expect(r).toMatchObject({ ok: true })
    expect(mockConfirmarContratoIvaIncluido).toHaveBeenCalledTimes(1)
  })
  it('🔴 sin motivo: el mensaje ya no pide mandar version ni huella', async () => {
    const r = await c.call('confirm_order_price_contract', { venueId: 'v1', orderId: 'o1' })
    expect(r).toMatchObject({ needsInput: true, field: 'motivo' })
    expect(r.message).not.toMatch(/version:|huella:/)
    expect(r.message).toMatch(/pide la vista previa otra vez con un motivo/)
  })
})
