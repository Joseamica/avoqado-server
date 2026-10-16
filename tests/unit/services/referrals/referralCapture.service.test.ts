/**
 * referralCapture.service tests — Phase B2, Tasks 10 + 11
 *
 * Schema notes:
 *   - `Customer` stores `firstName` / `lastName` (no unified `name`).
 *   - `Customer.referralCode` is unique per venue (composite uniqueness
 *     enforced upstream; we lookup with `findFirst` scoped by venueId).
 *   - Audit log model is `ActivityLog`; its JSON payload column is `data`,
 *     not `metadata`. The outer `data:` is Prisma's create-call argument,
 *     and the inner `data:` is the JSON column.
 *   - `Order.customerId` + `Order.venueId` count tells us whether the
 *     "new" customer is actually a returning customer.
 */

import {
  validateReferralCode,
  captureReferral,
  forceOverrideReferral,
  manualVoidReferral,
} from '@/services/referrals/referralCapture.service'
import prisma from '@/utils/prismaClient'
import { WHERE_ORDEN_SIN_TARJETAS } from '@/services/giftCards/giftCardMarks'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    referralProgramConfig: { findUnique: jest.fn() },
    customer: { findFirst: jest.fn(), findUnique: jest.fn() },
    referral: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    order: { count: jest.fn(), findFirst: jest.fn() },
    // La marca de cuenta de tarjetas (`leerSiEsCuentaDeTarjetas`): sin respuesta ⇒ cuenta normal, así las pruebas viejas no cambian.
    orderItem: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}))

const mockedPrisma = prisma as any

describe('referralCapture.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Default: the supplied staff id resolves directly as a StaffVenue id.
    mockedPrisma.staffVenue.findFirst.mockResolvedValue({ id: 'sv_1' })
    // Default: whatever intendedOrderId the caller passes IS a real order of
    // this venue, so it survives `resolveIntendedOrderId` unchanged.
    mockedPrisma.order.findFirst.mockImplementation(async ({ where }: any) => ({ id: where.id }))
  })

  describe('validateReferralCode', () => {
    const ctx = { venueId: 'venue_1', referralCode: 'TESTMF-JOSE2K7', newCustomerId: 'cust_new' }

    it('rejects when program inactive', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: false })
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'PROGRAM_INACTIVE' })
    })

    it('rejects when no config exists', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue(null)
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'PROGRAM_INACTIVE' })
    })

    it('rejects when code does not exist in this venue', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue(null)
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'CODE_NOT_FOUND' })
    })

    it('rejects self-referral', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_new', firstName: 'X', lastName: 'Y' })
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'SELF_REFERRAL' })
    })

    it('rejects existing customer (has prior Orders)', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(3)
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'EXISTING_CUSTOMER' })
    })

    it('returns valid + referrer + discountPercent when all checks pass', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
        active: true,
        newCustomerDiscountPercent: 10,
      })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'Pérez' })
      mockedPrisma.order.count.mockResolvedValue(0)
      const result = await validateReferralCode(ctx)
      expect(result.valid).toBe(true)
      expect(result.referrer?.id).toBe('cust_ref')
      expect(result.discountPercent).toBe(10)
    })
  })

  /**
   * Founder decision 2026-08-18 (see the market comparison in
   * `inv-decisiones-B-report.md`, question 3): "new customer" is defined by
   * MONEY, not by the existence of a row.
   *
   * Mindbody assigns "Referred by" to existing clients too and only pays on a
   * purchase; Booksy charges for "visits that actually took place"; Square
   * requires "one payment greater than $1". We used to disqualify on
   * `order.count` with NO status filter, so a booking, an abandoned cart or a
   * cancelled check made the customer "existing" forever.
   */
  describe('validateReferralCode — "new" = no PRIOR PAID sale', () => {
    const ctx = { venueId: 'venue_1', referralCode: 'TESTMF-JOSE2K7', newCustomerId: 'cust_new' }

    beforeEach(() => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
    })

    it('only counts orders that carry MONEY — an unpaid (PENDING) order must not disqualify', async () => {
      mockedPrisma.order.count.mockResolvedValue(0)
      const result = await validateReferralCode(ctx)

      expect(result.valid).toBe(true)
      // The WHERE clause is the assertion: a bare `{ customerId, venueId }`
      // count is what made a PENDING order disqualify. Both money signals are
      // required because prod has historically inconsistent rows (an order
      // left PENDING with a COMPLETED payment attached) — the same defensive
      // pair `order.dashboard.service.cancelOrder` already uses.
      const where = mockedPrisma.order.count.mock.calls[0][0].where
      expect(where).toMatchObject({ customerId: 'cust_new', venueId: 'venue_1' })
      expect(where.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ paymentStatus: 'PAID' }),
          expect.objectContaining({ payments: { some: { status: 'COMPLETED', type: 'REGULAR' } } }),
        ]),
      )
    })

    it('rejects with EXISTING_CUSTOMER and a Spanish message when the customer already bought', async () => {
      mockedPrisma.order.count.mockResolvedValue(1)
      const result = await validateReferralCode(ctx)

      expect(result).toMatchObject({ valid: false, reason: 'EXISTING_CUSTOMER' })
      // `reason` stays the machine discriminator the clients switch on; the
      // message is what the cashier reads, so it must be Spanish.
      expect(result.message).toMatch(/compra/i)
    })

    it('excludes intendedOrderId from the count so a post-payment capture cannot reject itself', async () => {
      // The POS captures on payment SUCCESS (Android `CheckoutScreen`, iOS
      // `CheckoutView`), so by then the sale of THIS checkout already exists
      // and is PAID. Counting it made every mobile capture return
      // EXISTING_CUSTOMER — the referral program was dead on both apps.
      mockedPrisma.order.count.mockResolvedValue(0)
      const result = await validateReferralCode({ ...ctx, intendedOrderId: 'order_this_sale' })

      expect(result.valid).toBe(true)
      expect(mockedPrisma.order.count.mock.calls[0][0].where).toMatchObject({ id: { not: 'order_this_sale' } })
    })

    it('does not add an id filter when no intendedOrderId is supplied (pre-payment validate)', async () => {
      mockedPrisma.order.count.mockResolvedValue(0)
      await validateReferralCode(ctx)
      expect(mockedPrisma.order.count.mock.calls[0][0].where).not.toHaveProperty('id')
    })

    it('carries a Spanish message on every rejection reason', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: false })
      expect((await validateReferralCode(ctx)).message).toEqual(expect.any(String))

      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue(null)
      expect((await validateReferralCode(ctx)).message).toEqual(expect.any(String))

      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_new', firstName: 'X', lastName: 'Y' })
      expect((await validateReferralCode(ctx)).message).toEqual(expect.any(String))
    })
  })

  describe('captureReferral', () => {
    it('rechaza con CUSTOMER_NOT_FOUND (no revienta por FK) si el cliente referido no existe en el venue', async () => {
      // /full-testing 2026-08-18: un newCustomerId inventado llegaba a `referral.create` y
      // reventaba con 500 + ruta interna del server (Referral_referredCustomerId_fkey), y lo
      // alcanzaba hasta un VIEWER. Ahora se valida ANTES de crear: razón de negocio, 4xx.
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst
        .mockResolvedValueOnce({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' }) // el que refiere existe
        .mockResolvedValueOnce(null) // el referido NO existe en este venue
      mockedPrisma.order.count.mockResolvedValue(0)

      await expect(
        captureReferral({
          venueId: 'venue_1',
          referralCode: 'TESTMF-JOSE2K7',
          newCustomerId: 'cust_inventado',
          capturedByStaffVenueId: 'sv_1',
        }),
      ).rejects.toThrow('CUSTOMER_NOT_FOUND')
      expect(mockedPrisma.referral.create).not.toHaveBeenCalled()
    })

    it('creates Referral with PENDING status', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(0)
      mockedPrisma.referral.create.mockResolvedValue({ id: 'ref_1', status: 'PENDING' })
      await captureReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        newCustomerId: 'cust_new',
        capturedByStaffVenueId: 'sv_1',
        intendedOrderId: 'order_pending',
      })
      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: 'venue_1',
          referrerCustomerId: 'cust_ref',
          referredCustomerId: 'cust_new',
          status: 'PENDING',
          capturedByStaffVenueId: 'sv_1',
          qualifyingOrderId: 'order_pending',
        }),
      })
    })

    it('resolves a raw Staff.id into the StaffVenue.id (mobile clients send Staff.id) — regression for FK violation', async () => {
      // Live-discovered bug: mobile apps persist Staff.id (userId), not the
      // StaffVenue join-row id the FK requires. Passing Staff.id straight to
      // the insert crashed capture with a 500 FK violation. The service now
      // resolves it: first findFirst({id}) misses, then findFirst({staffId}) hits.
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(0)
      mockedPrisma.referral.create.mockResolvedValue({ id: 'ref_1', status: 'PENDING' })
      mockedPrisma.staffVenue.findFirst
        .mockResolvedValueOnce(null) // not a StaffVenue.id
        .mockResolvedValueOnce({ id: 'sv_resolved' }) // but matches a Staff.id at this venue
      await captureReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        newCustomerId: 'cust_new',
        capturedByStaffVenueId: 'staff_raw_id',
      })
      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ capturedByStaffVenueId: 'sv_resolved' }),
      })
    })

    it('falls back to null capturedByStaffVenueId when the staff id cannot be resolved (no FK crash)', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(0)
      mockedPrisma.referral.create.mockResolvedValue({ id: 'ref_1', status: 'PENDING' })
      mockedPrisma.staffVenue.findFirst.mockResolvedValue(null) // neither StaffVenue.id nor Staff.id
      await captureReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        newCustomerId: 'cust_new',
        capturedByStaffVenueId: 'totally_unknown_id',
      })
      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ capturedByStaffVenueId: null }),
      })
    })

    it('threads intendedOrderId into validation so the sale it is about to qualify is not counted against it', async () => {
      // Without this, capture-on-payment-success is self-defeating: the very
      // order we are linking the referral to is a PAID order for this
      // customer, so re-running validation rejects with EXISTING_CUSTOMER.
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(0)
      mockedPrisma.referral.create.mockResolvedValue({ id: 'ref_1', status: 'PENDING' })

      await captureReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        newCustomerId: 'cust_new',
        capturedByStaffVenueId: 'sv_1',
        intendedOrderId: 'order_this_sale',
      })

      expect(mockedPrisma.order.count.mock.calls[0][0].where).toMatchObject({ id: { not: 'order_this_sale' } })
    })

    it('drops an intendedOrderId that does not exist in this venue instead of crashing the capture', async () => {
      // Capture must NEVER block the sale. An order id the server does not
      // know (a provisional/offline id, another venue's order) would violate
      // the `qualifyingOrderId` FK and turn the capture into a 500 — losing
      // the attribution AND showing the cashier a red error after a
      // successful charge. Same philosophy as `resolveStaffVenueId`: drop the
      // link, keep the row.
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(0)
      mockedPrisma.order.findFirst.mockResolvedValue(null) // unknown order
      mockedPrisma.referral.create.mockResolvedValue({ id: 'ref_1', status: 'PENDING' })

      await captureReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        newCustomerId: 'cust_new',
        capturedByStaffVenueId: 'sv_1',
        intendedOrderId: 'local_2f9c-not-a-server-id',
      })

      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'PENDING', qualifyingOrderId: null }),
      })
    })

    it('throws with reason when validation fails', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: false })
      await expect(
        captureReferral({
          venueId: 'venue_1',
          referralCode: 'X',
          newCustomerId: 'cust_new',
          capturedByStaffVenueId: 'sv_1',
        }),
      ).rejects.toThrow(/PROGRAM_INACTIVE/)
    })
  })

  /**
   * Tarjetas de regalo (R1, B6 r1): vender una tarjeta no es una compra. La captura sobre una cuenta de tarjetas se rechaza
   * (`GIFT_CARD_SALE`) —un referido atado ahí nunca calificaría— y esa cuenta no hace al comprador «cliente existente», así que el
   * referido se captura en su primera compra real.
   */
  describe('tarjetas de regalo (R1)', () => {
    const ctx = { venueId: 'venue_1', referralCode: 'TESTMF-JOSE2K7', newCustomerId: 'cust_new' }
    const capturar = (intendedOrderId?: string) =>
      captureReferral({ ...ctx, capturedByStaffVenueId: 'sv_1', ...(intendedOrderId ? { intendedOrderId } : {}) })
    /** Cuenta de tarjetas: un renglón con `giftCardId` y ninguno sin él (las dos lecturas de `leerSiEsCuentaDeTarjetas`). */
    const laCuentaEsDeTarjetas = () => mockedPrisma.orderItem.findFirst.mockResolvedValueOnce({ id: 'oi_gc' }).mockResolvedValueOnce(null)
    /** La base en chico: las cuentas PAGADAS previas del cliente; el conteo respeta la exclusión de cuentas de tarjetas si viene. */
    const cuentasPagadasPrevias = (previas: Array<{ esDeTarjetas: boolean }>) =>
      mockedPrisma.order.count.mockImplementation(async ({ where }: any) => {
        const excluyeTarjetas = (where.AND ?? []).some((c: unknown) => JSON.stringify(c) === JSON.stringify(WHERE_ORDEN_SIN_TARJETAS))
        return previas.filter(o => !(excluyeTarjetas && o.esDeTarjetas)).length
      })

    beforeEach(() => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.referral.create.mockResolvedValue({ id: 'ref_1', status: 'PENDING' })
      cuentasPagadasPrevias([])
    })

    it('🔴 validar sobre una venta de tarjetas ⇒ GIFT_CARD_SALE con un texto en español que el POS muestra tal cual', async () => {
      laCuentaEsDeTarjetas()
      const result = await validateReferralCode({ ...ctx, intendedOrderId: 'order_gc' })
      expect(result).toEqual({
        valid: false,
        reason: 'GIFT_CARD_SALE',
        message: 'El referido se registra en la primera compra; la venta de una tarjeta de regalo no cuenta.',
      })
    })

    it('🔴 capturar sobre una venta de tarjetas se rechaza con GIFT_CARD_SALE y no crea el referido', async () => {
      laCuentaEsDeTarjetas()
      await expect(capturar('order_gc')).rejects.toThrow('GIFT_CARD_SALE')
      expect(mockedPrisma.referral.create).not.toHaveBeenCalled()
    })

    it('🔴 si su única compra pagada previa es una tarjeta de regalo, NO es cliente existente: el referido se captura', async () => {
      cuentasPagadasPrevias([{ esDeTarjetas: true }])
      await expect(validateReferralCode(ctx)).resolves.toMatchObject({ valid: true })
      // `AND`, nunca una llave suelta: el `OR` de las dos señales de dinero sigue entero.
      const where = mockedPrisma.order.count.mock.calls[0][0].where
      expect(where.AND).toContainEqual(WHERE_ORDEN_SIN_TARJETAS)
      expect(where.OR).toHaveLength(2)
    })

    it('regresión: una compra de mercancía pagada previa sigue siendo EXISTING_CUSTOMER (también junto a una tarjeta)', async () => {
      cuentasPagadasPrevias([{ esDeTarjetas: false }])
      await expect(validateReferralCode(ctx)).resolves.toMatchObject({ valid: false, reason: 'EXISTING_CUSTOMER' })
      cuentasPagadasPrevias([{ esDeTarjetas: true }, { esDeTarjetas: false }])
      await expect(validateReferralCode(ctx)).resolves.toMatchObject({ valid: false, reason: 'EXISTING_CUSTOMER' })
    })

    it('regresión: capturar sobre una venta de mercancía funciona como siempre (la marca se lee de ESA cuenta)', async () => {
      mockedPrisma.orderItem.findFirst.mockResolvedValueOnce(null)
      await capturar('order_merc')
      expect(mockedPrisma.orderItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderId: 'order_merc', giftCardId: { not: null } } }),
      )
      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'PENDING', qualifyingOrderId: 'order_merc' }),
      })
    })

    it('sin venta en curso (validar antes de cobrar) no se lee ninguna marca', async () => {
      await expect(validateReferralCode(ctx)).resolves.toMatchObject({ valid: true })
      expect(mockedPrisma.orderItem.findFirst).not.toHaveBeenCalled()
    })
  })

  describe('forceOverrideReferral', () => {
    it('creates Referral with forcedOverride=true and writes activity log', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.referral.create.mockResolvedValue({
        id: 'ref_force',
        venueId: 'venue_1',
        forcedOverride: true,
      })
      await forceOverrideReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        existingCustomerId: 'cust_existing',
        capturedByStaffVenueId: 'sv_waiter',
        managerStaffVenueId: 'sv_manager',
        reason: 'Cliente histórica, no se le había mencionado el programa',
      })
      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          forcedOverride: true,
          overrideReason: expect.stringContaining('Cliente histórica'),
        }),
      })
      expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REFERRAL_FORCE_OVERRIDE',
            entity: 'Referral',
            entityId: 'ref_force',
            venueId: 'venue_1',
            data: expect.objectContaining({
              reason: expect.any(String),
              managerStaffVenueId: 'sv_manager',
            }),
          }),
        }),
      )
    })

    it('rejects when code does not exist', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue(null)
      await expect(
        forceOverrideReferral({
          venueId: 'venue_1',
          referralCode: 'BOGUS-X',
          existingCustomerId: 'cust_existing',
          capturedByStaffVenueId: 'sv_1',
          managerStaffVenueId: 'sv_manager',
          reason: 'X',
        }),
      ).rejects.toThrow(/CODE_NOT_FOUND/)
    })

    it('rejects self-referral even with override', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_existing', firstName: 'Jose', lastName: 'P' })
      await expect(
        forceOverrideReferral({
          venueId: 'venue_1',
          referralCode: 'TESTMF-JOSE2K7',
          existingCustomerId: 'cust_existing',
          capturedByStaffVenueId: 'sv_1',
          managerStaffVenueId: 'sv_manager',
          reason: 'X',
        }),
      ).rejects.toThrow(/SELF_REFERRAL/)
    })
  })

  describe('manualVoidReferral', () => {
    it('sets status VOID, voidedAt, voidReason + activity log', async () => {
      mockedPrisma.referral.findUnique.mockResolvedValue({ id: 'ref_1', status: 'PENDING', venueId: 'venue_1' })
      mockedPrisma.referral.update.mockResolvedValue({ id: 'ref_1', status: 'VOID' })
      await manualVoidReferral({ referralId: 'ref_1', reason: 'Fraude detectado', staffVenueId: 'sv_manager' })
      expect(mockedPrisma.referral.update).toHaveBeenCalledWith({
        where: { id: 'ref_1' },
        data: expect.objectContaining({
          status: 'VOID',
          voidedAt: expect.any(Date),
          voidReason: 'Fraude detectado',
        }),
      })
      expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REFERRAL_MANUAL_VOID',
            entity: 'Referral',
            entityId: 'ref_1',
          }),
        }),
      )
    })

    it('rejects when Referral is already QUALIFIED (must use refund flow)', async () => {
      mockedPrisma.referral.findUnique.mockResolvedValue({ id: 'ref_1', status: 'QUALIFIED', venueId: 'venue_1' })
      await expect(manualVoidReferral({ referralId: 'ref_1', reason: 'X', staffVenueId: 'sv_1' })).rejects.toThrow(/already qualified/i)
    })

    it('rejects when Referral does not exist', async () => {
      mockedPrisma.referral.findUnique.mockResolvedValue(null)
      await expect(manualVoidReferral({ referralId: 'ghost', reason: 'X', staffVenueId: 'sv_1' })).rejects.toThrow(/not found/i)
    })
  })
})
