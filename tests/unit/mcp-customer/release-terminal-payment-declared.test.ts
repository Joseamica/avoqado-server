/**
 * La variante DECLARADA de `release_terminal_payment` (plan 18-sep, Task 6).
 *
 * 🔴 F1 (founder, 17-nov): desde aquí ya no se declara. «No se cobró» lo firma siempre un gerente con su PIN en la app, así
 * que con `verifiedUncharged` el MCP dice dónde se firma y no toca el cobro. Estas pruebas fijan eso y el permiso de cada acción.
 */
import { registerTerminalTools } from '../../../src/mcp/tools/terminals'
import { auditMcpWrite } from '@/mcp/audit'
import type { McpScope } from '../../../src/mcp/scope'
import { z } from 'zod'

const mockRelease = jest.fn()
const mockRequirePermission = jest.fn()
const mockRequireWrite = jest.fn()
const mockFindFirst = jest.fn()

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: { releaseUnknownRequest: (...a: unknown[]) => mockRelease(...(a as [])) },
  desenlaceCanonico: () => ({ outcome: 'UNRESOLVED', outcomeEvidence: null }),
  // La función REAL (revisión A4b, menor 4): una copia de `RELEASE_FAILURE_CODES` aquí se desviaría en silencio si la lista crece.
  fueSoltadaPorPolitica: (...a: unknown[]) => jest.requireActual('@/services/terminal-payment.service').fueSoltadaPorPolitica(...a),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({
  requireWriteScopeAlways: (...a: unknown[]) => mockRequireWrite(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminalPaymentRequest: { findFirst: (...a: unknown[]) => mockFindFirst(...(a as [])) },
    terminal: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-cashier', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('release_terminal_payment')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

function fila(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    status: 'UNKNOWN',
    terminalId: 'n860w173397',
    amountCents: 7475,
    tipCents: 0,
    orderId: 'order-1',
    senderDevice: 'tablet-1',
    createdAt: new Date(Date.now() - 26 * 60 * 1000),
    terminalReturnedAt: new Date(),
    failureCode: null,
    cancelDisposition: null,
    paymentId: null,
    resultJson: null,
    ...over,
  }
}

beforeAll(() => {
  registerTerminalTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockFindFirst.mockResolvedValue(fila())
  mockRelease.mockResolvedValue({ requestId: 'req-1', released: true, status: 'FAILED', resolution: { id: 'r1', acceptedAt: 'x' } })
})

describe('release_terminal_payment — variante declarada', () => {
  // 🔴 F1 (founder, 17-nov): «no se cobró» lo firma SIEMPRE un gerente con su PIN, y eso pasa en la app (terminal o POS). El MCP
  // ya no declara: con `verifiedUncharged` contesta dónde se firma y no toca el cobro, con o sin `confirm`, con fila o sin ella.
  const diceDondeSeFirma = (out: { ok: boolean; error?: string }) => {
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/gerente/i)
    expect(out.error).toMatch(/PIN/)
    expect(mockRelease).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  }

  it('🔴 F1: sin confirm ya no hay vista previa de declarar: dirige a la app', async () => {
    diceDondeSeFirma(parse(await call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true })))
  })

  it('🔴 F1: con confirm tampoco declara: el servicio no recibe ninguna declaración', async () => {
    diceDondeSeFirma(parse(await call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true, confirm: true })))
  })

  it('🔴 F1: una fila TIMED_OUT tampoco se declara desde aquí', async () => {
    mockFindFirst.mockResolvedValue(fila({ status: 'TIMED_OUT' }))
    diceDondeSeFirma(parse(await call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true, confirm: true })))
  })

  it('🔴 F1: una solicitud que NO existe (el POST nunca llegó) tampoco deja lápida desde aquí', async () => {
    mockFindFirst.mockResolvedValue(null)
    diceDondeSeFirma(parse(await call({ venueId: 'v1', requestId: 'req-x', verifiedUncharged: true })))
    diceDondeSeFirma(parse(await call({ venueId: 'v1', requestId: 'req-x', verifiedUncharged: true, confirm: true })))
  })

  it('🔴 sin verifiedUncharged, una fila TIMED_OUT sigue rebotando EXACTAMENTE igual que antes', async () => {
    mockFindFirst.mockResolvedValue(fila({ status: 'TIMED_OUT' }))
    const out = parse(await call({ venueId: 'v1', requestId: 'req-1', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/UNKNOWN/)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('A4b: con la ranura ya soltada (TIMED_OUT/AUTO_RELEASED) dice que la terminal está libre y que la venta sigue pendiente', async () => {
    mockFindFirst.mockResolvedValue(fila({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED' }))
    const out = parse(await call({ venueId: 'v1', requestId: 'req-1', confirm: true }))
    expect(out).toMatchObject({ ok: false, status: 'TIMED_OUT', outcome: 'UNRESOLVED', slotHeld: false })
    expect(out.error).toMatch(/terminal ya está libre.*venta sigue pendiente de confirmar/)
    expect(out.error).not.toMatch(/no se cobró|no está atorado/)
    // F1: ya no invita a declarar desde aquí; dice que lo firma un gerente con su PIN.
    expect(out.error).not.toMatch(/verifiedUncharged/)
    expect(out.error).toMatch(/gerente.*PIN/)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('🔴 pedir la declaración sigue exigiendo su permiso (el cajero ya no lo trae de fábrica)', async () => {
    await call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true, confirm: true })
    expect(mockRequirePermission).toHaveBeenCalledWith('payments:reconcile-uncharged', 'v1')
  })

  it('🔴 liberar a secas sigue pidiendo el de GERENCIA', async () => {
    await call({ venueId: 'v1', requestId: 'req-1', confirm: true })
    expect(mockRequirePermission).toHaveBeenCalledWith('tpv:update', 'v1')
  })

  it('🔴 un token de sólo lectura no puede declarar', async () => {
    mockRequireWrite.mockImplementationOnce(() => {
      throw new Error('read-only')
    })
    await expect(call({ venueId: 'v1', requestId: 'req-1', verifiedUncharged: true, confirm: true })).rejects.toThrow()
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('🔴 sin verifiedUncharged, una solicitud que no existe sigue diciendo «No encontré ese cobro»', async () => {
    mockFindFirst.mockResolvedValue(null)
    const out = parse(await call({ venueId: 'v1', requestId: 'req-x', confirm: true }))
    expect(out.error).toMatch(/No encontré ese cobro/)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('sin declaración NO se manda `declaration` al servicio', async () => {
    await call({ venueId: 'v1', requestId: 'req-1', confirm: true })
    expect((mockRelease.mock.calls[0][0] as any).declaration).toBeUndefined()
  })
})

/**
 * A6 · S6 (21-oct): soporte de Avoqado suelta LA TERMINAL (no la venta) desde el MCP, por el MISMO camino que la ruta de
 * superadmin. Sólo con `scope.isSuperAdmin` (lo resuelve el servidor, nunca un argumento) y `slotOnly: true`; pide motivo y
 * conserva el `confirm`. Un no-superadmin con `slotOnly` no obtiene nada nuevo.
 */
describe('release_terminal_payment — slotOnly de soporte (A6 · S6)', () => {
  const handlersSa = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  const scopeSa = {
    staffId: 'staff-soporte',
    activeOrg: 'o1',
    allowedVenueIds: ['v1'],
    perVenueAccess: new Map(),
    isSuperAdmin: true,
  } as McpScope
  const callSa = (args: Record<string, unknown>) => handlersSa.get('release_terminal_payment')!(args, {})
  const MOTIVO = 'la PAX se reinició a media venta'

  const formas = new Map<string, Record<string, z.ZodTypeAny>>()
  beforeAll(() => {
    registerTerminalTools(
      {
        tool: (...a: unknown[]) => {
          handlersSa.set(a[0] as string, a[a.length - 1] as never)
          formas.set(a[0] as string, a[2] as Record<string, z.ZodTypeAny>)
        },
      } as never,
      scopeSa,
    )
  })

  // Fix round 1 (revisión A6, menor 2): el motivo se mide RECORTADO, con la misma regla que la ruta REST (`trim().min(3)`). El
  // SDK del MCP valida los argumentos contra esta forma antes de llamar al handler.
  it.each([['   '], ['  a '], ['ab ']])('P1 Fix1 el motivo «%s» no pasa la validación del MCP', motivo => {
    const forma = z.object(formas.get('release_terminal_payment')!)
    expect(forma.safeParse({ venueId: 'v1', requestId: 'req-1', slotOnly: true, reason: motivo, confirm: true }).success).toBe(false)
  })
  it('P1 Fix1 un motivo válido llega recortado', () => {
    const forma = z.object(formas.get('release_terminal_payment')!)
    const r = forma.safeParse({ venueId: 'v1', requestId: 'req-1', slotOnly: true, reason: '  la PAX se reinició  ', confirm: true })
    expect(r.success && r.data.reason).toBe('la PAX se reinició')
  })
  beforeEach(() => {
    mockRelease.mockResolvedValue({ requestId: 'req-1', released: true, status: 'TIMED_OUT' })
  })

  it('P1 sin confirm: vista previa que dice que se suelta la TERMINAL y no la venta; no llama al servicio', async () => {
    const out = parse(await callSa({ venueId: 'v1', requestId: 'req-1', slotOnly: true, reason: MOTIVO }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.amount).toBe(74.75)
    expect(out.message).toMatch(/TERMINAL/)
    expect(out.message).toMatch(/venta sigue/i)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('P1 con confirm: el servicio recibe el origen de SOPORTE, el staff del scope y el motivo, sin declaración', async () => {
    const out = parse(await callSa({ venueId: 'v1', requestId: 'req-1', slotOnly: true, reason: MOTIVO, confirm: true }))
    expect(out).toMatchObject({ ok: true, released: true, status: 'TIMED_OUT' })
    const arg = mockRelease.mock.calls[0][0] as any
    expect(arg).toMatchObject({
      requestId: 'req-1',
      venueId: 'v1',
      reason: MOTIVO,
      actor: { staffId: 'staff-soporte', source: 'SUPERADMIN' },
    })
    expect(arg.declaration).toBeUndefined()
    expect(auditMcpWrite).toHaveBeenCalledWith(scopeSa, expect.objectContaining({ data: expect.objectContaining({ slotOnly: true }) }))
  })

  it('P1 sin motivo no suelta nada', async () => {
    const out = parse(await callSa({ venueId: 'v1', requestId: 'req-1', slotOnly: true, confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/motivo/i)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('P1 con rastro de dinero lo dice y no suelta', async () => {
    mockRelease.mockResolvedValue({ requestId: 'req-1', released: false, status: 'UNKNOWN', heldByMoneyEvidence: true })
    const out = parse(await callSa({ venueId: 'v1', requestId: 'req-1', slotOnly: true, reason: MOTIVO, confirm: true }))
    expect(out).toMatchObject({ ok: false, released: false, status: 'UNKNOWN' })
    expect(out.message).toMatch(/rastro/i)
  })

  it('P1 un usuario que NO es superadmin con slotOnly no obtiene la rama de soporte', async () => {
    const out = parse(await call({ venueId: 'v1', requestId: 'req-1', slotOnly: true, reason: MOTIVO, confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/soporte/i)
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('P2 slotOnly no se combina con la declaración', async () => {
    const out = parse(
      await callSa({ venueId: 'v1', requestId: 'req-1', slotOnly: true, verifiedUncharged: true, reason: MOTIVO, confirm: true }),
    )
    expect(out.ok).toBe(false)
    expect(mockRelease).not.toHaveBeenCalled()
  })
})
