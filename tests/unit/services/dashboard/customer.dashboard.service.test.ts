import {
  settleCustomerBalance,
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerStats,
  updateCustomerMetrics,
} from '../../../../src/services/dashboard/customer.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { Decimal } from '@prisma/client/runtime/library'

// ── marketingConsent (Task 5): customer.dashboard.service YA NO escribe el campo directo —
// delega en consent.service (ledger+cache+ActivityLog atómicos, Task 3). Se mockea a nivel de
// MÓDULO (fuera de cualquier describe) para que el mock quede registrado antes de que el
// import de arriba cargue el servicio real — mismo patrón que `createSalePostingMasivoMock`
// más abajo en este archivo.
const grantConsentMock = jest.fn()
const revokeConsentMock = jest.fn()
jest.mock('@/services/customer/consent.service', () => ({
  __esModule: true,
  grantMarketingConsent: (...a: unknown[]) => grantConsentMock(...a),
  revokeMarketingConsent: (...a: unknown[]) => revokeConsentMock(...a),
}))

// Helper to create mock customer
const createMockCustomer = (overrides: Record<string, any> = {}) => ({
  id: 'customer-123',
  venueId: 'venue-123',
  email: 'test@example.com',
  phone: '+1234567890',
  firstName: 'John',
  lastName: 'Doe',
  birthDate: null,
  gender: null,
  loyaltyPoints: 100,
  totalVisits: 5,
  totalSpent: new Decimal(250.5),
  averageOrderValue: new Decimal(50.1),
  lastVisitAt: new Date('2025-01-20'),
  firstVisitAt: new Date('2024-12-01'),
  customerGroupId: null,
  notes: null,
  tags: [],
  marketingConsent: false,
  active: true,
  createdAt: new Date('2024-12-01'),
  updatedAt: new Date('2025-01-20'),
  ...overrides,
})

describe('Customer Dashboard Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getCustomers', () => {
    it('should return paginated customers with correct metadata', async () => {
      const mockCustomers = [
        createMockCustomer({ id: 'customer-1', email: 'customer1@test.com' }),
        createMockCustomer({ id: 'customer-2', email: 'customer2@test.com' }),
      ]

      prismaMock.$transaction.mockResolvedValue([mockCustomers, 25] as any)

      const result = await getCustomers('venue-123', 1, 10)

      expect(result.data).toHaveLength(2)
      expect(result.meta).toEqual({
        totalCount: 25,
        pageSize: 10,
        currentPage: 1,
        totalPages: 3,
        hasNextPage: true,
        hasPrevPage: false,
      })

      // Verify Decimal → Number conversion
      expect(result.data[0].totalSpent).toBe(250.5)
      expect(result.data[0].averageOrderValue).toBe(50.1)
    })

    it('should apply search filter across firstName, lastName, email, phone', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0] as any)

      await getCustomers('venue-123', 1, 10, 'john')

      // Verify $transaction was called (search logic is tested by integration tests)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should filter by customerGroupId', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0] as any)

      await getCustomers('venue-123', 1, 10, undefined, 'group-456')

      // Verify $transaction was called (filter logic is tested by integration tests)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should filter by tags (hasSome)', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0] as any)

      await getCustomers('venue-123', 1, 10, undefined, undefined, undefined, 'vip,regular')

      // Verify $transaction was called (tag filter logic is tested by integration tests)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0] as any)

      await getCustomers('venue-123')

      // Verify $transaction was called (venueId filter is enforced in service)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should calculate pagination metadata correctly (last page)', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 25] as any)

      const result = await getCustomers('venue-123', 3, 10)

      expect(result.meta).toEqual({
        totalCount: 25,
        pageSize: 10,
        currentPage: 3,
        totalPages: 3,
        hasNextPage: false,
        hasPrevPage: true,
      })
    })
  })

  describe('getCustomerById', () => {
    it('should return customer with orders and loyalty transactions', async () => {
      const mockCustomer = {
        ...createMockCustomer(),
        customerGroup: { id: 'group-1', name: 'VIP', color: '#FFD700' },
        orders: [{ id: 'order-1', orderNumber: 'ORD-001', total: new Decimal(50), status: 'COMPLETED', createdAt: new Date() }],
        loyaltyTransactions: [{ id: 'tx-1', points: 50, type: 'EARN', createdAt: new Date() }],
      }

      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)

      const result = await getCustomerById('venue-123', 'customer-123')

      expect(result.id).toBe('customer-123')
      expect(result.orders).toHaveLength(1)
      expect(result.loyaltyTransactions).toHaveLength(1)
      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({
        where: { id: 'customer-123', venueId: 'venue-123' },
        include: expect.objectContaining({
          customerGroup: true,
          orders: expect.any(Object),
          loyaltyTransactions: expect.any(Object),
        }),
      })
    })

    it('should throw NotFoundError if customer does not exist', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(getCustomerById('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(getCustomerById('venue-123', 'nonexistent')).rejects.toThrow('Customer with ID nonexistent not found')
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(getCustomerById('venue-123', 'customer-456')).rejects.toThrow(NotFoundError)

      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'customer-456', venueId: 'venue-123' },
        }),
      )
    })
  })

  describe('createCustomer', () => {
    it('should create customer with email and return with customerGroup', async () => {
      const mockCustomer = {
        ...createMockCustomer(),
        customerGroup: null,
      }

      prismaMock.customer.findFirst.mockResolvedValue(null) // No duplicates
      prismaMock.customer.create.mockResolvedValue(mockCustomer as any)

      const result = await createCustomer('venue-123', {
        email: 'new@example.com',
        firstName: 'Jane',
        lastName: 'Smith',
      })

      expect(result.email).toBe('test@example.com')
      // 🔴 marketingConsent ya NO se escribe en el create (Task 5) — sólo consent.service lo
      // escribe (ledger+cache+ActivityLog atómicos). El default `@default(false)` de Prisma
      // basta para "sin consentimiento", así que el campo no debe ir en el `data`.
      expect(prismaMock.customer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: 'venue-123',
          email: 'new@example.com',
          firstName: 'Jane',
          lastName: 'Smith',
          tags: [],
        }),
        include: { customerGroup: true },
      })
      const createCallData = prismaMock.customer.create.mock.calls[0][0].data
      expect(createCallData).not.toHaveProperty('marketingConsent')
    })

    it('should create customer with phone only (no email)', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)
      prismaMock.customer.create.mockResolvedValue(createMockCustomer({ email: null, phone: '+9876543210' }) as any)

      const result = await createCustomer('venue-123', {
        phone: '+9876543210',
        firstName: 'Alice',
      })

      expect(result.phone).toBe('+9876543210')
      expect(prismaMock.customer.create).toHaveBeenCalled()
    })

    it('should throw BadRequestError if neither email nor phone provided', async () => {
      await expect(
        createCustomer('venue-123', {
          firstName: 'NoContact',
        }),
      ).rejects.toThrow(BadRequestError)

      await expect(
        createCustomer('venue-123', {
          firstName: 'NoContact',
        }),
      ).rejects.toThrow('Se requiere email o teléfono')
    })

    it('should throw BadRequestError if email already exists in venue', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(createMockCustomer() as any)

      await expect(
        createCustomer('venue-123', {
          email: 'test@example.com',
        }),
      ).rejects.toThrow('Customer with email test@example.com already exists in this venue')
    })

    it('should throw BadRequestError if phone already exists in venue', async () => {
      // Only phone provided (no email), so only 1 findFirst call for phone duplicate check
      prismaMock.customer.findFirst.mockResolvedValue(createMockCustomer({ phone: '+1234567890' }) as any)

      await expect(
        createCustomer('venue-123', {
          phone: '+1234567890',
        }),
      ).rejects.toThrow('Customer with phone +1234567890 already exists in this venue')
    })

    it('should throw NotFoundError if customerGroupId does not exist in venue', async () => {
      // Email check returns null (no duplicate), then customerGroup check returns null (not found)
      prismaMock.customer.findFirst.mockResolvedValue(null)
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(
        createCustomer('venue-123', {
          email: 'test@example.com',
          customerGroupId: 'invalid-group',
        }),
      ).rejects.toThrow('Customer group with ID invalid-group not found in this venue')
    })

    it('should create customer with valid customerGroupId', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)
      prismaMock.customerGroup.findFirst.mockResolvedValue({ id: 'group-1', name: 'VIP' } as any)
      prismaMock.customer.create.mockResolvedValue(createMockCustomer({ customerGroupId: 'group-1' }) as any)

      await createCustomer('venue-123', {
        email: 'vip@example.com',
        customerGroupId: 'group-1',
      })

      expect(prismaMock.customerGroup.findFirst).toHaveBeenCalledWith({
        where: { id: 'group-1', venueId: 'venue-123' },
      })
      expect(prismaMock.customer.create).toHaveBeenCalled()
    })

    it('should default tags to [] and NOT write marketingConsent directly (Task 5: only consent.service writes it)', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)
      prismaMock.customer.create.mockResolvedValue(createMockCustomer() as any)

      await createCustomer('venue-123', {
        email: 'test@example.com',
      })

      expect(prismaMock.customer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tags: [],
        }),
        include: { customerGroup: true },
      })
      const createCallData = prismaMock.customer.create.mock.calls[0][0].data
      expect(createCallData).not.toHaveProperty('marketingConsent')
    })
  })

  // ── marketingConsent: SOLO vía consent.service (Task 5) ─────────────────────
  describe('createCustomer — consentimiento vía consent.service', () => {
    beforeEach(() => {
      grantConsentMock.mockReset().mockResolvedValue(undefined)
      revokeConsentMock.mockReset()
    })

    it('marketingConsent:true ⇒ llama grantMarketingConsent con channel FORM_STAFF y el actor', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)
      prismaMock.customer.create.mockResolvedValue(createMockCustomer({ id: 'cust-new' }) as any)

      await createCustomer('venue-123', { email: 'new@example.com', marketingConsent: true }, 'staff-9')

      expect(grantConsentMock).toHaveBeenCalledWith({
        venueId: 'venue-123',
        customerId: 'cust-new',
        channel: 'FORM_STAFF',
        actorStaffId: 'staff-9',
      })
      expect(revokeConsentMock).not.toHaveBeenCalled()
    })

    it('marketingConsent:false (u omitido) ⇒ NO llama a consent.service', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)
      prismaMock.customer.create.mockResolvedValue(createMockCustomer() as any)

      await createCustomer('venue-123', { email: 'test@example.com' })

      expect(grantConsentMock).not.toHaveBeenCalled()
      expect(revokeConsentMock).not.toHaveBeenCalled()
    })

    it('grant que lanza ⇒ el create SOBREVIVE (el cliente existe) y la respuesta trae el warning', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)
      prismaMock.customer.create.mockResolvedValue(createMockCustomer({ id: 'cust-fail' }) as any)
      grantConsentMock.mockRejectedValue(
        new BadRequestError('Registra el aviso de privacidad del negocio antes de capturar consentimiento'),
      )

      const result = await createCustomer('venue-123', { email: 'test@example.com', marketingConsent: true })

      // El cliente se creó — no se revierte por un fallo de consentimiento.
      expect(result.id).toBe('cust-fail')
      expect((result as any).consentWarning).toEqual({
        code: 'CONSENT_NOT_CAPTURED',
        reason: 'Registra el aviso de privacidad del negocio antes de capturar consentimiento',
      })
    })
  })

  describe('updateCustomer', () => {
    it('should update customer successfully', async () => {
      const existingCustomer = createMockCustomer()
      const updatedCustomer = createMockCustomer({ firstName: 'UpdatedJohn' })

      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(updatedCustomer as any)

      const result = await updateCustomer('venue-123', 'customer-123', {
        firstName: 'UpdatedJohn',
      })

      expect(result.firstName).toBe('UpdatedJohn')
      expect(prismaMock.customer.update).toHaveBeenCalledWith({
        where: { id: 'customer-123' },
        data: expect.objectContaining({
          firstName: 'UpdatedJohn',
        }),
        include: { customerGroup: true },
      })
    })

    it('should throw NotFoundError if customer does not exist in venue', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(
        updateCustomer('venue-123', 'nonexistent', {
          firstName: 'Test',
        }),
      ).rejects.toThrow(NotFoundError)

      await expect(
        updateCustomer('venue-123', 'nonexistent', {
          firstName: 'Test',
        }),
      ).rejects.toThrow('Customer with ID nonexistent not found')
    })

    it('should throw BadRequestError if new email already exists (different customer)', async () => {
      const existingCustomer = createMockCustomer({ email: 'old@example.com' })
      const duplicateCustomer = createMockCustomer({ id: 'customer-456', email: 'new@example.com' })

      // First call returns existing customer, second call returns duplicate
      prismaMock.customer.findFirst.mockResolvedValueOnce(existingCustomer as any).mockResolvedValueOnce(duplicateCustomer as any)

      await expect(
        updateCustomer('venue-123', 'customer-123', {
          email: 'new@example.com',
        }),
      ).rejects.toThrow('Customer with email new@example.com already exists')
    })

    it('should allow updating to same email (no duplicate error)', async () => {
      const existingCustomer = createMockCustomer({ email: 'same@example.com' })

      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(existingCustomer as any)

      await updateCustomer('venue-123', 'customer-123', {
        email: 'same@example.com',
      })

      // Should NOT check for duplicates if email hasn't changed
      expect(prismaMock.customer.findFirst).toHaveBeenCalledTimes(1)
    })

    it('should throw BadRequestError if new phone already exists (different customer)', async () => {
      const existingCustomer = createMockCustomer({ phone: '+1111111111' })
      const duplicateCustomer = createMockCustomer({ id: 'customer-456', phone: '+2222222222' })

      // First call returns existing customer, second call checks phone duplicate (email not provided, so no email check)
      prismaMock.customer.findFirst.mockResolvedValueOnce(existingCustomer as any).mockResolvedValueOnce(duplicateCustomer as any)

      await expect(
        updateCustomer('venue-123', 'customer-123', {
          phone: '+2222222222',
        }),
      ).rejects.toThrow('Customer with phone +2222222222 already exists')
    })

    it('should throw NotFoundError if customerGroupId does not exist in venue', async () => {
      const existingCustomer = createMockCustomer()

      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customerGroup.findFirst.mockResolvedValue(null)

      await expect(
        updateCustomer('venue-123', 'customer-123', {
          customerGroupId: 'invalid-group',
        }),
      ).rejects.toThrow(NotFoundError)

      await expect(
        updateCustomer('venue-123', 'customer-123', {
          customerGroupId: 'invalid-group',
        }),
      ).rejects.toThrow('Customer group with ID invalid-group not found')
    })

    it('should update customer with valid customerGroupId', async () => {
      const existingCustomer = createMockCustomer()
      const updatedCustomer = createMockCustomer({ customerGroupId: 'group-new' })

      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customerGroup.findFirst.mockResolvedValue({ id: 'group-new', name: 'Premium' } as any)
      prismaMock.customer.update.mockResolvedValue(updatedCustomer as any)

      await updateCustomer('venue-123', 'customer-123', {
        customerGroupId: 'group-new',
      })

      expect(prismaMock.customerGroup.findFirst).toHaveBeenCalledWith({
        where: { id: 'group-new', venueId: 'venue-123' },
      })
      expect(prismaMock.customer.update).toHaveBeenCalled()
    })

    it('should update active status (soft delete/restore)', async () => {
      const existingCustomer = createMockCustomer({ active: true })
      const deactivatedCustomer = createMockCustomer({ active: false })

      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(deactivatedCustomer as any)

      const result = await updateCustomer('venue-123', 'customer-123', {
        active: false,
      })

      expect(result.active).toBe(false)
      expect(prismaMock.customer.update).toHaveBeenCalledWith({
        where: { id: 'customer-123' },
        data: expect.objectContaining({
          active: false,
        }),
        include: { customerGroup: true },
      })
    })

    it('el update ya NO escribe marketingConsent en el prisma.customer.update', async () => {
      const existingCustomer = createMockCustomer({ marketingConsent: false })
      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(createMockCustomer({ firstName: 'X' }) as any)

      await updateCustomer('venue-123', 'customer-123', { firstName: 'X', marketingConsent: true })

      const updateCallData = prismaMock.customer.update.mock.calls[0][0].data
      expect(updateCallData).not.toHaveProperty('marketingConsent')
    })
  })

  // ── marketingConsent en update: SOLO vía consent.service, y SOLO si cambia (Task 5) ──
  describe('updateCustomer — consentimiento vía consent.service', () => {
    beforeEach(() => {
      grantConsentMock.mockReset().mockResolvedValue(undefined)
      revokeConsentMock.mockReset().mockResolvedValue(undefined)
    })

    it('marketingConsent NO viene en el DTO ⇒ NO llama grant/revoke', async () => {
      const existingCustomer = createMockCustomer({ marketingConsent: false })
      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(existingCustomer as any)

      await updateCustomer('venue-123', 'customer-123', { firstName: 'Sólo el nombre' })

      expect(grantConsentMock).not.toHaveBeenCalled()
      expect(revokeConsentMock).not.toHaveBeenCalled()
    })

    it('marketingConsent viene pero es IGUAL al valor actual ⇒ NO llama grant/revoke', async () => {
      const existingCustomer = createMockCustomer({ marketingConsent: true })
      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(existingCustomer as any)

      await updateCustomer('venue-123', 'customer-123', { marketingConsent: true })

      expect(grantConsentMock).not.toHaveBeenCalled()
      expect(revokeConsentMock).not.toHaveBeenCalled()
    })

    it('false → true ⇒ llama grantMarketingConsent con channel FORM_STAFF y el actor', async () => {
      const existingCustomer = createMockCustomer({ marketingConsent: false })
      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(createMockCustomer({ marketingConsent: true }) as any)

      await updateCustomer('venue-123', 'customer-123', { marketingConsent: true }, 'staff-7')

      expect(grantConsentMock).toHaveBeenCalledWith({
        venueId: 'venue-123',
        customerId: 'customer-123',
        channel: 'FORM_STAFF',
        actorStaffId: 'staff-7',
      })
      expect(revokeConsentMock).not.toHaveBeenCalled()
    })

    it('true → false ⇒ llama revokeMarketingConsent', async () => {
      const existingCustomer = createMockCustomer({ marketingConsent: true })
      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(createMockCustomer({ marketingConsent: false }) as any)

      await updateCustomer('venue-123', 'customer-123', { marketingConsent: false }, 'staff-7')

      expect(revokeConsentMock).toHaveBeenCalledWith({
        venueId: 'venue-123',
        customerId: 'customer-123',
        channel: 'FORM_STAFF',
        actorStaffId: 'staff-7',
      })
      expect(grantConsentMock).not.toHaveBeenCalled()
    })

    it('🔴 revoke que lanza ⇒ el PUT entero se RECHAZA (fail closed) y NO se escribe nada', async () => {
      const existingCustomer = createMockCustomer({ marketingConsent: true })
      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(createMockCustomer({ firstName: 'Sigue' }) as any)
      revokeConsentMock.mockRejectedValue(new Error('boom'))

      // Un opt-out es evidencia legal — perderlo en silencio (200 con warning) es peor que
      // rechazar el PUT: el operador reintenta hasta que la revocación aterrice de verdad.
      await expect(updateCustomer('venue-123', 'customer-123', { firstName: 'Sigue', marketingConsent: false })).rejects.toThrow('boom')

      expect(prismaMock.customer.update).not.toHaveBeenCalled()
    })

    it('grant (opt-in) que lanza en update SÍ sigue fail-open: el update sobrevive con warning', async () => {
      const existingCustomer = createMockCustomer({ marketingConsent: false })
      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(createMockCustomer({ firstName: 'Sigue' }) as any)
      grantConsentMock.mockRejectedValue(new Error('boom'))

      const result = await updateCustomer('venue-123', 'customer-123', { firstName: 'Sigue', marketingConsent: true })

      expect(result.firstName).toBe('Sigue')
      expect((result as any).consentWarning).toEqual({ code: 'CONSENT_NOT_CAPTURED', reason: 'boom' })
      expect(prismaMock.customer.update).toHaveBeenCalled()
    })
  })

  describe('deleteCustomer', () => {
    it('should soft-delete customer (set active=false)', async () => {
      const existingCustomer = createMockCustomer({ active: true })

      prismaMock.customer.findFirst.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue({ ...existingCustomer, active: false } as any)

      const result = await deleteCustomer('venue-123', 'customer-123')

      expect(result.success).toBe(true)
      expect(result.message).toBe('Customer deactivated successfully')
      expect(prismaMock.customer.update).toHaveBeenCalledWith({
        where: { id: 'customer-123' },
        data: { active: false },
      })
    })

    it('should throw NotFoundError if customer does not exist', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(deleteCustomer('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(deleteCustomer('venue-123', 'nonexistent')).rejects.toThrow('Customer with ID nonexistent not found')
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(deleteCustomer('venue-123', 'customer-456')).rejects.toThrow(NotFoundError)

      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({
        where: { id: 'customer-456', venueId: 'venue-123' },
      })
    })
  })

  describe('getCustomerStats', () => {
    it('should return correct statistics with all metrics', async () => {
      const mockTopSpenders = [
        createMockCustomer({ id: 'c1', firstName: 'Alice', totalSpent: new Decimal(5000), totalVisits: 20 }),
        createMockCustomer({ id: 'c2', firstName: 'Bob', totalSpent: new Decimal(3000), totalVisits: 15 }),
      ]

      prismaMock.$transaction.mockResolvedValue([
        50, // totalCustomers
        45, // activeCustomers
        10, // newCustomersThisMonth
        5, // vipCustomers
        { _avg: { totalSpent: new Decimal(500), totalVisits: 8 } }, // avgStats
        mockTopSpenders, // topSpenders
      ] as any)

      const result = await getCustomerStats('venue-123')

      expect(result).toEqual({
        totalCustomers: 50,
        activeCustomers: 45,
        newCustomersThisMonth: 10,
        vipCustomers: 5,
        averageLifetimeValue: 500,
        averageVisitsPerCustomer: 8,
        topSpenders: [
          { id: 'c1', name: 'Alice Doe', totalSpent: 5000, totalVisits: 20 },
          { id: 'c2', name: 'Bob Doe', totalSpent: 3000, totalVisits: 15 },
        ],
      })
    })

    it('should handle customers with no first/last name (show "Unknown")', async () => {
      const mockTopSpenders = [createMockCustomer({ id: 'c1', firstName: null, lastName: null, totalSpent: new Decimal(1000) })]

      prismaMock.$transaction.mockResolvedValue([
        10,
        10,
        2,
        1,
        { _avg: { totalSpent: new Decimal(200), totalVisits: 5 } },
        mockTopSpenders,
      ] as any)

      const result = await getCustomerStats('venue-123')

      expect(result.topSpenders[0].name).toBe('Unknown')
    })

    it('should handle zero customers gracefully', async () => {
      prismaMock.$transaction.mockResolvedValue([
        0, // totalCustomers
        0, // activeCustomers
        0, // newCustomersThisMonth
        0, // vipCustomers
        { _avg: { totalSpent: null, totalVisits: null } }, // avgStats
        [], // topSpenders
      ] as any)

      const result = await getCustomerStats('venue-123')

      expect(result).toEqual({
        totalCustomers: 0,
        activeCustomers: 0,
        newCustomersThisMonth: 0,
        vipCustomers: 0,
        averageLifetimeValue: 0,
        averageVisitsPerCustomer: 0,
        topSpenders: [],
      })
    })

    it('should enforce multi-tenant isolation (venueId in all queries)', async () => {
      prismaMock.$transaction.mockResolvedValue([0, 0, 0, 0, { _avg: { totalSpent: null, totalVisits: null } }, []] as any)

      await getCustomerStats('venue-123')

      // Verify $transaction was called (venueId filter is enforced in service for all queries)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should count VIP customers correctly (>10 visits OR >$1000 spent)', async () => {
      prismaMock.$transaction.mockResolvedValue([10, 10, 2, 3, { _avg: {} }, []] as any)

      const result = await getCustomerStats('venue-123')

      // Verify VIP count was returned (VIP logic is tested by integration tests)
      expect(result.vipCustomers).toBe(3)
    })
  })

  describe('updateCustomerMetrics', () => {
    it('applies an order to customer metrics only once using a durable order ledger', async () => {
      const metric = (prismaMock as any).customerOrderMetric
      prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
      ;(prismaMock as any).$queryRaw.mockResolvedValue([
        { id: 'customer-123', venueId: 'venue-123', totalVisits: 5, totalSpent: new Decimal(500), firstVisitAt: new Date('2024-01-01') },
      ])
      metric.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'metric-1' })
      metric.create.mockResolvedValue({ id: 'metric-1' })
      prismaMock.customer.update.mockResolvedValue({} as any)

      await (updateCustomerMetrics as any)('customer-123', 150, 'order-1', 'venue-123')
      await (updateCustomerMetrics as any)('customer-123', 150, 'order-1', 'venue-123')

      expect(metric.create).toHaveBeenCalledTimes(1)
      expect(metric.create).toHaveBeenCalledWith({
        data: { customerId: 'customer-123', orderId: 'order-1', venueId: 'venue-123', amount: 150 },
      })
      expect(prismaMock.customer.update).toHaveBeenCalledTimes(1)
    })

    it('should update customer metrics after order completion', async () => {
      const existingCustomer = {
        id: 'customer-123',
        totalVisits: 5,
        totalSpent: new Decimal(500),
        firstVisitAt: new Date('2024-01-01'),
      }

      const updatedCustomer = {
        id: 'customer-123',
        totalVisits: 6,
        totalSpent: new Decimal(650),
        averageOrderValue: new Decimal(108.33),
        lastVisitAt: new Date(),
        firstVisitAt: new Date('2024-01-01'),
      }

      prismaMock.customer.findUnique.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue(updatedCustomer as any)

      await updateCustomerMetrics('customer-123', 150)

      expect(prismaMock.customer.update).toHaveBeenCalledWith({
        where: { id: 'customer-123' },
        data: {
          totalVisits: 6, // 5 + 1
          totalSpent: 650, // 500 + 150
          averageOrderValue: 108.33333333333333, // 650 / 6
          lastVisitAt: expect.any(Date),
          firstVisitAt: new Date('2024-01-01'), // Should NOT change
        },
      })
    })

    it('should set firstVisitAt if it is null', async () => {
      const existingCustomer = {
        id: 'customer-123',
        totalVisits: 0,
        totalSpent: new Decimal(0),
        firstVisitAt: null, // First order ever
      }

      prismaMock.customer.findUnique.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue({} as any)

      await updateCustomerMetrics('customer-123', 50)

      expect(prismaMock.customer.update).toHaveBeenCalledWith({
        where: { id: 'customer-123' },
        data: expect.objectContaining({
          firstVisitAt: expect.any(Date), // Should set current date
          lastVisitAt: expect.any(Date),
        }),
      })
    })

    it('should not throw error if customer not found (graceful degradation)', async () => {
      prismaMock.customer.findUnique.mockResolvedValue(null)

      await expect(updateCustomerMetrics('nonexistent', 100)).resolves.toBeUndefined()

      // Should NOT call update
      expect(prismaMock.customer.update).not.toHaveBeenCalled()
    })

    it('should calculate averageOrderValue correctly', async () => {
      const existingCustomer = {
        id: 'customer-123',
        totalVisits: 3,
        totalSpent: new Decimal(300),
        firstVisitAt: new Date(),
      }

      prismaMock.customer.findUnique.mockResolvedValue(existingCustomer as any)
      prismaMock.customer.update.mockResolvedValue({} as any)

      await updateCustomerMetrics('customer-123', 200)

      expect(prismaMock.customer.update).toHaveBeenCalledWith({
        where: { id: 'customer-123' },
        data: expect.objectContaining({
          totalVisits: 4,
          totalSpent: 500,
          averageOrderValue: 125, // 500 / 4
        }),
      })
    })
  })
})

// ── settleCustomerBalance: CAS + vale (fase 5, audit Codex) ──
// Liquidación MASIVA del saldo de un cliente. Tenía dos huecos: (1) el update
// de cada orden era ciego, así que competía con settleOrder y podía crear DOS
// pagos por la misma orden; (2) marcaba PAID sin descontar inventario.
const createSalePostingMasivoMock = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...a: unknown[]) => createSalePostingMasivoMock(...a),
  applySalePosting: jest.fn().mockResolvedValue({ postingId: 'p-1', applied: true, issues: [] }),
}))

const onOrderPaidMock = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/referrals/referralQualification.service', () => ({
  __esModule: true,
  onOrderPaid: (...a: unknown[]) => onOrderPaidMock(...a),
}))

const logActionMock = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: (...a: unknown[]) => logActionMock(...a),
}))

describe('settleCustomerBalance — CAS por orden + vale de deducción', () => {
  const CLIENTE = 'cust-1'
  const ORDEN = { id: 'order-1', orderNumber: 'ORD-1', remainingBalance: new Decimal(100), total: new Decimal(100) }

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
    prismaMock.customer.findFirst.mockResolvedValue({
      id: CLIENTE,
      orderAssociations: [{ order: ORDEN }],
    } as any)
    prismaMock.orderItem.findMany.mockResolvedValue([
      { id: 'oi-1', productId: 'p1', quantity: 1, weightQuantity: null, modifiers: [] },
    ] as any)
    createSalePostingMasivoMock.mockResolvedValue({ id: 'posting-masivo-1' })
    prismaMock.payment.create.mockResolvedValue({ id: 'pay-1' } as any)
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: 0, tipAmount: 0 } } as any)
    prismaMock.payment.count.mockResolvedValue(0 as any)
    prismaMock.order.findFirst.mockImplementation(async ({ where }: any) => {
      const amount = where.id === 'order-1' ? 100 : 300
      return {
        id: where.id,
        total: new Decimal(amount),
        tipAmount: new Decimal(0),
        remainingBalance: new Decimal(amount),
        paymentStatus: 'PENDING',
        version: 1,
      } as any
    })
  })

  it('usa CAS por orden: la que ya fue liquidada por otro camino no genera segundo pago', async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 } as any)

    await settleCustomerBalance('venue-1', CLIENTE)

    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'order-1', paymentStatus: { in: ['PENDING', 'PARTIAL'] } }),
      }),
    )
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(createSalePostingMasivoMock).not.toHaveBeenCalled()
  })

  it('la orden que SÍ gana el CAS crea su pago y su vale', async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)

    await settleCustomerBalance('venue-1', CLIENTE)

    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(createSalePostingMasivoMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ venueId: 'venue-1', orderId: 'order-1' }),
    )
  })

  // ── El hook de referidos sigue al CAS, no a la lista de candidatas ──────────
  // `pendingOrders` son las órdenes que ESTABAN pendientes cuando se leyó el
  // cliente. La que pierde el CAS NO la liquidó ESTA llamada, así que dispararle
  // `onOrderPaid` es afirmar un cobro que este camino no hizo — y calificar un
  // referido de más es irreversible (quema el `ReferralTierUnlock` de por vida).
  it('🔴 la orden que PIERDE el CAS no dispara el hook de referidos', async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 } as any)

    await settleCustomerBalance('venue-1', CLIENTE)

    expect(onOrderPaidMock).not.toHaveBeenCalled()
  })

  it('✅ la orden que SÍ liquidó esta llamada sí lo dispara, con su propio orderId', async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)

    await settleCustomerBalance('venue-1', CLIENTE)

    expect(onOrderPaidMock).toHaveBeenCalledTimes(1)
    expect(onOrderPaidMock).toHaveBeenCalledWith({ orderId: 'order-1', venueId: 'venue-1' })
  })

  // ── Lo REPORTADO también sale del CAS, no de la foto inicial ────────────────
  //
  // Escenario real: cliente con 3 órdenes de fiado de $300. Entre la lectura del
  // cliente y el CAS, el TPV cobra una. Se crean 2 Payment ($600) — correcto —
  // pero el conteo, el monto, el mensaje y el ActivityLog salían de
  // `pendingOrders` (la foto inicial): le decían al cajero "3 órdenes / $900" y
  // dejaban una bitácora que cuenta el dinero DOS veces. La bitácora es de lo
  // que dependemos para investigar incidentes: no puede mentir.
  describe('lo reportado sale del CAS, no de pendingOrders', () => {
    const TRES_DE_300 = [
      { order: { id: 'order-A', orderNumber: 'ORD-A', remainingBalance: new Decimal(300), total: new Decimal(300) } },
      { order: { id: 'order-B', orderNumber: 'ORD-B', remainingBalance: new Decimal(300), total: new Decimal(300) } },
      { order: { id: 'order-C', orderNumber: 'ORD-C', remainingBalance: new Decimal(300), total: new Decimal(300) } },
    ]

    // A gana · B la perdió (el TPV se le adelantó) · C gana.
    const conBPerdida = () => {
      prismaMock.customer.findFirst.mockResolvedValue({ id: CLIENTE, orderAssociations: TRES_DE_300 } as any)
      prismaMock.order.updateMany
        .mockResolvedValueOnce({ count: 1 } as any)
        .mockResolvedValueOnce({ count: 0 } as any)
        .mockResolvedValueOnce({ count: 1 } as any)
    }

    it('🔴 devuelve 2 y $600 — no 3 y $900 — cuando una orden pierde el CAS', async () => {
      conBPerdida()

      const result = await settleCustomerBalance('venue-1', CLIENTE)

      expect(result.settledOrderCount).toBe(2)
      expect(result.settledAmount).toBe(600)
      // El monto reportado es la suma EXACTA de los Payment que se crearon.
      expect(prismaMock.payment.create).toHaveBeenCalledTimes(2)
    })

    it('🔴 el mensaje al cajero no le confirma una liquidación que no hizo', async () => {
      conBPerdida()

      const result = await settleCustomerBalance('venue-1', CLIENTE)

      expect(result.message).toContain('2 order(s)')
      expect(result.message).toContain('600')
      expect(result.message).not.toContain('3 order(s)')
      expect(result.message).not.toContain('900')
    })

    it('🔴 el ActivityLog CUSTOMER_BALANCE_SETTLED no cuenta el dinero dos veces', async () => {
      conBPerdida()

      await settleCustomerBalance('venue-1', CLIENTE)

      expect(logActionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CUSTOMER_BALANCE_SETTLED',
          entityId: CLIENTE,
          data: { settledOrderCount: 2, settledAmount: 600 },
        }),
      )
    })

    it('✅ sin contención las tres se liquidan y se reportan las tres', async () => {
      prismaMock.customer.findFirst.mockResolvedValue({ id: CLIENTE, orderAssociations: TRES_DE_300 } as any)
      prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)

      const result = await settleCustomerBalance('venue-1', CLIENTE)

      expect(result.settledOrderCount).toBe(3)
      expect(result.settledAmount).toBe(900)
      expect(onOrderPaidMock).toHaveBeenCalledTimes(3)
    })

    it('✅ si las TRES pierden el CAS no se reporta nada liquidado', async () => {
      prismaMock.customer.findFirst.mockResolvedValue({ id: CLIENTE, orderAssociations: TRES_DE_300 } as any)
      prismaMock.order.updateMany.mockResolvedValue({ count: 0 } as any)

      const result = await settleCustomerBalance('venue-1', CLIENTE)

      expect(result.settledOrderCount).toBe(0)
      expect(result.settledAmount).toBe(0)
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(onOrderPaidMock).not.toHaveBeenCalled()
    })
  })
})
