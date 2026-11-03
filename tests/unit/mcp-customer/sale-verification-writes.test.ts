import { registerSaleVerificationTools } from '../../../src/mcp/tools/saleVerifications'
import { ForbiddenError } from '../../../src/errors/AppError'
import type { McpScope } from '../../../src/mcp/scope'

const mockReview = jest.fn()
const mockReopen = jest.fn()
const mockEdit = jest.fn()
const mockSetNumbers = jest.fn()
const mockLinkingFlag = jest.fn()
const mockFindFirst = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/services/dashboard/sale-verification.org.dashboard.service', () => ({
  __esModule: true,
  reviewOrgSaleVerification: (...a: unknown[]) => mockReview(...(a as [])),
  reopenOrgSaleVerification: (...a: unknown[]) => mockReopen(...(a as [])),
  editOrgSaleVerification: (...a: unknown[]) => mockEdit(...(a as [])),
  setOrgSaleVerificationNumbers: (...a: unknown[]) => mockSetNumbers(...(a as [])),
  listOrgSaleVerifications: jest.fn(),
  getOrgSalesSummary: jest.fn(),
  getSalesByMonth: jest.fn(),
  getSalesByCity: jest.fn(),
  getSalesByStore: jest.fn(),
  getSalesBySupervisor: jest.fn(),
  getSalesByPromoter: jest.fn(),
  getSalesByPromoterDaily: jest.fn(),
  getSalesBySaleTypeWeekly: jest.fn(),
  getSalesBySimTypeWeekly: jest.fn(),
  getSalesByPromoterWeekly: jest.fn(),
  getOrgStructure: jest.fn(),
  parseRange: (a?: string, b?: string) => ({ from: a, to: b }),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true }))
jest.mock('@/services/playtelecom/linkingNumber.flag', () => ({
  isLinkingNumberEnabledForOrg: (...a: unknown[]) => mockLinkingFlag(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { saleVerification: { findFirst: (...a: unknown[]) => mockFindFirst(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  scopes: ['mcp:read', 'mcp:write'],
  perVenueAccess: new Map([['v1', { organizationId: 'o1' }]]),
} as unknown as McpScope
const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const PENDING = {
  id: 'sv1',
  status: 'PENDING',
  isPortabilidad: false,
  venueId: 'v1',
  staff: { firstName: 'Ana', lastName: 'León' },
  venue: { name: 'BAE Uno' },
  payment: { amount: 250 },
}

beforeAll(() =>
  registerSaleVerificationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => jest.clearAllMocks())

describe('review_sale_verification', () => {
  it('no confirm → preview, service not called', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'approve' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(mockReview).not.toHaveBeenCalled()
  })
  it('confirm approve → calls backend with APPROVE + audits', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    mockReview.mockResolvedValue({ status: 'COMPLETED' })
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'approve', confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockReview).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ saleVerificationId: 'sv1', reviewedById: 's1', decision: 'APPROVE' }),
    )
    expect(mockAudit).toHaveBeenCalled()
  })
  it('not PENDING with a CONFLICTING decision → guides to reopen, service not called', async () => {
    mockFindFirst.mockResolvedValue({ ...PENDING, status: 'COMPLETED' })
    const out = parse(
      await call('review_sale_verification', {
        saleVerificationId: 'sv1',
        decision: 'reject',
        reviewNotes: 'Falta la imagen de vinculación',
        confirm: true,
      }),
    )
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/reopen_sale_verification/)
    expect(mockReview).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('not PENDING but the SAME outcome already on file → idempotent ok, nothing written or audited', async () => {
    mockFindFirst.mockResolvedValue({ ...PENDING, status: 'COMPLETED' })
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'approve', confirm: true }))
    expect(out.ok).toBe(true)
    expect(out.idempotent).toBe(true)
    expect(out.status).toBe('COMPLETED')
    expect(mockReview).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('race: status moved between preview and write → service no-op is NOT audited as a write', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    mockReview.mockResolvedValue({ id: 'sv1', status: 'COMPLETED', idempotentNoOp: true })
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'approve', confirm: true }))
    expect(out.ok).toBe(true)
    expect(out.idempotent).toBe(true)
    expect(mockReview).toHaveBeenCalledTimes(1)
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('reject without reason/notes → error, service not called', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'reject', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockReview).not.toHaveBeenCalled()
  })
  it('reject con motivos pero SIN reviewNotes → error (un checkbox pelón no dice qué corregir)', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    const out = parse(
      await call('review_sale_verification', {
        saleVerificationId: 'sv1',
        decision: 'reject',
        rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'],
        confirm: true,
      }),
    )
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/mínimo 5 caracteres/i)
    expect(mockReview).not.toHaveBeenCalled()
  })
  it('reject con reviewNotes válidas → llama al backend', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    mockReview.mockResolvedValue({ status: 'FAILED' })
    const out = parse(
      await call('review_sale_verification', {
        saleVerificationId: 'sv1',
        decision: 'reject',
        reviewNotes: 'Falta la imagen de vinculación',
        confirm: true,
      }),
    )
    expect(out.ok).toBe(true)
    expect(mockReview).toHaveBeenCalledWith('o1', expect.objectContaining({ decision: 'REJECT' }))
  })
})

describe('reopen_sale_verification', () => {
  it('confirm → calls reopen with reason', async () => {
    mockFindFirst.mockResolvedValue({ ...PENDING, status: 'COMPLETED' })
    mockReopen.mockResolvedValue({ status: 'PENDING' })
    const out = parse(await call('reopen_sale_verification', { saleVerificationId: 'sv1', reason: 'documento incorrecto', confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockReopen).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ saleVerificationId: 'sv1', reopenedById: 's1', reason: 'documento incorrecto' }),
    )
  })
})

const NO_APPROVE = () => new ForbiddenError('No tienes permiso para aprobar ni rechazar ventas', 'SALE_APPROVE_FORBIDDEN')

describe('permiso sale-verifications:approve (lo revisa el servicio contra la tienda de la venta)', () => {
  it('review_sale_verification: el servicio niega → error con su mensaje y nada se audita', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    mockReview.mockRejectedValue(NO_APPROVE())
    const out = parse(await call('review_sale_verification', { saleVerificationId: 'sv1', decision: 'approve', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toBe('No tienes permiso para aprobar ni rechazar ventas')
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('edit_sale_verification con cambio de estado: el servicio niega → error con su mensaje, su código y nada se audita', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    mockEdit.mockRejectedValue(NO_APPROVE())
    const out = parse(
      await call('edit_sale_verification', { saleVerificationId: 'sv1', status: 'COMPLETED', reason: 'corrección', confirm: true }),
    )
    expect(out.ok).toBe(false)
    expect(out.error).toBe('No tienes permiso para aprobar ni rechazar ventas')
    expect(out.code).toBe('SALE_APPROVE_FORBIDDEN')
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('edit_sale_verification', () => {
  it('no fields → error', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    const out = parse(await call('edit_sale_verification', { saleVerificationId: 'sv1', reason: 'ajuste monto', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockEdit).not.toHaveBeenCalled()
  })
  it('confirm with amount → calls edit', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    mockEdit.mockResolvedValue({ status: 'PENDING' })
    const out = parse(
      await call('edit_sale_verification', { saleVerificationId: 'sv1', amount: 300, reason: 'ajuste monto', confirm: true }),
    )
    expect(out.ok).toBe(true)
    expect(mockEdit).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ saleVerificationId: 'sv1', editedById: 's1', amount: 300, reason: 'ajuste monto' }),
    )
  })
  it('status=FAILED sin reviewNotes → error, servicio no llamado', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        status: 'FAILED',
        reason: 'Documentación incompleta',
        confirm: true,
      }),
    )
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/mínimo 5 caracteres/i)
    expect(mockEdit).not.toHaveBeenCalled()
  })
  it('status=FAILED con reviewNotes → las pasa al servicio', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    mockEdit.mockResolvedValue({ status: 'FAILED' })
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        status: 'FAILED',
        reviewNotes: 'Falta la imagen de vinculación',
        reason: 'Documentación incompleta',
        confirm: true,
      }),
    )
    expect(out.ok).toBe(true)
    expect(mockEdit).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ status: 'FAILED', reviewNotes: 'Falta la imagen de vinculación' }),
    )
  })
  it('Codex R13-3 · el cobro es del protocolo de costo: el servicio rechaza con 409 y la tool contesta ok:false con el código, sin auditar como escritura — `confirm:true` no acredita otro importe', async () => {
    mockFindFirst.mockResolvedValue(PENDING)
    const rechazo = Object.assign(
      new Error('Este cobro pertenece al protocolo de costo: su importe y su forma de pago sólo cambian por reembolso'),
      {
        statusCode: 409,
        code: 'PAYMENT_PROTECTED_BY_COST_PROTOCOL',
        details: { fields: ['amount'] },
      },
    )
    mockEdit.mockRejectedValue(rechazo)
    const out = parse(
      await call('edit_sale_verification', { saleVerificationId: 'sv1', amount: 300, reason: 'ajuste monto', confirm: true }),
    )
    expect(out).toMatchObject({ ok: false, code: 'PAYMENT_PROTECTED_BY_COST_PROTOCOL' })
    expect(out.error).toMatch(/protocolo de costo/)
    expect(mockEdit).toHaveBeenCalledTimes(1)
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('edit_sale_verification — número de vinculación (camino aparte)', () => {
  const NUMBERED = { ...PENDING, isPortabilidad: true, linkingNumber: '5511112222', portedNumber: null }
  beforeEach(() => {
    mockFindFirst.mockResolvedValue(NUMBERED)
    mockLinkingFlag.mockResolvedValue(true)
  })
  const nothingWritten = () => {
    expect(mockEdit).not.toHaveBeenCalled()
    expect(mockSetNumbers).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  }

  it('sólo el número, sin confirm → vista previa de antes → después en dígitos, y nada se escribe', async () => {
    const out = parse(
      await call('edit_sale_verification', { saleVerificationId: 'sv1', linkingNumber: '55 1234-5678', reason: 'número mal capturado' }),
    )
    expect(out.requiresConfirmation).toBe(true)
    expect(out.change.numbers.linkingNumber).toEqual({ from: '5511112222', to: '5512345678' })
    expect(out.message).toContain('5511112222 → 5512345678')
    nothingWritten()
  })

  it('9 dígitos sin allowNineDigits → pregunta «Tiene 9 dígitos. ¿Guardarlo así?» y no escribe, aunque venga confirm:true', async () => {
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        linkingNumber: '551234567',
        reason: 'número mal capturado',
        confirm: true,
      }),
    )
    expect(out.ok).toBe(false)
    expect(out.requiresConfirmation).toBe(true)
    expect(out.message).toContain('Tiene 9 dígitos. ¿Guardarlo así?')
    expect(out.message).toMatch(/allowNineDigits\s*:\s*true/)
    nothingWritten()
  })

  it('sólo el número con confirm → lo guarda por el camino de números (no por la edición general) y lo audita', async () => {
    mockSetNumbers.mockResolvedValue({ id: 'sv1', linkingNumber: '5512345678', portedNumber: '5599998888' })
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        linkingNumber: '55 1234-5678',
        portedNumber: '5599998888',
        reason: 'número mal capturado',
        confirm: true,
      }),
    )
    expect(out).toMatchObject({ ok: true, saleVerificationId: 'sv1', updated: { linkingNumber: '5512345678', portedNumber: '5599998888' } })
    expect(mockSetNumbers).toHaveBeenCalledWith('o1', {
      saleVerificationId: 'sv1',
      editedById: 's1',
      linkingNumber: '55 1234-5678',
      portedNumber: '5599998888',
      allowNineDigits: undefined,
      reason: 'número mal capturado',
    })
    expect(mockEdit).not.toHaveBeenCalled()
    expect(mockAudit).toHaveBeenCalledTimes(1)
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ entity: 'SaleVerification', entityId: 'sv1', venueId: 'v1' })
  })

  it('9 dígitos con allowNineDigits:true y confirm → lo pasa al servicio', async () => {
    mockSetNumbers.mockResolvedValue({ id: 'sv1', linkingNumber: '551234567', portedNumber: null })
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        linkingNumber: '551234567',
        allowNineDigits: true,
        reason: 'número mal capturado',
        confirm: true,
      }),
    )
    expect(out.ok).toBe(true)
    expect(mockSetNumbers).toHaveBeenCalledWith('o1', expect.objectContaining({ linkingNumber: '551234567', allowNineDigits: true }))
  })

  it.each([false, true])('número + status (confirm=%s) → «Corrige el número en una edición aparte» y ninguna escritura', async confirm => {
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        linkingNumber: '5512345678',
        status: 'COMPLETED',
        reason: 'corrección completa',
        confirm,
      }),
    )
    expect(out.ok).toBe(false)
    expect(out.requiresConfirmation).toBeUndefined()
    expect(out.error).toMatch(/Corrige el número en una edición aparte/)
    nothingWritten()
  })

  it('número + amount con confirm → también se rechaza antes de escribir', async () => {
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        portedNumber: '5512345678',
        amount: 300,
        reason: 'corrección completa',
        confirm: true,
      }),
    )
    expect(out.error).toMatch(/Corrige el número en una edición aparte/)
    nothingWritten()
  })

  it('interruptor apagado → LINKING_NUMBER_DISABLED en llano, sin vista previa ni escritura', async () => {
    mockLinkingFlag.mockResolvedValue(false)
    for (const confirm of [undefined, true]) {
      const out = parse(
        await call('edit_sale_verification', {
          saleVerificationId: 'sv1',
          linkingNumber: '5512345678',
          reason: 'número mal capturado',
          confirm,
        }),
      )
      expect(out).toMatchObject({ ok: false, code: 'LINKING_NUMBER_DISABLED' })
      expect(out.error).toMatch(/no está activo/)
    }
    expect(mockLinkingFlag).toHaveBeenCalledWith('o1')
    nothingWritten()
  })

  it('pegado con +52 (12 caracteres) → INVALID_LINKING_NUMBER desde la vista previa', async () => {
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        linkingNumber: '+52 55 1234 5678',
        reason: 'número mal capturado',
      }),
    )
    expect(out).toMatchObject({ ok: false, code: 'INVALID_LINKING_NUMBER' })
    nothingWritten()
  })

  it('número portado en una venta que no es de portabilidad → NOT_PORTABILIDAD, sin escribir', async () => {
    mockFindFirst.mockResolvedValue({ ...NUMBERED, isPortabilidad: false })
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        portedNumber: '5512345678',
        reason: 'número mal capturado',
        confirm: true,
      }),
    )
    expect(out).toMatchObject({ ok: false, code: 'NOT_PORTABILIDAD' })
    nothingWritten()
  })

  it('el servicio rechaza (p. ej. carrera con el interruptor) → ok:false con su código y nada se audita', async () => {
    mockSetNumbers.mockRejectedValue(
      new ForbiddenError('El número de vinculación no está activo en esta organización', 'LINKING_NUMBER_DISABLED'),
    )
    const out = parse(
      await call('edit_sale_verification', {
        saleVerificationId: 'sv1',
        linkingNumber: '5512345678',
        reason: 'número mal capturado',
        confirm: true,
      }),
    )
    expect(out).toMatchObject({ ok: false, code: 'LINKING_NUMBER_DISABLED' })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: sin números la edición general no consulta el interruptor', async () => {
    mockEdit.mockResolvedValue({ status: 'PENDING' })
    const out = parse(
      await call('edit_sale_verification', { saleVerificationId: 'sv1', amount: 300, reason: 'ajuste monto', confirm: true }),
    )
    expect(out.ok).toBe(true)
    expect(mockLinkingFlag).not.toHaveBeenCalled()
    expect(mockSetNumbers).not.toHaveBeenCalled()
  })
})
