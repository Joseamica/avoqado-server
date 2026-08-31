import { prismaMock } from '@tests/__helpers__/setup'
import { DeviceFormFactor, Prisma, TerminalType } from '@prisma/client'

// Mock superadmin terminal service
jest.mock('@/services/dashboard/terminals.superadmin.service', () => ({
  createTerminal: jest.fn(),
  updateTerminal: jest.fn(),
  deleteTerminal: jest.fn(),
  generateActivationCodeForTerminal: jest.fn(),
  sendRemoteActivation: jest.fn(),
}))

// Mock command queue service
jest.mock('@/services/tpv/command-queue.service', () => ({
  tpvCommandQueueService: {
    queueCommand: jest.fn(),
  },
}))

import {
  getTerminalForOrg,
  createTerminalForOrg,
  updateTerminalForOrg,
  deleteTerminalForOrg,
  generateActivationCodeForOrg,
  sendRemoteActivationForOrg,
  sendCommandForOrg,
  assignMerchantsForOrg,
  getOrgMerchantAccounts,
} from '@/services/organization-dashboard/orgTerminals.service'
import {
  createTerminal as superadminCreateTerminal,
  updateTerminal as superadminUpdateTerminal,
  deleteTerminal as superadminDeleteTerminal,
  generateActivationCodeForTerminal,
  sendRemoteActivation as superadminSendRemoteActivation,
} from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { ForbiddenError, NotFoundError } from '@/errors/AppError'
import { getTerminalsData, getTpvById } from '@/services/dashboard/tpv.dashboard.service'
import { registerTerminalTools } from '@/mcp/tools/terminals'

const NOW = new Date('2026-08-30T12:00:00.000Z')

const orgId = 'org-1'
const terminalId = 'term-1'
const staffId = 'staff-1'
const venueId = 'v1'

function projectPrismaSelect(row: Record<string, any>, select: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(select).map(([key, selection]) => {
      if (selection === true) return [key, row[key]]
      if (selection && typeof selection === 'object' && selection.select) {
        return [key, row[key] == null ? row[key] : projectPrismaSelect(row[key], selection.select)]
      }
      return [key, row[key]]
    }),
  )
}

function captureListDevicesHandler() {
  let handler: ((input: Record<string, unknown>) => Promise<any>) | undefined
  const server = {
    tool: (name: string, _description: string, _schema: unknown, candidate: typeof handler) => {
      if (name === 'list_devices') handler = candidate
    },
  }

  registerTerminalTools(server as any, { allowedVenueIds: [venueId], staffId } as any)

  if (!handler) throw new Error('list_devices handler was not registered')
  return handler
}

const mockTerminal = {
  id: terminalId,
  name: 'Terminal 1',
  serialNumber: 'AVQD-123456',
  type: 'TPV_ANDROID',
  status: 'ACTIVE',
  venueId,
  venue: { id: venueId, name: 'Store A', slug: 'store-a', organizationId: orgId },
}

const mockTerminalForeign = {
  id: 'term-foreign',
  name: 'Foreign Terminal',
  venueId: 'v-foreign',
  venue: { id: 'v-foreign', name: 'Other Store', slug: 'other', organizationId: 'org-other' },
}

describe('OrgTerminals Service', () => {
  afterEach(() => {
    jest.useRealTimers()
  })
  // ==========================================
  // ORG SCOPING VALIDATION
  // ==========================================

  describe('Org scoping - rejects foreign terminals', () => {
    it('should throw NotFoundError when terminal does not exist', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(null)

      await expect(getTerminalForOrg(orgId, 'nonexistent')).rejects.toThrow(NotFoundError)
    })

    it('should throw ForbiddenError when terminal belongs to another org', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminalForeign)

      await expect(getTerminalForOrg(orgId, 'term-foreign')).rejects.toThrow(ForbiddenError)
    })

    it('should succeed when terminal belongs to the org', async () => {
      prismaMock.terminal.findUnique
        .mockResolvedValueOnce(mockTerminal) // validateTerminalInOrg
        .mockResolvedValueOnce({
          ...mockTerminal,
          healthMetrics: [{ healthScore: 90 }],
        }) // getTerminalForOrg full fetch

      const result = await getTerminalForOrg(orgId, terminalId)

      expect(result).toBeDefined()
      expect(result!.id).toBe(terminalId)
    })

    it('projects capabilities and durable display state only after preserving org isolation', async () => {
      jest.useFakeTimers().setSystemTime(NOW)
      const orgScoped = {
        ...mockTerminal,
        type: 'POS_ANDROID',
        customerDisplayPresent: true,
        customerDisplayInvertible: true,
        displayModeProtocolVersion: 1,
        capabilitiesObservedAt: new Date('2026-08-30T11:00:00.000Z'),
        customerDisplayInverted: true,
        customerDisplayRequest: { requestId: 'request-1', desiredInverted: false },
        customerDisplayRequestVersion: 3,
        healthMetrics: [{ healthScore: 90 }],
      }
      prismaMock.terminal.findUnique.mockResolvedValueOnce(orgScoped).mockResolvedValueOnce(orgScoped)

      const result = await getTerminalForOrg(orgId, terminalId)

      expect(prismaMock.terminal.findUnique).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ where: { id: terminalId }, include: expect.any(Object) }),
      )
      expect(result).toEqual(
        expect.objectContaining({
          customerDisplayInverted: true,
          customerDisplayRequest: { requestId: 'request-1', desiredInverted: false },
          customerDisplayRequestVersion: 3,
          healthMetrics: [{ healthScore: 90 }],
          capabilities: expect.objectContaining({
            requiresActivation: false,
            customerDisplay: {
              presence: 'SUPPORTED',
              invertibility: 'SUPPORTED',
              canRequestInversion: true,
              observedAt: '2026-08-30T11:00:00.000Z',
              stale: false,
            },
          }),
        }),
      )
    })
  })

  describe('four-surface capability parity', () => {
    const observedAt = new Date('2026-08-30T11:00:00.000Z')
    const staleObservedAt = new Date('2026-08-23T11:59:59.999Z')
    const unsupportedDisplay = {
      presence: 'UNSUPPORTED',
      invertibility: 'UNSUPPORTED',
      canRequestInversion: false,
      observedAt: null,
      stale: false,
    }

    const cases = [
      {
        name: 'fresh invertible POS Android protocol v1',
        facts: {
          type: TerminalType.POS_ANDROID,
          customerDisplayPresent: true,
          customerDisplayInvertible: true,
          displayModeProtocolVersion: 1,
          capabilitiesObservedAt: observedAt,
        },
        requiresActivation: false,
        expectedDisplay: {
          presence: 'SUPPORTED',
          invertibility: 'SUPPORTED',
          canRequestInversion: true,
          observedAt: observedAt.toISOString(),
          stale: false,
        },
      },
      {
        name: 'stale POS Android facts',
        facts: {
          type: TerminalType.POS_ANDROID,
          customerDisplayPresent: true,
          customerDisplayInvertible: true,
          displayModeProtocolVersion: 1,
          capabilitiesObservedAt: staleObservedAt,
        },
        requiresActivation: false,
        expectedDisplay: {
          presence: 'UNKNOWN',
          invertibility: 'UNKNOWN',
          canRequestInversion: false,
          observedAt: staleObservedAt.toISOString(),
          stale: true,
        },
      },
      {
        name: 'fresh nullable POS Android facts',
        facts: {
          type: TerminalType.POS_ANDROID,
          customerDisplayPresent: null,
          customerDisplayInvertible: null,
          displayModeProtocolVersion: 1,
          capabilitiesObservedAt: observedAt,
        },
        requiresActivation: false,
        expectedDisplay: {
          presence: 'UNKNOWN',
          invertibility: 'UNKNOWN',
          canRequestInversion: false,
          observedAt: observedAt.toISOString(),
          stale: false,
        },
      },
      {
        name: 'TPV Android',
        facts: {
          type: TerminalType.TPV_ANDROID,
          customerDisplayPresent: null,
          customerDisplayInvertible: null,
          displayModeProtocolVersion: null,
          capabilitiesObservedAt: null,
        },
        requiresActivation: true,
        expectedDisplay: unsupportedDisplay,
      },
      {
        name: 'receipt printer',
        facts: {
          type: TerminalType.PRINTER_RECEIPT,
          customerDisplayPresent: null,
          customerDisplayInvertible: null,
          displayModeProtocolVersion: null,
          capabilitiesObservedAt: null,
        },
        requiresActivation: false,
        expectedDisplay: unsupportedDisplay,
      },
    ]

    it.each(cases)('deep-compares the same $name capabilities across all four surfaces', async testCase => {
      jest.useFakeTimers().setSystemTime(NOW)
      const request = { requestId: 'request-parity', desiredInverted: false, status: 'PENDING' }
      const row = {
        id: terminalId,
        venueId,
        name: 'Parity device',
        status: 'ACTIVE',
        brand: 'TEST',
        model: 'MODEL-1',
        modelIdentifier: null,
        formFactor: DeviceFormFactor.COUNTERTOP_POS,
        osVersion: '13',
        version: '3.2.0',
        serialNumber: 'PARITY-1',
        deviceUid: 'authorized-device-uid',
        selfRegistered: true,
        firstSeenAt: new Date('2026-08-01T12:00:00.000Z'),
        lastHeartbeat: new Date('2026-08-30T11:59:00.000Z'),
        lastStaffId: null,
        customerDisplayInverted: true,
        customerDisplayRequest: request,
        customerDisplayRequestVersion: 9,
        venue: { id: venueId, name: 'Store A', slug: 'store-a', organizationId: orgId },
        healthMetrics: [{ healthScore: 90 }],
        ...testCase.facts,
      }

      prismaMock.$transaction.mockResolvedValueOnce([[row], 1])
      prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
      prismaMock.payment.groupBy.mockResolvedValue([])
      const venueList = await getTerminalsData(venueId, 1, 20, {})

      prismaMock.terminal.findFirst.mockResolvedValue(row)
      const venueDetail = await getTpvById(venueId, terminalId)

      prismaMock.terminal.findUnique.mockResolvedValueOnce(row).mockResolvedValueOnce(row)
      const organizationDetail = await getTerminalForOrg(orgId, terminalId)

      prismaMock.terminal.findMany.mockImplementationOnce(async (query: Prisma.TerminalFindManyArgs) => [
        projectPrismaSelect(row, query.select ?? {}),
      ])
      const mcpResponse = await captureListDevicesHandler()({ venueId })
      const mcpDevice = JSON.parse(mcpResponse.content[0].text).devices[0]
      const venueListDevice = venueList.data[0]

      expect(venueListDevice).toHaveProperty('capabilities')
      if (!('capabilities' in venueListDevice)) throw new Error('Expected venue list projection to include capabilities')

      const capabilities = [
        venueListDevice.capabilities,
        venueDetail.capabilities,
        organizationDetail!.capabilities,
        mcpDevice.capabilities,
      ]
      for (const projected of capabilities.slice(1)) expect(projected).toEqual(capabilities[0])
      expect(capabilities[0]).toEqual(
        expect.objectContaining({
          requiresActivation: testCase.requiresActivation,
          customerDisplay: testCase.expectedDisplay,
        }),
      )

      const mcpSelect = prismaMock.terminal.findMany.mock.calls.at(-1)![0].select
      expect(mcpSelect).toEqual(
        expect.objectContaining({
          type: true,
          customerDisplayPresent: true,
          customerDisplayInvertible: true,
          displayModeProtocolVersion: true,
          capabilitiesObservedAt: true,
        }),
      )
    })
  })

  // ==========================================
  // CRUD OPERATIONS
  // ==========================================

  describe('createTerminalForOrg', () => {
    it('should validate venue belongs to org and delegate to superadmin', async () => {
      prismaMock.venue.findFirst.mockResolvedValue({ id: venueId, name: 'Store A' })
      ;(superadminCreateTerminal as jest.Mock).mockResolvedValue({
        terminal: mockTerminal,
        activationCode: null,
        autoAttachedMerchants: [],
      })

      const result = await createTerminalForOrg(
        orgId,
        {
          venueId,
          serialNumber: 'AVQD-123456',
          name: 'Terminal 1',
          type: 'TPV_ANDROID',
        },
        staffId,
      )

      expect(superadminCreateTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          venueId,
          serialNumber: 'AVQD-123456',
          name: 'Terminal 1',
          type: 'TPV_ANDROID',
          staffId,
        }),
      )
      expect(result.terminal).toBeDefined()
    })

    it('should reject when venue does not belong to org', async () => {
      prismaMock.venue.findFirst.mockResolvedValue(null)

      await expect(
        createTerminalForOrg(orgId, { venueId: 'foreign-venue', serialNumber: 'SN-1', name: 'T1', type: 'TPV_ANDROID' }, staffId),
      ).rejects.toThrow(ForbiddenError)
    })
  })

  describe('updateTerminalForOrg', () => {
    it('should validate terminal in org and delegate to superadmin', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminal)
      ;(superadminUpdateTerminal as jest.Mock).mockResolvedValue({ ...mockTerminal, name: 'Updated' })

      const result = await updateTerminalForOrg(orgId, terminalId, { name: 'Updated' })

      expect(superadminUpdateTerminal).toHaveBeenCalledWith(terminalId, { name: 'Updated' })
      expect(result.name).toBe('Updated')
    })

    it('should reject foreign terminal update', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminalForeign)

      await expect(updateTerminalForOrg(orgId, 'term-foreign', { name: 'Hack' })).rejects.toThrow(ForbiddenError)
    })
  })

  describe('deleteTerminalForOrg', () => {
    it('should validate terminal in org and delegate to superadmin', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminal)
      ;(superadminDeleteTerminal as jest.Mock).mockResolvedValue({ success: true })

      const result = await deleteTerminalForOrg(orgId, terminalId)

      expect(superadminDeleteTerminal).toHaveBeenCalledWith(terminalId)
      expect(result.success).toBe(true)
    })
  })

  // ==========================================
  // ACTIVATION
  // ==========================================

  describe('generateActivationCodeForOrg', () => {
    it('should validate and delegate to activation service', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminal)
      ;(generateActivationCodeForTerminal as jest.Mock).mockResolvedValue({
        activationCode: 'A3F9K2',
        expiresAt: new Date(),
      })

      const result = await generateActivationCodeForOrg(orgId, terminalId, staffId)

      expect(generateActivationCodeForTerminal).toHaveBeenCalledWith(terminalId, staffId)
      expect(result.activationCode).toBe('A3F9K2')
    })
  })

  describe('sendRemoteActivationForOrg', () => {
    it('should validate and delegate to remote activation', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminal)
      ;(superadminSendRemoteActivation as jest.Mock).mockResolvedValue({
        commandId: 'cmd-1',
        status: 'QUEUED',
      })

      const result = await sendRemoteActivationForOrg(orgId, terminalId, staffId)

      expect(superadminSendRemoteActivation).toHaveBeenCalledWith(terminalId, staffId)
      expect(result.commandId).toBe('cmd-1')
    })
  })

  // ==========================================
  // REMOTE COMMANDS
  // ==========================================

  describe('sendCommandForOrg', () => {
    it('should send allowed commands', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminal)
      ;(tpvCommandQueueService.queueCommand as jest.Mock).mockResolvedValue({
        commandId: 'cmd-1',
        correlationId: 'corr-1',
        status: 'QUEUED',
        queued: true,
        terminalOnline: true,
        message: 'Command queued',
      })

      const result = await sendCommandForOrg(orgId, terminalId, 'LOCK', staffId, 'John Doe')

      expect(tpvCommandQueueService.queueCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalId,
          venueId,
          commandType: 'LOCK',
          requestedBy: staffId,
          requestedByName: 'John Doe',
        }),
      )
      expect(result.queued).toBe(true)
    })

    it('should reject disallowed commands', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminal)

      await expect(sendCommandForOrg(orgId, terminalId, 'SHUTDOWN' as any, staffId)).rejects.toThrow('Comando no permitido')
    })

    it('should reject command for foreign terminal', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminalForeign)

      await expect(sendCommandForOrg(orgId, 'term-foreign', 'LOCK', staffId)).rejects.toThrow(ForbiddenError)
    })
  })

  // ==========================================
  // MERCHANT ASSIGNMENT
  // ==========================================

  describe('assignMerchantsForOrg', () => {
    it('should validate merchants in org and delegate update', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminal)
      prismaMock.venue.findMany.mockResolvedValue([{ id: venueId }])
      prismaMock.merchantAccount.findMany.mockResolvedValue([{ id: 'merch-1' }])
      ;(superadminUpdateTerminal as jest.Mock).mockResolvedValue({
        ...mockTerminal,
        assignedMerchantIds: ['merch-1'],
      })

      const result = await assignMerchantsForOrg(orgId, terminalId, ['merch-1'])

      expect(superadminUpdateTerminal).toHaveBeenCalledWith(terminalId, { assignedMerchantIds: ['merch-1'] })
      expect(result.assignedMerchantIds).toEqual(['merch-1'])
    })

    it('should reject merchants not belonging to org', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminal)
      prismaMock.venue.findMany.mockResolvedValue([{ id: venueId }])
      prismaMock.merchantAccount.findMany.mockResolvedValue([]) // No matching merchants

      await expect(assignMerchantsForOrg(orgId, terminalId, ['merch-unknown'])).rejects.toThrow(ForbiddenError)
    })

    it('should allow empty merchant array (clear assignments)', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(mockTerminal)
      ;(superadminUpdateTerminal as jest.Mock).mockResolvedValue({
        ...mockTerminal,
        assignedMerchantIds: [],
      })

      const result = await assignMerchantsForOrg(orgId, terminalId, [])

      expect(superadminUpdateTerminal).toHaveBeenCalledWith(terminalId, { assignedMerchantIds: [] })
      expect(result.assignedMerchantIds).toEqual([])
    })
  })

  // ==========================================
  // GET ORG MERCHANT ACCOUNTS
  // ==========================================

  describe('getOrgMerchantAccounts', () => {
    it('should return merchants linked to org venues', async () => {
      prismaMock.venue.findMany.mockResolvedValue([{ id: venueId }])
      prismaMock.merchantAccount.findMany.mockResolvedValue([
        {
          id: 'merch-1',
          displayName: 'Main Account',
          alias: 'main',
          externalMerchantId: 'ext-1',
          provider: { name: 'Blumon' },
          blumonSerialNumber: '123456',
        },
      ])

      const result = await getOrgMerchantAccounts(orgId)

      expect(result).toHaveLength(1)
      expect(result[0].displayName).toBe('Main Account')
      expect(prismaMock.merchantAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ active: true }),
        }),
      )
    })

    it('should return empty array for org with no merchants', async () => {
      prismaMock.venue.findMany.mockResolvedValue([{ id: venueId }])
      prismaMock.merchantAccount.findMany.mockResolvedValue([])

      const result = await getOrgMerchantAccounts(orgId)

      expect(result).toEqual([])
    })
  })

  // ==========================================
  // REGRESSION TESTS
  // ==========================================

  describe('Regression - org isolation maintained', () => {
    it('should always call validateTerminalInOrg before any write operation', async () => {
      // Attempting to update a non-existent terminal
      prismaMock.terminal.findUnique.mockResolvedValue(null)

      await expect(updateTerminalForOrg(orgId, 'nonexistent', { name: 'X' })).rejects.toThrow(NotFoundError)
      await expect(deleteTerminalForOrg(orgId, 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(generateActivationCodeForOrg(orgId, 'nonexistent', staffId)).rejects.toThrow(NotFoundError)
      await expect(sendRemoteActivationForOrg(orgId, 'nonexistent', staffId)).rejects.toThrow(NotFoundError)
      await expect(sendCommandForOrg(orgId, 'nonexistent', 'LOCK', staffId)).rejects.toThrow(NotFoundError)

      // superadmin functions should NOT have been called
      expect(superadminUpdateTerminal).not.toHaveBeenCalled()
      expect(superadminDeleteTerminal).not.toHaveBeenCalled()
      expect(generateActivationCodeForTerminal).not.toHaveBeenCalled()
      expect(superadminSendRemoteActivation).not.toHaveBeenCalled()
      expect(tpvCommandQueueService.queueCommand).not.toHaveBeenCalled()
    })

    it('should always validate venue in org before create', async () => {
      prismaMock.venue.findFirst.mockResolvedValue(null) // Venue not in org

      await expect(
        createTerminalForOrg(orgId, { venueId: 'v-hack', serialNumber: 'S', name: 'T', type: 'TPV_ANDROID' }, staffId),
      ).rejects.toThrow(ForbiddenError)

      expect(superadminCreateTerminal).not.toHaveBeenCalled()
    })
  })
})
