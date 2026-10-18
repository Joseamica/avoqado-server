jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    documentRequestDelivery: { findMany: jest.fn(), updateMany: jest.fn() },
    documentRequest: { updateMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('../../../src/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
import prisma from '../../../src/utils/prismaClient'
import emailService from '../../../src/services/email.service'
import { deliverNotifications, notificationEmail } from '../../../src/services/document-requests/notifications'
beforeEach(() => {
  ;(prisma.$transaction as jest.Mock).mockImplementation(fn => fn(prisma))
  ;(prisma.documentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
})

describe('durable onboarding notification', () => {
  test('HTML escapes payload, contains both logos, text and black CTA', () => {
    const mail = notificationEmail({ id: 'c1234567890123456789012345', version: 1, provider: '<script>', entityType: 'PERSONA_FISICA' })
    expect(mail.html).not.toContain('<script>')
    expect(mail.html.match(/isotipo.svg/g)).toHaveLength(2)
    expect(mail.html).toContain('background-color:#000000')
    expect(mail.text.length).toBeGreaterThan(20)
  })
  test('retries only unsent recipient with stable version-scoped key', async () => {
    const row = {
      id: 'c1234567890123456789012345',
      submissionVersion: 2,
      submittedAt: new Date(),
      attempts: 1,
      recipient: 'daniel@avoqado.io',
      status: 'PENDING',
      requestId: 'c1234567890123456789012345',
      firstAttemptAt: null,
      snapshot: { id: 'c1234567890123456789012345', version: 2, provider: 'ANGELPAY', entityType: 'PERSONA_FISICA' },
      notificationSnapshot: { id: 'c1234567890123456789012345', version: 2, provider: 'ANGELPAY', entityType: 'PERSONA_FISICA' },
    }
    ;(prisma.documentRequestDelivery.findMany as jest.Mock).mockResolvedValue([row])
    ;(prisma.documentRequestDelivery.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    ;(emailService.sendEmailWithResult as jest.Mock).mockResolvedValue({ ok: true, transient: false })
    await deliverNotifications()
    expect(emailService.sendEmailWithResult).toHaveBeenCalledTimes(1)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(emailService.sendEmailWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'daniel@avoqado.io', idempotencyKey: `document-request/${row.id}/2/daniel` }),
    )
  })
})

test('an expired retry window stops delivery and marks pending recipients UNKNOWN', async () => {
  jest.clearAllMocks()
  const row = {
    id: 'c1234567890123456789012345',
    status: 'SUBMITTED',
    submissionVersion: 1,
    firstAttemptAt: new Date(Date.now() - 24 * 3600000),
    attempts: 2,
    onboardingNotification: 'PENDING',
    danielNotification: 'PENDING',
  }
  ;(prisma.documentRequestDelivery.findMany as jest.Mock).mockResolvedValue([row])
  ;(prisma.documentRequestDelivery.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  await deliverNotifications()
  expect(emailService.sendEmailWithResult).not.toHaveBeenCalled()
  expect(prisma.documentRequestDelivery.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: 'UNKNOWN', nextAttemptAt: null }) }),
  )
})
test('a competing lease prevents delivery', async () => {
  jest.clearAllMocks()
  ;(prisma.documentRequestDelivery.findMany as jest.Mock).mockResolvedValue([{ id: 'c1234567890123456789012345', submissionVersion: 1 }])
  ;(prisma.documentRequestDelivery.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
  await deliverNotifications()
  expect(emailService.sendEmailWithResult).not.toHaveBeenCalled()
})
