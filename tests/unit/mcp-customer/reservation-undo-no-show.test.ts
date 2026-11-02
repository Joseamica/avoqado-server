/**
 * D4 — `undo_no_show`: «Sí llegó» por el MCP de clientes (sólo el modo libre `/mcp`).
 *
 * Dos pasos con el token de `src/mcp/confirmation.ts`: sin token sólo enseña lo que se va a revertir (no escribe);
 * con el token de ESTOS argumentos corrige. Estas pruebas dejan el servicio de la corrección y el aviso como dobles
 * (su lógica ya tiene pruebas propias) y usan el token REAL: lo que se prueba aquí es el cableado, el permiso, el
 * plan de la reserva, la atadura del token y que ningún camino rechazado escriba.
 */
import jwt from 'jsonwebtoken'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerReservationTools } from '../../../src/mcp/tools/reservations'
import { configureToolCatalog, TOOL_EFFECTS } from '../../../src/mcp/catalog'
import { DIRECTORY_TOOLS } from '../../../src/mcp/directory/catalog'
import { issueConfirmation } from '../../../src/mcp/confirmation'
import { ConflictError } from '../../../src/errors/AppError'
import type { McpScope } from '../../../src/mcp/scope'

const mockFindFirst = jest.fn()
const mockTransaction = jest.fn()
const mockPreview = jest.fn()
const mockUndo = jest.fn()
const mockAfter = jest.fn()
const mockAudit = jest.fn()
const mockPlanGate = jest.fn()
const mockRequirePermission = jest.fn()
const TX = { tx: true }

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    reservation: { findFirst: (...a: unknown[]) => mockFindFirst(...(a as [])), findMany: jest.fn() },
    $transaction: (...a: unknown[]) => mockTransaction(...(a as [])),
  },
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v && v !== 'v1') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: ['v1'] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  createReservation: jest.fn(),
  rescheduleAppointmentReservation: jest.fn(),
  cancelReservation: jest.fn(),
  confirmReservation: jest.fn(),
  completeReservation: jest.fn(),
  markNoShow: jest.fn(),
  updateReservation: jest.fn(),
}))
jest.mock('@/services/reservation/undoNoShow.service', () => ({
  previewUndoNoShow: (...a: unknown[]) => mockPreview(...(a as [])),
  undoNoShow: (...a: unknown[]) => mockUndo(...(a as [])),
}))
jest.mock('@/services/reservation/noShowNotices.service', () => ({
  afterNoShowCorrection: (...a: unknown[]) => mockAfter(...(a as [])),
  PENDING_TEXT: {
    CLASS_UNPAID: 'Esta clase no estaba pagada: cóbrala en caja',
    CREDIT_NOT_RECONSUMED: 'No había clase que descontar: cóbrala o regálala',
    FEE_CAPTURED: 'La multa ya se cobró a la tarjeta: si corresponde, reembólsala desde el pago',
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const descriptions = new Map<string, string>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map(),
  scopes: ['mcp:read', 'mcp:write'],
} as unknown as McpScope

const RESERVATION = { id: 'r1', venueId: 'v1', status: 'NO_SHOW' }
const PLAN = {
  creditToReconsume: 1,
  clearFee: true,
  restoreDeposit: true,
  feeAmount: null as number | null,
  depositAmount: null as number | null,
  packName: null as string | null,
  pending: [] as string[],
}
/** El plan de la ventana: con montos y nombre del paquete, como lo arma el servicio. */
const PLAN_CON_MONTOS = { ...PLAN, feeAmount: 50, depositAmount: 100, packName: '5 clases de yoga' }
const NADA = { ...PLAN, creditToReconsume: 0, clearFee: false, restoreDeposit: false }
const ARGS = { venueId: 'v1', confirmationCode: 'RES-ABC' }
const call = (args: Record<string, unknown>) => handlers.get('undo_no_show')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
/** Un token tal como lo emite la vista previa, atado a {venueId, confirmationCode, reason}. */
const token = (binding: Record<string, unknown> = { venueId: 'v1', confirmationCode: 'RES-ABC', reason: null }) =>
  issueConfirmation(scope, 'undo_no_show', binding)
const nothingWritten = () => {
  expect(mockTransaction).not.toHaveBeenCalled()
  expect(mockUndo).not.toHaveBeenCalled()
  expect(mockAfter).not.toHaveBeenCalled()
  expect(mockAudit).not.toHaveBeenCalled()
}

beforeAll(() => {
  registerReservationTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as never)
        if (typeof a[1] === 'string') descriptions.set(a[0] as string, a[1])
      },
    } as never,
    scope,
  )
})

beforeEach(() => {
  jest.resetAllMocks()
  mockPlanGate.mockResolvedValue(null)
  mockFindFirst.mockResolvedValue(RESERVATION)
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX))
  mockPreview.mockResolvedValue(PLAN)
  mockUndo.mockResolvedValue({
    outcome: 'UNDONE',
    reservation: { id: 'r1' },
    plan: PLAN,
    correction: { id: 'c1', pending: [], resolvedAt: null },
  })
})

describe('undo_no_show — permiso, plan y reserva', () => {
  it('sin reservations:update se rechaza y no lee ni escribe nada', async () => {
    mockRequirePermission.mockImplementation((permission: string) => {
      if (permission === 'reservations:update') throw new Error('Missing permission reservations:update for venue v1')
    })
    await expect(call(ARGS)).rejects.toThrow('Missing permission reservations:update')
    expect(mockRequirePermission).toHaveBeenCalledWith('reservations:update', 'v1')
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockPreview).not.toHaveBeenCalled()
    nothingWritten()
  })

  it('un local fuera de tu alcance se rechaza antes de tocar la base', async () => {
    await expect(call({ venueId: 'foreign', confirmationCode: 'RES-ABC' })).rejects.toThrow('out of scope')
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  it('sin el plan de reservaciones (PRO) devuelve planRequired y no escribe', async () => {
    mockPlanGate.mockResolvedValue('Las reservaciones requieren el plan Pro')
    const out = parse(await call(ARGS))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockPlanGate).toHaveBeenCalledWith('v1', 'RESERVATIONS', 'Las reservaciones')
    expect(mockFindFirst).not.toHaveBeenCalled()
    nothingWritten()
  })

  it('un código que no existe en ese local dice que no lo encontró y no escribe', async () => {
    mockFindFirst.mockResolvedValue(null)
    const out = parse(await call(ARGS))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('RES-ABC')
    expect(mockFindFirst.mock.calls[0][0].where).toMatchObject({ venueId: { in: ['v1'] }, confirmationCode: 'RES-ABC' })
    expect(mockPreview).not.toHaveBeenCalled()
    nothingWritten()
  })
})

describe('undo_no_show — primera llamada (vista previa, sin escribir)', () => {
  it('lee el plan, devuelve un token y NO escribe', async () => {
    const out = parse(await call(ARGS))

    expect(mockPreview).toHaveBeenCalledWith(expect.anything(), 'v1', 'r1', expect.any(Date))
    expect(out.preview).toEqual(PLAN)
    expect(typeof out.confirmationToken).toBe('string')
    expect(out.expiresInSeconds).toBe(600)
    // todavía no se corrigió nada: ni ok:true (no se confunde con una escritura hecha) ni 'status' de éxito
    expect(out.ok).toBe(false)
    expect(out.requiresConfirmation).toBe(true)
    nothingWritten()
  })

  it('explica en español qué se va a revertir: clase, multa, depósito', async () => {
    const out = parse(await call(ARGS))
    expect(out.message).toContain('RES-ABC')
    expect(out.message).toMatch(/vuelve a descontar 1 clase/)
    expect(out.message).toMatch(/multa/)
    expect(out.message).toMatch(/depósito/)
    expect(out.message).toMatch(/nunca se devuelve dinero a la tarjeta/i)
    expect(out.message).toContain('confirmationToken')
  })

  it('🔴 con montos y paquete, la vista previa dice EXACTAMENTE qué se revierte (multa, depósito, clase) en pesos', async () => {
    mockPreview.mockResolvedValue(PLAN_CON_MONTOS)
    const out = parse(await call(ARGS))
    expect(out.message).toContain('Se anula la multa de $50 por no presentarse')
    expect(out.message).toContain('Sus $100 de depósito retenido vuelven a ser parte de su visita')
    expect(out.message).toContain('Se le vuelve a descontar 1 de «5 clases de yoga»')
    // el sustantivo genérico ya no hace falta cuando se sabe cuál paquete es
    expect(out.message).not.toMatch(/del paquete del cliente/)
    // la vista previa va en futuro/presente: lo pasado es sólo del «Listo:»
    expect(out.message).not.toMatch(/Se anuló|volvieron a ser|Se le volvió/)
    expect(out.preview).toEqual(PLAN_CON_MONTOS)
    nothingWritten()
  })

  it('montos con centavos salen con dos decimales y miles con coma; los enteros, sin decimales', async () => {
    mockPreview.mockResolvedValue({ ...PLAN_CON_MONTOS, feeAmount: 50.5, depositAmount: 1500 })
    const out = parse(await call(ARGS))
    expect(out.message).toContain('la multa de $50.50')
    expect(out.message).toContain('Sus $1,500 de depósito')
  })

  it('varias clases del paquete: el número va antes del nombre', async () => {
    mockPreview.mockResolvedValue({ ...PLAN_CON_MONTOS, creditToReconsume: 2 })
    const out = parse(await call(ARGS))
    expect(out.message).toContain('Se le vuelve a descontar 2 de «5 clases de yoga»')
  })

  it('sin montos ni nombre (plan de una corrección vieja) cae al texto genérico de siempre', async () => {
    mockPreview.mockResolvedValue({ creditToReconsume: 1, clearFee: true, restoreDeposit: true, pending: [] }) // sin las 3 llaves nuevas
    const out = parse(await call(ARGS))
    expect(out.message).toMatch(/vuelve a descontar 1 clase del paquete del cliente/)
    expect(out.message).toContain('Se anula la multa por no presentarse que estaba anotada')
    expect(out.message).toContain('El depósito retenido vuelve a quedar como pagado')
    expect(out.message).not.toMatch(/\$|undefined|null|NaN/)
  })

  it('con pendientes, los dice con los textos de la regla', async () => {
    mockPreview.mockResolvedValue({ ...NADA, pending: ['CLASS_UNPAID', 'CREDIT_NOT_RECONSUMED', 'FEE_CAPTURED'] })
    const out = parse(await call(ARGS))
    expect(out.message).toContain('Esta clase no estaba pagada: cóbrala en caja')
    expect(out.message).toContain('No había clase que descontar: cóbrala o regálala')
    expect(out.message).toContain('La multa ya se cobró a la tarjeta: si corresponde, reembólsala desde el pago')
    expect(out.message).not.toMatch(/vuelve a descontar/)
    nothingWritten()
  })

  it('sin clase, multa ni depósito que revertir lo dice y sólo cambia el estado', async () => {
    mockPreview.mockResolvedValue(NADA)
    const out = parse(await call(ARGS))
    expect(out.message).toMatch(/sólo cambia el estado/)
    expect(out.message).not.toMatch(/Se vuelve a descontar|Se anula la multa|depósito retenido/)
  })

  it('si la reserva no es un «No asistió» o vino de un pase, devuelve el motivo con su código y no emite token', async () => {
    mockPreview.mockRejectedValue(
      new ConflictError('Esta reserva vino de un pase (TotalPass/Wellhub); corrígela desde su app', 'NO_SHOW_UNDO_PASS_BOOKING'),
    )
    const out = parse(await call(ARGS))
    expect(out).toMatchObject({ ok: false, code: 'NO_SHOW_UNDO_PASS_BOOKING' })
    expect(out.error).toContain('pase')
    expect(out.confirmationToken).toBeUndefined()
    nothingWritten()
  })
})

describe('undo_no_show — segunda llamada (con el token)', () => {
  it('con el token de estos argumentos corrige, avisa una vez y deja rastro', async () => {
    mockUndo.mockResolvedValue({
      outcome: 'UNDONE',
      reservation: { id: 'r1' },
      plan: { ...PLAN, pending: ['CLASS_UNPAID'] },
      correction: { id: 'c1', pending: ['CLASS_UNPAID'], resolvedAt: null },
    })
    const out = parse(await call({ ...ARGS, confirmationToken: token() }))

    expect(mockPreview).not.toHaveBeenCalled()
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    // transacción normal (READ COMMITTED), nunca serializable: va sin el segundo argumento de aislamiento
    expect(mockTransaction.mock.calls[0]).toHaveLength(1)
    expect(mockUndo).toHaveBeenCalledWith(TX, {
      reservationId: 'r1',
      venueId: 'v1',
      actor: { type: 'HUMAN', staffId: 's1' },
      source: 'MCP',
      now: expect.any(Date),
      reason: undefined,
    })
    expect(mockAfter).toHaveBeenCalledTimes(1)
    expect(mockAfter).toHaveBeenCalledWith('c1')
    expect(mockAudit).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        action: 'RESERVATION_NO_SHOW_UNDONE',
        entity: 'Reservation',
        entityId: 'r1',
        venueId: 'v1',
        data: expect.objectContaining({ confirmationCode: 'RES-ABC', outcome: 'UNDONE', pending: ['CLASS_UNPAID'] }),
      }),
    )
    expect(out).toMatchObject({ ok: true, outcome: 'UNDONE', pending: ['CLASS_UNPAID'] })
    expect(out.plan).toEqual({ ...PLAN, pending: ['CLASS_UNPAID'] })
    expect(out.message).toContain('Esta clase no estaba pagada: cóbrala en caja')
  })

  it('🔴 el «Listo:» después de corregir habla en pasado y con los montos y el paquete', async () => {
    mockUndo.mockResolvedValue({
      outcome: 'UNDONE',
      reservation: { id: 'r1' },
      plan: PLAN_CON_MONTOS,
      correction: { id: 'c1', pending: [], resolvedAt: null },
    })
    const out = parse(await call({ ...ARGS, confirmationToken: token() }))
    expect(out.message).toContain('Listo: la reserva RES-ABC quedó como «Sí llegó».')
    expect(out.message).toContain('Se le volvió a descontar 1 de «5 clases de yoga»')
    expect(out.message).toContain('Se anuló la multa de $50 por no presentarse')
    expect(out.message).toContain('Sus $100 de depósito retenido volvieron a ser parte de su visita')
    expect(out.message).not.toMatch(/Se anula |vuelve a descontar|vuelven a ser|vuelve a quedar/)
    expect(out.plan).toEqual(PLAN_CON_MONTOS)
  })

  it('el «Listo:» sin montos usa el pasado genérico; sin nada que revertir dice que sólo cambió el estado', async () => {
    mockUndo.mockResolvedValue({
      outcome: 'UNDONE',
      reservation: { id: 'r1' },
      plan: PLAN, // clase, multa y depósito, pero sin montos ni nombre
      correction: { id: 'c1', pending: [], resolvedAt: null },
    })
    const generico = parse(await call({ ...ARGS, confirmationToken: token() }))
    expect(generico.message).toMatch(/Se volvió a descontar 1 clase del paquete del cliente/)
    expect(generico.message).toContain('Se anuló la multa por no presentarse que estaba anotada')
    expect(generico.message).toContain('El depósito retenido volvió a quedar como pagado')

    mockUndo.mockResolvedValue({
      outcome: 'UNDONE',
      reservation: { id: 'r1' },
      plan: NADA,
      correction: { id: 'c1', pending: [], resolvedAt: null },
    })
    const nada = parse(await call({ ...ARGS, confirmationToken: token() }))
    expect(nada.message).toMatch(/sólo cambió el estado/)
    expect(nada.message).not.toMatch(/sólo cambia el estado/)
  })

  it('el motivo se recorta y viaja a la corrección; el token de la vista previa con el motivo sin recortar sirve', async () => {
    const preview = parse(await call({ ...ARGS, reason: '  se marcó por error  ' }))
    const out = parse(await call({ ...ARGS, reason: 'se marcó por error', confirmationToken: preview.confirmationToken }))
    expect(out.ok).toBe(true)
    expect(mockUndo).toHaveBeenCalledWith(TX, expect.objectContaining({ reason: 'se marcó por error' }))
    expect(mockAudit.mock.calls[0][1].data.reason).toBe('se marcó por error')
  })

  it('un token emitido por la vista previa real sirve en la segunda llamada', async () => {
    const preview = parse(await call(ARGS))
    mockPreview.mockClear()
    const out = parse(await call({ ...ARGS, confirmationToken: preview.confirmationToken }))
    expect(out.ok).toBe(true)
    expect(mockUndo).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['otro código de reserva', { ...ARGS, confirmationCode: 'RES-OTRA' }],
    ['un motivo donde la vista previa no tenía', { ...ARGS, reason: 'nuevo' }],
  ])('el token de otros argumentos se rechaza y no escribe (%s)', async (_label, args) => {
    const out = parse(await call({ ...args, confirmationToken: token() }))
    expect(out).toMatchObject({ ok: false, code: 'NO_SHOW_UNDO_CONFIRMATION_INVALID' })
    expect(out.error).toMatch(/vista previa nueva/)
    nothingWritten()
  })

  it('el token de otra herramienta, de otra persona o basura se rechaza y no escribe', async () => {
    const otraHerramienta = issueConfirmation(scope, 'log_waste', { venueId: 'v1', confirmationCode: 'RES-ABC', reason: null })
    const otraPersona = issueConfirmation({ ...scope, staffId: 'otro' } as McpScope, 'undo_no_show', {
      venueId: 'v1',
      confirmationCode: 'RES-ABC',
      reason: null,
    })
    for (const t of [otraHerramienta, otraPersona, 'basura']) {
      const out = parse(await call({ ...ARGS, confirmationToken: t }))
      expect(out).toMatchObject({ ok: false, code: 'NO_SHOW_UNDO_CONFIRMATION_INVALID' })
    }
    nothingWritten()
  })

  it('un token vacío cuenta como «sin token»: enseña la vista previa y no escribe', async () => {
    const out = parse(await call({ ...ARGS, confirmationToken: '  ' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(mockPreview).toHaveBeenCalledTimes(1)
    nothingWritten()
  })

  it('un token vencido se rechaza y no escribe', async () => {
    const vencido = jwt.sign(
      {
        sub: 's1',
        org: 'o1',
        tool: 'undo_no_show',
        hash: jwt.decode(token(), { json: true })!.hash,
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      process.env.ACCESS_TOKEN_SECRET as string,
      { algorithm: 'HS256', audience: 'avoqado-mcp-confirmation' },
    )
    const out = parse(await call({ ...ARGS, confirmationToken: vencido }))
    expect(out).toMatchObject({ ok: false, code: 'NO_SHOW_UNDO_CONFIRMATION_INVALID' })
    nothingWritten()
  })

  it('si la reserva ya estaba corregida (respuesta perdida) devuelve lo mismo sin avisar ni auditar otra vez', async () => {
    mockUndo.mockResolvedValue({
      outcome: 'ALREADY_UNDONE',
      reservation: { id: 'r1' },
      plan: PLAN,
      correction: { id: 'c1', pending: [], resolvedAt: null },
    })
    const out = parse(await call({ ...ARGS, confirmationToken: token() }))
    expect(out).toMatchObject({ ok: true, outcome: 'ALREADY_UNDONE', pending: [] })
    expect(mockAfter).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('si el servicio rechaza (reserva de un pase), devuelve el código y no avisa ni audita', async () => {
    mockUndo.mockRejectedValue(
      new ConflictError('Esta reserva vino de un pase (TotalPass/Wellhub); corrígela desde su app', 'NO_SHOW_UNDO_PASS_BOOKING'),
    )
    const out = parse(await call({ ...ARGS, confirmationToken: token() }))
    expect(out).toMatchObject({ ok: false, code: 'NO_SHOW_UNDO_PASS_BOOKING' })
    expect(mockAfter).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('undo_no_show — descripción y catálogo', () => {
  it('la descripción dice que ESCRIBE, los dos pasos, el permiso y que nunca devuelve dinero a la tarjeta', () => {
    const d = descriptions.get('undo_no_show')!
    expect(d).toContain('This WRITES')
    expect(d).toContain('reservations:update')
    expect(d).toMatch(/WITHOUT confirmationToken/)
    expect(d).toMatch(/confirmationToken/)
    expect(d).toMatch(/NEVER refunds money to a card/)
  })

  it('es una escritura del catálogo libre y NO está en el catálogo certificado (directorio)', () => {
    expect(TOOL_EFFECTS.undo_no_show).toBe('write')
    expect(DIRECTORY_TOOLS.has('undo_no_show')).toBe(false)
  })

  it('por el catálogo real: la vista previa sale como needs_input sin escribir y el token de ahí corrige una vez', async () => {
    const server = new McpServer({ name: 'undo-no-show', version: '1' })
    configureToolCatalog(server, scope)
    registerReservationTools(server, scope)
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
      const listed = (await client.listTools()).tools.find(t => t.name === 'undo_no_show')
      expect(listed?.annotations).toMatchObject({ readOnlyHint: false })
      expect(Object.keys((listed!.inputSchema as { properties: object }).properties)).toEqual(
        expect.arrayContaining(['venueId', 'confirmationCode', 'reason', 'confirmationToken']),
      )

      const first = await client.callTool({ name: 'undo_no_show', arguments: ARGS })
      expect((first.structuredContent as { status: string }).status).toBe('needs_input')
      nothingWritten()

      const { confirmationToken } = JSON.parse((first.content as Array<{ text: string }>)[0].text)
      const second = await client.callTool({ name: 'undo_no_show', arguments: { ...ARGS, confirmationToken } })
      expect((second.structuredContent as { status: string }).status).toBe('success')
      expect(mockUndo).toHaveBeenCalledTimes(1)
      expect(mockAfter).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
