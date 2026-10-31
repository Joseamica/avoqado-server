/**
 * MCP de clientes — `cancel_unpaid_order` (Amaena, 30-oct): la misma «Cancelar orden» de Cuentas por cobrar del panel.
 *   · exige mcp:write y el permiso acotado `orders:cancel-unpaid`, con el guardia REAL;
 *   · sin confirm sólo muestra la cuenta (el catálogo ata la confirmación a esa vista previa);
 *   · confirmar llama la función del panel con el autor de la conexión (ella deja la única entrada de bitácora);
 *   · lo que la función rechaza (mesa, en línea, con pagos) vuelve como respuesta, no como caída.
 */
import { StaffRole } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import { registerOrderTools } from '@/mcp/tools/orders'
import { prismaMock } from '@tests/__helpers__/setup'

const cancelarCuentaSinCobrar = jest.fn()
jest.mock('@/services/dashboard/order.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/order.dashboard.service'),
  cancelarCuentaSinCobrar: (...a: unknown[]) => cancelarCuentaSinCobrar(...a),
}))
const auditMcpWrite = jest.fn()
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => auditMcpWrite(...a) }))

const ambito = (scopes: string[], corePermissions: string[]) => ({
  staffId: 'staff-1',
  activeOrg: 'org-1',
  allowedVenueIds: ['venue-1'],
  scopes,
  perVenueAccess: new Map([
    [
      'venue-1',
      {
        userId: 'staff-1',
        venueId: 'venue-1',
        organizationId: 'org-1',
        role: StaffRole.MANAGER,
        corePermissions,
        whiteLabelEnabled: false,
        enabledFeatures: [],
        featureAccess: {},
        featureMetadata: {},
      },
    ],
  ]),
})

function tool(scopes: string[] = ['mcp:read', 'mcp:write'], corePermissions: string[] = ['orders:cancel-unpaid', 'orders:read']) {
  let handler: ((input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) | undefined
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
      if (n === 'cancel_unpaid_order') handler = h
    },
  }
  registerOrderTools(server as never, ambito(scopes, corePermissions) as never)
  if (!handler) throw new Error('la tool cancel_unpaid_order no se registró')
  return handler
}

const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)
const entrada = { venueId: 'venue-1', orderId: 'order-1', reason: 'La abrí por error' }

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.order.findFirst.mockResolvedValue({
    orderNumber: 'ORD-77',
    total: 250,
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    tableId: null,
    onlineOrder: null,
  } as any)
  cancelarCuentaSinCobrar.mockResolvedValue(undefined)
})

describe('MCP cancel_unpaid_order', () => {
  it('🔴 sin mcp:write no cancela nada', async () => {
    await expect(tool(['mcp:read'])({ ...entrada, confirm: true })).rejects.toThrow(/mcp:write/)
    expect(cancelarCuentaSinCobrar).not.toHaveBeenCalled()
  })

  it('🔴 sin el permiso orders:cancel-unpaid no cancela nada', async () => {
    await expect(tool(undefined, ['orders:read'])({ ...entrada, confirm: true })).rejects.toThrow()
    expect(cancelarCuentaSinCobrar).not.toHaveBeenCalled()
  })

  it('sin confirm sólo muestra la cuenta y pide confirmación', async () => {
    const r = json(await tool()(entrada))
    expect(r).toMatchObject({ ok: false, requiresConfirmation: true, preview: { cuenta: 'ORD-77', total: 250, motivo: 'La abrí por error' } })
    expect(cancelarCuentaSinCobrar).not.toHaveBeenCalled()
  })

  it('con confirm cancela con el autor de la conexión; la bitácora la deja la cancelación, UNA vez (Codex código r1 #2)', async () => {
    const r = json(await tool()({ ...entrada, confirm: true }))
    expect(r).toEqual({ ok: true, cuenta: 'ORD-77', status: 'CANCELLED' })
    expect(cancelarCuentaSinCobrar).toHaveBeenCalledWith('venue-1', 'order-1', 'La abrí por error', 'staff-1')
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('lo que el panel rechaza (una cuenta de mesa) vuelve como respuesta con su código y sin auditoría', async () => {
    cancelarCuentaSinCobrar.mockRejectedValue(new BadRequestError('Esta cuenta es de una mesa', 'ORDER_IS_TABLE'))
    const r = json(await tool()({ ...entrada, confirm: true }))
    expect(r).toEqual({ ok: false, error: 'Esta cuenta es de una mesa', code: 'ORDER_IS_TABLE' })
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('una cuenta de otro negocio no existe', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)
    const r = json(await tool()({ ...entrada, confirm: true }))
    expect(r).toEqual({ ok: false, error: 'Esa cuenta no existe en este negocio.' })
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order-1', venueId: 'venue-1' } }))
    expect(cancelarCuentaSinCobrar).not.toHaveBeenCalled()
  })
})
