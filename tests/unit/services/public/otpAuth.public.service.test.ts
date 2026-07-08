import { prismaMock } from '@tests/__helpers__/setup'
import { BadRequestError } from '@/errors/AppError'
import { hashOtpCode } from '@/lib/otp'

// --- Mocks for the side-effecting collaborators ---
jest.mock('@/services/whatsapp.service', () => ({
  __esModule: true,
  sendOtpWhatsApp: jest.fn().mockResolvedValue(true),
}))

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendOtpCodeEmail: jest.fn().mockResolvedValue(true) },
}))

jest.mock('@/jwt.service', () => ({
  __esModule: true,
  generateCustomerToken: jest.fn(() => 'signed.jwt.token'),
}))

// Imported AFTER the mocks so the service binds to the mocked modules.
import { requestOtp, verifyOtp } from '@/services/public/otpAuth.public.service'
import { sendOtpWhatsApp } from '@/services/whatsapp.service'
import emailService from '@/services/email.service'
import { generateCustomerToken } from '@/jwt.service'

const VENUE_ID = 'venue-123'
const PHONE_RAW = '+52 (55) 1234-5678'
const PHONE_NORM = '+525512345678'

describe('OTP Auth Public Service', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    process.env.OTP_PEPPER = 'test-pepper'
    // Re-arm the default resolved values that resetAllMocks() wiped.
    ;(sendOtpWhatsApp as jest.Mock).mockResolvedValue(true)
    ;(emailService.sendOtpCodeEmail as jest.Mock).mockResolvedValue(true)
    ;(generateCustomerToken as jest.Mock).mockReturnValue('signed.jwt.token')
    // Name-backfill lookup (findGuestNameFromPastReservations) runs on every new-customer
    // path. Default to "no past reservation" so tests that don't care about backfill
    // don't have to mock it; tests below override per-case.
    prismaMock.reservation.findMany.mockResolvedValue([])
    prismaMock.reservation.findFirst.mockResolvedValue(null)
    prismaMock.$queryRaw.mockResolvedValue([]) // phone-path backfill now uses $queryRaw
  })

  // ==========================================
  // requestOtp
  // ==========================================
  describe('requestOtp', () => {
    it('expires prior challenges, stores a HASHED code, sends WhatsApp, returns {ok:true}', async () => {
      prismaMock.otpChallenge.count.mockResolvedValue(0) // both rate-limit windows clear
      prismaMock.otpChallenge.updateMany.mockResolvedValue({ count: 1 })
      prismaMock.otpChallenge.create.mockResolvedValue({ id: 'otp-1' })

      const result = await requestOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: PHONE_RAW, ip: '1.2.3.4' })

      expect(result).toEqual({ ok: true })

      // Prior unconsumed challenges are invalidated for the normalized destination
      expect(prismaMock.otpChallenge.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ destination: PHONE_NORM, consumedAt: null }),
          data: expect.objectContaining({ consumedAt: expect.any(Date) }),
        }),
      )

      // The stored code must be a sha256 hex hash, never the plaintext
      expect(prismaMock.otpChallenge.create).toHaveBeenCalledTimes(1)
      const createArg = (prismaMock.otpChallenge.create as jest.Mock).mock.calls[0][0]
      expect(createArg.data.channel).toBe('whatsapp')
      expect(createArg.data.destination).toBe(PHONE_NORM)
      expect(createArg.data.codeHash).toMatch(/^[a-f0-9]{64}$/)
      expect(createArg.data.ip).toBe('1.2.3.4')
      expect(createArg.data.expiresAt).toBeInstanceOf(Date)

      // WhatsApp send fired to the normalized number; email untouched
      expect(sendOtpWhatsApp).toHaveBeenCalledTimes(1)
      expect((sendOtpWhatsApp as jest.Mock).mock.calls[0][0]).toBe(PHONE_NORM)
      expect(emailService.sendOtpCodeEmail).not.toHaveBeenCalled()
    })

    it('rate-limits: throws when the hourly count is >= 5', async () => {
      // 1st count() = 30s window (clear), 2nd count() = 1h window (5 → over limit)
      prismaMock.otpChallenge.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5)

      await expect(requestOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: PHONE_RAW })).rejects.toThrow(BadRequestError)

      // No challenge written and no message sent when rate-limited
      expect(prismaMock.otpChallenge.create).not.toHaveBeenCalled()
      expect(sendOtpWhatsApp).not.toHaveBeenCalled()
    })
  })

  // ==========================================
  // verifyOtp
  // ==========================================
  describe('verifyOtp', () => {
    it('throws when the challenge is expired', async () => {
      prismaMock.otpChallenge.findFirst.mockResolvedValue({
        id: 'otp-1',
        destination: PHONE_NORM,
        codeHash: hashOtpCode('123456'),
        attempts: 0,
        maxAttempts: 5,
        consumedAt: null,
        expiresAt: new Date(Date.now() - 1000), // already expired
      })

      await expect(verifyOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: PHONE_RAW, code: '123456' })).rejects.toThrow(/expir/i)
    })

    it('wrong code: increments attempts and throws', async () => {
      prismaMock.otpChallenge.findFirst.mockResolvedValue({
        id: 'otp-1',
        destination: PHONE_NORM,
        codeHash: hashOtpCode('123456'), // correct code is 123456
        attempts: 0,
        maxAttempts: 5,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      })
      prismaMock.otpChallenge.update.mockResolvedValue({})

      await expect(verifyOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: PHONE_RAW, code: '000000' })).rejects.toThrow(
        /incorrecto/i,
      )

      expect(prismaMock.otpChallenge.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'otp-1' }, data: { attempts: 1 } }),
      )
    })

    it('attempts >= maxAttempts: invalidates the challenge and throws', async () => {
      prismaMock.otpChallenge.findFirst.mockResolvedValue({
        id: 'otp-1',
        destination: PHONE_NORM,
        codeHash: hashOtpCode('123456'),
        attempts: 5,
        maxAttempts: 5,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      })
      prismaMock.otpChallenge.update.mockResolvedValue({})

      await expect(verifyOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: PHONE_RAW, code: '123456' })).rejects.toThrow(
        /intentos/i,
      )

      // The exhausted challenge is consumed so it can never be reused
      expect(prismaMock.otpChallenge.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'otp-1' }, data: { consumedAt: expect.any(Date) } }),
      )
    })

    it('valid code: consumes the challenge, resolves Consumer+Customer, mints a customer token', async () => {
      prismaMock.otpChallenge.findFirst.mockResolvedValue({
        id: 'otp-1',
        destination: PHONE_NORM,
        codeHash: hashOtpCode('654321'),
        attempts: 0,
        maxAttempts: 5,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      })
      prismaMock.otpChallenge.update.mockResolvedValue({})

      // Identity resolution: no existing Consumer → create one, then no existing Customer → create one
      prismaMock.consumer.findMany.mockResolvedValue([]) // phone path uses findMany
      prismaMock.consumer.create.mockResolvedValue({ id: 'consumer-1', phone: PHONE_NORM, createdAt: new Date() })
      prismaMock.customer.findUnique.mockResolvedValue(null)
      prismaMock.customer.findFirst.mockResolvedValue(null)
      prismaMock.customer.create.mockResolvedValue({
        id: 'customer-1',
        firstName: null,
        lastName: null,
        email: null,
        phone: PHONE_NORM,
        consumerId: 'consumer-1',
      })

      const result = await verifyOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: PHONE_RAW, code: '654321' })

      // Challenge consumed
      expect(prismaMock.otpChallenge.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'otp-1' }, data: { consumedAt: expect.any(Date) } }),
      )

      // New Consumer + Customer created on the phone path
      expect(prismaMock.consumer.create).toHaveBeenCalledWith(expect.objectContaining({ data: { phone: PHONE_NORM } }))
      expect(prismaMock.customer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ venueId: VENUE_ID, consumerId: 'consumer-1', provider: 'PHONE', phone: PHONE_NORM }),
        }),
      )

      // Token minted with (customerId, venueId)
      expect(generateCustomerToken).toHaveBeenCalledWith('customer-1', VENUE_ID)

      expect(result).toEqual({
        token: 'signed.jwt.token',
        customer: { id: 'customer-1', firstName: null, lastName: null, email: null, phone: PHONE_NORM },
      })
    })

    it('valid code (email channel): reuses an existing Consumer and Customer by compound key', async () => {
      const EMAIL = 'User@Example.com'
      const EMAIL_NORM = 'user@example.com'

      prismaMock.otpChallenge.findFirst.mockResolvedValue({
        id: 'otp-2',
        destination: EMAIL_NORM,
        codeHash: hashOtpCode('111222'),
        attempts: 0,
        maxAttempts: 5,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      })
      prismaMock.otpChallenge.update.mockResolvedValue({})

      prismaMock.consumer.findFirst.mockResolvedValue({ id: 'consumer-9', email: EMAIL_NORM, createdAt: new Date() })
      prismaMock.customer.findUnique.mockResolvedValue({
        id: 'customer-9',
        firstName: 'Ana',
        lastName: 'Lopez',
        email: EMAIL_NORM,
        phone: null,
        consumerId: 'consumer-9',
      })

      const result = await verifyOtp({ venueId: VENUE_ID, channel: 'email', destination: EMAIL, code: '111222' })

      // Email path normalizes the destination before lookups
      expect(prismaMock.consumer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { email: EMAIL_NORM } }))
      expect(prismaMock.customer.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { venueId_email: { venueId: VENUE_ID, email: EMAIL_NORM } } }),
      )
      // No new rows created since both already exist
      expect(prismaMock.consumer.create).not.toHaveBeenCalled()
      expect(prismaMock.customer.create).not.toHaveBeenCalled()

      expect(generateCustomerToken).toHaveBeenCalledWith('customer-9', VENUE_ID)
      expect(result.customer.id).toBe('customer-9')
      expect(result.token).toBe('signed.jwt.token')
    })
  })

  // ==========================================
  // verifyOtp — name backfill on new customer
  // ==========================================
  describe('verifyOtp — name backfill on new customer', () => {
    beforeEach(() => {
      // Valid, unconsumed, matching challenge
      prismaMock.otpChallenge.findFirst.mockResolvedValue({
        id: 'ch1',
        destination: PHONE_NORM,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        attempts: 0,
        maxAttempts: 5,
        codeHash: hashOtpCode('123456'),
      })
      prismaMock.otpChallenge.update.mockResolvedValue({})
      // No existing Consumer or Customer → create paths
      prismaMock.consumer.findMany.mockResolvedValue([])
      prismaMock.consumer.create.mockResolvedValue({ id: 'cons1' })
      prismaMock.customer.findUnique.mockResolvedValue(null)
      prismaMock.customer.findFirst.mockResolvedValue(null)
    })

    it('seeds firstName/lastName from the most recent past guest reservation', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ guestName: 'Juan Pérez López', guestPhone: '5512345678' }])
      prismaMock.customer.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'cust1', firstName: data.firstName ?? null, lastName: data.lastName ?? null, email: null, phone: data.phone ?? null }),
      )

      const res = await verifyOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: PHONE_RAW, code: '123456' })

      expect(prismaMock.customer.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ firstName: 'Juan', lastName: 'Pérez López' }) }),
      )
      expect(res.customer.firstName).toBe('Juan')
    })

    it('creates a nameless customer when no past named reservation exists', async () => {
      prismaMock.$queryRaw.mockResolvedValue([])
      prismaMock.customer.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'cust1', firstName: data.firstName ?? null, lastName: data.lastName ?? null, email: null, phone: data.phone ?? null }),
      )

      const res = await verifyOtp({ venueId: VENUE_ID, channel: 'whatsapp', destination: PHONE_RAW, code: '123456' })

      expect(res.customer.firstName).toBeNull()
    })
  })
})
