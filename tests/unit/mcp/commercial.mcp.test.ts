import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerCommercialTools, resolveCommercialMcpActiveVersion } from '@/mcp/tools/commercial'
import type { McpScope } from '@/mcp/scope'

const readVerifiedActiveCatalog = jest.fn()
jest.mock('@/services/commercial/commercialCatalogAuthority.service', () => ({
  ...jest.requireActual('@/services/commercial/commercialCatalogAuthority.service'),
  readVerifiedActiveCatalog: (...args: unknown[]) => readVerifiedActiveCatalog(...args),
}))
jest.mock('@/services/commercial/commercialRead.service', () => ({
  getActiveCommercialCatalog: jest.fn(),
}))

const scope = {
  staffId: 'staff_1',
  activeOrg: 'org_1',
  allowedVenueIds: ['venue_1'],
  perVenueAccess: new Map(),
} as unknown as McpScope

async function connectedCommercialMcp(
  input: {
    resolveActiveVersion: jest.Mock
    previewQuote: jest.Mock
    listManualSpeiCases?: jest.Mock
    getManualSpeiCase?: jest.Mock
    getBillingOverview?: jest.Mock
    listBillingReceipts?: jest.Mock
  },
  toolScope: McpScope = scope,
) {
  const server = new McpServer({ name: 'commercial-test', version: '1.0.0' })
  const client = new Client({ name: 'commercial-client-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  registerCommercialTools(server, toolScope, input)
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server }
}

describe('commercial MCP version safety', () => {
  it.each([
    [null, 'MISSING'],
    [{ catalog: { schemaVersion: 1 }, fallback: null }, 'ACTIVE_V1'],
    [{ catalog: { schemaVersion: 2 }, fallback: null }, 'ACTIVE_V2'],
    [{ catalog: { schemaVersion: 1 }, fallback: { fallbackUsed: true } }, 'UNSUPPORTED'],
  ] as const)('resolves verified authority state %# without opening a raw publication reader', async (decision, expected) => {
    readVerifiedActiveCatalog.mockResolvedValue(decision)

    await expect(resolveCommercialMcpActiveVersion()).resolves.toBe(expected)
  })

  it('lets the SDK reject invalid quote input before the active-version guard or quote dependency', async () => {
    const resolveActiveVersion = jest.fn().mockResolvedValue('UNSUPPORTED')
    const previewQuote = jest.fn()
    const { client, server } = await connectedCommercialMcp({ resolveActiveVersion, previewQuote })

    const result = await client.callTool({ name: 'commercial_quote_preview', arguments: { lines: [] } })

    expect(result.isError).toBe(true)
    expect(resolveActiveVersion).not.toHaveBeenCalled()
    expect(previewQuote).not.toHaveBeenCalled()
    await client.close()
    await server.close()
  })

  it.each(['ACTIVE_V2', 'UNSUPPORTED'] as const)(
    'returns the stable disabled code for valid %s state before the quote dependency',
    async activeVersion => {
      const resolveActiveVersion = jest.fn().mockResolvedValue(activeVersion)
      const previewQuote = jest.fn()
      const { client, server } = await connectedCommercialMcp({ resolveActiveVersion, previewQuote })

      const result = await client.callTool({
        name: 'commercial_quote_preview',
        arguments: {
          lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
        },
      })
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text)

      expect(data.code).toBe('COMMERCIAL_MCP_V2_NOT_ENABLED')
      expect(resolveActiveVersion).toHaveBeenCalledTimes(1)
      expect(previewQuote).not.toHaveBeenCalled()
      await client.close()
      await server.close()
    },
  )

  it('returns not-active for a missing catalog before the quote dependency', async () => {
    const resolveActiveVersion = jest.fn().mockResolvedValue('MISSING')
    const previewQuote = jest.fn()
    const { client, server } = await connectedCommercialMcp({ resolveActiveVersion, previewQuote })

    const result = await client.callTool({
      name: 'commercial_quote_preview',
      arguments: {
        lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      },
    })
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(data).toEqual({
      ok: false,
      code: 'COMMERCIAL_CATALOG_NOT_ACTIVE',
      message: 'El catálogo comercial todavía no está activo.',
    })
    expect(previewQuote).not.toHaveBeenCalled()
    await client.close()
    await server.close()
  })
})

describe('commercial MCP financial boundary', () => {
  const customerBillingScope = {
    ...scope,
    organizationId: 'org_1',
    perVenueAccess: new Map([
      [
        'venue_1',
        {
          organizationId: 'org_1',
          corePermissions: ['billing:subscriptions:read', 'billing:history:read'],
        },
      ],
    ]),
  } as unknown as McpScope

  it('does not advertise manual reconciliation data to a customer-scoped connection', async () => {
    const { client, server } = await connectedCommercialMcp({
      resolveActiveVersion: jest.fn(),
      previewQuote: jest.fn(),
    })

    const tools = await client.listTools()

    expect(tools.tools.map(tool => tool.name)).not.toContain('commercial_manual_spei_cases')
    expect(tools.tools.map(tool => tool.name)).not.toContain('commercial_manual_spei_case')
    await client.close()
    await server.close()
  })

  it('gives a platform superadmin read-only review tools without registering a money command', async () => {
    const listManualSpeiCases = jest.fn().mockResolvedValue({
      items: [{ id: 'case-1', observedAmountMinor: '28884', status: 'AWAITING_APPROVAL' }],
      nextCursor: null,
    })
    const getManualSpeiCase = jest.fn()
    const { client, server } = await connectedCommercialMcp(
      {
        resolveActiveVersion: jest.fn(),
        previewQuote: jest.fn(),
        listManualSpeiCases,
        getManualSpeiCase,
      },
      { ...scope, isSuperAdmin: true },
    )

    const tools = await client.listTools()
    const toolNames = tools.tools.map(tool => tool.name)
    expect(toolNames).toContain('commercial_manual_spei_cases')
    expect(toolNames).toContain('commercial_manual_spei_case')
    expect(toolNames).not.toContain('commercial_manual_spei_approve')

    const result = await client.callTool({
      name: 'commercial_manual_spei_cases',
      arguments: { status: 'AWAITING_APPROVAL', limit: 25 },
    })
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(data.items[0]).toEqual({ id: 'case-1', observedAmountMxn: '288.84', status: 'AWAITING_APPROVAL' })
    expect(data.items[0]).not.toHaveProperty('observedAmountMinor')
    expect(listManualSpeiCases).toHaveBeenCalledWith({ status: 'AWAITING_APPROVAL', limit: 25 })
    await client.close()
    await server.close()
  })

  it('reads the commercial subscription only for an explicitly permitted venue and preserves exact large money', async () => {
    const getBillingOverview = jest.fn().mockResolvedValue({
      schemaVersion: 1,
      state: 'READY',
      collectionState: 'PAYMENT_REQUIRED',
      contract: {
        id: 'contract-1',
        currency: 'MXN',
        today: {
          subtotalMinor: '900719925474099301',
          taxMinor: '144115188075855888',
          totalMinor: '1044835113549955189',
        },
      },
      obligations: [
        {
          reference: 'AVQ-001',
          amountDueMinor: '1044835113549955189',
          allocatedMinor: '0',
          outstandingMinor: '1044835113549955189',
          currency: 'MXN',
        },
      ],
      recentReceipts: [],
    })
    const { client, server } = await connectedCommercialMcp(
      {
        resolveActiveVersion: jest.fn(),
        previewQuote: jest.fn(),
        getBillingOverview,
      },
      customerBillingScope,
    )

    const result = await client.callTool({
      name: 'commercial_billing_overview',
      arguments: { venueId: 'venue_1' },
    })
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(getBillingOverview).toHaveBeenCalledWith({ organizationId: 'org_1', venueId: 'venue_1' })
    expect(data.contract.today).toEqual({
      subtotalMxn: '9007199254740993.01',
      taxMxn: '1441151880758558.88',
      totalMxn: '10448351135499551.89',
    })
    expect(data.obligations[0].outstandingMxn).toBe('10448351135499551.89')
    expect(JSON.stringify(data)).not.toContain('Minor')
    await client.close()
    await server.close()
  })

  it('lists bounded receipt history with exact pesos and rejects an out-of-scope venue before reading', async () => {
    const listBillingReceipts = jest.fn().mockResolvedValue({
      schemaVersion: 1,
      state: 'READY',
      items: [
        {
          id: 'receipt-1',
          amountMinor: '28884',
          currency: 'MXN',
          provider: 'MANUAL_SPEI',
        },
      ],
      nextCursor: 'receipt-1',
    })
    const { client, server } = await connectedCommercialMcp(
      {
        resolveActiveVersion: jest.fn(),
        previewQuote: jest.fn(),
        listBillingReceipts,
      },
      customerBillingScope,
    )

    const result = await client.callTool({
      name: 'commercial_billing_receipts',
      arguments: { venueId: 'venue_1', limit: 25 },
    })
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(data.items[0]).toEqual({
      id: 'receipt-1',
      amountMxn: '288.84',
      currency: 'MXN',
      provider: 'MANUAL_SPEI',
    })
    expect(listBillingReceipts).toHaveBeenCalledWith({ organizationId: 'org_1', venueId: 'venue_1', limit: 25 })

    const denied = await client.callTool({
      name: 'commercial_billing_receipts',
      arguments: { venueId: 'venue_outside' },
    })
    expect(denied.isError).toBe(true)
    expect(listBillingReceipts).toHaveBeenCalledTimes(1)
    await client.close()
    await server.close()
  })
})
