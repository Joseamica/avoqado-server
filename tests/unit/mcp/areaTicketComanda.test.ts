/**
 * D2 de vales (3-nov-2026): `set_area_ticket_comanda` apaga o prende la comanda de un área desde el MCP. Primero enseña
 * la vista previa y no escribe; confirmar con la huella de esa vista previa escribe por el servicio del panel (que deja
 * la bitácora con fuente `mcp`). Sin `area-tickets:configure`, o con un área de otro negocio, no escribe nada.
 */
import { StaffRole } from '@prisma/client'
import { registerAreaTicketTools } from '@/mcp/tools/areaTickets'
import { prismaMock } from '@tests/__helpers__/setup'

const updateArea = jest.fn()
jest.mock('@/services/dashboard/areaTicket.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/areaTicket.dashboard.service'),
  updateArea: (...a: unknown[]) => updateArea(...a),
}))

const ambito = (corePermissions: string[]) => ({
  staffId: 'staff-1',
  activeOrg: 'org-1',
  allowedVenueIds: ['venue-1'],
  scopes: ['mcp:read', 'mcp:write'],
  perVenueAccess: new Map([
    [
      'venue-1',
      {
        userId: 'staff-1',
        venueId: 'venue-1',
        organizationId: 'org-1',
        role: StaffRole.ADMIN,
        corePermissions,
        whiteLabelEnabled: false,
        enabledFeatures: [],
        featureAccess: {},
        featureMetadata: {},
      },
    ],
  ]),
})

function tool(corePermissions: string[] = ['area-tickets:configure']) {
  let handler: ((input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) | undefined
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
      if (n === 'set_area_ticket_comanda') handler = h
    },
  }
  registerAreaTicketTools(server as never, ambito(corePermissions) as never)
  if (!handler) throw new Error('la tool no se registró')
  return handler
}
const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.fulfillmentArea.findFirst as jest.Mock).mockResolvedValue({ id: 'area-cremeria', name: 'Cremería', sendsComanda: true })
  updateArea.mockResolvedValue({ id: 'area-cremeria' })
})

describe('set_area_ticket_comanda (D2)', () => {
  it('sin confirmar sólo enseña la vista previa y no escribe', async () => {
    const r = json(await tool()({ venueId: 'venue-1', areaId: 'area-cremeria', sendsComanda: false }))
    expect(r.requiresConfirmation).toBe(true)
    expect(r.preview).toEqual({ area: 'Cremería', current: 'manda comanda', new: 'sólo el vale, sin comanda' })
    expect(updateArea).not.toHaveBeenCalled()
  })

  it('confirmar con la huella de la vista previa escribe por el servicio del panel, con fuente mcp', async () => {
    const t = tool()
    const vista = json(await t({ venueId: 'venue-1', areaId: 'area-cremeria', sendsComanda: false }))
    const r = json(
      await t({
        venueId: 'venue-1',
        areaId: 'area-cremeria',
        sendsComanda: false,
        confirm: true,
        expectedSourceFingerprint: vista.expectedSourceFingerprint,
      }),
    )
    expect(r.ok).toBe(true)
    expect(updateArea).toHaveBeenCalledWith('venue-1', 'area-cremeria', { sendsComanda: false }, 'staff-1', {
      source: 'mcp',
      siSigueComo: { name: 'Cremería', sendsComanda: true },
    })
  })

  it('si renombraron el área después de la vista previa, pide revisarla otra vez (Codex r2 #3)', async () => {
    const t = tool()
    const vista = json(await t({ venueId: 'venue-1', areaId: 'area-cremeria', sendsComanda: false }))
    ;(prismaMock.fulfillmentArea.findFirst as jest.Mock).mockResolvedValue({ id: 'area-cremeria', name: 'Cafetería', sendsComanda: true })
    const r = json(
      await t({ venueId: 'venue-1', areaId: 'area-cremeria', sendsComanda: false, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }),
    )
    expect(r.needsInput).toBe(true)
    expect(updateArea).not.toHaveBeenCalled()
  })

  it('si el área cambia entre la confirmación y la escritura, pide revisarla otra vez (Codex r3)', async () => {
    const t = tool()
    const vista = json(await t({ venueId: 'venue-1', areaId: 'area-cremeria', sendsComanda: false }))
    const { ConflictError } = jest.requireActual('@/errors/AppError')
    updateArea.mockRejectedValue(new ConflictError('El área cambió desde la vista previa. Revísala otra vez.', 'AREA_CHANGED'))
    const r = json(
      await t({ venueId: 'venue-1', areaId: 'area-cremeria', sendsComanda: false, confirm: true, expectedSourceFingerprint: vista.expectedSourceFingerprint }),
    )
    expect(r.needsInput).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('una huella vieja no escribe', async () => {
    const r = json(
      await tool()({ venueId: 'venue-1', areaId: 'area-cremeria', sendsComanda: false, confirm: true, expectedSourceFingerprint: 'otra' }),
    )
    expect(r.needsInput).toBe(true)
    expect(updateArea).not.toHaveBeenCalled()
  })

  it('un área de otro negocio no existe para este local', async () => {
    ;(prismaMock.fulfillmentArea.findFirst as jest.Mock).mockResolvedValue(null)
    const r = json(await tool()({ venueId: 'venue-1', areaId: 'area-ajena', sendsComanda: false }))
    expect(r.ok).toBe(false)
    expect(prismaMock.fulfillmentArea.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'area-ajena', venueId: 'venue-1' } }))
    expect(updateArea).not.toHaveBeenCalled()
  })

  it('sin permiso de configurar vales no escribe', async () => {
    const r = json(await tool([])({ venueId: 'venue-1', areaId: 'area-cremeria', sendsComanda: false }))
    expect(r.ok).toBe(false)
    expect(updateArea).not.toHaveBeenCalled()
  })
})
