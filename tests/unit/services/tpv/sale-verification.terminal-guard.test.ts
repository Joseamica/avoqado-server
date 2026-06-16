/**
 * Terminal guard: a REJECTED ("Rechazada") sale cannot be modified from the TPV.
 *
 * Asana 1215725049493387 — "Rechazada" is a lost sale (couldn't link/port, customer
 * gone). Unlike FAILED ("Revisar"), the promoter must NOT be able to revive it by
 * re-uploading evidence; only an admin can reopen it via the dashboard edit. Enforced
 * server-side so it holds regardless of TPV app version.
 */

import { createOrUpdateProofOfSale } from '@/services/tpv/sale-verification.service'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findFirst: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    saleVerification: { findFirst: jest.fn(), update: jest.fn() },
  },
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn() },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const mockedPaymentFindFirst = prisma.payment.findFirst as jest.Mock
const mockedStaffVenueFindFirst = prisma.staffVenue.findFirst as jest.Mock
const mockedSvUpdate = prisma.saleVerification.update as jest.Mock
const mockedIsModuleEnabled = moduleService.isModuleEnabled as jest.Mock

const VENUE_ID = 'venue-1'
const PAYMENT_ID = 'pay-1'
const STAFF_ID = 'staff-1'

beforeEach(() => {
  jest.clearAllMocks()
  mockedStaffVenueFindFirst.mockResolvedValue({ id: 'sv-row', staffId: STAFF_ID, venueId: VENUE_ID })
  mockedIsModuleEnabled.mockResolvedValue(true) // serialized inventory → back-office review
})

it('blocks re-upload on a REJECTED sale (terminal) and never writes', async () => {
  mockedPaymentFindFirst.mockResolvedValue({
    id: PAYMENT_ID,
    venueId: VENUE_ID,
    saleVerification: { id: 'ver-1', venueId: VENUE_ID, status: 'REJECTED', photos: [], isPortabilidad: false, reviewedAt: new Date() },
  })

  await expect(createOrUpdateProofOfSale(VENUE_ID, PAYMENT_ID, ['https://x/photo.jpg'], STAFF_ID)).rejects.toMatchObject({
    message: expect.stringMatching(/rechazada y no puede modificarse/i),
  })

  expect(mockedSvUpdate).not.toHaveBeenCalled()
})

it('still allows re-upload on a FAILED sale ("Revisar" is correctable)', async () => {
  mockedPaymentFindFirst.mockResolvedValue({
    id: PAYMENT_ID,
    venueId: VENUE_ID,
    saleVerification: { id: 'ver-1', venueId: VENUE_ID, status: 'FAILED', photos: [], isPortabilidad: false, reviewedAt: new Date() },
  })
  mockedSvUpdate.mockResolvedValue({
    id: 'ver-1',
    venueId: VENUE_ID,
    paymentId: PAYMENT_ID,
    staffId: STAFF_ID,
    photos: ['https://x/photo.jpg'],
    status: 'PENDING',
    scannedProducts: [],
    inventoryDeducted: false,
    deviceId: null,
    notes: null,
    isPortabilidad: false,
    rejectionReasons: [],
    reviewNotes: null,
    reviewedById: null,
    reviewedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  await createOrUpdateProofOfSale(VENUE_ID, PAYMENT_ID, ['https://x/photo.jpg'], STAFF_ID)

  // FAILED → re-upload returns it to the review queue (PENDING)
  expect(mockedSvUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING' }) }),
  )
})
