import {
  getOrCreateLoyaltyConfig,
  getLoyaltyConfig,
  updateLoyaltyConfig,
  calculatePointsForAmount,
  calculateDiscountFromPoints,
  getCustomerPointsBalance,
  canRedeemPoints,
  earnPoints,
  redeemPoints,
  adjustPoints,
  getLoyaltyTransactions,
  expireOldPoints,
} from '../../../../src/services/dashboard/loyalty.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'
import * as loyaltyMobileService from '../../../../src/services/mobile/loyalty.mobile.service'
import * as stampLedger from '../../../../src/services/wallet/stampLedger.service'
import { venueHasFeatureAccess } from '../../../../src/services/access/basePlan.service'

jest.mock('../../../../src/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

// El sellado se engancha DENTRO de earnPoints; aquí sólo se prueba que se llama
// bien y, sobre todo, que no puede romper la acumulación de puntos.
jest.mock('../../../../src/services/wallet/stampLedger.service', () => ({
  grantStamp: jest.fn().mockResolvedValue({ granted: false, reason: 'STAMPS_DISABLED' }),
}))

// El canje seguro vive en el servicio del POS; aquí sólo se prueba que el del panel delega.
jest.mock('../../../../src/services/mobile/loyalty.mobile.service', () => ({
  redeemPointsToOrder: jest.fn(),
}))
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'
import { LoyaltyTransactionType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

// Helper to create mock loyalty config
const createMockLoyaltyConfig = (overrides: Record<string, any> = {}) => ({
  id: 'config-123',
  venueId: 'venue-123',
  pointsPerDollar: new Decimal(1),
  pointsPerVisit: new Decimal(0),
  redemptionRate: new Decimal(0.01), // 100 points = $1
  minPointsRedeem: 100,
  pointsExpireDays: 365,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

// Helper to create mock customer with loyalty points
const createMockCustomer = (overrides: Record<string, any> = {}) => ({
  id: 'customer-123',
  venueId: 'venue-123',
  loyaltyPoints: 500,
  ...overrides,
})

// Helper to create mock loyalty transaction
const createMockTransaction = (overrides: Record<string, any> = {}) => ({
  id: 'tx-123',
  customerId: 'customer-123',
  type: LoyaltyTransactionType.EARN,
  points: 50,
  reason: 'Earned 50 points for purchase',
  orderId: 'order-123',
  createdById: null,
  createdAt: new Date(),
  ...overrides,
})

describe('Loyalty Dashboard Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
  })

  describe('getOrCreateLoyaltyConfig', () => {
    it('should return existing loyalty config with Decimal conversion', async () => {
      const mockConfig = createMockLoyaltyConfig()

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const result = await getOrCreateLoyaltyConfig('venue-123')

      expect(result.venueId).toBe('venue-123')
      expect(result.pointsPerDollar).toBe(1) // Decimal → Number
      expect(result.redemptionRate).toBe(0.01) // Decimal → Number
      expect(prismaMock.loyaltyConfig.findUnique).toHaveBeenCalledWith({
        where: { venueId: 'venue-123' },
      })
    })

    it('should create default config if none exists', async () => {
      const mockDefaultConfig = createMockLoyaltyConfig()

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(null)
      prismaMock.loyaltyConfig.create.mockResolvedValue(mockDefaultConfig as any)

      const result = await getOrCreateLoyaltyConfig('venue-123')

      expect(prismaMock.loyaltyConfig.create).toHaveBeenCalledWith({
        data: {
          venueId: 'venue-123',
          pointsPerDollar: 1,
          pointsPerVisit: 0,
          redemptionRate: 0.01,
          minPointsRedeem: 100,
          pointsExpireDays: 365,
          active: false,
        },
      })
      expect(result.pointsPerDollar).toBe(1)
      expect(result.redemptionRate).toBe(0.01)
    })
  })

  describe('getLoyaltyConfig', () => {
    it('should call getOrCreateLoyaltyConfig', async () => {
      const mockConfig = createMockLoyaltyConfig()

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const result = await getLoyaltyConfig('venue-123')

      expect(result.venueId).toBe('venue-123')
      expect(prismaMock.loyaltyConfig.findUnique).toHaveBeenCalledWith({
        where: { venueId: 'venue-123' },
      })
    })
  })

  describe('updateLoyaltyConfig', () => {
    it('should update loyalty config successfully', async () => {
      const existingConfig = createMockLoyaltyConfig()
      const updatedConfig = createMockLoyaltyConfig({ pointsPerDollar: new Decimal(2) })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(existingConfig as any)
      prismaMock.loyaltyConfig.update.mockResolvedValue(updatedConfig as any)

      const result = await updateLoyaltyConfig('venue-123', {
        pointsPerDollar: 2,
      })

      expect(result.pointsPerDollar).toBe(2)
      expect(prismaMock.loyaltyConfig.update).toHaveBeenCalledWith({
        where: { venueId: 'venue-123' },
        data: { pointsPerDollar: 2 },
      })
    })

    it('should throw BadRequestError if pointsPerDollar is negative', async () => {
      await expect(
        updateLoyaltyConfig('venue-123', {
          pointsPerDollar: -1,
        }),
      ).rejects.toThrow(BadRequestError)

      await expect(
        updateLoyaltyConfig('venue-123', {
          pointsPerDollar: -1,
        }),
      ).rejects.toThrow('Points per dollar must be non-negative')
    })

    it('should throw BadRequestError if pointsPerVisit is negative', async () => {
      await expect(
        updateLoyaltyConfig('venue-123', {
          pointsPerVisit: -5,
        }),
      ).rejects.toThrow(BadRequestError)

      await expect(
        updateLoyaltyConfig('venue-123', {
          pointsPerVisit: -5,
        }),
      ).rejects.toThrow('Points per visit must be non-negative')
    })

    it('should throw BadRequestError if redemptionRate is negative', async () => {
      await expect(
        updateLoyaltyConfig('venue-123', {
          redemptionRate: -0.01,
        }),
      ).rejects.toThrow(BadRequestError)

      await expect(
        updateLoyaltyConfig('venue-123', {
          redemptionRate: -0.01,
        }),
      ).rejects.toThrow('Redemption rate must be non-negative')
    })

    it('should throw BadRequestError if minPointsRedeem is negative', async () => {
      await expect(
        updateLoyaltyConfig('venue-123', {
          minPointsRedeem: -100,
        }),
      ).rejects.toThrow(BadRequestError)

      await expect(
        updateLoyaltyConfig('venue-123', {
          minPointsRedeem: -100,
        }),
      ).rejects.toThrow('Minimum redemption points must be non-negative')
    })

    it('should throw BadRequestError if pointsExpireDays is negative (not null)', async () => {
      await expect(
        updateLoyaltyConfig('venue-123', {
          pointsExpireDays: -30,
        }),
      ).rejects.toThrow(BadRequestError)

      await expect(
        updateLoyaltyConfig('venue-123', {
          pointsExpireDays: -30,
        }),
      ).rejects.toThrow('Points expiration days must be non-negative or null')
    })

    it('should allow pointsExpireDays to be null (no expiration)', async () => {
      const existingConfig = createMockLoyaltyConfig()
      const updatedConfig = createMockLoyaltyConfig({ pointsExpireDays: null })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(existingConfig as any)
      prismaMock.loyaltyConfig.update.mockResolvedValue(updatedConfig as any)

      const result = await updateLoyaltyConfig('venue-123', {
        pointsExpireDays: null,
      })

      expect(result.pointsExpireDays).toBeNull()
    })

    it('should create config if it does not exist before updating', async () => {
      const mockDefaultConfig = createMockLoyaltyConfig()
      const updatedConfig = createMockLoyaltyConfig({ active: false })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(null)
      prismaMock.loyaltyConfig.create.mockResolvedValue(mockDefaultConfig as any)
      prismaMock.loyaltyConfig.update.mockResolvedValue(updatedConfig as any)

      await updateLoyaltyConfig('venue-123', {
        active: false,
      })

      expect(prismaMock.loyaltyConfig.create).toHaveBeenCalled()
      expect(prismaMock.loyaltyConfig.update).toHaveBeenCalled()
    })
  })

  describe('calculatePointsForAmount', () => {
    it('should calculate points correctly (floor rounding)', async () => {
      const mockConfig = createMockLoyaltyConfig({ pointsPerDollar: new Decimal(1.5) })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const points = await calculatePointsForAmount('venue-123', 100)

      expect(points).toBe(150) // 100 * 1.5 = 150
    })

    it('should floor fractional points', async () => {
      const mockConfig = createMockLoyaltyConfig({ pointsPerDollar: new Decimal(1) })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const points = await calculatePointsForAmount('venue-123', 50.75)

      expect(points).toBe(50) // floor(50.75 * 1) = 50
    })

    it('should return 0 if loyalty config is inactive', async () => {
      const mockConfig = createMockLoyaltyConfig({ active: false })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const points = await calculatePointsForAmount('venue-123', 100)

      expect(points).toBe(0)
    })

    it('should return 0 for zero amount', async () => {
      const mockConfig = createMockLoyaltyConfig()

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const points = await calculatePointsForAmount('venue-123', 0)

      expect(points).toBe(0)
    })
  })

  describe('calculateDiscountFromPoints', () => {
    it('should calculate discount correctly', async () => {
      const mockConfig = createMockLoyaltyConfig({ redemptionRate: new Decimal(0.01) })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const discount = await calculateDiscountFromPoints('venue-123', 500, 100)

      expect(discount).toBe(5) // 500 * 0.01 = 5
    })

    it('should cap discount at order total', async () => {
      const mockConfig = createMockLoyaltyConfig({ redemptionRate: new Decimal(0.01) })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const discount = await calculateDiscountFromPoints('venue-123', 2000, 15)

      expect(discount).toBe(15) // 2000 * 0.01 = 20, but capped at orderTotal (15)
    })

    it('should return 0 if points < minPointsRedeem', async () => {
      const mockConfig = createMockLoyaltyConfig({ minPointsRedeem: 100 })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const discount = await calculateDiscountFromPoints('venue-123', 50, 100)

      expect(discount).toBe(0)
    })

    it('should return 0 if loyalty config is inactive', async () => {
      const mockConfig = createMockLoyaltyConfig({ active: false })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const discount = await calculateDiscountFromPoints('venue-123', 500, 100)

      expect(discount).toBe(0)
    })

    it('should round discount to 2 decimal places', async () => {
      const mockConfig = createMockLoyaltyConfig({ redemptionRate: new Decimal(0.01234) })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const discount = await calculateDiscountFromPoints('venue-123', 100, 50)

      expect(discount).toBe(1.23) // 100 * 0.01234 = 1.234 → 1.23
    })
  })

  describe('getCustomerPointsBalance', () => {
    it('should return customer loyalty points', async () => {
      const mockCustomer = createMockCustomer({ loyaltyPoints: 750 })

      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)

      const balance = await getCustomerPointsBalance('venue-123', 'customer-123')

      expect(balance).toBe(750)
      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({
        where: { id: 'customer-123', venueId: 'venue-123' },
        select: { loyaltyPoints: true },
      })
    })

    it('should throw NotFoundError if customer not found', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(getCustomerPointsBalance('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(getCustomerPointsBalance('venue-123', 'nonexistent')).rejects.toThrow('Customer not found')
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(getCustomerPointsBalance('venue-123', 'customer-456')).rejects.toThrow(NotFoundError)

      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({
        where: { id: 'customer-456', venueId: 'venue-123' },
        select: { loyaltyPoints: true },
      })
    })
  })

  describe('canRedeemPoints', () => {
    it('should return true if customer can redeem points', async () => {
      const mockConfig = createMockLoyaltyConfig({ minPointsRedeem: 100 })
      const mockCustomer = createMockCustomer({ loyaltyPoints: 500 })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)

      const canRedeem = await canRedeemPoints('venue-123', 'customer-123', 200)

      expect(canRedeem).toBe(true)
    })

    it('should return false if loyalty config is inactive', async () => {
      const mockConfig = createMockLoyaltyConfig({ active: false })
      const mockCustomer = createMockCustomer({ loyaltyPoints: 500 })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)

      const canRedeem = await canRedeemPoints('venue-123', 'customer-123', 200)

      expect(canRedeem).toBe(false)
    })

    it('should return false if points < minPointsRedeem', async () => {
      const mockConfig = createMockLoyaltyConfig({ minPointsRedeem: 100 })
      const mockCustomer = createMockCustomer({ loyaltyPoints: 500 })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)

      const canRedeem = await canRedeemPoints('venue-123', 'customer-123', 50)

      expect(canRedeem).toBe(false)
    })

    it('should return false if customer has insufficient balance', async () => {
      const mockConfig = createMockLoyaltyConfig({ minPointsRedeem: 100 })
      const mockCustomer = createMockCustomer({ loyaltyPoints: 150 })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)

      const canRedeem = await canRedeemPoints('venue-123', 'customer-123', 200)

      expect(canRedeem).toBe(false) // Trying to redeem 200, but only has 150
    })
  })

  describe('earnPoints', () => {
    it('does not create config or rewards when the venue has no paid loyalty access', async () => {
      ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)

      const result = await earnPoints('venue-123', 'customer-123', 100, 'order-123')

      expect(result).toEqual({ pointsEarned: 0, newBalance: 0 })
      expect(prismaMock.loyaltyConfig.findUnique).not.toHaveBeenCalled()
      expect(prismaMock.loyaltyConfig.create).not.toHaveBeenCalled()
      expect(stampLedger.grantStamp).not.toHaveBeenCalled()
    })

    it('should earn points and update balance atomically', async () => {
      const mockConfig = createMockLoyaltyConfig({ pointsPerDollar: new Decimal(1) })
      const mockTransaction = createMockTransaction({ points: 100 })
      const mockCustomer = { loyaltyPoints: 600 }

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.$transaction.mockResolvedValue([mockTransaction, mockCustomer] as any)

      const result = await earnPoints('venue-123', 'customer-123', 100, 'order-123', 'staff-123')

      expect(result.pointsEarned).toBe(100)
      expect(result.newBalance).toBe(600)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should return 0 if loyalty config is inactive', async () => {
      const mockConfig = createMockLoyaltyConfig({ active: false })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const result = await earnPoints('venue-123', 'customer-123', 100, 'order-123')

      expect(result.pointsEarned).toBe(0)
      expect(result.newBalance).toBe(0)
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it('should return 0 if calculated points are 0', async () => {
      const mockConfig = createMockLoyaltyConfig({ pointsPerDollar: new Decimal(1) })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const result = await earnPoints('venue-123', 'customer-123', 0, 'order-123')

      expect(result.pointsEarned).toBe(0)
      expect(result.newBalance).toBe(0)
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it('should create transaction with correct data', async () => {
      const mockConfig = createMockLoyaltyConfig()
      const mockTransaction = createMockTransaction({ points: 50 })
      const mockCustomer = { loyaltyPoints: 550 }

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.$transaction.mockResolvedValue([mockTransaction, mockCustomer] as any)

      const result = await earnPoints('venue-123', 'customer-123', 50, 'order-123', 'staff-123')

      // Verify transaction was created and balance updated
      expect(result.pointsEarned).toBe(50)
      expect(result.newBalance).toBe(550)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })
  })

  // 🔴 DINERO. `redeemPoints` quemaba los puntos y sólo DEVOLVÍA el monto del
  // descuento: nadie creaba el OrderDiscount, así que el cliente perdía su saldo
  // y la cuenta no bajaba un peso. El endpoint
  // `POST /api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/redeem`
  // está vivo en producción con permiso `loyalty:redeem`; hoy ninguna pantalla lo
  // dispara, pero el método ya existe en el dashboard (`loyalty.service.ts`)
  // esperando a que alguien lo conecte.
  //
  // Ahora delega en `redeemPointsToOrder`, que quema los puntos y crea el
  // OrderDiscount en la MISMA transacción, topa contra la base (subtotal −
  // descuentos, no total) y usa decremento condicional contra el doble canje
  // concurrente. Las validaciones (programa activo, saldo, mínimo, orden ya
  // pagada) viven allá y NO se duplican aquí — un segundo juego de reglas es
  // exactamente cómo nacieron los dos caminos divergentes.
  describe('redeemPoints', () => {
    const mockedRedeemToOrder = loyaltyMobileService.redeemPointsToOrder as jest.Mock

    beforeEach(() => {
      mockedRedeemToOrder.mockReset()
    })

    it('delega en el camino transaccional que SÍ crea el OrderDiscount', async () => {
      mockedRedeemToOrder.mockResolvedValue({
        pointsRedeemed: 200,
        discountAmount: 2,
        newBalance: 300,
        order: { total: 98 },
      })

      await redeemPoints('venue-123', 'customer-123', 200, 'order-123', 'staff-123')

      // Ojo con el orden: allá es (venueId, orderId, customerId, points, staffId),
      // aquí es (venueId, customerId, points, orderId, staffId). Invertirlos canjea
      // los puntos de la orden equivocada.
      expect(mockedRedeemToOrder).toHaveBeenCalledWith('venue-123', 'order-123', 'customer-123', 200, 'staff-123')
    })

    it('conserva los tres campos del contrato de la API', async () => {
      mockedRedeemToOrder.mockResolvedValue({
        pointsRedeemed: 200,
        discountAmount: 2,
        newBalance: 300,
        order: { total: 98 },
      })

      const result = await redeemPoints('venue-123', 'customer-123', 200, 'order-123', 'staff-123')

      // Clientes viejos siguen leyendo estos tres. `order` se agrega, no reemplaza.
      expect(result.pointsRedeemed).toBe(200)
      expect(result.discountAmount).toBe(2)
      expect(result.newBalance).toBe(300)
    })

    it('propaga el error del camino transaccional sin quemar puntos por su cuenta', async () => {
      mockedRedeemToOrder.mockRejectedValue(new BadRequestError('Puntos insuficientes: el cliente tiene 150'))

      // El mensaje EXACTO del delegado. El camino viejo tenía el suyo propio en
      // inglés ('Insufficient points. Customer has ...'), así que esta aserción es
      // lo que distingue delegar de volver a validar aquí: con el código anterior
      // el test pasaba igual, y por eso no probaba nada.
      await expect(redeemPoints('venue-123', 'customer-123', 200, 'order-123')).rejects.toThrow(
        'Puntos insuficientes: el cliente tiene 150',
      )

      // Y este servicio ya no abre ninguna transacción propia contra Postgres.
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })
  })

  describe('adjustPoints', () => {
    it('should adjust points (positive) and update balance atomically', async () => {
      const mockCustomer = createMockCustomer({ loyaltyPoints: 500 })
      const mockTransaction = createMockTransaction({ type: LoyaltyTransactionType.ADJUST, points: 100 })
      const updatedCustomer = { loyaltyPoints: 600 }

      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)
      prismaMock.$transaction.mockResolvedValue([mockTransaction, updatedCustomer] as any)

      const result = await adjustPoints('venue-123', 'customer-123', 100, 'Bonus points', 'staff-123')

      expect(result.newBalance).toBe(600)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should adjust points (negative penalty) successfully', async () => {
      const mockCustomer = createMockCustomer({ loyaltyPoints: 500 })
      const mockTransaction = createMockTransaction({ type: LoyaltyTransactionType.ADJUST, points: -50 })
      const updatedCustomer = { loyaltyPoints: 450 }

      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)
      prismaMock.$transaction.mockResolvedValue([mockTransaction, updatedCustomer] as any)

      const result = await adjustPoints('venue-123', 'customer-123', -50, 'Penalty', 'staff-123')

      expect(result.newBalance).toBe(450)
    })

    it('should throw NotFoundError if customer not found', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(adjustPoints('venue-123', 'nonexistent', 100, 'Bonus', 'staff-123')).rejects.toThrow(NotFoundError)

      await expect(adjustPoints('venue-123', 'nonexistent', 100, 'Bonus', 'staff-123')).rejects.toThrow('Customer not found')
    })

    it('should throw BadRequestError if adjustment would result in negative balance', async () => {
      const mockCustomer = createMockCustomer({ loyaltyPoints: 100 })

      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)

      await expect(adjustPoints('venue-123', 'customer-123', -150, 'Penalty', 'staff-123')).rejects.toThrow(BadRequestError)

      await expect(adjustPoints('venue-123', 'customer-123', -150, 'Penalty', 'staff-123')).rejects.toThrow(
        'Cannot adjust points. Would result in negative balance (-50)',
      )
    })

    it('should enforce multi-tenant isolation (venueId filter)', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(adjustPoints('venue-123', 'customer-456', 100, 'Bonus', 'staff-123')).rejects.toThrow(NotFoundError)

      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({
        where: { id: 'customer-456', venueId: 'venue-123' },
      })
    })
  })

  describe('getLoyaltyTransactions', () => {
    it('should return paginated loyalty transactions with Decimal conversion', async () => {
      const mockCustomer = createMockCustomer()
      const mockTransactions = [
        {
          ...createMockTransaction({ id: 'tx-1', points: 50 }),
          order: { id: 'order-1', orderNumber: 'ORD-001', total: new Decimal(50), createdAt: new Date() },
          createdBy: { staff: { id: 'staff-1', firstName: 'John', lastName: 'Doe' } },
        },
      ]

      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)
      prismaMock.$transaction.mockResolvedValue([mockTransactions, 1] as any)

      const result = await getLoyaltyTransactions('venue-123', 'customer-123', { page: 1, pageSize: 20 })

      expect(result.data).toHaveLength(1)
      expect(result.data[0].order?.total).toBe(50) // Decimal → Number
      expect(result.data[0].createdBy?.name).toBe('John Doe')
      expect(result.meta.totalCount).toBe(1)
      expect(result.currentBalance).toBe(500)
    })

    it('should filter by transaction type', async () => {
      const mockCustomer = createMockCustomer()

      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)
      prismaMock.$transaction.mockResolvedValue([[], 0] as any)

      await getLoyaltyTransactions('venue-123', 'customer-123', { type: LoyaltyTransactionType.REDEEM })

      // Verify $transaction was called (type filter logic is tested by integration tests)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should throw NotFoundError if customer not found', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(getLoyaltyTransactions('venue-123', 'nonexistent')).rejects.toThrow(NotFoundError)
      await expect(getLoyaltyTransactions('venue-123', 'nonexistent')).rejects.toThrow('Customer not found')
    })

    it('should enforce multi-tenant isolation (customer belongs to venue)', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)

      await expect(getLoyaltyTransactions('venue-123', 'customer-456')).rejects.toThrow(NotFoundError)

      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({
        where: { id: 'customer-456', venueId: 'venue-123' },
      })
    })

    it('should use default pagination values (page=1, pageSize=20)', async () => {
      const mockCustomer = createMockCustomer()

      prismaMock.customer.findFirst.mockResolvedValue(mockCustomer as any)
      prismaMock.$transaction.mockResolvedValue([[], 0] as any)

      const result = await getLoyaltyTransactions('venue-123', 'customer-123')

      // Verify default pagination metadata
      expect(result.meta.currentPage).toBe(1)
      expect(result.meta.pageSize).toBe(20)
    })
  })

  describe('expireOldPoints', () => {
    it('should expire old points and update customer balances', async () => {
      const mockConfig = createMockLoyaltyConfig({ pointsExpireDays: 365 })
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 400) // 400 days ago

      const mockOldTransactions = [
        {
          ...createMockTransaction({ id: 'tx-1', points: 100, createdAt: oldDate }),
          customer: { id: 'customer-1', loyaltyPoints: 150 },
          customerId: 'customer-1',
        },
        {
          ...createMockTransaction({ id: 'tx-2', points: 50, createdAt: oldDate }),
          customer: { id: 'customer-2', loyaltyPoints: 80 },
          customerId: 'customer-2',
        },
      ]

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.loyaltyTransaction.findMany.mockResolvedValue(mockOldTransactions as any)
      prismaMock.$transaction.mockResolvedValue([{}, {}] as any)

      const result = await expireOldPoints('venue-123')

      expect(result.customersAffected).toBe(2)
      expect(result.pointsExpired).toBe(150) // 100 + 50
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2) // Once per transaction
    })

    it('should return 0 if loyalty config is inactive', async () => {
      const mockConfig = createMockLoyaltyConfig({ active: false })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const result = await expireOldPoints('venue-123')

      expect(result.customersAffected).toBe(0)
      expect(result.pointsExpired).toBe(0)
      expect(prismaMock.loyaltyTransaction.findMany).not.toHaveBeenCalled()
    })

    it('should return 0 if pointsExpireDays is null', async () => {
      const mockConfig = createMockLoyaltyConfig({ pointsExpireDays: null })

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)

      const result = await expireOldPoints('venue-123')

      expect(result.customersAffected).toBe(0)
      expect(result.pointsExpired).toBe(0)
      expect(prismaMock.loyaltyTransaction.findMany).not.toHaveBeenCalled()
    })

    it('should not expire more points than customer has', async () => {
      const mockConfig = createMockLoyaltyConfig({ pointsExpireDays: 365 })
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 400)

      const mockOldTransactions = [
        {
          ...createMockTransaction({ id: 'tx-1', points: 500, createdAt: oldDate }),
          customer: { id: 'customer-1', loyaltyPoints: 200 }, // Only has 200 points
          customerId: 'customer-1',
        },
      ]

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.loyaltyTransaction.findMany.mockResolvedValue(mockOldTransactions as any)
      prismaMock.$transaction.mockResolvedValue([{}, {}] as any)

      const result = await expireOldPoints('venue-123')

      // Should only expire 200 points (customer's current balance), not the full 500 from the old transaction
      expect(result.pointsExpired).toBe(200)
      expect(prismaMock.$transaction).toHaveBeenCalled()
    })

    it('should skip customers with 0 points', async () => {
      const mockConfig = createMockLoyaltyConfig({ pointsExpireDays: 365 })
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 400)

      const mockOldTransactions = [
        {
          ...createMockTransaction({ id: 'tx-1', points: 100, createdAt: oldDate }),
          customer: { id: 'customer-1', loyaltyPoints: 0 }, // No points to expire
          customerId: 'customer-1',
        },
      ]

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.loyaltyTransaction.findMany.mockResolvedValue(mockOldTransactions as any)

      const result = await expireOldPoints('venue-123')

      expect(result.customersAffected).toBe(0)
      expect(result.pointsExpired).toBe(0)
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it('should only find EARN transactions (not REDEEM, ADJUST, EXPIRE)', async () => {
      const mockConfig = createMockLoyaltyConfig()

      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
      prismaMock.loyaltyTransaction.findMany.mockResolvedValue([])

      await expireOldPoints('venue-123')

      expect(prismaMock.loyaltyTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: LoyaltyTransactionType.EARN,
          }),
        }),
      )
    })
  })
})

/**
 * 🔴 REGRESIÓN. `earnPoints` corre en CADA cobro de CADA negocio: es la función
 * más caliente del sistema de lealtad. Enganchar los sellos aquí sólo es aceptable
 * si no puede alterar en nada lo que ya hace.
 */
describe('earnPoints + sellos (Plan B)', () => {
  const mockedGrantStamp = stampLedger.grantStamp as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    mockedGrantStamp.mockResolvedValue({ granted: false, reason: 'STAMPS_DISABLED' })
  })

  it('🔴 un negocio SIN sellos se comporta EXACTAMENTE como antes', async () => {
    const mockConfig = createMockLoyaltyConfig({ pointsPerDollar: new Decimal(1) })
    const mockTransaction = createMockTransaction({ points: 50 })

    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
    prismaMock.loyaltyTransaction.findFirst.mockResolvedValue(null)
    prismaMock.$transaction.mockResolvedValue([mockTransaction, { loyaltyPoints: 550 }] as any)

    const result = await earnPoints('venue-123', 'customer-123', 50, 'order-123')

    // Los puntos siguen su curso, intactos.
    expect(result.pointsEarned).toBe(50)
    expect(result.newBalance).toBe(550)
  })

  it('🔴 un negocio con sellos y CERO puntos SÍ sella', async () => {
    // Este es el test que justifica el diseño entero. `earnPoints` sale temprano
    // cuando los puntos calculados son 0 — y un negocio que usa SELLOS y no puntos
    // tiene pointsPerDollar en 0. Si el sellado fuera después de ese return, ese
    // negocio nunca sellaría nada y el defecto sería invisible.
    const mockConfig = createMockLoyaltyConfig({ pointsPerDollar: new Decimal(0), pointsPerVisit: 0 })
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
    prismaMock.loyaltyTransaction.findFirst.mockResolvedValue(null)
    mockedGrantStamp.mockResolvedValue({ granted: true, stampsEarned: 3, stampsRequired: 7 })

    const result = await earnPoints('venue-123', 'customer-123', 50, 'order-123')

    expect(mockedGrantStamp).toHaveBeenCalledWith('venue-123', 'customer-123', 'order-123', expect.any(Object))
    // Y aun así devuelve 0 puntos, que es lo correcto: ese negocio no da puntos.
    expect(result.pointsEarned).toBe(0)
  })

  it('🔴 si el sellado TRUENA, conserva los puntos pero propaga el fallo para que el reconciliador reintente el sello', async () => {
    // El cobro ya está confirmado y el llamador captura este error. Silenciarlo
    // aquí marcaría la orden como procesada y el sello faltante jamás se
    // recuperaría. Los puntos sí deben persistir antes de propagarlo.
    const mockConfig = createMockLoyaltyConfig({ pointsPerDollar: new Decimal(1) })
    const mockTransaction = createMockTransaction({ points: 50 })

    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
    prismaMock.loyaltyTransaction.findFirst.mockResolvedValue(null)
    prismaMock.$transaction.mockResolvedValue([mockTransaction, { loyaltyPoints: 550 }] as any)
    mockedGrantStamp.mockRejectedValue(new Error('la base se cayó'))

    await expect(earnPoints('venue-123', 'customer-123', 50, 'order-123')).rejects.toThrow('la base se cayó')

    expect(prismaMock.$transaction).toHaveBeenCalled()
  })

  it('pasa el autor del sello, para que quede atribuible', async () => {
    const mockConfig = createMockLoyaltyConfig({ pointsPerDollar: new Decimal(1) })
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(mockConfig as any)
    prismaMock.loyaltyTransaction.findFirst.mockResolvedValue(null)
    prismaMock.$transaction.mockResolvedValue([createMockTransaction(), { loyaltyPoints: 1 }] as any)

    await earnPoints('venue-123', 'customer-123', 50, 'order-123', 'staffvenue-9')

    expect(mockedGrantStamp).toHaveBeenCalledWith(
      'venue-123',
      'customer-123',
      'order-123',
      expect.objectContaining({ staffVenueId: 'staffvenue-9' }),
    )
  })
})
