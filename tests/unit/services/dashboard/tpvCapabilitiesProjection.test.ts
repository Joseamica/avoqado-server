import { TerminalType } from '@prisma/client'

import { prismaMock } from '@tests/__helpers__/setup'
import { getTerminalsData, getTpvById } from '@/services/dashboard/tpv.dashboard.service'

const NOW = new Date('2026-08-30T12:00:00.000Z')
const OBSERVED_AT = new Date('2026-08-30T11:00:00.000Z')

const displayRequest = {
  requestId: 'request-1',
  desiredInverted: false,
  status: 'PENDING',
}

function posRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    venueId: 'venue-1',
    name: 'Sunmi mostrador',
    type: TerminalType.POS_ANDROID,
    activatedAt: null,
    customerDisplayPresent: true,
    customerDisplayInvertible: true,
    displayModeProtocolVersion: 1,
    capabilitiesObservedAt: OBSERVED_AT,
    customerDisplayInverted: true,
    customerDisplayRequest: displayRequest,
    customerDisplayRequestVersion: 7,
    ...overrides,
  }
}

const supportedDisplayCapabilities = {
  requiresActivation: false,
  canManagePaymentConfiguration: false,
  canAcceptTerminalPaymentRequests: false,
  customerDisplay: {
    presence: 'SUPPORTED',
    invertibility: 'SUPPORTED',
    canRequestInversion: true,
    observedAt: OBSERVED_AT.toISOString(),
    stale: false,
  },
  supportedRemoteCommands: [],
}

describe('venue device capability projections', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('projects identical capabilities and durable display state in list and detail without adding deviceUid', async () => {
    const row = posRow()
    prismaMock.$transaction.mockResolvedValueOnce([[row], 1])
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    prismaMock.payment.groupBy.mockResolvedValue([])
    prismaMock.terminal.findFirst.mockResolvedValue(row)

    const list = await getTerminalsData('venue-1', 1, 20, {})
    const detail = await getTpvById('venue-1', 'pos-1')
    const listDevice = list.data[0]

    expect(listDevice).toHaveProperty('capabilities')
    if (!('capabilities' in listDevice)) throw new Error('Expected list projection to include capabilities')

    expect(listDevice.capabilities).toEqual(supportedDisplayCapabilities)
    expect(detail.capabilities).toEqual(listDevice.capabilities)
    expect(listDevice).toEqual(
      expect.objectContaining({
        customerDisplayInverted: true,
        customerDisplayRequest: displayRequest,
        customerDisplayRequestVersion: 7,
      }),
    )
    expect(detail).toEqual(
      expect.objectContaining({
        customerDisplayInverted: true,
        customerDisplayRequest: displayRequest,
        customerDisplayRequestVersion: 7,
      }),
    )
    expect(listDevice).not.toHaveProperty('deviceUid')
    expect(detail).not.toHaveProperty('deviceUid')
    expect(listDevice).toEqual(expect.objectContaining({ todayPaymentCount: 0, todayPaymentTotal: 0 }))
    expect(list.meta).toEqual({ total: 1, page: 1, pageSize: 20, pageCount: 1 })
  })

  it.each([
    {
      name: 'stale POS facts',
      row: posRow({ capabilitiesObservedAt: new Date('2026-08-23T11:59:59.999Z') }),
      expectedDisplay: {
        presence: 'UNKNOWN',
        invertibility: 'UNKNOWN',
        canRequestInversion: false,
        observedAt: '2026-08-23T11:59:59.999Z',
        stale: true,
      },
    },
    {
      name: 'fresh nullable POS facts',
      row: posRow({ customerDisplayPresent: null, customerDisplayInvertible: null }),
      expectedDisplay: {
        presence: 'UNKNOWN',
        invertibility: 'UNKNOWN',
        canRequestInversion: false,
        observedAt: OBSERVED_AT.toISOString(),
        stale: false,
      },
    },
    {
      name: 'TPV Android',
      row: posRow({ type: TerminalType.TPV_ANDROID }),
      expectedDisplay: {
        presence: 'UNSUPPORTED',
        invertibility: 'UNSUPPORTED',
        canRequestInversion: false,
        observedAt: null,
        stale: false,
      },
    },
    {
      name: 'non-capability printer',
      row: posRow({ type: TerminalType.PRINTER_RECEIPT }),
      expectedDisplay: {
        presence: 'UNSUPPORTED',
        invertibility: 'UNSUPPORTED',
        canRequestInversion: false,
        observedAt: null,
        stale: false,
      },
    },
  ])('uses the canonical resolver for $name', async ({ row, expectedDisplay }) => {
    prismaMock.terminal.findFirst.mockResolvedValue(row)

    const result = await getTpvById('venue-1', 'pos-1')

    expect(result.capabilities.customerDisplay).toEqual(expectedDisplay)
  })
})

describe('activation filters are applied before pagination', () => {
  async function captureWhere(activations: Array<'activated' | 'notActivated'>, types?: TerminalType[]) {
    prismaMock.$transaction.mockResolvedValueOnce([[], 0])
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })

    await getTerminalsData('venue-1', 1, 20, { activations, types })

    return prismaMock.terminal.findMany.mock.calls[0][0].where
  }

  it('restricts activated rows to activatable TPV types in the Prisma where', async () => {
    expect(await captureWhere(['activated'])).toEqual(
      expect.objectContaining({
        type: { in: [TerminalType.TPV_ANDROID, TerminalType.TPV_IOS] },
        activatedAt: { not: null },
      }),
    )
  })

  it('restricts pending activation rows to activatable TPV types in the Prisma where', async () => {
    expect(await captureWhere(['notActivated'])).toEqual(
      expect.objectContaining({
        type: { in: [TerminalType.TPV_ANDROID, TerminalType.TPV_IOS] },
        activatedAt: null,
      }),
    )
  })

  it('intersects an explicit type filter so POS can never enter an activation bucket', async () => {
    expect(await captureWhere(['notActivated'], [TerminalType.POS_ANDROID, TerminalType.TPV_IOS])).toEqual(
      expect.objectContaining({
        type: { in: [TerminalType.TPV_IOS] },
        activatedAt: null,
      }),
    )
  })

  it('keeps all device types visible when both activation options are selected', async () => {
    const where = await captureWhere(['activated', 'notActivated'])

    expect(where).not.toHaveProperty('type')
    expect(where).not.toHaveProperty('activatedAt')
  })
})
