import { registerInterVenueTransferTools } from '@/mcp/tools/interVenueTransfers'
import type { McpScope } from '@/mcp/scope'

const mockList = jest.fn()
const mockGet = jest.fn()
const mockCreate = jest.fn()
const mockApprove = jest.fn()
const mockReject = jest.fn()
const mockCancel = jest.fn()
const mockDispatch = jest.fn()
const mockReceive = jest.fn()
const mockResolve = jest.fn()
const mockPlanGate = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/services/dashboard/interVenueTransfer.service', () => ({
  listInterVenueTransfers: (...args: unknown[]) => mockList(...(args as [])),
  getInterVenueTransfer: (...args: unknown[]) => mockGet(...(args as [])),
  createInterVenueTransfer: (...args: unknown[]) => mockCreate(...(args as [])),
  approveInterVenueTransfer: (...args: unknown[]) => mockApprove(...(args as [])),
  rejectInterVenueTransfer: (...args: unknown[]) => mockReject(...(args as [])),
  cancelInterVenueTransfer: (...args: unknown[]) => mockCancel(...(args as [])),
  dispatchInterVenueTransfer: (...args: unknown[]) => mockDispatch(...(args as [])),
  receiveInterVenueTransfer: (...args: unknown[]) => mockReceive(...(args as [])),
  resolveInterVenueTransferVariance: (...args: unknown[]) => mockResolve(...(args as [])),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...args: unknown[]) => mockPlanGate(...(args as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...args: unknown[]) => mockAudit(...(args as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (venueId?: string) => {
      if (venueId !== 'v1' && venueId !== 'v2') throw new Error('out of scope')
      return { venueId: { in: [venueId] } }
    },
    requirePermission: jest.fn(),
  }),
}))

const handlers = new Map<string, (args: any, extra: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1', 'v2'], perVenueAccess: new Map() } as McpScope
const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args, {})
const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text)

beforeAll(() => {
  registerInterVenueTransferTools(
    { tool: (...args: unknown[]) => handlers.set(args[0] as string, args[args.length - 1] as never) } as never,
    scope,
  )
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null)
  mockGet.mockResolvedValue({ id: 't1', number: 'TR-1', sourceVenueId: 'v1', destinationVenueId: 'v2', items: [] })
  mockDispatch.mockResolvedValue({ id: 't1', status: 'IN_TRANSIT' })
  mockReceive.mockResolvedValue({ id: 't1', status: 'PARTIALLY_RECEIVED' })
  mockResolve.mockResolvedValue({ id: 't1', status: 'COMPLETED_WITH_VARIANCE' })
})

it('registra el conjunto completo de herramientas del spec', () => {
  expect([...handlers.keys()]).toEqual(
    expect.arrayContaining([
      'list_inter_venue_transfers',
      'inter_venue_transfer_detail',
      'create_inter_venue_transfer',
      'approve_inter_venue_transfer',
      'reject_inter_venue_transfer',
      'cancel_inter_venue_transfer',
      'dispatch_inter_venue_transfer',
      'receive_inter_venue_transfer',
      'resolve_inter_venue_transfer_variance',
    ]),
  )
})

it.each([
  [
    'dispatch_inter_venue_transfer',
    mockDispatch,
    { venueId: 'v1', transferId: 't1', idempotencyKey: 'c5d2d49a-a693-4b10-97f3-c4ebcb40cd9d', items: [] },
  ],
  [
    'receive_inter_venue_transfer',
    mockReceive,
    { venueId: 'v2', transferId: 't1', idempotencyKey: '7e1ddf64-bb56-4e05-bcba-c78fa89c06db', items: [] },
  ],
  [
    'resolve_inter_venue_transfer_variance',
    mockResolve,
    {
      venueId: 'v2',
      transferId: 't1',
      idempotencyKey: 'd3427483-3526-4142-bb68-97fc03b3a8da',
      items: [{ itemId: 'i1', quantity: 1, reason: 'DAMAGED' }],
    },
  ],
] as const)('%s exige confirmación antes de escribir', async (tool, write, args) => {
  const preview = parse(await call(tool, args))
  expect(preview.requiresConfirmation).toBe(true)
  expect(write).not.toHaveBeenCalled()

  await call(tool, { ...args, confirm: true })
  expect(write).toHaveBeenCalled()
  expect(mockAudit).toHaveBeenCalled()
})
