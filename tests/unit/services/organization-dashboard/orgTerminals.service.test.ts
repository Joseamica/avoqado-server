import { prismaMock } from '@tests/__helpers__/setup'

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

const orgId = 'org-1'
const terminalId = 'term-1'
const staffId = 'staff-1'
const venueId = 'v1'

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

      await expect(sendCommandForOrg(orgId, terminalId, 'FACTORY_RESET' as any, staffId)).rejects.toThrow('Comando no permitido')
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
