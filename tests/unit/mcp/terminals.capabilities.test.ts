import { DeviceFormFactor, StaffRole, TerminalType } from '@prisma/client'

import { registerTerminalTools } from '@/mcp/tools/terminals'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: {
    requestRefundOnTerminal: jest.fn(),
  },
}))

const NOW = new Date('2026-08-30T12:00:00.000Z')
const OBSERVED_AT = new Date('2026-08-30T11:00:00.000Z')

function captureListDevicesHandler() {
  let handler: ((input: Record<string, unknown>) => Promise<any>) | undefined
  const server = {
    tool: (name: string, _description: string, _schema: unknown, candidate: typeof handler) => {
      if (name === 'list_devices') handler = candidate
    },
  }

  registerTerminalTools(server as any, { allowedVenueIds: ['venue-1'], staffId: 'staff-1' } as any)

  if (!handler) throw new Error('list_devices handler was not registered')
  return handler
}

function captureRefundHandler() {
  let handler: ((input: Record<string, any>) => Promise<any>) | undefined
  const server = {
    tool: (name: string, _description: string, _schema: unknown, candidate: typeof handler) => {
      if (name === 'refund_card_on_terminal') handler = candidate
    },
  }
  const access = {
    userId: 'staff-1',
    venueId: 'venue-1',
    organizationId: 'org-1',
    role: StaffRole.SUPERADMIN,
    corePermissions: ['*:*'],
    whiteLabelEnabled: false,
    enabledFeatures: [],
    featureAccess: {},
    featureMetadata: {},
  }

  registerTerminalTools(
    server as any,
    {
      staffId: 'staff-1',
      activeOrg: 'org-1',
      allowedVenueIds: ['venue-1'],
      perVenueAccess: new Map([['venue-1', access]]),
    } as any,
  )

  if (!handler) throw new Error('refund_card_on_terminal handler was not registered')
  return handler
}

function parseBody(response: any) {
  return JSON.parse(response.content[0].text)
}

function eligibleCardPayment() {
  return {
    id: 'payment-1',
    venueId: 'venue-1',
    status: 'COMPLETED',
    method: 'CREDIT_CARD',
    amount: 125,
    tipAmount: 10,
    processorData: {},
  }
}

function targetDevice(type: TerminalType) {
  return {
    id: 'device-row-1',
    serialNumber: type === TerminalType.TPV_ANDROID ? 'AVQD-SERIAL-1' : 'DEVICE-SERIAL-1',
    type,
    customerDisplayPresent: null,
    customerDisplayInvertible: null,
    displayModeProtocolVersion: null,
    capabilitiesObservedAt: null,
  }
}

describe('MCP list_devices capability projection', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses the canonical capabilities while preserving authorized deviceUid and display state', async () => {
    const request = { requestId: 'request-1', desiredInverted: false, status: 'PENDING' }
    prismaMock.terminal.findMany.mockResolvedValue([
      {
        id: 'pos-1',
        name: 'Sunmi mostrador',
        type: TerminalType.POS_ANDROID,
        status: 'ACTIVE',
        brand: 'SUNMI',
        model: 'T2S',
        modelIdentifier: null,
        formFactor: DeviceFormFactor.COUNTERTOP_POS,
        osVersion: '13',
        version: '3.2.0',
        serialNumber: 'SUNMI-1',
        deviceUid: 'authorized-device-uid',
        selfRegistered: true,
        firstSeenAt: new Date('2026-08-01T12:00:00.000Z'),
        lastHeartbeat: new Date('2026-08-30T11:59:00.000Z'),
        lastStaffId: null,
        customerDisplayPresent: true,
        customerDisplayInvertible: true,
        displayModeProtocolVersion: 1,
        capabilitiesObservedAt: OBSERVED_AT,
        customerDisplayInverted: true,
        customerDisplayRequest: request,
        customerDisplayRequestVersion: 5,
        venue: { name: 'Sucursal Centro' },
      },
    ])

    const response = await captureListDevicesHandler()({ venueId: 'venue-1' })
    const body = JSON.parse(response.content[0].text)

    expect(prismaMock.terminal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          deviceUid: true,
          customerDisplayPresent: true,
          customerDisplayInvertible: true,
          displayModeProtocolVersion: true,
          capabilitiesObservedAt: true,
          customerDisplayInverted: true,
          customerDisplayRequest: true,
          customerDisplayRequestVersion: true,
        }),
      }),
    )
    expect(body.devices[0]).toEqual(
      expect.objectContaining({
        deviceUid: 'authorized-device-uid',
        customerDisplayInverted: true,
        customerDisplayRequest: request,
        customerDisplayRequestVersion: 5,
        capabilities: {
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
          // Qué ajustes puede cambiar este aparato desde su propia pantalla de Configuración.
          // Un POS Android sólo obedece las pantallas del cobro; el catálogo completo es de las
          // terminales de COBRO (`device-capabilities.service.ts`).
          configurableSettings: ['showReviewScreen', 'showTipScreen', 'tipSuggestions'],
        },
      }),
    )
  })
})

describe('MCP refund_card_on_terminal device action capability guard', () => {
  const requestRefundOnTerminal = terminalPaymentService.requestRefundOnTerminal as jest.Mock

  beforeEach(() => {
    prismaMock.payment.findFirst.mockResolvedValue(eligibleCardPayment())
    prismaMock.terminal.findFirst.mockResolvedValue(targetDevice(TerminalType.TPV_ANDROID))
    requestRefundOnTerminal.mockResolvedValue({ status: 'opened', requestId: 'refund-request-1' })
  })

  it.each([
    {
      label: 'internal id',
      terminalId: 'device-row-1',
      expectedLookup: { id: 'device-row-1' },
    },
    {
      label: 'case-insensitive stored serial',
      terminalId: 'avqd-serial-1',
      expectedLookup: { serialNumber: { equals: 'avqd-serial-1', mode: 'insensitive' } },
    },
    {
      label: 'bare TPV Android serial normalized to AVQD-',
      terminalId: 'serial-1',
      expectedLookup: {
        type: TerminalType.TPV_ANDROID,
        serialNumber: { equals: 'AVQD-serial-1', mode: 'insensitive' },
      },
    },
  ])('resolves the target by $label inside the requested venue', async ({ terminalId, expectedLookup }) => {
    const response = await captureRefundHandler()({
      venueId: 'venue-1',
      paymentId: 'payment-1',
      terminalId,
    })

    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: { in: ['venue-1'] },
          OR: expect.arrayContaining([expectedLookup]),
        }),
        select: {
          id: true,
          serialNumber: true,
          type: true,
          customerDisplayPresent: true,
          customerDisplayInvertible: true,
          displayModeProtocolVersion: true,
          capabilitiesObservedAt: true,
        },
      }),
    )
    expect(parseBody(response)).toMatchObject({ ok: false, requiresConfirmation: true })
  })

  it('returns the same not-found response for an absent or other-venue target without calling the low-level service', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null)

    const response = await captureRefundHandler()({
      venueId: 'venue-1',
      paymentId: 'payment-1',
      terminalId: 'device-from-another-venue',
      confirm: true,
    })

    expect(parseBody(response)).toEqual({
      ok: false,
      code: 'DEVICE_NOT_FOUND',
      error: 'No encontré ese dispositivo en tu local.',
    })
    expect(requestRefundOnTerminal).not.toHaveBeenCalled()
  })

  it('preserves payment eligibility rejection before looking up a target device', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({
      ...eligibleCardPayment(),
      method: 'CASH',
    })

    const response = await captureRefundHandler()({
      venueId: 'venue-1',
      paymentId: 'payment-1',
      terminalId: 'device-row-1',
    })

    expect(parseBody(response)).toEqual({
      ok: false,
      reason: 'NOT_A_CARD_PAYMENT',
      error: 'La terminal sólo puede devolver cobros con tarjeta.',
    })
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    expect(requestRefundOnTerminal).not.toHaveBeenCalled()
  })

  it.each([
    TerminalType.TPV_IOS,
    TerminalType.POS_ANDROID,
    TerminalType.POS_IOS,
    TerminalType.POS_DESKTOP,
    TerminalType.KDS,
    TerminalType.PRINTER_RECEIPT,
    TerminalType.PRINTER_KITCHEN,
  ])('rejects unsupported %s before returning a confirmation preview', async type => {
    prismaMock.terminal.findFirst.mockResolvedValue(targetDevice(type))

    const response = await captureRefundHandler()({
      venueId: 'venue-1',
      paymentId: 'payment-1',
      terminalId: 'device-row-1',
    })
    const body = parseBody(response)

    expect(body).toMatchObject({ ok: false, code: 'DEVICE_ACTION_UNSUPPORTED' })
    expect(body).not.toHaveProperty('requiresConfirmation')
    expect(body).not.toHaveProperty('preview')
    expect(requestRefundOnTerminal).not.toHaveBeenCalled()
  })

  it('rejects an unsupported confirmed target before the low-level refund call', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(targetDevice(TerminalType.POS_ANDROID))

    const response = await captureRefundHandler()({
      venueId: 'venue-1',
      paymentId: 'payment-1',
      terminalId: 'pos-row-1',
      confirm: true,
    })

    expect(parseBody(response)).toMatchObject({ ok: false, code: 'DEVICE_ACTION_UNSUPPORTED' })
    expect(requestRefundOnTerminal).not.toHaveBeenCalled()
  })

  it('preserves the TPV Android confirmation preview after target validation', async () => {
    const response = await captureRefundHandler()({
      venueId: 'venue-1',
      paymentId: 'payment-1',
      terminalId: 'serial-1',
      reason: 'Producto defectuoso',
    })

    expect(parseBody(response)).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      preview: {
        paymentId: 'payment-1',
        terminalId: 'serial-1',
        maxRefundable: 135,
        reason: 'Producto defectuoso',
      },
    })
    expect(requestRefundOnTerminal).not.toHaveBeenCalled()
  })

  it('preserves the caller-provided registry identity on confirmed TPV Android refunds', async () => {
    const response = await captureRefundHandler()({
      venueId: 'venue-1',
      paymentId: 'payment-1',
      terminalId: 'serial-1',
      reason: 'Producto defectuoso',
      confirm: true,
    })

    expect(requestRefundOnTerminal).toHaveBeenCalledWith({
      terminalId: 'serial-1',
      venueId: 'venue-1',
      paymentId: 'payment-1',
      requestedBy: 'staff-1',
      reason: 'Producto defectuoso',
    })
    expect(parseBody(response)).toMatchObject({ ok: true, status: 'opened', requestId: 'refund-request-1' })
  })
})

/**
 * `terminal_checkout_screens` — «¿esta tablet sigue pidiendo calificación?».
 *
 * 🔴 Lo que se fija aquí es la interpretación del dato, que es donde una lectura mentiría: un
 * ajuste AUSENTE en `Terminal.config.settings` significa «el default del servidor», que está
 * ENCENDIDO. Leerlo como apagado le diría a soporte que el negocio ya lo apagó cuando no lo hizo,
 * y la búsqueda del problema arrancaría en el lugar equivocado.
 */
describe('MCP terminal_checkout_screens', () => {
  function captureHandler() {
    let handler: ((input: Record<string, unknown>) => Promise<any>) | undefined
    const server = {
      tool: (name: string, _description: string, _schema: unknown, candidate: typeof handler) => {
        if (name === 'terminal_checkout_screens') handler = candidate
      },
    }
    registerTerminalTools(server as any, { allowedVenueIds: ['venue-1'], staffId: 'staff-1' } as any)
    if (!handler) throw new Error('terminal_checkout_screens handler was not registered')
    return handler
  }

  function device(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pos-1',
      name: 'Tablet mostrador',
      type: TerminalType.POS_ANDROID,
      config: {},
      venue: { name: 'Sucursal Centro' },
      ...overrides,
    }
  }

  it('un ajuste ausente se reporta ENCENDIDO: es el default del servidor, no un apagado', async () => {
    prismaMock.terminal.findMany.mockResolvedValue([device({ config: {} })] as any)

    const body = parseBody(await captureHandler()({ venueId: 'venue-1' }))

    expect(body.devices[0].asksForRating.enabled).toBe(true)
    expect(body.devices[0].asksForTip.enabled).toBe(true)
  })

  it('refleja lo que el negocio apagó, sin tocar el otro ajuste', async () => {
    prismaMock.terminal.findMany.mockResolvedValue([device({ config: { settings: { showReviewScreen: false } } })] as any)

    const body = parseBody(await captureHandler()({ venueId: 'venue-1' }))

    expect(body.devices[0].asksForRating.enabled).toBe(false)
    expect(body.devices[0].asksForTip.enabled).toBe(true)
  })

  it('dice si ese aparato lo puede cambiar desde su propia pantalla, y eso depende del TIPO', async () => {
    prismaMock.terminal.findMany.mockResolvedValue([
      device({ id: 'pos-1', type: TerminalType.POS_ANDROID }),
      device({ id: 'pax-1', type: TerminalType.TPV_ANDROID }),
      device({ id: 'kds-1', type: TerminalType.KDS }),
    ] as any)

    const body = parseBody(await captureHandler()({ venueId: 'venue-1' }))
    const byId = Object.fromEntries(body.devices.map((d: any) => [d.id, d]))

    expect(byId['pos-1'].asksForRating.configurable).toBe(true)
    // La PAX lo tiene en su catálogo (lo edita el dashboard), una pantalla de cocina no.
    expect(byId['pax-1'].asksForRating.configurable).toBe(true)
    expect(byId['kds-1'].asksForRating.configurable).toBe(false)
  })

  it('está acotada: nunca trae más de 100 aparatos y excluye los retirados', async () => {
    prismaMock.terminal.findMany.mockResolvedValue([device()] as any)

    await captureHandler()({ venueId: 'venue-1' })

    expect(prismaMock.terminal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        where: expect.objectContaining({ status: { not: 'RETIRED' } }),
      }),
    )
  })
})
