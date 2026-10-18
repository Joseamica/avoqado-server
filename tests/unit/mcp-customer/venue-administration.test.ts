import type { McpScope } from '@/mcp/scope'
import { registerVenueAdministrationTools } from '@/mcp/tools/venueAdministration'
import { auditMcpWrite } from '@/mcp/audit'

const getAdministration = jest.fn()
const updateProfile = jest.fn()
const updateOrganization = jest.fn()
const updateOwner = jest.fn()
const updateStatus = jest.fn()

jest.mock('@/services/superadmin/venueAdministration.service', () => ({
  getVenueAdministration: (...args: unknown[]) => getAdministration(...args),
  updateVenueProfile: (...args: unknown[]) => updateProfile(...args),
  updateVenueOrganization: (...args: unknown[]) => updateOrganization(...args),
  updateVenueOwner: (...args: unknown[]) => updateOwner(...args),
  updateVenueStatus: (...args: unknown[]) => updateStatus(...args),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))

const version = '2026-10-15T12:00:00.000Z'
const venueId = 'cm123456789012345678901234'
const organizationId = 'cm123456789012345678901235'
const staffId = 'cm123456789012345678901236'
const administration = {
  venue: { id: venueId, organizationId, name: 'Estudio Centro', phone: '5555555555', status: 'ACTIVE', updatedAt: version },
  organization: { id: organizationId, name: 'Grupo Centro', venueCount: 3, updatedAt: version },
  owner: { id: staffId, firstName: 'Ana', lastName: 'Pérez', role: 'OWNER', venueCount: 2, updatedAt: version },
  allowedStatusTransitions: ['SUSPENDED', 'ADMIN_SUSPENDED', 'CLOSED'],
}

type Result = { content: Array<{ text: string }> }
type Handler = (input: Record<string, unknown>) => Promise<Result>
function handlers(overrides: Partial<McpScope> = {}) {
  const scope = {
    staffId,
    activeOrg: organizationId,
    isSuperAdmin: true,
    allowedVenueIds: [venueId],
    perVenueAccess: new Map([[venueId, { role: 'SUPERADMIN' }]]),
    scopes: ['mcp:read', 'mcp:write'],
    ...overrides,
  } as McpScope
  const tools = new Map<string, Handler>()
  registerVenueAdministrationTools(
    { tool: (...args: unknown[]) => tools.set(args[0] as string, args[args.length - 1] as Handler) } as never,
    scope,
  )
  return tools
}
const parse = (result: Result) => JSON.parse(result.content[0].text)

beforeEach(() => {
  jest.clearAllMocks()
  getAdministration.mockResolvedValue(administration)
  for (const update of [updateProfile, updateOrganization, updateOwner, updateStatus]) update.mockResolvedValue(administration)
})

describe('administración de negocios por MCP', () => {
  it('no registra capacidades de plataforma para un cliente común', () => {
    expect(handlers({ isSuperAdmin: false }).size).toBe(0)
  })

  it('aplica scope de sucursal y permiso antes de leer', async () => {
    await expect(handlers().get('venue_administration')!({ venueId: 'cm123456789012345678901239' })).rejects.toThrow('scope')
    expect(getAdministration).not.toHaveBeenCalled()
  })

  it('devuelve el perfil administrativo proyectado por el servicio', async () => {
    const result = parse(await handlers().get('venue_administration')!({ venueId }))
    expect(result).toEqual(administration)
    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('exige escritura OAuth incluso para una conexión SUPERADMIN', async () => {
    await expect(
      handlers({ scopes: ['mcp:read'] }).get('update_venue_business_profile')!({
        venueId,
        expectedUpdatedAt: version,
        changes: { name: 'Estudio Norte' },
        confirm: true,
      }),
    ).rejects.toThrow('mcp:write')
    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('muestra valores antes y después sin ejecutar ni auditar la vista previa', async () => {
    const result = parse(
      await handlers().get('update_venue_business_profile')!({
        venueId,
        expectedUpdatedAt: version,
        changes: { name: 'Estudio Norte', phone: null },
      }),
    )
    expect(result.requiresConfirmation).toBe(true)
    expect(result.preview).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ campo: 'Nombre del negocio', anterior: 'Estudio Centro', nuevo: 'Estudio Norte' }),
        expect.objectContaining({ campo: 'Teléfono', anterior: '5555555555', nuevo: null }),
      ]),
    )
    expect(updateProfile).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })

  it('al confirmar conserva versión, null y actor del principal autenticado', async () => {
    const input = { expectedUpdatedAt: version, changes: { phone: null } }
    await handlers().get('update_venue_business_profile')!({ venueId, ...input, confirm: true })
    expect(updateProfile).toHaveBeenCalledWith(venueId, input, staffId)
    expect(auditMcpWrite).toHaveBeenCalledWith(
      expect.objectContaining({ staffId }),
      expect.objectContaining({
        venueId,
        entity: 'Venue',
        entityId: venueId,
      }),
    )
  })

  it('rechaza un borrador viejo ya en la vista previa', async () => {
    await expect(
      handlers().get('update_venue_business_profile')!({
        venueId,
        expectedUpdatedAt: '2026-10-14T12:00:00.000Z',
        changes: { name: 'Estudio Norte' },
      }),
    ).rejects.toThrow(/cambi|actualiz/i)
    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('organización muestra el alcance exacto y verifica la identidad esperada', async () => {
    const input = {
      expectedOrganizationId: organizationId,
      expectedUpdatedAt: version,
      confirmShared: true,
      changes: { name: 'Grupo Norte' },
    }
    const tool = handlers().get('update_venue_organization')!
    const preview = parse(await tool({ venueId, ...input }))
    expect(preview.affectedVenues).toBe(3)
    await tool({ venueId, ...input, confirm: true })
    expect(updateOrganization).toHaveBeenCalledWith(venueId, input, staffId)
  })

  it('responsable conserva la identidad leída y avisa que el perfil es compartido', async () => {
    const input = { expectedOwnerId: staffId, expectedUpdatedAt: version, confirmShared: true, changes: { firstName: 'Andrea' } }
    const tool = handlers().get('update_venue_responsible_contact')!
    expect(parse(await tool({ venueId, ...input })).affectedVenues).toBe(2)
    await tool({ venueId, ...input, confirm: true })
    expect(updateOwner).toHaveBeenCalledWith(venueId, input, staffId)
  })

  it('un cambio de responsable invalida el borrador aunque coincida su fecha', async () => {
    await expect(
      handlers().get('update_venue_responsible_contact')!({
        venueId,
        expectedOwnerId: 'cm123456789012345678901239',
        expectedUpdatedAt: version,
        confirmShared: true,
        changes: { firstName: 'Andrea' },
        confirm: true,
      }),
    ).rejects.toThrow(/responsable|cambi/i)
    expect(updateOwner).not.toHaveBeenCalled()
  })

  it('estado pide confirmación y envía el motivo al servicio', async () => {
    const input = { expectedUpdatedAt: version, status: 'SUSPENDED', reason: 'Revisión administrativa' }
    const tool = handlers().get('change_venue_administrative_status')!
    expect(parse(await tool({ venueId, ...input })).requiresConfirmation).toBe(true)
    expect(updateStatus).not.toHaveBeenCalled()
    await tool({ venueId, ...input, confirm: true })
    expect(updateStatus).toHaveBeenCalledWith(venueId, input, staffId)
  })

  it('no audita éxito si la escritura entra en conflicto', async () => {
    updateProfile.mockRejectedValueOnce(new Error('El negocio cambió; vuelve a cargar'))
    await expect(
      handlers().get('update_venue_business_profile')!({
        venueId,
        expectedUpdatedAt: version,
        changes: { name: 'Estudio Norte' },
        confirm: true,
      }),
    ).rejects.toThrow('cambió')
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
})
