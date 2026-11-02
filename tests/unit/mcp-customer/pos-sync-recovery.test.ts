import { StaffRole } from '@prisma/client'
import { z } from 'zod'
import { registerOrderTools } from '@/mcp/tools/orders'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'
import { lookupSyncRecovery } from '@/services/mobile/sync-recovery.mobile.service'

jest.mock('@/services/mobile/sync-recovery.mobile.service', () => ({ lookupSyncRecovery: jest.fn() }))

function tool(permissions = ['orders:read']) {
  const registered = new Map<string, { schema: z.ZodRawShape; handler: (args: any) => Promise<any> }>()
  const scope: McpScope = {
    staffId: 's1',
    activeOrg: 'org1',
    scopes: ['mcp:read'],
    allowedVenueIds: ['v1'],
    perVenueAccess: new Map([['v1', { role: StaffRole.WAITER, corePermissions: permissions } as never]]),
  }
  registerOrderTools(
    {
      tool: (name: string, _description: string, schema: z.ZodRawShape, handler: any) => registered.set(name, { schema, handler }),
    } as never,
    scope,
  )
  return registered.get('pos_sync_recovery')
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(lookupSyncRecovery as jest.Mock).mockResolvedValue({ intents: [], orders: [] })
})

it('registra la nueva lectura sólo en el catálogo libre', () => {
  expect(tool()).toBeDefined()
  expect(TOOL_EFFECTS.pos_sync_recovery).toBe('read')
  expect(DIRECTORY_TOOLS.has('pos_sync_recovery')).toBe(false)
})

it('reusa recovery con opt-in y conserva la respuesta de sólo lectura', async () => {
  const registered = tool()!
  expect(registered).toBeDefined()
  const result = await registered.handler({ venueId: 'v1', externalOrderIds: ['folio-1'] })
  expect(lookupSyncRecovery).toHaveBeenCalledWith('v1', { externalOrderIds: ['folio-1'], includeCancelledPaymentEvidence: true })
  expect(JSON.parse(result.content[0].text)).toEqual({ intents: [], orders: [] })
})

it('exige orders:read y sucursal propia antes de consultar', async () => {
  const denied = tool([])!
  expect(denied).toBeDefined()
  await expect(denied.handler({ venueId: 'v1', externalOrderIds: ['folio'] })).rejects.toThrow('orders:read')
  await expect(tool()!.handler({ venueId: 'foreign', externalOrderIds: ['folio'] })).rejects.toThrow('scope')
  expect(lookupSyncRecovery).not.toHaveBeenCalled()
})

it('acota identidades, rechaza vacíos y nunca acepta una acción para marcar revisado', () => {
  const registered = tool()!
  expect(registered).toBeDefined()
  const schema = z.object(registered.schema)
  for (const externalOrderIds of [[], [''], [' '.repeat(2)], ['f'.repeat(257)], Array.from({ length: 101 }, (_, i) => `folio-${i}`)]) {
    expect(schema.safeParse({ venueId: 'v1', externalOrderIds }).success).toBe(false)
  }
  expect(Object.keys(registered.schema)).toEqual(['venueId', 'externalOrderIds'])
})
