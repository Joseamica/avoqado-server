/**
 * Marketing Service Unit Tests
 *
 * Basic tests for the marketing campaign functionality.
 * Tests template and campaign CRUD operations.
 */

import { CampaignStatus, DeliveryStatus, StaffRole } from '@prisma/client'

// Mock Prisma client
const mockPrisma = {
  emailTemplate: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  marketingCampaign: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
  },
  campaignDelivery: {
    createMany: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  venue: {
    findMany: jest.fn(),
  },
  staff: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn((updates: unknown[]) => Promise.all(updates)),
}

// Mock Resend
const mockResendSend = jest.fn()
const mockResend = {
  emails: {
    send: mockResendSend,
  },
}

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: mockPrisma,
}))

jest.mock('resend', () => ({
  Resend: jest.fn(() => mockResend),
}))

// Import after mocks
import * as marketingService from '../../../../src/services/superadmin/marketing.superadmin.service'

describe('Marketing Service', () => {
  const testUserId = 'test-staff-123'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Templates', () => {
    const mockTemplate = {
      id: 'template-1',
      name: 'Test Template',
      subject: 'Test Subject',
      bodyHtml: '<p>Hello {{name}}</p>',
      bodyText: 'Hello {{name}}',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: testUserId,
      creator: {
        id: testUserId,
        firstName: 'Test',
        lastName: 'User',
        email: 'test@test.com',
      },
    }

    describe('createTemplate', () => {
      it('should create a new template', async () => {
        mockPrisma.emailTemplate.create.mockResolvedValue(mockTemplate)

        const result = await marketingService.createTemplate({
          name: 'Test Template',
          subject: 'Test Subject',
          bodyHtml: '<p>Hello {{name}}</p>',
          bodyText: 'Hello {{name}}',
          createdBy: testUserId,
        })

        expect(mockPrisma.emailTemplate.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            name: 'Test Template',
            subject: 'Test Subject',
            createdBy: testUserId,
          }),
          include: expect.any(Object),
        })
        expect(result).toEqual(mockTemplate)
      })
    })

    describe('listTemplates', () => {
      it('should list templates with pagination', async () => {
        const templates = [mockTemplate]
        mockPrisma.emailTemplate.findMany.mockResolvedValue(templates)
        mockPrisma.emailTemplate.count.mockResolvedValue(1)

        const result = await marketingService.listTemplates({ limit: 10, offset: 0 })

        expect(mockPrisma.emailTemplate.findMany).toHaveBeenCalled()
        expect(result.templates).toEqual(templates)
        expect(result.total).toBe(1)
      })

      it('should filter templates by search query', async () => {
        mockPrisma.emailTemplate.findMany.mockResolvedValue([mockTemplate])
        mockPrisma.emailTemplate.count.mockResolvedValue(1)

        await marketingService.listTemplates({ search: 'Test' })

        expect(mockPrisma.emailTemplate.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              OR: expect.arrayContaining([
                { name: { contains: 'Test', mode: 'insensitive' } },
                { subject: { contains: 'Test', mode: 'insensitive' } },
              ]),
            }),
          }),
        )
      })
    })

    describe('updateTemplate', () => {
      it('should update an existing template', async () => {
        const updatedTemplate = { ...mockTemplate, name: 'Updated Name' }
        mockPrisma.emailTemplate.update.mockResolvedValue(updatedTemplate)

        const result = await marketingService.updateTemplate('template-1', {
          name: 'Updated Name',
        })

        expect(mockPrisma.emailTemplate.update).toHaveBeenCalledWith({
          where: { id: 'template-1' },
          data: { name: 'Updated Name' },
          include: expect.any(Object),
        })
        expect(result.name).toBe('Updated Name')
      })
    })

    describe('deleteTemplate', () => {
      it('should delete a template', async () => {
        mockPrisma.marketingCampaign.count.mockResolvedValue(0)
        mockPrisma.emailTemplate.delete.mockResolvedValue(mockTemplate)

        await marketingService.deleteTemplate('template-1')

        expect(mockPrisma.emailTemplate.delete).toHaveBeenCalledWith({
          where: { id: 'template-1' },
        })
      })

      it('should unlink campaigns before deleting template', async () => {
        mockPrisma.marketingCampaign.count.mockResolvedValue(2)
        mockPrisma.marketingCampaign.updateMany.mockResolvedValue({ count: 2 })
        mockPrisma.emailTemplate.delete.mockResolvedValue(mockTemplate)

        await marketingService.deleteTemplate('template-1')

        expect(mockPrisma.marketingCampaign.updateMany).toHaveBeenCalledWith({
          where: { templateId: 'template-1' },
          data: { templateId: null },
        })
        expect(mockPrisma.emailTemplate.delete).toHaveBeenCalled()
      })
    })
  })

  describe('Campaigns', () => {
    const mockCampaign = {
      id: 'campaign-1',
      name: 'Test Campaign',
      subject: 'Test Subject',
      bodyHtml: '<p>Hello</p>',
      bodyText: 'Hello',
      templateId: null,
      targetAllVenues: true,
      targetVenueIds: [],
      includeStaff: false,
      targetStaffRoles: [],
      status: CampaignStatus.DRAFT,
      scheduledFor: null,
      startedAt: null,
      completedAt: null,
      totalRecipients: 0,
      sentCount: 0,
      failedCount: 0,
      openedCount: 0,
      clickedCount: 0,
      createdAt: new Date(),
      createdBy: testUserId,
      creator: {
        id: testUserId,
        firstName: 'Test',
        lastName: 'User',
        email: 'test@test.com',
      },
      template: null,
    }

    describe('createCampaign', () => {
      it('should create a new campaign as draft', async () => {
        mockPrisma.marketingCampaign.create.mockResolvedValue(mockCampaign)

        const result = await marketingService.createCampaign({
          name: 'Test Campaign',
          subject: 'Test Subject',
          bodyHtml: '<p>Hello</p>',
          bodyText: 'Hello',
          targetAllVenues: true,
          targetVenueIds: [],
          includeStaff: false,
          targetStaffRoles: [],
          createdBy: testUserId,
        })

        expect(mockPrisma.marketingCampaign.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            name: 'Test Campaign',
            status: 'DRAFT',
            createdBy: testUserId,
          }),
          include: expect.any(Object),
        })
        expect(result.status).toBe(CampaignStatus.DRAFT)
      })
    })

    describe('getCampaign', () => {
      it('should return campaign with relations', async () => {
        mockPrisma.marketingCampaign.findUnique.mockResolvedValue(mockCampaign)

        const result = await marketingService.getCampaign('campaign-1')

        expect(mockPrisma.marketingCampaign.findUnique).toHaveBeenCalledWith({
          where: { id: 'campaign-1' },
          include: expect.any(Object),
        })
        expect(result).toEqual(mockCampaign)
      })

      it('should return null for non-existent campaign', async () => {
        mockPrisma.marketingCampaign.findUnique.mockResolvedValue(null)

        const result = await marketingService.getCampaign('non-existent')

        expect(result).toBeNull()
      })
    })

    describe('listCampaigns', () => {
      it('should list campaigns with pagination', async () => {
        const campaigns = [mockCampaign]
        mockPrisma.marketingCampaign.findMany.mockResolvedValue(campaigns)
        mockPrisma.marketingCampaign.count.mockResolvedValue(1)

        const result = await marketingService.listCampaigns({ limit: 10, offset: 0 })

        expect(result.campaigns).toEqual(campaigns)
        expect(result.total).toBe(1)
      })

      it('should filter by status array', async () => {
        mockPrisma.marketingCampaign.findMany.mockResolvedValue([mockCampaign])
        mockPrisma.marketingCampaign.count.mockResolvedValue(1)

        await marketingService.listCampaigns({ status: [CampaignStatus.DRAFT] })

        expect(mockPrisma.marketingCampaign.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ status: { in: [CampaignStatus.DRAFT] } }),
          }),
        )
      })
    })

    describe('deleteCampaign', () => {
      it('should delete a draft campaign', async () => {
        mockPrisma.marketingCampaign.findUnique.mockResolvedValue(mockCampaign)
        mockPrisma.marketingCampaign.delete.mockResolvedValue(mockCampaign)

        await marketingService.deleteCampaign('campaign-1')

        expect(mockPrisma.marketingCampaign.delete).toHaveBeenCalledWith({
          where: { id: 'campaign-1' },
        })
      })

      it('should throw error when campaign not found', async () => {
        mockPrisma.marketingCampaign.findUnique.mockResolvedValue(null)

        await expect(marketingService.deleteCampaign('non-existent')).rejects.toThrow('Campaign not found')
      })

      it('should allow deleting completed campaigns', async () => {
        const completedCampaign = { ...mockCampaign, status: CampaignStatus.COMPLETED }
        mockPrisma.marketingCampaign.findUnique.mockResolvedValue(completedCampaign)
        mockPrisma.marketingCampaign.delete.mockResolvedValue(completedCampaign)

        await marketingService.deleteCampaign('campaign-1')

        expect(mockPrisma.marketingCampaign.delete).toHaveBeenCalledWith({
          where: { id: 'campaign-1' },
        })
      })
    })

    describe('updateCampaign', () => {
      it('should update a draft campaign', async () => {
        mockPrisma.marketingCampaign.findUnique.mockResolvedValue(mockCampaign)
        mockPrisma.marketingCampaign.update.mockResolvedValue({ ...mockCampaign, name: 'Updated' })

        const result = await marketingService.updateCampaign('campaign-1', { name: 'Updated' })

        expect(mockPrisma.marketingCampaign.update).toHaveBeenCalled()
        expect(result.name).toBe('Updated')
      })

      it('should throw error when updating non-draft campaign', async () => {
        const sendingCampaign = { ...mockCampaign, status: CampaignStatus.SENDING }
        mockPrisma.marketingCampaign.findUnique.mockResolvedValue(sendingCampaign)

        await expect(marketingService.updateCampaign('campaign-1', { name: 'Updated' })).rejects.toThrow(
          'Cannot update campaign that is not in DRAFT status',
        )
      })
    })
  })

  describe('Webhook Handling', () => {
    const mockDelivery = {
      id: 'd1',
      campaignId: 'campaign-1',
      resendId: 'resend-123',
      recipientEmail: 'test@test.com',
      recipientName: 'Test',
      status: DeliveryStatus.SENT,
      openedAt: null,
      clickedAt: null,
      clickedLinks: [],
    }

    it('should update delivery on email.opened event', async () => {
      mockPrisma.campaignDelivery.findFirst.mockResolvedValue(mockDelivery)
      mockPrisma.campaignDelivery.update.mockResolvedValue({ ...mockDelivery, openedAt: new Date() })
      mockPrisma.marketingCampaign.update.mockResolvedValue({})

      await marketingService.handleResendWebhook({
        type: 'email.opened',
        data: {
          email_id: 'resend-123',
          to: ['test@test.com'],
          from: 'noreply@avoqado.io',
          created_at: new Date().toISOString(),
        },
      })

      expect(mockPrisma.campaignDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { openedAt: expect.any(Date) },
      })
    })

    it('should update delivery on email.clicked event', async () => {
      mockPrisma.campaignDelivery.findFirst.mockResolvedValue(mockDelivery)
      mockPrisma.campaignDelivery.update.mockResolvedValue({
        ...mockDelivery,
        clickedAt: new Date(),
        clickedLinks: ['https://example.com'],
      })
      mockPrisma.marketingCampaign.update.mockResolvedValue({})

      await marketingService.handleResendWebhook({
        type: 'email.clicked',
        data: {
          email_id: 'resend-123',
          to: ['test@test.com'],
          from: 'noreply@avoqado.io',
          created_at: new Date().toISOString(),
          click: { link: 'https://example.com', timestamp: new Date().toISOString() },
        },
      })

      expect(mockPrisma.campaignDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: expect.objectContaining({
          clickedAt: expect.any(Date),
          clickedLinks: expect.arrayContaining(['https://example.com']),
        }),
      })
    })

    it('should update delivery status on email.bounced event', async () => {
      mockPrisma.campaignDelivery.findFirst.mockResolvedValue(mockDelivery)
      mockPrisma.campaignDelivery.update.mockResolvedValue({ ...mockDelivery, status: DeliveryStatus.BOUNCED })
      mockPrisma.marketingCampaign.update.mockResolvedValue({})

      await marketingService.handleResendWebhook({
        type: 'email.bounced',
        data: {
          email_id: 'resend-123',
          to: ['test@test.com'],
          from: 'noreply@avoqado.io',
          created_at: new Date().toISOString(),
        },
      })

      expect(mockPrisma.campaignDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { status: DeliveryStatus.BOUNCED },
      })
    })

    it('should not update if delivery not found', async () => {
      mockPrisma.campaignDelivery.findFirst.mockResolvedValue(null)

      await marketingService.handleResendWebhook({
        type: 'email.opened',
        data: {
          email_id: 'unknown-123',
          to: ['test@test.com'],
          from: 'noreply@avoqado.io',
          created_at: new Date().toISOString(),
        },
      })

      expect(mockPrisma.campaignDelivery.update).not.toHaveBeenCalled()
    })
  })

  describe('Bulk Delete', () => {
    it('should delete multiple campaigns by IDs', async () => {
      mockPrisma.marketingCampaign.count.mockResolvedValue(2)
      mockPrisma.marketingCampaign.deleteMany.mockResolvedValue({ count: 2 })

      const result = await marketingService.bulkDeleteCampaigns({ ids: ['c1', 'c2'] })

      expect(mockPrisma.marketingCampaign.deleteMany).toHaveBeenCalled()
      expect(result.deletedCount).toBe(2)
    })

    it('should filter by status when provided', async () => {
      mockPrisma.marketingCampaign.count.mockResolvedValue(1)
      mockPrisma.marketingCampaign.deleteMany.mockResolvedValue({ count: 1 })

      const result = await marketingService.bulkDeleteCampaigns({ status: [CampaignStatus.DRAFT] })

      expect(mockPrisma.marketingCampaign.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          status: { in: [CampaignStatus.DRAFT] },
        }),
      })
      expect(result.deletedCount).toBe(1)
    })
  })
})
