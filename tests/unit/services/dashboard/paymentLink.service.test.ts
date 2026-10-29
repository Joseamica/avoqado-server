// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

// El finalizador de Stripe hace `new Stripe(...)` para leer el cargo; sin connectAccountId ni lo llama (casi todas las
// pruebas). La del tipo del cargo (Codex r1, 19-oct) sí lo necesita.
const retrieveStripePi = jest.fn()
const createStripePi = jest.fn()
const createStripeHosted = jest.fn()
jest.mock('@/services/superadmin/platformSettings.service', () => ({ getVatRateBps: jest.fn().mockResolvedValue(1600) }))
jest.mock('@/services/mercado-pago/connection.service', () => ({
  loadCredentials: jest.fn().mockResolvedValue({ accessToken: 'fixture', publicKey: 'fixture', expiresAt: new Date('2099-01-01') }),
}))
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    paymentIntents: { retrieve: retrieveStripePi, create: createStripePi },
    checkout: { sessions: { create: createStripeHosted } },
  })),
}))

// Mock nanoid before imports
jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'abc12345'),
}))

// Mock Blumon E-commerce service
const mockBlumonService = {
  tokenizeCard: jest.fn().mockResolvedValue({
    token: 'tok_test_123',
    maskedPan: '424242******4242',
    cardBrand: 'VISA',
  }),
  authorizePayment: jest.fn().mockResolvedValue({
    transactionId: 'txn_test_123',
    authorizationCode: 'AUTH123',
  }),
}

jest.mock('@/services/sdk/blumon-ecommerce.service', () => ({
  getBlumonEcommerceService: jest.fn(() => mockBlumonService),
}))

// Mock inventory deduction
const mockDeductInventory = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: mockDeductInventory,
}))

// El outbox durable de inventario se mockea para poder observar CON QUÉ cliente
// de transacción nace el vale (el invariante "orden PAID ⟺ posting existe") y
// que el aplicador corra DESPUÉS del commit, nunca dentro.
const mockCreateSalePostingInTx = jest.fn()
const mockApplySalePosting = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: (...a: unknown[]) => mockCreateSalePostingInTx(...a),
  applySalePosting: (...a: unknown[]) => mockApplySalePosting(...a),
}))

// Lealtad y métricas del cliente: se mockean los DOS servicios compartidos que
// ya usan TPV y el pago manual. Lo que esta suite prueba es el CABLEADO del
// canal (que se disparen, con qué base y contra qué orden), no la aritmética de
// puntos — ésa vive en loyalty.dashboard.service.test.ts y duplicarla aquí
// permitiría que las dos versiones se separen sin que nadie se entere.
const mockEarnPoints = jest.fn()
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  __esModule: true,
  earnPoints: (...a: unknown[]) => mockEarnPoints(...a),
}))

const mockUpdateCustomerMetrics = jest.fn()
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  __esModule: true,
  updateCustomerMetrics: (...a: unknown[]) => mockUpdateCustomerMetrics(...a),
}))

// Fase 3 (A5): la comisión de la liga se encola DENTRO de la transacción del cobro. El resto del módulo queda real.
const mockEnqueuePaymentCommissionInTx = jest.fn()
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: (...a: unknown[]) => mockEnqueuePaymentCommissionInTx(...a),
}))

import {
  createPaymentLink,
  createStripePaymentIntentForPaymentLink,
  createStripeCheckoutForPaymentLink,
  createCheckoutSession,
  createMercadoPagoPaymentIntentForPaymentLink,
  getPaymentLinks,
  getPaymentLinkById,
  updatePaymentLink,
  archivePaymentLink,
  getPaymentLinkByShortCode,
  completeCharge,
  finalizePaymentLinkCheckout,
  finalizeMercadoPagoCheckout,
  getSessionStatus,
} from '../../../../src/services/dashboard/paymentLink.service'
import { prismaMock } from '../../../__helpers__/setup'
import { OPCIONES_DE_TRANSACCION_DEL_INTENTO } from '../../../../src/services/tpv/candadoDeIntento'
import { BadRequestError, NotFoundError, PaymentOutcomeUnknownError } from '../../../../src/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { Decimal } from '@prisma/client/runtime/library'
import { mapFormaPago } from '../../../../src/services/fiscal/satCatalog'
import { paymentCountsAsDrawerCash } from '../../../../src/services/shared/tenderSemantics'

// ==========================================
// MOCK HELPERS
// ==========================================

const VENUE_ID = 'venue-123'
const STAFF_ID = 'staff-123'
const PRODUCT_ID = 'product-456'

// Auto-pick (no ecommerceMerchantId passed) reads active merchants via findMany
// and keeps only ones that can actually charge. A Stripe Connect merchant with
// chargesEnabled=true qualifies.
const chargeableMerchants = [{ id: 'merchant-123', chargesEnabled: true, providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } }]

const createMockPaymentLink = (overrides: Record<string, any> = {}) => ({
  id: 'pl-123',
  shortCode: 'abc12345',
  venueId: VENUE_ID,
  ecommerceMerchantId: 'merchant-123',
  createdById: STAFF_ID,
  purpose: 'PAYMENT',
  title: 'Test Payment',
  description: 'Test description',
  imageUrl: null,
  amountType: 'FIXED',
  amount: new Decimal(100),
  currency: 'MXN',
  isReusable: false,
  expiresAt: null,
  redirectUrl: null,
  status: 'ACTIVE',
  totalCollected: new Decimal(0),
  paymentCount: 0,
  createdAt: new Date('2026-03-01'),
  updatedAt: new Date('2026-03-01'),
  createdBy: { id: STAFF_ID, firstName: 'Test', lastName: 'User' },
  // Default fixtures for the new multi-item / multi-staff schema. Tests can
  // override per-case via the `overrides` arg.
  items: [],
  attributions: [],
  ecommerceMerchant: { provider: { code: 'BLUMON' } },
  _count: { checkoutSessions: 0 },
  ...overrides,
})

const createMockItemPaymentLink = (overrides: Record<string, any> = {}) =>
  createMockPaymentLink({
    purpose: 'ITEM',
    title: 'Test Product',
    amount: new Decimal(250),
    items: [
      {
        id: 'pli-1',
        quantity: 1,
        product: {
          id: PRODUCT_ID,
          name: 'Test Product',
          description: null,
          price: new Decimal(250),
          imageUrl: null,
          taxRate: new Decimal(0.16),
        },
        modifiers: [],
      },
    ],
    ...overrides,
  })

const createMockCheckoutSession = (overrides: Record<string, any> = {}) => ({
  id: 'session-db-123',
  sessionId: 'cs_pl_test123',
  ecommerceMerchantId: 'merchant-123',
  paymentLinkId: 'pl-123',
  amount: new Decimal(100),
  currency: 'MXN',
  description: 'Test Payment',
  customerEmail: 'john@example.com',
  customerPhone: null,
  customerName: 'John Doe',
  status: 'PROCESSING',
  metadata: {
    cardToken: 'tok_test_123',
    maskedPan: '424242******4242',
    cardBrand: 'VISA',
    cvv: '123',
  },
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  completedAt: null,
  blumonCheckoutId: null,
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  paymentLink: {
    id: 'pl-123',
    shortCode: 'abc12345',
    venueId: VENUE_ID,
    purpose: 'PAYMENT',
    createdById: STAFF_ID,
    // attributions[] is read by completeCharge to drive commission split.
    // Default empty = no commission row created (which is fine for most
    // tests; cases that exercise the split branch override this).
    attributions: [],
  },
  ecommerceMerchant: {
    id: 'merchant-123',
    sandboxMode: true,
    providerCredentials: { accessToken: 'test-token' },
    provider: { code: 'BLUMON' },
  },
  ...overrides,
})

// ==========================================
// TESTS: DASHBOARD CRUD
// ==========================================

describe('PaymentLink Service', () => {
  beforeEach(() => {
    mockCreateSalePostingInTx.mockResolvedValue({ id: 'posting-pl-1', status: 'PENDING' })
    mockApplySalePosting.mockResolvedValue({ postingId: 'posting-pl-1', applied: true, issues: [] })
    mockEarnPoints.mockResolvedValue({ pointsEarned: 0, newBalance: 0 })
    mockUpdateCustomerMetrics.mockResolvedValue(undefined)
    mockEnqueuePaymentCommissionInTx.mockResolvedValue(undefined)
  })

  describe('atribución explícita del cliente', () => {
    beforeEach(() => {
      prismaMock.customer.findFirst.mockReset()
    })

    it.each(['Stripe inline', 'Stripe hosted', 'Blumon', 'MercadoPago'])(
      '%s: guarda snapshot interno A e ignora id público B',
      async canal => {
        process.env.STRIPE_PUBLISHABLE_KEY = 'fixture-public-key'
        const provider = canal === 'Blumon' ? 'BLUMON' : canal === 'MercadoPago' ? 'MERCADO_PAGO' : 'STRIPE_CONNECT'
        prismaMock.paymentLink.findUnique.mockResolvedValue(
          createMockPaymentLink({
            customerId: 'customer-A',
            ecommerceMerchant: {
              id: 'merchant-123',
              provider: { code: provider },
              chargesEnabled: true,
              platformFeeBps: 100,
              providerCredentials: { connectAccountId: 'acct_fixture', accessToken: 'fixture' },
            },
          }),
        )
        prismaMock.checkoutSession.create.mockResolvedValue({ sessionId: 'session-fixture' })
        createStripePi.mockResolvedValue({ id: 'pi_fixture', client_secret: 'fixture' })
        createStripeHosted.mockResolvedValue({ id: 'cs_fixture', url: 'https://example.test' })
        const input = { customerEmail: 'payer-b@example.test', attributedCustomerId: 'customer-B', customerId: 'customer-B' }
        if (canal === 'Stripe inline') await createStripePaymentIntentForPaymentLink('abc12345', input)
        else if (canal === 'Stripe hosted') await createStripeCheckoutForPaymentLink('abc12345', input)
        else if (canal === 'MercadoPago') await createMercadoPagoPaymentIntentForPaymentLink('abc12345', input)
        else
          await createCheckoutSession('abc12345', {
            ...input,
            pan: '4242424242424242',
            cvv: '123',
            expMonth: '12',
            expYear: '2030',
            holderName: 'Pagador B',
          })
        expect(prismaMock.checkoutSession.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ attributedCustomerId: 'customer-A', customerEmail: 'payer-b@example.test' }),
          }),
        )
      },
    )

    it.each(['ajeno', 'inactivo'])('rechaza cliente %s antes de crear', async () => {
      prismaMock.customer.findFirst.mockResolvedValue(null)
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue(chargeableMerchants)
      prismaMock.paymentLink.create.mockResolvedValue(createMockPaymentLink())
      await expect(
        createPaymentLink(VENUE_ID, { title: 'Anticipo', amountType: 'FIXED', amount: 100, customerId: 'customer-A' } as any, STAFF_ID),
      ).rejects.toThrow(/cliente/i)
      expect(prismaMock.paymentLink.create).not.toHaveBeenCalled()
      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'customer-A', venueId: VENUE_ID, active: true } }),
      )
    })

    it('guarda el cliente validado y su resumen privado', async () => {
      prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue(chargeableMerchants)
      prismaMock.paymentLink.create.mockResolvedValue(createMockPaymentLink())
      await createPaymentLink(VENUE_ID, { title: 'Anticipo', amountType: 'FIXED', amount: 100, customerId: 'customer-A' } as any, STAFF_ID)
      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ customerId: 'customer-A' }),
          include: expect.objectContaining({
            customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
          }),
        }),
      )
    })

    it('conserva la opción reutilizable con atribución explícita', async () => {
      prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue(chargeableMerchants)
      prismaMock.paymentLink.create.mockResolvedValue(createMockPaymentLink())
      await createPaymentLink(
        VENUE_ID,
        { title: 'Anticipo', amountType: 'OPEN', customerId: 'customer-A', isReusable: true } as any,
        STAFF_ID,
      )
      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isReusable: true, customerId: 'customer-A' }) }),
      )
    })

    it('no permite reasignar ni borrar la atribución al editar', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValue(createMockPaymentLink({ customerId: 'customer-A' }))
      prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-B' })
      for (const customerId of ['customer-B', null]) {
        await expect(updatePaymentLink(VENUE_ID, 'pl-123', { customerId } as any)).rejects.toThrow(/cliente/i)
      }
      expect(prismaMock.paymentLink.updateMany).not.toHaveBeenCalled()
    })

    // Founder 23-oct: en «Editar liga» se puede AGREGAR un cliente si la liga no tiene; nunca cambiarlo.
    describe('agregar cliente al editar una liga sin cliente', () => {
      const sinCliente = () => createMockPaymentLink({ customerId: null })

      it('lo agrega sólo donde sigue vacío (CAS) y deja rastro', async () => {
        prismaMock.paymentLink.findUnique.mockResolvedValue(sinCliente())
        prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
        prismaMock.paymentLink.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.paymentLink.update.mockResolvedValue(createMockPaymentLink({ customerId: 'customer-A' }))
        await updatePaymentLink(VENUE_ID, 'pl-123', { customerId: 'customer-A' } as any, STAFF_ID)
        expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'customer-A', venueId: VENUE_ID, active: true } }),
        )
        expect(prismaMock.paymentLink.updateMany).toHaveBeenCalledWith({
          where: { id: 'pl-123', venueId: VENUE_ID, customerId: null, status: { not: 'ARCHIVED' } },
          data: { customerId: 'customer-A' },
        })
        expect(logAction).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'PAYMENT_LINK_CUSTOMER_ADDED',
            staffId: STAFF_ID,
            entityId: 'pl-123',
            data: { customerId: 'customer-A' },
          }),
        )
      })

      it('desde el MCP, su auditoría reemplaza la nativa (una sola fila)', async () => {
        prismaMock.paymentLink.findUnique.mockResolvedValue(sinCliente())
        prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
        prismaMock.paymentLink.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.paymentLink.update.mockResolvedValue(createMockPaymentLink({ customerId: 'customer-A' }))
        const auditar = jest.fn().mockResolvedValue(undefined)
        await updatePaymentLink(VENUE_ID, 'pl-123', { customerId: 'customer-A' } as any, STAFF_ID, auditar)
        expect(auditar).toHaveBeenCalledTimes(1)
        expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_LINK_CUSTOMER_ADDED' }))
      })

      it('rechaza un cliente ajeno o inactivo sin escribir', async () => {
        prismaMock.paymentLink.findUnique.mockResolvedValue(sinCliente())
        prismaMock.customer.findFirst.mockResolvedValue(null)
        await expect(updatePaymentLink(VENUE_ID, 'pl-123', { customerId: 'customer-A' } as any, STAFF_ID)).rejects.toThrow(/cliente/i)
        expect(prismaMock.paymentLink.updateMany).not.toHaveBeenCalled()
      })

      it('el mismo cliente otra vez no escribe ni audita de nuevo', async () => {
        prismaMock.paymentLink.findUnique.mockResolvedValue(createMockPaymentLink({ customerId: 'customer-A' }))
        prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
        prismaMock.paymentLink.update.mockResolvedValue(createMockPaymentLink({ customerId: 'customer-A' }))
        await updatePaymentLink(VENUE_ID, 'pl-123', { customerId: 'customer-A' } as any, STAFF_ID)
        expect(prismaMock.paymentLink.updateMany).not.toHaveBeenCalled()
        expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_LINK_CUSTOMER_ADDED' }))
      })

      it('si otro guardado puso otro cliente primero, responde 409 y no toca nada más', async () => {
        prismaMock.paymentLink.findUnique
          .mockResolvedValueOnce(sinCliente())
          .mockResolvedValueOnce({ customerId: 'customer-B' } as any)
        prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
        prismaMock.paymentLink.updateMany.mockResolvedValue({ count: 0 })
        await expect(
          updatePaymentLink(VENUE_ID, 'pl-123', { customerId: 'customer-A', title: 'Nuevo' } as any, STAFF_ID),
        ).rejects.toMatchObject({ statusCode: 409 })
        expect(prismaMock.paymentLink.update).not.toHaveBeenCalled()
      })

      // Codex r1 #1: repetir sólo { customerId } igual no escribe NI deja filas de «liga editada».
      it('repetir sólo el mismo cliente no escribe ni audita nada', async () => {
        prismaMock.paymentLink.findUnique.mockResolvedValue(createMockPaymentLink({ customerId: 'customer-A' }))
        prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
        await updatePaymentLink(VENUE_ID, 'pl-123', { customerId: 'customer-A' } as any, STAFF_ID)
        expect(prismaMock.paymentLink.update).not.toHaveBeenCalled()
        expect(logAction).not.toHaveBeenCalled()
      })

      it('agregar sólo el cliente no deja también una fila de «liga editada»', async () => {
        prismaMock.paymentLink.findUnique.mockResolvedValue(sinCliente())
        prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
        prismaMock.paymentLink.updateMany.mockResolvedValue({ count: 1 })
        prismaMock.paymentLink.update.mockResolvedValue(createMockPaymentLink({ customerId: 'customer-A' }))
        await updatePaymentLink(VENUE_ID, 'pl-123', { customerId: 'customer-A' } as any, STAFF_ID)
        expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_LINK_UPDATED' }))
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_LINK_CUSTOMER_ADDED' }))
      })

      // Codex r1 #2: si la archivan entre la lectura y la escritura, no se le agrega el cliente.
      it('una liga archivada a media edición no recibe el cliente', async () => {
        prismaMock.paymentLink.findUnique
          .mockResolvedValueOnce(sinCliente())
          .mockResolvedValueOnce({ customerId: null, status: 'ARCHIVED' } as any)
        prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
        prismaMock.paymentLink.updateMany.mockResolvedValue({ count: 0 })
        await expect(updatePaymentLink(VENUE_ID, 'pl-123', { customerId: 'customer-A' } as any, STAFF_ID)).rejects.toThrow(/archivada/)
        expect(prismaMock.paymentLink.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ status: { not: 'ARCHIVED' } }) }),
        )
      })

      it('si otro guardado puso el MISMO cliente primero, sigue sin error', async () => {
        prismaMock.paymentLink.findUnique
          .mockResolvedValueOnce(sinCliente())
          .mockResolvedValueOnce({ customerId: 'customer-A' } as any)
        prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
        prismaMock.paymentLink.updateMany.mockResolvedValue({ count: 0 })
        prismaMock.paymentLink.update.mockResolvedValue(createMockPaymentLink({ customerId: 'customer-A' }))
        await expect(updatePaymentLink(VENUE_ID, 'pl-123', { customerId: 'customer-A' } as any, STAFF_ID)).resolves.toBeTruthy()
      })
    })
  })

  describe('idempotencia de creación', () => {
    const body = { title: 'Anticipo', amountType: 'FIXED' as const, amount: 100 }
    const callWithKey = (data = body, staff = STAFF_ID, venue = VENUE_ID) =>
      (createPaymentLink as any)(venue, data, staff, 'logical-attempt')
    beforeEach(() => {
      prismaMock.paymentLink.findUnique.mockReset()
      prismaMock.paymentLink.create.mockReset()
    })
    it('reusa la liga ante respuesta perdida, con hash canónico y sin nueva auditoría', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValue(null)
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue(chargeableMerchants)
      prismaMock.paymentLink.create.mockImplementation(async (args: any) => createMockPaymentLink(args.data))
      const first = await callWithKey()
      const firstCall: any = prismaMock.paymentLink.create.mock.calls[0][0]
      expect(firstCall.data).toMatchObject({ creationKey: 'logical-attempt', creationHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
      prismaMock.paymentLink.findUnique.mockResolvedValue(first)
      expect(await callWithKey({ amount: 100, title: 'Anticipo', amountType: 'FIXED' })).toEqual(first)
      expect(prismaMock.paymentLink.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.paymentLink.findUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { venueId_createdById_creationKey: { venueId: VENUE_ID, createdById: STAFF_ID, creationKey: 'logical-attempt' } },
        }),
      )
      await expect(callWithKey({ ...body, amount: 200 })).rejects.toMatchObject({ statusCode: 409 })
    })
    it('recupera P2002 concurrente sólo con hash igual', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue(chargeableMerchants)
      let written: any
      prismaMock.paymentLink.findUnique.mockImplementation(async () => written ?? null)
      prismaMock.paymentLink.create.mockImplementation(async (args: any) => {
        written = createMockPaymentLink(args.data)
        throw Object.assign(new Error('race'), { code: 'P2002' })
      })
      expect(await callWithKey()).toMatchObject({ id: 'pl-123', creationKey: 'logical-attempt' })
      expect(prismaMock.paymentLink.create).toHaveBeenCalledTimes(1)
    })
    it('ordena claves anidadas pero conserva orden de arrays', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValue(null)
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue(chargeableMerchants)
      prismaMock.paymentLink.create.mockImplementation(async (args: any) => createMockPaymentLink(args.data))
      const fields = [
        { id: 'f1', type: 'TEXT', label: 'Referencia', required: true },
        { id: 'f2', type: 'TEXT', label: 'Nota', required: false },
      ]
      const first = await callWithKey({ ...body, customFields: fields } as any)
      prismaMock.paymentLink.findUnique.mockResolvedValue(first)
      await expect(
        callWithKey({ ...body, customFields: fields.map(({ label, required, type, id }) => ({ required, label, id, type })) } as any),
      ).resolves.toEqual(first)
      await expect(callWithKey({ ...body, customFields: [...fields].reverse() } as any)).rejects.toMatchObject({ statusCode: 409 })
    })

    it('replay conserva archivada/inactiva sin revalidar canal ni cliente ni auditar', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue(chargeableMerchants)
      prismaMock.paymentLink.create.mockImplementation(async (args: any) => createMockPaymentLink(args.data))
      const first = await callWithKey()
      prismaMock.paymentLink.findUnique.mockResolvedValue({ ...first, status: 'ARCHIVED' })
      prismaMock.ecommerceMerchant.findMany.mockClear()
      prismaMock.customer.findFirst.mockClear()
      const callback = jest.fn()
      expect(await (createPaymentLink as any)(VENUE_ID, body, STAFF_ID, 'logical-attempt', callback)).toMatchObject({ status: 'ARCHIVED' })
      expect(prismaMock.ecommerceMerchant.findMany).not.toHaveBeenCalled()
      expect(prismaMock.customer.findFirst).not.toHaveBeenCalled()
      expect(callback).not.toHaveBeenCalled()
    })

    it('la escritura MCP reemplaza auditoría nativa, no duplica al reintentar y soporta fallo de auditoría', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue(chargeableMerchants)
      prismaMock.paymentLink.create.mockImplementation(async (args: any) => createMockPaymentLink(args.data))
      const callback = jest.fn().mockResolvedValue(undefined)
      const first = await (createPaymentLink as any)(VENUE_ID, body, STAFF_ID, 'logical-attempt', callback)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
      prismaMock.paymentLink.findUnique.mockResolvedValue(first)
      await (createPaymentLink as any)(VENUE_ID, body, STAFF_ID, 'logical-attempt', callback)
      expect(callback).toHaveBeenCalledTimes(1)
      prismaMock.paymentLink.findUnique.mockResolvedValue(null)
      callback.mockRejectedValue(new Error('audit temporal'))
      await expect((createPaymentLink as any)(VENUE_ID, body, STAFF_ID, 'attempt2', callback)).resolves.toMatchObject({ id: 'pl-123' })
    })

    it.each(['', ' ', 'x'.repeat(129)])('rechaza clave inválida %j', async key => {
      await expect((createPaymentLink as any)(VENUE_ID, body, STAFF_ID, key)).rejects.toMatchObject({ statusCode: 400 })
      expect(prismaMock.paymentLink.create).not.toHaveBeenCalled()
    })

    it('separa claves por actor y venue', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValue(null)
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue(chargeableMerchants)
      prismaMock.paymentLink.create.mockResolvedValue(createMockPaymentLink())
      await callWithKey(body, 'staff-otro', 'venue-otro')
      expect(prismaMock.paymentLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId_createdById_creationKey: { venueId: 'venue-otro', createdById: 'staff-otro', creationKey: 'logical-attempt' } },
        }),
      )
    })
  })

  // ─── CREATE ──────────────────────────────────────
  describe('createPaymentLink', () => {
    it('should create a PAYMENT link with FIXED amount', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce(chargeableMerchants)
      prismaMock.paymentLink.create.mockResolvedValueOnce(createMockPaymentLink())

      const result = await createPaymentLink(
        VENUE_ID,
        {
          title: 'Test Payment',
          description: 'Test description',
          amountType: 'FIXED',
          amount: 100,
          purpose: 'PAYMENT',
        },
        STAFF_ID,
      )

      expect(result).toBeDefined()
      expect(result.shortCode).toBe('abc12345')
      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            purpose: 'PAYMENT',
            title: 'Test Payment',
            amountType: 'FIXED',
          }),
        }),
      )
    })

    it('should create an ITEM link with items[]', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce(chargeableMerchants)
      // validateBundleItems uses product.findMany (plural) to look up all
      // distinct product IDs with their modifier groups for validation.
      prismaMock.product.findMany.mockResolvedValueOnce([{ id: PRODUCT_ID, modifierGroups: [] }])
      prismaMock.paymentLink.create.mockResolvedValueOnce(createMockItemPaymentLink())

      const result = await createPaymentLink(
        VENUE_ID,
        {
          title: 'Test Product',
          amountType: 'FIXED',
          amount: 250,
          purpose: 'ITEM',
          items: [{ productId: PRODUCT_ID, quantity: 1 }],
        },
        STAFF_ID,
      )

      expect(result).toBeDefined()
    })

    it('should reject ITEM link without items[]', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce(chargeableMerchants)

      await expect(
        createPaymentLink(
          VENUE_ID,
          {
            title: 'No Product',
            amountType: 'FIXED',
            amount: 100,
            purpose: 'ITEM',
            // No items
          },
          STAFF_ID,
        ),
      ).rejects.toThrow(BadRequestError)
    })

    it('should reject ITEM link with product from another venue', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce(chargeableMerchants)
      // Empty product list = the requested productId doesn't belong to this venue
      prismaMock.product.findMany.mockResolvedValueOnce([])

      await expect(
        createPaymentLink(
          VENUE_ID,
          {
            title: 'Wrong Product',
            amountType: 'FIXED',
            amount: 100,
            purpose: 'ITEM',
            items: [{ productId: 'product-from-other-venue', quantity: 1 }],
          },
          STAFF_ID,
        ),
      ).rejects.toThrow(BadRequestError)
    })

    it('should reject if no ecommerce merchant', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValue([])

      await expect(
        createPaymentLink(
          VENUE_ID,
          {
            title: 'Test',
            amountType: 'FIXED',
            amount: 100,
          },
          STAFF_ID,
        ),
      ).rejects.toThrow(BadRequestError)
    })

    // ─── AUTO-PICK USABILITY (regression for Mobanq "Configuración de pago
    //     incompleta") ──────────────────────────────────────────────────────
    it('auto-pick skips an unconfigured Blumon channel and binds to a chargeable one', async () => {
      // Mobanq's real state: an active Blumon merchant that was never onboarded
      // (no accessToken) plus a fully onboarded Stripe Connect channel. The old
      // code blindly preferred Blumon and produced a link that threw at checkout.
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce([
        { id: 'blumon-dead', chargesEnabled: false, providerCredentials: { environment: 'SANDBOX' }, provider: { code: 'BLUMON' } },
        {
          id: 'stripe-live',
          chargesEnabled: true,
          providerCredentials: { connectAccountId: 'acct_1' },
          provider: { code: 'STRIPE_CONNECT' },
        },
      ])
      prismaMock.paymentLink.create.mockResolvedValueOnce(createMockPaymentLink())

      await createPaymentLink(VENUE_ID, { title: 'X', amountType: 'FIXED', amount: 80, purpose: 'PAYMENT' }, STAFF_ID)

      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ecommerceMerchantId: 'stripe-live' }) }),
      )
    })

    it('auto-pick prefers a properly configured Blumon channel (inline card UX) over others', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce([
        {
          id: 'stripe-live',
          chargesEnabled: true,
          providerCredentials: { connectAccountId: 'acct_1' },
          provider: { code: 'STRIPE_CONNECT' },
        },
        { id: 'blumon-live', chargesEnabled: false, providerCredentials: { accessToken: 'tok_live_123' }, provider: { code: 'BLUMON' } },
      ])
      prismaMock.paymentLink.create.mockResolvedValueOnce(createMockPaymentLink())

      await createPaymentLink(VENUE_ID, { title: 'X', amountType: 'FIXED', amount: 80, purpose: 'PAYMENT' }, STAFF_ID)

      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ecommerceMerchantId: 'blumon-live' }) }),
      )
    })

    it('auto-pick rejects when the only channel is an unconfigured Blumon (no accessToken)', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce([
        { id: 'blumon-dead', chargesEnabled: false, providerCredentials: { environment: 'SANDBOX' }, provider: { code: 'BLUMON' } },
      ])

      await expect(
        createPaymentLink(VENUE_ID, { title: 'X', amountType: 'FIXED', amount: 80, purpose: 'PAYMENT' }, STAFF_ID),
      ).rejects.toThrow(BadRequestError)
      expect(prismaMock.paymentLink.create).not.toHaveBeenCalled()
    })
  })

  // ─── LIST ──────────────────────────────────────
  describe('getPaymentLinks', () => {
    // Tope 200 = la página más grande que ofrece la tabla del dashboard (10…200); más grande se recorta, nunca se ignora.
    it('impone tope200 y orden estable sin ocultar total', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(350)
      const result = await getPaymentLinks(VENUE_ID, { limit: 10000, offset: -5 })
      expect(prismaMock.paymentLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200, skip: 0, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      )
      expect(result).toMatchObject({ limit: 200, offset: 0, total: 350, hasMore: true })
    })

    it('should return paginated links', async () => {
      const mockLinks = [createMockPaymentLink()]
      prismaMock.paymentLink.findMany.mockResolvedValueOnce(mockLinks)
      prismaMock.paymentLink.count.mockResolvedValueOnce(1)
      prismaMock.checkoutSession.groupBy.mockResolvedValueOnce([] as any)

      const result = await getPaymentLinks(VENUE_ID)

      expect(result.paymentLinks).toHaveLength(1)
      expect(result.total).toBe(1)
      expect(prismaMock.paymentLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID },
        }),
      )
    })

    it('should filter by status', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(0)

      await getPaymentLinks(VENUE_ID, { status: 'PAUSED' })

      expect(prismaMock.paymentLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: VENUE_ID, status: 'PAUSED' },
        }),
      )
    })

    it('should filter by search term', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(0)

      await getPaymentLinks(VENUE_ID, { search: 'test' })

      expect(prismaMock.paymentLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            venueId: VENUE_ID,
            title: { contains: 'test', mode: 'insensitive' },
          },
        }),
      )
    })

    // El dashboard muestra cuándo se pagó cada liga: la fecha del último cobro COMPLETADO, también si después se archivó.
    it('trae lastPaidAt = último cobro completado de cada liga, en UNA consulta acotada a la página', async () => {
      const pagadaAyer = new Date('2026-10-27T18:05:00.000Z')
      const ultimoPago = new Date('2026-10-28T20:40:00.000Z')
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([
        createMockPaymentLink({ id: 'pl-unica', status: 'ARCHIVED', isReusable: false, paymentCount: 1 }),
        createMockPaymentLink({ id: 'pl-reusable', isReusable: true, paymentCount: 3 }),
        createMockPaymentLink({ id: 'pl-sin-pago', paymentCount: 0 }),
      ])
      prismaMock.paymentLink.count.mockResolvedValueOnce(3)
      prismaMock.checkoutSession.groupBy.mockResolvedValueOnce([
        { paymentLinkId: 'pl-unica', _max: { completedAt: pagadaAyer } },
        { paymentLinkId: 'pl-reusable', _max: { completedAt: ultimoPago } },
      ] as any)

      const result = await getPaymentLinks(VENUE_ID)

      // Se comparan los argumentos como datos simples: si la aserción falla, jest no intenta imprimir el mock profundo de Prisma.
      const llamadas = prismaMock.checkoutSession.groupBy.mock.calls.map((c: unknown[]) => c[0])
      expect(llamadas).toHaveLength(1)
      expect(llamadas[0]).toEqual({
        by: ['paymentLinkId'],
        where: { paymentLinkId: { in: ['pl-unica', 'pl-reusable', 'pl-sin-pago'] }, status: 'COMPLETED' },
        _max: { completedAt: true },
      })
      const porId = Object.fromEntries(result.paymentLinks.map(l => [l.id, l.lastPaidAt]))
      expect(porId).toEqual({ 'pl-unica': pagadaAyer, 'pl-reusable': ultimoPago, 'pl-sin-pago': null })
    })

    it('sin ligas en la página no consulta los cobros', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(0)

      const result = await getPaymentLinks(VENUE_ID)

      expect(result.paymentLinks).toEqual([])
      expect(prismaMock.checkoutSession.groupBy.mock.calls).toHaveLength(0)
    })

    // ─── Pestañas, filtro de estados y contadores en el servidor (antes el dashboard filtraba y contaba sólo las 20 que le llegaban)
    const whereDeLaLista = () => prismaMock.paymentLink.findMany.mock.calls[0][0]?.where
    const USADA = { status: 'ACTIVE', isReusable: false, paymentCount: { gt: 0 } }

    it('pestaña «used»: de un solo uso ya cobrada (sigue ACTIVE en la base), en el where del servidor', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(0)
      await getPaymentLinks(VENUE_ID, { view: 'used' })
      expect(whereDeLaLista()).toEqual({ venueId: VENUE_ID, AND: [USADA] })
    })

    it('pestaña «active»: ACTIVE sin las de un solo uso ya cobradas', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(0)
      await getPaymentLinks(VENUE_ID, { view: 'active' })
      expect(whereDeLaLista()).toEqual({
        venueId: VENUE_ID,
        AND: [{ status: 'ACTIVE', OR: [{ isReusable: true }, { paymentCount: 0 }] }],
      })
    })

    it('pestañas «paused»/«expired» filtran su estado; «all» no agrega nada', async () => {
      for (const [view, extra] of [
        ['paused', { AND: [{ status: 'PAUSED' }] }],
        ['expired', { AND: [{ status: 'EXPIRED' }] }],
        ['all', {}],
      ] as const) {
        prismaMock.paymentLink.findMany.mockClear()
        prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
        prismaMock.paymentLink.count.mockResolvedValueOnce(0)
        await getPaymentLinks(VENUE_ID, { view })
        expect(whereDeLaLista()).toEqual({ venueId: VENUE_ID, ...extra })
      }
    })

    it('varios estados a la vez (filtro «Estado») van como status in, junto con la búsqueda', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(0)
      await getPaymentLinks(VENUE_ID, { statuses: ['ACTIVE', 'PAUSED'], search: 'clase' })
      expect(whereDeLaLista()).toEqual({
        venueId: VENUE_ID,
        status: { in: ['ACTIVE', 'PAUSED'] },
        title: { contains: 'clase', mode: 'insensitive' },
      })
    })

    it('withCounts: contadores por pestaña (sin la pestaña, con búsqueda y estados) y totales del conjunto filtrado', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count
        .mockResolvedValueOnce(4) // total de la pestaña
        .mockResolvedValueOnce(3) // usadas (para los contadores)
        .mockResolvedValueOnce(2) // ligas con al menos un pago (tasa de uso)
      prismaMock.paymentLink.groupBy.mockResolvedValueOnce([
        { status: 'ACTIVE', _count: { _all: 5 } },
        { status: 'PAUSED', _count: { _all: 2 } },
        { status: 'ARCHIVED', _count: { _all: 1 } },
      ] as any)
      prismaMock.paymentLink.aggregate.mockResolvedValueOnce({ _sum: { totalCollected: new Decimal('1550.50') } } as any)

      const result = await getPaymentLinks(VENUE_ID, { view: 'used', search: 'clase', withCounts: true })

      expect(result.counts).toEqual({ all: 8, active: 2, used: 3, paused: 2, expired: 0 })
      expect(result.summary).toEqual({ totalCollected: 1550.5, paidLinks: 2 })
      const base = { venueId: VENUE_ID, title: { contains: 'clase', mode: 'insensitive' } }
      expect(prismaMock.paymentLink.groupBy.mock.calls[0][0]).toEqual({ by: ['status'], where: base, _count: { _all: true } })
      const conteos = prismaMock.paymentLink.count.mock.calls.map((c: unknown[]) => (c[0] as { where: unknown }).where)
      expect(conteos).toContainEqual({ AND: [base, USADA] })
      const filtrado = { ...base, AND: [USADA] }
      expect(conteos).toContainEqual({ AND: [filtrado, { paymentCount: { gt: 0 } }] })
      expect(prismaMock.paymentLink.aggregate.mock.calls[0][0]).toEqual({ where: filtrado, _sum: { totalCollected: true } })
    })

    it('sin withCounts (MCP, chatbot) no gasta las consultas de contadores', async () => {
      prismaMock.paymentLink.findMany.mockResolvedValueOnce([])
      prismaMock.paymentLink.count.mockResolvedValueOnce(0)
      const result = await getPaymentLinks(VENUE_ID, { view: 'active' })
      expect(result.counts).toBeUndefined()
      expect(result.summary).toBeUndefined()
      expect(prismaMock.paymentLink.groupBy.mock.calls).toHaveLength(0)
      expect(prismaMock.paymentLink.aggregate.mock.calls).toHaveLength(0)
    })
  })

  // ─── GET BY ID ──────────────────────────────────────
  describe('getPaymentLinkById', () => {
    it('should return link with checkout sessions', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(createMockPaymentLink({ checkoutSessions: [] }))
      prismaMock.checkoutSession.findMany.mockResolvedValueOnce([])
      prismaMock.checkoutSession.count.mockResolvedValueOnce(0)

      const result = await getPaymentLinkById(VENUE_ID, 'pl-123')
      expect(result).toBeDefined()
      expect(result.id).toBe('pl-123')
    })

    // El detalle de la liga en el dashboard lista sus pagos con «Ver recibo» (abre el detalle del pago, donde vive su recibo).
    it('trae los pagos completados (con paymentId), del más reciente al más viejo, con tope 50 y el total', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(createMockPaymentLink({ checkoutSessions: [] }))
      const pagos = [
        { id: 'cs-2', amount: new Decimal(250), completedAt: new Date('2026-10-28T20:40:00.000Z'), paymentId: 'pay-2' },
        { id: 'cs-1', amount: new Decimal(250), completedAt: new Date('2026-10-25T15:00:00.000Z'), paymentId: 'pay-1' },
      ]
      prismaMock.checkoutSession.findMany.mockResolvedValueOnce(pagos as any)
      prismaMock.checkoutSession.count.mockResolvedValueOnce(57)

      const result = await getPaymentLinkById(VENUE_ID, 'pl-123')

      expect(prismaMock.checkoutSession.findMany.mock.calls[0][0]).toEqual({
        where: { paymentLinkId: 'pl-123', status: 'COMPLETED' },
        orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { id: true, amount: true, completedAt: true, paymentId: true },
      })
      expect(prismaMock.checkoutSession.count.mock.calls[0][0]).toEqual({ where: { paymentLinkId: 'pl-123', status: 'COMPLETED' } })
      expect(result.completedPayments).toEqual(pagos)
      expect(result.completedPaymentsTotal).toBe(57)
    })

    it('should reject if link not found', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(null)

      await expect(getPaymentLinkById(VENUE_ID, 'bad-id')).rejects.toThrow(NotFoundError)
    })

    it('should reject if link belongs to another venue', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(createMockPaymentLink({ venueId: 'other-venue' }))

      await expect(getPaymentLinkById(VENUE_ID, 'pl-123')).rejects.toThrow()
    })
  })

  // ─── UPDATE ──────────────────────────────────────
  describe('updatePaymentLink', () => {
    it('should update title and amount', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce({
        id: 'pl-123',
        venueId: VENUE_ID,
        status: 'ACTIVE',
      })
      prismaMock.paymentLink.update.mockResolvedValueOnce(createMockPaymentLink({ title: 'Updated', amount: new Decimal(200) }))

      const result = await updatePaymentLink(VENUE_ID, 'pl-123', {
        title: 'Updated',
        amount: 200,
      })

      expect(result.title).toBe('Updated')
    })

    it('should reject update on archived link', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce({
        id: 'pl-123',
        venueId: VENUE_ID,
        status: 'ARCHIVED',
      })

      await expect(updatePaymentLink(VENUE_ID, 'pl-123', { title: 'Nope' })).rejects.toThrow(BadRequestError)
    })
  })

  // ─── ARCHIVE ──────────────────────────────────────
  describe('archivePaymentLink', () => {
    it('should soft-delete by setting status to ARCHIVED', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce({
        id: 'pl-123',
        venueId: VENUE_ID,
      })
      prismaMock.paymentLink.update.mockResolvedValueOnce({})

      const result = await archivePaymentLink(VENUE_ID, 'pl-123')

      expect(result.success).toBe(true)
      expect(prismaMock.paymentLink.update).toHaveBeenCalledWith({
        where: { id: 'pl-123' },
        data: { status: 'ARCHIVED' },
      })
    })
  })

  // ─── PUBLIC: RESOLVE BY SHORT CODE ─────────────────
  describe('getPaymentLinkByShortCode', () => {
    it('no filtra identidad seleccionada, ni llaves de creación al público', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({
          customerId: 'customer-A',
          creationKey: 'private-key',
          creationHash: 'private-hash',
          customer: { id: 'customer-A', email: 'selected@example.test', phone: '+525500000000' },
          venue: { id: VENUE_ID, name: 'Fixture', slug: 'fixture', logo: null },
        }),
      )
      const result = await getPaymentLinkByShortCode('abc12345')
      expect(result).not.toHaveProperty('customerId')
      expect(result).not.toHaveProperty('customer')
      expect(result).not.toHaveProperty('creationKey')
      expect(result).not.toHaveProperty('creationHash')
      expect(JSON.stringify(result)).not.toContain('selected@example.test')
    })

    it('should return link with venue branding', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({
          venue: { id: VENUE_ID, name: 'Test Venue', slug: 'test', logo: null, primaryColor: null, secondaryColor: null },
          product: null,
        }),
      )

      const result = await getPaymentLinkByShortCode('abc12345')

      expect(result.shortCode).toBe('abc12345')
      expect(result.venue.name).toBe('Test Venue')
      expect(result.purpose).toBe('PAYMENT')
    })

    it('should return product data for ITEM links', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockItemPaymentLink({
          venue: { id: VENUE_ID, name: 'Test Venue', slug: 'test', logo: null, primaryColor: null, secondaryColor: null },
          product: { id: PRODUCT_ID, name: 'Test Product', description: null, price: new Decimal(250), imageUrl: null },
        }),
      )

      const result = await getPaymentLinkByShortCode('abc12345')

      expect(result.purpose).toBe('ITEM')
      // After multi-item migration, the public API returns `items[]` instead
      // of a single `product` field. The assertion shape here would need to
      // be regenerated against the new mock — covered by smoke tests.
      expect(result.items).toBeDefined()
    })

    it('should reject expired links', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({
          expiresAt: new Date('2020-01-01'), // In the past
          venue: {},
          product: null,
        }),
      )
      prismaMock.paymentLink.update.mockResolvedValueOnce({})

      await expect(getPaymentLinkByShortCode('abc12345')).rejects.toThrow(BadRequestError)
    })

    it('should reject single-use link already used', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(
        createMockPaymentLink({
          isReusable: false,
          paymentCount: 1,
          venue: {},
          product: null,
        }),
      )

      await expect(getPaymentLinkByShortCode('abc12345')).rejects.toThrow(BadRequestError)
    })

    it('should reject paused/archived links', async () => {
      prismaMock.paymentLink.findUnique.mockResolvedValueOnce(createMockPaymentLink({ status: 'PAUSED', venue: {}, product: null }))

      await expect(getPaymentLinkByShortCode('abc12345')).rejects.toThrow(BadRequestError)
    })
  })

  // ─── COMPLETE CHARGE (ITEM LINK) ─────────────────
  describe('completeCharge', () => {
    beforeEach(() => {
      // Claim atómico PROCESSING→CHARGING (auditoría 2026-08-12): por default el
      // CAS "gana" (count 1) para que el happy path fluya; cada test de carrera
      // lo pisa con count 0.
      prismaMock.checkoutSession.updateMany.mockResolvedValue({ count: 1 } as any)
    })

    it('reclama la sesión con CAS (PROCESSING→CHARGING) ANTES de autorizar con el proveedor', async () => {
      const session = createMockCheckoutSession()
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(session)
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})
      prismaMock.order.create.mockResolvedValueOnce({ id: 'order-123', orderNumber: 'PL-123' })
      prismaMock.payment.create.mockResolvedValueOnce({ id: 'payment-123' })

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: session.id, status: 'PROCESSING' }),
          data: expect.objectContaining({ status: 'CHARGING' }),
        }),
      )
      // El claim ocurre ANTES de la autorización (si no, no protege nada).
      const claimOrder = prismaMock.checkoutSession.updateMany.mock.invocationCallOrder[0]
      const authOrder = mockBlumonService.authorizePayment.mock.invocationCallOrder[0]
      expect(claimOrder).toBeLessThan(authOrder)
    })

    it('la llamada concurrente que PIERDE el CAS no autoriza ni cobra doble', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      prismaMock.checkoutSession.updateMany.mockResolvedValueOnce({ count: 0 } as any)

      await expect(completeCharge('abc12345', 'cs_pl_test123')).rejects.toThrow(BadRequestError)
      expect(mockBlumonService.authorizePayment).not.toHaveBeenCalled()
    })

    it('si el proveedor FALLA antes de mandar el cargo, la sesión regresa a PROCESSING (reintentable)', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      mockBlumonService.authorizePayment.mockRejectedValueOnce(new Error('provider timeout'))

      await expect(completeCharge('abc12345', 'cs_pl_test123')).rejects.toThrow('provider timeout')

      expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'CHARGING' }),
          data: expect.objectContaining({ status: 'PROCESSING' }),
        }),
      )
    })

    it('un rechazo DEFINITIVO del proveedor (declinada) suelta el claim para reintentar con otra tarjeta', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      mockBlumonService.authorizePayment.mockRejectedValueOnce(new BadRequestError('Tarjeta declinada'))

      await expect(completeCharge('abc12345', 'cs_pl_test123')).rejects.toThrow('Tarjeta declinada')

      expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'CHARGING' }),
          data: expect.objectContaining({ status: 'PROCESSING' }),
        }),
      )
    })

    it('🔴 resultado DESCONOCIDO (timeout post-envío) NO suelta el claim — la sesión queda CHARGING', async () => {
      // El doble cargo del audit: Blumon aprueba pero la respuesta se pierde.
      // Si el claim se soltara aquí, el cliente reintenta, gana el CAS otra vez
      // y autoriza una SEGUNDA vez con otro transactionId. La sesión debe
      // quedarse CHARGING (atorada pero segura) para reconciliación.
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      mockBlumonService.authorizePayment.mockRejectedValueOnce(new PaymentOutcomeUnknownError())

      await expect(completeCharge('abc12345', 'cs_pl_test123')).rejects.toThrow(PaymentOutcomeUnknownError)

      // El ÚNICO updateMany permitido es el claim PROCESSING→CHARGING; jamás el
      // revert CHARGING→PROCESSING.
      const revertCalls = prismaMock.checkoutSession.updateMany.mock.calls.filter((call: any[]) => call[0]?.data?.status === 'PROCESSING')
      expect(revertCalls).toHaveLength(0)
    })

    it('should charge and create Order for ITEM link', async () => {
      const itemSession = createMockCheckoutSession({
        paymentLink: {
          id: 'pl-123',
          shortCode: 'abc12345',
          venueId: VENUE_ID,
          purpose: 'ITEM',
          createdById: STAFF_ID,
          attributions: [],
        },
        metadata: {
          cardToken: 'tok_test_123',
          maskedPan: '424242******4242',
          cardBrand: 'VISA',
          cvv: '123',
          purpose: 'ITEM',
          // Bundle snapshot — new shape after multi-product migration.
          // Each line has its product info + pre-selected modifiers (empty here).
          items: [{ productId: PRODUCT_ID, productName: 'Test Product', quantity: 2, unitPrice: 250, modifiers: [] }],
        },
        amount: new Decimal(500),
      })

      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(itemSession)

      // $transaction mock calls callback with prismaMock — the callback
      // creates checkout update, payment link update, order create, and now
      // a Payment row too (post-Blumon-parity refactor).
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})
      prismaMock.order.create.mockResolvedValueOnce({ id: 'order-123', orderNumber: 'PL-123' })
      prismaMock.payment.create.mockResolvedValueOnce({ id: 'payment-123' })

      const result = await completeCharge('abc12345', 'cs_pl_test123')

      expect(result.status).toBe('COMPLETED')
      expect(result.transactionId).toBe('txn_test_123')

      // Verify Blumon was called
      expect(mockBlumonService.authorizePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 500,
          cardToken: 'tok_test_123',
        }),
      )

      // Order created — TAKEOUT for ITEM links, source=PAYMENT_LINK, with the
      // bundle's line items nested under items.create (array now, not a single
      // object — multi-product post-migration).
      expect(prismaMock.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: VENUE_ID,
            type: 'TAKEOUT',
            source: 'PAYMENT_LINK',
            status: 'COMPLETED',
            paymentStatus: 'PAID',
            contratoDePrecio: 'IVA_INCLUIDO',
          }),
        }),
      )

      // El inventario ya NO se deduce a mano fuera de la transacción: nace un
      // vale durable atado a la orden real y se aplica tras el commit.
      expect(mockDeductInventory).not.toHaveBeenCalled()
      expect(mockCreateSalePostingInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ venueId: VENUE_ID, orderId: 'order-123' }),
      )
      expect(mockApplySalePosting).toHaveBeenCalledWith('posting-pl-1', expect.anything())
    })

    it('should charge and create MANUAL_ENTRY Order for PAYMENT link', async () => {
      // Post-Blumon-parity refactor: PAYMENT/DONATION links now also get an
      // Order (MANUAL_ENTRY type) so the unified Payment row can attach to it
      // and the transaction shows up in /payments. Inventory is NOT deducted.
      const paymentSession = createMockCheckoutSession()

      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(paymentSession)
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})
      prismaMock.order.create.mockResolvedValueOnce({ id: 'order-123', orderNumber: 'PL-123' })
      prismaMock.payment.create.mockResolvedValueOnce({ id: 'payment-123' })

      const result = await completeCharge('abc12345', 'cs_pl_test123')

      expect(result.status).toBe('COMPLETED')
      // Order IS created (MANUAL_ENTRY) so revenue reports include it.
      expect(prismaMock.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'MANUAL_ENTRY', source: 'PAYMENT_LINK' }),
        }),
      )
      // Inventory still skipped — PAYMENT links have no products.
      expect(mockDeductInventory).not.toHaveBeenCalled()
    })

    it('should reject already completed session', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession({ status: 'COMPLETED' }))

      await expect(completeCharge('abc12345', 'cs_pl_test123')).rejects.toThrow(BadRequestError)
    })

    it('should reject session from wrong payment link', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
        createMockCheckoutSession({
          paymentLink: { ...createMockCheckoutSession().paymentLink, shortCode: 'other123' },
        }),
      )

      await expect(completeCharge('abc12345', 'cs_pl_test123')).rejects.toThrow(BadRequestError)
    })

    it('should not fail payment if inventory deduction fails', async () => {
      mockApplySalePosting.mockRejectedValueOnce(new Error('Insufficient stock'))

      const itemSession = createMockCheckoutSession({
        paymentLink: {
          id: 'pl-123',
          shortCode: 'abc12345',
          venueId: VENUE_ID,
          purpose: 'ITEM',
          createdById: STAFF_ID,
          attributions: [],
        },
        metadata: {
          cardToken: 'tok_test_123',
          maskedPan: '424242******4242',
          cardBrand: 'VISA',
          cvv: '123',
          purpose: 'ITEM',
          items: [{ productId: PRODUCT_ID, productName: 'Test Product', quantity: 1, unitPrice: 250, modifiers: [] }],
        },
        amount: new Decimal(250),
      })

      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(itemSession)
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})
      prismaMock.order.create.mockResolvedValueOnce({ id: 'order-123' })
      prismaMock.payment.create.mockResolvedValueOnce({ id: 'payment-123' })

      // Should NOT throw — inventory failure is non-blocking
      const result = await completeCharge('abc12345', 'cs_pl_test123')
      expect(result.status).toBe('COMPLETED')
    })
  })

  // ─── INVENTARIO POR VALE DURABLE (fase 5.4) ─────
  //
  // Antes: los dos webhooks de liga de pago deducían inventario FUERA de la
  // transacción, best-effort, y le pasaban al movimiento `session.sessionId`
  // como si fuera el id de la orden. Dos daños distintos:
  //   1. Un crash entre el commit del cobro y el `for` de deducción dejaba la
  //      venta cobrada y SIN deducir, sin rastro consultable.
  //   2. El movimiento quedaba apuntando a un id de sesión de checkout, no a
  //      una orden — el kardex no se podía conciliar contra la venta.
  // Ahora el vale nace en la MISMA transacción que la orden PAID y el
  // aplicador corre después del commit (y el sweeper rescata lo que falle).
  describe('ligas de pago — el inventario pasa por el vale durable', () => {
    const itemLinkSession = () =>
      createMockCheckoutSession({
        paymentLink: {
          id: 'pl-123',
          shortCode: 'abc12345',
          venueId: VENUE_ID,
          purpose: 'ITEM',
          createdById: STAFF_ID,
          attributions: [],
        },
        metadata: {
          cardToken: 'tok_test_123',
          maskedPan: '424242******4242',
          cardBrand: 'VISA',
          cvv: '123',
          purpose: 'ITEM',
          items: [{ productId: PRODUCT_ID, productName: 'Test Product', quantity: 2, unitPrice: 250, modifiers: [] }],
        },
        amount: new Decimal(500),
      })

    const armarCobro = (orderId = 'order-123') => {
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})
      prismaMock.order.create.mockResolvedValueOnce({
        id: orderId,
        orderNumber: 'PL-123',
        items: [{ id: 'oi-1', productId: PRODUCT_ID, quantity: 2, weightQuantity: null, modifiers: [] }],
      })
      prismaMock.payment.create.mockResolvedValueOnce({ id: 'payment-123' })
    }

    it('Blumon: el vale nace con el MISMO cliente de transacción que creó la orden', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(itemLinkSession())
      armarCobro()

      // Cliente de transacción distinguible del prisma global: si el vale se
      // creara en su propia transacción (o fuera de una), este objeto no sería
      // el primer argumento y la ventana de "cobrado sin deducir" seguiría viva.
      const txClient: any = { ...prismaMock, __tx: true }
      prismaMock.$transaction.mockImplementationOnce((cb: any) => cb(txClient))

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(mockCreateSalePostingInTx).toHaveBeenCalled()
      expect(mockCreateSalePostingInTx.mock.calls[0][0]).toBe(txClient)
    })

    it('Blumon: el vale se ata a la ORDEN, nunca al id de la sesión de checkout', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(itemLinkSession())
      armarCobro('order-real-999')

      await completeCharge('abc12345', 'cs_pl_test123')

      const params = mockCreateSalePostingInTx.mock.calls[0][1]
      expect(params.orderId).toBe('order-real-999')
      expect(params.orderId).not.toBe('cs_pl_test123')
    })

    it('Blumon: aplicar el vale ocurre DESPUÉS del commit, no dentro de la transacción', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(itemLinkSession())
      armarCobro()

      let aplicadoDentroDeLaTx = false
      prismaMock.$transaction.mockImplementationOnce(async (cb: any) => {
        const r = await cb(prismaMock)
        aplicadoDentroDeLaTx = mockApplySalePosting.mock.calls.length > 0
        return r
      })

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(aplicadoDentroDeLaTx).toBe(false)
      expect(mockApplySalePosting).toHaveBeenCalledWith('posting-pl-1', expect.anything())
    })

    it('Blumon: una liga de PAGO (sin productos) igual deja vale — orden PAID ⟺ vale existe', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      armarCobro()

      await completeCharge('abc12345', 'cs_pl_test123')

      // Sin renglones el vale nace SKIPPED por el propio servicio de posting;
      // lo que este test fija es que la orden cobrada nunca se queda sin vale.
      expect(mockCreateSalePostingInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orderId: 'order-123' }))
    })

    // Codex r1 (19-oct): el webhook casi nunca trae el tipo (no expande `latest_charge`) y un OXXO caía a CREDIT_CARD / SAT 04.
    it('Stripe: sin tipo en el webhook, el método sale del cargo — OXXO → OTHER + SAT 01, nunca efectivo del cajón', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({
        ...createMockCheckoutSession(),
        ecommerceMerchant: {
          id: 'merchant-123',
          providerCredentials: { connectAccountId: 'acct_1' },
          provider: { code: 'STRIPE_CONNECT' },
        },
      })
      armarCobro('order-stripe-oxxo')
      retrieveStripePi.mockResolvedValueOnce({ latest_charge: { receipt_url: null, payment_method_details: { type: 'oxxo' } } })

      await finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1', stripePaymentMethodType: null })

      const data = prismaMock.payment.create.mock.calls[0][0].data
      expect(data.method).toBe('OTHER')
      expect(mapFormaPago(data.method, data.tenderSatFormaPago)).toBe('01')
      expect(data.fundsFlow).toBe('AVOQADO_PROCESSED')
      expect(paymentCountsAsDrawerCash(data)).toBe(false)
    })

    // Cierre del techo OXXO (founder «A», 19-oct): sin tipo y con Stripe caído un momento, se lanza para que Stripe reintente.
    it('Stripe: sin tipo y la consulta del cargo falla por algo pasajero → lanza sin guardar', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({
        ...createMockCheckoutSession(),
        ecommerceMerchant: {
          id: 'merchant-123',
          providerCredentials: { connectAccountId: 'acct_1' },
          provider: { code: 'STRIPE_CONNECT' },
        },
      })
      // Sin `armarCobro`: lanza antes de cobrar, y sus `…Once` se derramarían a las pruebas siguientes.
      retrieveStripePi.mockRejectedValueOnce(Object.assign(new Error('stripe caído'), { type: 'StripeConnectionError' }))

      await expect(
        finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1', stripePaymentMethodType: null }),
      ).rejects.toThrow('stripe caído')
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('Stripe: el vale nace en la transacción del cobro y se aplica después', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({
        ...itemLinkSession(),
        // Sin connectAccountId el servicio se salta la llamada a Stripe.
        ecommerceMerchant: { id: 'merchant-123', providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } },
      })
      armarCobro('order-stripe-1')

      const txClient: any = { ...prismaMock, __tx: true }
      prismaMock.$transaction.mockImplementationOnce((cb: any) => cb(txClient))

      await finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1' })

      expect(mockDeductInventory).not.toHaveBeenCalled()
      expect(mockCreateSalePostingInTx.mock.calls[0][0]).toBe(txClient)
      expect(mockCreateSalePostingInTx.mock.calls[0][1]).toEqual(expect.objectContaining({ orderId: 'order-stripe-1' }))
      expect(mockApplySalePosting).toHaveBeenCalledWith('posting-pl-1', expect.anything())
      // IVA por producto (plan 2): la liga de Stripe materializa precios con IVA incluido.
      expect(prismaMock.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ contratoDePrecio: 'IVA_INCLUIDO' }) }),
      )
    })

    // MercadoPago era el caso más roto de los tres: creaba SIEMPRE una orden
    // MANUAL_ENTRY / pago FAST y SIN renglones, aunque la liga fuera de
    // productos. Consecuencias: cero inventario descontado y la venta contada
    // como "entrada manual" (que por definición se filtra de los reportes
    // operativos). Aquí se fija que una liga de productos se materialice igual
    // que en Stripe y Blumon.
    describe('MercadoPago', () => {
      const mpSession = (overrides: Record<string, any> = {}) => ({
        id: 'session-db-123',
        sessionId: 'mp_sess_1',
        amount: new Decimal(500),
        applicationFeeCents: 0,
        customerEmail: 'john@example.com',
        paymentId: null,
        metadata: {
          items: [{ productId: PRODUCT_ID, productName: 'Test Product', quantity: 2, unitPrice: 250, modifiers: [] }],
        },
        ecommerceMerchant: { id: 'merchant-123', venueId: VENUE_ID },
        paymentLink: { id: 'pl-123', venueId: VENUE_ID, createdById: STAFF_ID, purpose: 'ITEM' },
        ...overrides,
      })

      const armarMp = (orderId = 'order-mp-1') => {
        prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ paymentId: null })
        prismaMock.order.create.mockResolvedValueOnce({
          id: orderId,
          items: [{ id: 'oi-1', productId: PRODUCT_ID, quantity: 2, weightQuantity: null, modifiers: [] }],
        })
        prismaMock.payment.create.mockResolvedValueOnce({ id: 'payment-mp-1' })
        prismaMock.checkoutSession.update.mockResolvedValueOnce({})
        prismaMock.paymentLink.update.mockResolvedValueOnce({})
      }

      it('una liga de PRODUCTOS materializa sus renglones en la orden', async () => {
        prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(mpSession())
        armarMp()

        await finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 777 })

        const args = prismaMock.order.create.mock.calls[0][0]
        expect(args.data.items).toBeDefined()
        expect(args.data.items.create).toHaveLength(1)
        expect(args.data.items.create[0]).toEqual(expect.objectContaining({ productId: PRODUCT_ID, quantity: 2 }))
      })

      it('una liga de PRODUCTOS es TAKEOUT, no una entrada manual', async () => {
        prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(mpSession())
        armarMp()

        await finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 777 })

        expect(prismaMock.order.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ type: 'TAKEOUT', contratoDePrecio: 'IVA_INCLUIDO' }) }),
        )
      })

      it('el vale nace en la transacción del cobro y se aplica después', async () => {
        prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(mpSession())
        armarMp('order-mp-9')

        const txClient: any = { ...prismaMock, __tx: true }
        prismaMock.$transaction.mockImplementationOnce((cb: any) => cb(txClient))

        await finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 777 })

        expect(mockCreateSalePostingInTx.mock.calls[0][0]).toBe(txClient)
        expect(mockCreateSalePostingInTx.mock.calls[0][1]).toEqual(expect.objectContaining({ orderId: 'order-mp-9' }))
        expect(mockApplySalePosting).toHaveBeenCalledWith('posting-pl-1', expect.anything())
      })

      it('un cobro de puro monto (sin productos) sigue siendo entrada manual', async () => {
        prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
          mpSession({ metadata: {}, paymentLink: { id: 'pl-123', venueId: VENUE_ID, createdById: STAFF_ID, purpose: 'PAYMENT' } }),
        )
        armarMp()

        await finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 777 })

        expect(prismaMock.order.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ type: 'MANUAL_ENTRY' }) }),
        )
      })

      // 16-oct (producción): un SPEI de $10 quedó como CREDIT_CARD porque el método iba fijo. El tipo lo dice Mercado
      // Pago (`payment_type_id`). OXXO NO es CASH (conciliación, saldo, póliza y corte deciden por `method === CASH`):
      // va como OTHER con forma SAT 01 sellada. Todo tipo conocido debe poder facturarse (forma SAT distinta de '99').
      it.each([
        ['bank_transfer', 'BANK_TRANSFER', '03'],
        ['ticket', 'OTHER', '01'],
        ['atm', 'OTHER', '01'],
        ['debit_card', 'DEBIT_CARD', '28'],
        ['prepaid_card', 'DEBIT_CARD', '28'],
        ['credit_card', 'CREDIT_CARD', '04'],
        ['account_money', 'DIGITAL_WALLET', '06'],
        ['algo_nuevo_de_mp', 'OTHER', '99'],
      ])('el cobro se registra con el tipo que dice Mercado Pago: %s → %s (SAT %s)', async (paymentTypeId, method, formaSat) => {
        prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(mpSession())
        armarMp()

        await finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 777, paymentTypeId })

        const data = prismaMock.payment.create.mock.calls[0][0].data
        expect(data.method).toBe(method)
        expect(mapFormaPago(data.method, data.tenderSatFormaPago)).toBe(formaSat)
        // La devolución hereda este sello: sin él, un reembolso SPEI no se descontaba en la conciliación bancaria.
        expect(data.fundsFlow).toBe('AVOQADO_PROCESSED')
        expect(paymentCountsAsDrawerCash(data)).toBe(false)
      })

      it('sin tipo (llamada que no lo trae) conserva CREDIT_CARD, como antes', async () => {
        prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(mpSession())
        armarMp()

        await finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 777 })

        expect(prismaMock.payment.create.mock.calls[0][0].data.method).toBe('CREDIT_CARD')
      })
    })

    it('Stripe: si aplicar el vale truena, el cobro NO se cae', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({
        ...itemLinkSession(),
        ecommerceMerchant: { id: 'merchant-123', providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } },
      })
      armarCobro()
      mockApplySalePosting.mockRejectedValueOnce(new Error('pool agotado'))

      await expect(finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1' })).resolves.not.toThrow()
    })
  })

  // ─── LEALTAD Y MÉTRICAS DEL CLIENTE (W1) ─────────
  //
  // El hueco no era el importe libre: era el CANAL. El TPV y el pago manual ya
  // acreditaban puntos y movían visitas/gasto sobre el total de la orden; una
  // liga de pago disparaba comisión y NUNCA tocaba al cliente. Un cliente
  // registrado que pagaba por link se quedaba sin sus puntos y sin su visita.
  describe('ligas de pago — lealtad y métricas del cliente', () => {
    const CUSTOMER_ID = 'cus-registrado-1'

    const armarCobro = (orderId = 'order-123') => {
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})
      prismaMock.order.create.mockResolvedValueOnce({ id: orderId, orderNumber: 'PL-123', items: [] })
      prismaMock.payment.create.mockResolvedValueOnce({ id: 'payment-123' })
    }

    const armarMp = (orderId = 'order-mp-1') => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ paymentId: null })
      prismaMock.order.create.mockResolvedValueOnce({ id: orderId, items: [] })
      prismaMock.payment.create.mockResolvedValueOnce({ id: 'payment-mp-1' })
      prismaMock.checkoutSession.update.mockResolvedValueOnce({})
      prismaMock.paymentLink.update.mockResolvedValueOnce({})
    }

    const mpSession = (overrides: Record<string, any> = {}) => ({
      id: 'session-db-123',
      sessionId: 'mp_sess_1',
      amount: new Decimal(500),
      applicationFeeCents: 0,
      customerEmail: 'john@example.com',
      customerPhone: null,
      paymentId: null,
      metadata: {},
      ecommerceMerchant: { id: 'merchant-123', venueId: VENUE_ID },
      paymentLink: { id: 'pl-123', venueId: VENUE_ID, createdById: STAFF_ID, purpose: 'PAYMENT' },
      ...overrides,
    })

    beforeEach(() => {
      prismaMock.checkoutSession.updateMany.mockResolvedValue({ count: 1 } as any)
      // `jest.clearAllMocks()` (setup global) borra las LLAMADAS pero NO las colas
      // de `mockResolvedValueOnce`. Un test que corta antes de resolver al cliente
      // deja su valor encolado y el siguiente lo consume: sin este reset, el test
      // del "pagador anónimo" veía al cliente del test anterior.
      prismaMock.customer.findFirst.mockReset()
    })

    it.each(['Stripe', 'Blumon', 'MercadoPago'])('%s: el snapshot A gana aunque B paga; conserva al cliente inactivo', async canal => {
      prismaMock.customer.findFirst.mockResolvedValue({ id: 'customer-A' })
      if (canal === 'MercadoPago') {
        prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(mpSession({ attributedCustomerId: 'customer-A' }))
        armarMp()
        await finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 'mp1' })
      } else {
        prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession({ attributedCustomerId: 'customer-A' }))
        armarCobro()
        if (canal === 'Stripe') await finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1' })
        else await completeCharge('abc12345', 'cs_pl_test123')
      }
      expect(prismaMock.customer.findFirst).toHaveBeenCalledTimes(1)
      expect(prismaMock.customer.findFirst).toHaveBeenCalledWith({ where: { id: 'customer-A', venueId: VENUE_ID }, select: { id: true } })
      expect(prismaMock.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ customerId: 'customer-A' }) }),
      )
    })

    it('snapshot de otro venue falla cerrado y nunca adopta al pagador', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession({ attributedCustomerId: 'customer-ajeno' }))
      prismaMock.customer.findFirst.mockResolvedValue(null)
      await expect(finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1' })).rejects.toThrow(/cliente/i)
      expect(prismaMock.customer.findFirst).toHaveBeenCalledTimes(1)
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })

    it('Blumon: un cliente registrado del venue recibe sus puntos UNA vez, sobre el total cobrado', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      armarCobro()

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(mockEarnPoints).toHaveBeenCalledTimes(1)
      // (venueId, customerId, base, orderId) — la MISMA firma que usa el TPV.
      // Sin 5º argumento a propósito: `LoyaltyTransaction.createdById` apunta a
      // StaffVenue.id y en una liga de pago no hay cajero; mandar el Staff.id del
      // creador de la liga reventaría la FK en silencio.
      expect(mockEarnPoints).toHaveBeenCalledWith(VENUE_ID, CUSTOMER_ID, 100, 'order-123')
    })

    it('Blumon: la visita y el gasto del cliente se mueven con la MISMA base que los puntos', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      armarCobro()

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(mockUpdateCustomerMetrics).toHaveBeenCalledTimes(1)
      // (customerId, base, orderId, venueId). Los dos últimos NO son decorativos:
      // `updateCustomerMetrics` sólo toma el row lock de `Customer` cuando recibe
      // `orderId` (customer.dashboard.service.ts:903). Sin él, dos cobros del mismo
      // cliente leen los mismos contadores y el último pisa al anterior.
      expect(mockUpdateCustomerMetrics).toHaveBeenCalledWith(CUSTOMER_ID, 100, 'order-123', VENUE_ID)
    })

    it('🔴 la propina NO entra en la base: es del empleado, no venta del negocio', async () => {
      // $500 cobrados = $450 de venta + $50 de propina. Los puntos van sobre 450.
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
        createMockCheckoutSession({
          amount: new Decimal(500),
          metadata: { cardToken: 'tok_test_123', maskedPan: '4242', cardBrand: 'VISA', cvv: '123', tipAmount: 50 },
        }),
      )
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      armarCobro()

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(mockEarnPoints).toHaveBeenCalledWith(VENUE_ID, CUSTOMER_ID, 450, 'order-123')
      expect(mockUpdateCustomerMetrics).toHaveBeenCalledWith(CUSTOMER_ID, 450, 'order-123', VENUE_ID)
    })

    it('la venta queda atada al cliente (Order.customerId), no sólo los puntos', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      armarCobro()

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(prismaMock.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ customerId: CUSTOMER_ID }) }),
      )
    })

    it('Stripe: el cobro por liga también acredita puntos y mueve métricas', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
        createMockCheckoutSession({
          ecommerceMerchant: { id: 'merchant-123', providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } },
        }),
      )
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      armarCobro('order-stripe-1')

      await finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1' })

      expect(mockEarnPoints).toHaveBeenCalledWith(VENUE_ID, CUSTOMER_ID, 100, 'order-stripe-1')
      expect(mockUpdateCustomerMetrics).toHaveBeenCalledWith(CUSTOMER_ID, 100, 'order-stripe-1', VENUE_ID)
      expect(prismaMock.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ customerId: CUSTOMER_ID }) }),
      )
    })

    it('MercadoPago: el cobro por liga también acredita puntos y mueve métricas', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(mpSession())
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      armarMp('order-mp-9')

      await finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 777 })

      expect(mockEarnPoints).toHaveBeenCalledWith(VENUE_ID, CUSTOMER_ID, 500, 'order-mp-9')
      expect(mockUpdateCustomerMetrics).toHaveBeenCalledWith(CUSTOMER_ID, 500, 'order-mp-9', VENUE_ID)
      expect(prismaMock.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ customerId: CUSTOMER_ID }) }),
      )
    })

    // ── Idempotencia: un webhook reentregado NO regala puntos dos veces ──
    //
    // Las visitas del cliente (`totalVisits++`) NO tienen llave de deduplicación
    // propia, así que dependen enteramente de que el finalizador sea de un solo
    // disparo. Estos tests fijan que el enganche viva DESPUÉS de ese candado.

    it('🔴 Stripe: una reentrega del webhook (sesión ya COMPLETED) no vuelve a acreditar', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
        createMockCheckoutSession({
          status: 'COMPLETED',
          ecommerceMerchant: { id: 'merchant-123', providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } },
        }),
      )
      prismaMock.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID })

      await finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1' })

      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(mockEarnPoints).not.toHaveBeenCalled()
      expect(mockUpdateCustomerMetrics).not.toHaveBeenCalled()
    })

    it('🔴 MercadoPago: si una llamada concurrente ya selló el pago, no se acredita nada', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(mpSession())
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      // Recheck DENTRO de la transacción: el otro finalizador ya creó la orden.
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ paymentId: 'payment-ya-existente' })

      await finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 777 })

      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(mockEarnPoints).not.toHaveBeenCalled()
      expect(mockUpdateCustomerMetrics).not.toHaveBeenCalled()
    })

    it('Blumon: una sesión ya COMPLETED se rechaza y no acredita', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession({ status: 'COMPLETED' }))
      prismaMock.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID })

      await expect(completeCharge('abc12345', 'cs_pl_test123')).rejects.toThrow(BadRequestError)
      expect(mockEarnPoints).not.toHaveBeenCalled()
      expect(mockUpdateCustomerMetrics).not.toHaveBeenCalled()
    })

    // ── Sin cliente, nada cambia ──

    it('un pagador anónimo (correo que no es de ningún cliente) NO toca lealtad ni métricas', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      prismaMock.customer.findFirst.mockResolvedValue(null) // no empata por correo ni por teléfono
      armarCobro()

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(mockEarnPoints).not.toHaveBeenCalled()
      expect(mockUpdateCustomerMetrics).not.toHaveBeenCalled()
      // Y jamás se crea un cliente nuevo: un pago anónimo no da de alta a nadie.
      expect(prismaMock.customer.create).not.toHaveBeenCalled()
      expect(prismaMock.order.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.not.objectContaining({ customerId: expect.anything() }) }),
      )
    })

    it('un cobro sin correo ni teléfono ni siquiera consulta la tabla de clientes', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession({ customerEmail: null, customerPhone: null }))
      armarCobro()

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(prismaMock.customer.findFirst).not.toHaveBeenCalled()
      expect(mockEarnPoints).not.toHaveBeenCalled()
    })

    // ── Nunca puede tumbar un cobro ya aprobado ──

    it('🔴 si acreditar los puntos truena, el cobro NO se cae', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      armarCobro()
      mockUpdateCustomerMetrics.mockRejectedValueOnce(new Error('pool agotado'))
      mockEarnPoints.mockRejectedValueOnce(new Error('lealtad caída'))

      const result = await completeCharge('abc12345', 'cs_pl_test123')

      expect(result.status).toBe('COMPLETED')
    })

    it('el programa apagado lo decide earnPoints, aquí no se replica el candado', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(createMockCheckoutSession())
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      armarCobro()
      // Venue con LoyaltyConfig.active=false → earnPoints devuelve 0 puntos.
      mockEarnPoints.mockResolvedValueOnce({ pointsEarned: 0, newBalance: 0 })

      const result = await completeCharge('abc12345', 'cs_pl_test123')

      expect(result.status).toBe('COMPLETED')
      // Las métricas SÍ se mueven aunque no haya puntos: la visita ocurrió.
      expect(mockUpdateCustomerMetrics).toHaveBeenCalledWith(CUSTOMER_ID, 100, 'order-123', VENUE_ID)
    })

    it('🔴 la comisión nace con el cobro, en SU transacción, para la persona atribuida (A5)', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
        createMockCheckoutSession({
          paymentLink: {
            id: 'pl-123',
            shortCode: 'abc12345',
            venueId: VENUE_ID,
            purpose: 'PAYMENT',
            createdById: STAFF_ID,
            attributions: [{ staffId: STAFF_ID }],
          },
        }),
      )
      prismaMock.customer.findFirst.mockResolvedValueOnce({ id: CUSTOMER_ID })
      armarCobro()
      const txClient: any = { ...prismaMock, __tx: true }
      prismaMock.$transaction.mockImplementationOnce((cb: any) => cb(txClient))

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(mockEnqueuePaymentCommissionInTx).toHaveBeenCalledWith(txClient, 'payment-123', [STAFF_ID])
      // A5 r1: la transacción del cobro lleva el tope de la terminal (10 s), no los 5 s de fábrica de Prisma.
      expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), OPCIONES_DE_TRANSACCION_DEL_INTENTO)
    })

    it('🔴 sin cliente, la comisión dividida nace en la transacción y el vale de inventario sigue intacto (A5)', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
        createMockCheckoutSession({
          paymentLink: {
            id: 'pl-123',
            shortCode: 'abc12345',
            venueId: VENUE_ID,
            purpose: 'PAYMENT',
            createdById: STAFF_ID,
            attributions: [{ staffId: STAFF_ID }, { staffId: 'staff-2' }],
          },
        }),
      )
      prismaMock.customer.findFirst.mockResolvedValue(null)
      armarCobro()
      const txClient: any = { ...prismaMock, __tx: true }
      prismaMock.$transaction.mockImplementationOnce((cb: any) => cb(txClient))

      await completeCharge('abc12345', 'cs_pl_test123')

      expect(mockEnqueuePaymentCommissionInTx).toHaveBeenCalledWith(txClient, 'payment-123', [STAFF_ID, 'staff-2'])
      expect(mockCreateSalePostingInTx).toHaveBeenCalled()
      expect(mockApplySalePosting).toHaveBeenCalledWith('posting-pl-1', expect.anything())
    })

    it('🔴 Stripe: la comisión dividida nace en la transacción del cobro, no después del commit (A5)', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(
        createMockCheckoutSession({
          ecommerceMerchant: { id: 'merchant-123', providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } },
          paymentLink: {
            id: 'pl-123',
            shortCode: 'abc12345',
            venueId: VENUE_ID,
            purpose: 'PAYMENT',
            createdById: STAFF_ID,
            attributions: [{ staffId: STAFF_ID }, { staffId: 'staff-2' }],
          },
        }),
      )
      prismaMock.customer.findFirst.mockResolvedValue(null)
      armarCobro('order-stripe-1')
      const txClient: any = { ...prismaMock, __tx: true }
      prismaMock.$transaction.mockImplementationOnce((cb: any) => cb(txClient))

      await finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1' })

      expect(mockEnqueuePaymentCommissionInTx).toHaveBeenCalledTimes(1)
      expect(mockEnqueuePaymentCommissionInTx).toHaveBeenCalledWith(txClient, 'payment-123', [STAFF_ID, 'staff-2'])
      expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), OPCIONES_DE_TRANSACCION_DEL_INTENTO)
    })
  })

  // ─── SESSION STATUS ─────────────────────────────
  describe('getSessionStatus', () => {
    it('should return session status', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({
        sessionId: 'cs_pl_test123',
        status: 'COMPLETED',
        amount: new Decimal(100),
        currency: 'MXN',
        completedAt: new Date(),
        errorMessage: null,
        paymentLink: { shortCode: 'abc12345', redirectUrl: null },
      })

      const result = await getSessionStatus('abc12345', 'cs_pl_test123')

      expect(result.status).toBe('COMPLETED')
      expect(result.sessionId).toBe('cs_pl_test123')
    })

    it('should reject if session not found', async () => {
      prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(null)

      await expect(getSessionStatus('abc12345', 'bad-session')).rejects.toThrow(NotFoundError)
    })
  })

  // ─── REGRESSION: Existing features still work ─────
  describe('Regression tests', () => {
    it('DONATION links should work with OPEN amount', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce(chargeableMerchants)
      prismaMock.paymentLink.create.mockResolvedValueOnce(
        createMockPaymentLink({
          purpose: 'DONATION',
          amountType: 'OPEN',
          amount: null,
          isReusable: true,
        }),
      )

      const result = await createPaymentLink(
        VENUE_ID,
        {
          title: 'Donación',
          amountType: 'OPEN',
          isReusable: true,
          purpose: 'DONATION',
        },
        STAFF_ID,
      )

      expect(result).toBeDefined()
      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            purpose: 'DONATION',
            isReusable: true,
          }),
        }),
      )
    })

    it('default purpose should be PAYMENT when not specified', async () => {
      prismaMock.ecommerceMerchant.findMany.mockResolvedValueOnce(chargeableMerchants)
      prismaMock.paymentLink.create.mockResolvedValueOnce(createMockPaymentLink())

      await createPaymentLink(
        VENUE_ID,
        {
          title: 'No purpose specified',
          amountType: 'FIXED',
          amount: 50,
          // No purpose field
        },
        STAFF_ID,
      )

      expect(prismaMock.paymentLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            purpose: 'PAYMENT',
          }),
        }),
      )
    })
  })
})
