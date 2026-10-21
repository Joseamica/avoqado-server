import { registerTerminalTools } from '@/mcp/tools/terminals'
import { prismaMock } from '@tests/__helpers__/setup'
import type { McpScope } from '@/mcp/scope'

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<any>>()
function register() {
  registerTerminalTools(
    { tool: (...a: any[]) => handlers.set(a[0], a.at(-1)) } as never,
    {
      staffId: 's',
      activeOrg: 'org',
      scopes: ['mcp:read'],
      allowedVenueIds: ['centro', 'norte'],
      perVenueAccess: new Map([
        ['centro', { role: 'MANAGER', corePermissions: ['tpv:read'] }],
        ['norte', { role: 'WAITER', corePermissions: [] }],
      ]),
    } as unknown as McpScope,
  )
}
beforeEach(() => {
  jest.clearAllMocks()
  register()
})
it.each(['audit_terminals', 'list_devices', 'terminal_checkout_screens', 'terminal_payment_requests'])(
  '%s exige permiso del venue antes de cualquier consulta',
  async name => {
    await expect(handlers.get(name)!({ venueId: 'norte' })).rejects.toThrow(/permission/i)
    expect(prismaMock.terminal.findMany).not.toHaveBeenCalled()
    expect((prismaMock as any).terminalPaymentRequest.findMany).not.toHaveBeenCalled()
  },
)
it('consulta general sólo lee sucursales con tpv:read y explica cobertura', async () => {
  prismaMock.terminal.findMany.mockResolvedValue([])
  const r = JSON.parse((await handlers.get('audit_terminals')!({})).content[0].text)
  expect(prismaMock.terminal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: { in: ['centro'] } } }))
  expect(r.coverage).toMatchObject({ requested: 2, included: 1, excluded: 1, complete: false })
})

it('audita una página de terminales y declara que el conteo de alertas corresponde a esa página', async () => {
  prismaMock.terminal.findMany.mockResolvedValue([])
  prismaMock.terminal.count.mockResolvedValue(300)
  const r = JSON.parse((await handlers.get('audit_terminals')!({ venueId: 'centro', limit: 10, offset: 10 })).content[0].text)
  expect(r).toMatchObject({ total: 300, countsScope: 'page', hasMore: true })
  expect(prismaMock.terminal.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 10 }))
})

it('los cobros y declaraciones locales ofrecen continuación sin confundir la página con el total', async () => {
  prismaMock.terminalPaymentRequest.findMany.mockResolvedValue([])
  prismaMock.terminalPaymentRequest.count.mockResolvedValue(120)
  prismaMock.terminalAttemptResolution.findMany.mockResolvedValue([])
  prismaMock.terminalAttemptResolution.count.mockResolvedValue(80)
  const r = JSON.parse(
    (await handlers.get('terminal_payment_requests')!({ venueId: 'centro', limit: 10, offset: 10, localResolutionsOffset: 25 })).content[0]
      .text,
  )
  expect(r).toMatchObject({
    total: 120,
    countsScope: 'page',
    hasMore: true,
    nextOffset: 20,
    localResolutionsTotal: 80,
    localResolutionsHasMore: true,
    localResolutionsNextOffset: 50,
  })
  expect(prismaMock.terminalPaymentRequest.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ take: 10, skip: 10, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
  )
  expect(prismaMock.terminalAttemptResolution.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ take: 25, skip: 25, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
  )
})
