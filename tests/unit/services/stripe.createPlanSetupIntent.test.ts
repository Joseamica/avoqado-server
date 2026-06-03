const mockSetupIntentCreate = jest.fn()
const mockCustomerCreate = jest.fn()
const mockCustomerRetrieve = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    setupIntents: { create: mockSetupIntentCreate },
    customers: { create: mockCustomerCreate, retrieve: mockCustomerRetrieve, update: jest.fn() },
  })),
)
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findUnique: jest.fn().mockResolvedValue({ id: 'v1', email: 'a@b.com', name: 'V', slug: 'v', stripeCustomerId: 'cus_1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  },
}))

import { createPlanSetupIntent } from '../../../src/services/stripe.service'

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  mockSetupIntentCreate.mockResolvedValue({ id: 'seti_1', client_secret: 'seti_1_secret' })
  mockCustomerRetrieve.mockResolvedValue({ id: 'cus_1', deleted: false })
})

it('creates a customer-scoped SetupIntent and returns its client_secret', async () => {
  const secret = await createPlanSetupIntent('v1')
  expect(secret).toBe('seti_1_secret')
  const arg = mockSetupIntentCreate.mock.calls[0][0]
  expect(arg.customer).toBe('cus_1')
  expect(arg.payment_method_types).toEqual(['card'])
  expect(arg.usage).toBe('off_session')
})
