import type { McpScope } from '@/mcp/scope'
import { registerPaymentEffectTools } from '@/mcp/tools/paymentEffects'
import { listPaymentEffects } from '@/services/tpv/paymentEffectsRead.service'

jest.mock('@/services/tpv/paymentEffectsRead.service', () => ({ listPaymentEffects: jest.fn() }))
const mockPermission = jest.fn()
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (venue: string) => {
      if (venue !== 'own') throw new Error('out of scope')
      return { venueId: { in: [venue] } }
    },
    requirePermission: (...args: unknown[]) => mockPermission(...args),
  }),
}))

const scope = { staffId: 'staff', activeOrg: 'org', allowedVenueIds: ['own'], perVenueAccess: new Map() } as McpScope
let esquema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> | undefined
let descripcion = ''
const handler = () => {
  let call: ((input: Record<string, unknown>) => Promise<any>) | undefined
  registerPaymentEffectTools(
    {
      tool: (name: string, description: string, schema: unknown, fn: typeof call) => {
        if (name === 'list_payment_effects') {
          call = fn
          descripcion = description
          esquema = schema as typeof esquema
        }
      },
    } as never,
    scope,
  )
  expect(call).toBeDefined()
  return call!
}
beforeEach(() => {
  jest.resetAllMocks()
  ;(listPaymentEffects as jest.Mock).mockResolvedValue({ items: [], total: 0, hasMore: false, nextCursor: null })
})

describe('payment effect operator tool', () => {
  it('requires the selected venue scope and payment read permission before fetching effects', async () => {
    const call = handler()
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(listPaymentEffects).not.toHaveBeenCalled()
    mockPermission.mockImplementationOnce(() => {
      throw new Error('permission denied')
    })
    await expect(call({ venueId: 'own' })).rejects.toThrow('permission denied')
    expect(mockPermission).toHaveBeenCalledWith('payments:read', 'own')
    expect(listPaymentEffects).not.toHaveBeenCalled()
  })
  it('Codex R4 (P2): TRANSACTION_COST es un tipo consultable (la obligación de costo pendiente se ve en la cola)', async () => {
    const call = handler()
    expect(esquema!.kind.safeParse('TRANSACTION_COST').success).toBe(true)
    expect(esquema!.kind.safeParse('OTRA').success).toBe(false)
    await call({ venueId: 'own', kind: 'TRANSACTION_COST' })
    expect(listPaymentEffects).toHaveBeenCalledWith({ venueId: 'own', kind: 'TRANSACTION_COST' })
  })
  it('Ronda 2 de A3: la descripción explica los dos motivos de espera del reverso de una comisión', () => {
    handler()
    expect(descripcion).toContain('COMMISSION_AWAITS_ORIGINAL (')
    expect(descripcion).toContain('COMMISSION_AWAITS_ORIGINAL_OVERDUE (')
  })
  it('S15: list_payment_effects nombra STAMP_REVERSAL en español («Quitar el sello de una venta devuelta»), sin cambiar su entrada', () => {
    handler()
    expect(descripcion).toContain('STAMP_REVERSAL')
    expect(descripcion).toContain('Quitar el sello de una venta devuelta')
    // El filtro es el mismo de hoy: la herramienta está en el directorio certificado y su entrada no cambia.
    expect(esquema!.kind.safeParse('STAMP_REVERSAL').success).toBe(false)
  })
  it('D649: list_payment_effects nombra SUBIR_VERSION_DE_VALES en español, sin cambiar su entrada (herramienta certificada)', () => {
    handler()
    expect(descripcion).toContain('SUBIR_VERSION_DE_VALES')
    expect(descripcion).toContain('Avisar a la caja de vales de un abono devuelto')
    expect(esquema!.kind.safeParse('SUBIR_VERSION_DE_VALES').success).toBe(false)
  })
  it('exposes page metadata and passes the exact status, payment and cursor filters to the bounded service', async () => {
    const input = { venueId: 'own', status: 'DEAD_LETTER', paymentId: 'payment', limit: 1000000, cursor: 'cursor' }
    const response = await handler()(input)
    expect(listPaymentEffects).toHaveBeenCalledWith(input)
    expect(JSON.parse(response.content[0].text)).toMatchObject({ items: [], total: 0, hasMore: false, nextCursor: null })
  })
})
