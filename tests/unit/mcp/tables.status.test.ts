import { registerTableTools } from '../../../src/mcp/tools/tables'
import { prismaMock } from '../../__helpers__/setup'

/**
 * `tables_status` must derive occupancy from the LIVE checks, never from the raw
 * `Table.status` column.
 *
 * That column drifts: the shared table-release step only frees a table when
 * `Table.currentOrderId` equals the order being closed, which an order created by
 * SPLIT_ORDER never satisfies. A table can therefore sit at OCCUPIED with zero open
 * checks indefinitely — observed twice on real hardware.
 *
 * avoqado-android, avoqado-ios and avoqado-tpv all already derive free/occupied from
 * the open checks. This tool was the last consumer trusting the raw column, so an
 * owner asking "¿cuántas mesas tengo ocupadas?" got an inflated count.
 */
describe('tables_status derives occupancy from live checks', () => {
  function captureHandler() {
    let handler: any
    const server: any = {
      tool: (name: string, _desc: string, _schema: any, fn: any) => {
        if (name === 'tables_status') handler = fn
      },
    }
    registerTableTools(server, { allowedVenueIds: ['venue-1'], staffId: 'staff-1' } as any)
    return handler
  }

  const table = (over: Record<string, any>) => ({
    id: 't1',
    number: '1',
    capacity: 4,
    status: 'AVAILABLE',
    area: null,
    currentOrder: null,
    orders: [],
    ...over,
  })

  async function run(tables: any[]) {
    prismaMock.table.findMany.mockResolvedValue(tables)
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enforceTableOwnership: false })
    const res = await captureHandler()({ venueId: 'venue-1' })
    return JSON.parse(res.content[0].text)
  }

  it('reports a phantom table (OCCUPIED, no open checks) as AVAILABLE', async () => {
    const out = await run([table({ status: 'OCCUPIED', orders: [], currentOrder: null })])

    expect(out.tables[0].status).toBe('AVAILABLE')
    expect(out.byStatus.AVAILABLE).toBe(1)
    expect(out.byStatus.OCCUPIED).toBeUndefined()
    // The drifted column stays visible so the row is diagnosable, not silently rewritten.
    expect(out.tables[0].storedStatus).toBe('OCCUPIED')
  })

  it('reports a table holding a live check as OCCUPIED even if the column says AVAILABLE', async () => {
    const out = await run([table({ status: 'AVAILABLE', orders: [{ id: 'o1' }] })])

    expect(out.tables[0].status).toBe('OCCUPIED')
    expect(out.byStatus.OCCUPIED).toBe(1)
  })

  it('keeps RESERVED and CLEANING, the legitimate states without a check', async () => {
    const out = await run([
      table({ id: 't1', number: '1', status: 'RESERVED' }),
      table({ id: 't2', number: '2', status: 'CLEANING' }),
    ])

    expect(out.tables.map((t: any) => t.status)).toEqual(['RESERVED', 'CLEANING'])
  })
})
