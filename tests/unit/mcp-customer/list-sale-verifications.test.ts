import { registerSaleVerificationTools } from '../../../src/mcp/tools/saleVerifications'
import type { McpScope } from '../../../src/mcp/scope'

const mockList = jest.fn()
jest.mock('@/services/dashboard/sale-verification.org.dashboard.service', () => ({
  __esModule: true,
  listOrgSaleVerifications: (...a: unknown[]) => mockList(...(a as [])),
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
jest.mock('@/services/playtelecom/linkingNumber.flag', () => ({ isLinkingNumberEnabledForOrg: jest.fn() }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const descriptions = new Map<string, string>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { organizationId: 'o1' }]]),
} as unknown as McpScope
const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() =>
  registerSaleVerificationTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as never)
        descriptions.set(a[0] as string, a[1] as string)
      },
    } as never,
    scope,
  ),
)
beforeEach(() => jest.clearAllMocks())

it('passes filters and returns the rows', async () => {
  mockList.mockResolvedValue({ rows: [{ id: 'sv1', status: 'FAILED' }], totalCount: 1, pageNumber: 1, pageSize: 20 })
  const out = parse(await call('list_sale_verifications', { status: 'FAILED', pageSize: 20, pageNumber: 1 }))
  expect(out.totalCount).toBe(1)
  expect(mockList).toHaveBeenCalledWith('o1', expect.objectContaining({ status: 'FAILED', pageSize: 20, pageNumber: 1 }))
})

describe('número de vinculación', () => {
  it('la descripción dice que trae los números y sus alertas, y que search encuentra un número de 9 o 10 dígitos', () => {
    const desc = descriptions.get('list_sale_verifications')!
    expect(desc).toMatch(/número de vinculación/i)
    expect(desc).toMatch(/portado/i)
    expect(desc).toMatch(/numberAlerts/)
    expect(desc).toMatch(/9 (o|or) 10/)
  })

  it('un número en search llega al servicio tal cual y la fila regresa con sus números y alertas', async () => {
    const row = {
      id: 'sv1',
      linkingNumber: '5512345678',
      portedNumber: null,
      linkingNumberSource: 'TPV',
      numberAlerts: [{ code: 'LINKING_DUPLICATE', saleVerificationId: 'sv2' }],
    }
    mockList.mockResolvedValue({ data: [row], pagination: { pageSize: 20, pageNumber: 1, totalCount: 1, totalPages: 1 } })
    const out = parse(await call('list_sale_verifications', { search: '55 1234-5678' }))
    expect(mockList).toHaveBeenCalledWith('o1', expect.objectContaining({ search: '55 1234-5678' }))
    expect(out.data[0]).toEqual(row)
  })
})
