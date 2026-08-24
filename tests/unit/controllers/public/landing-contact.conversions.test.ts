jest.mock('@/services/onboarding/signup.service', () => ({
  signupFromLanding: jest.fn(),
}))

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendEmail: jest.fn() },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import type { NextFunction, Request, Response } from 'express'
import { submitContact } from '@/controllers/public/landing.public.controller'
import emailService from '@/services/email.service'
import { signupFromLanding } from '@/services/onboarding/signup.service'

const mockSignupFromLanding = signupFromLanding as jest.Mock
const mockSendEmail = emailService.sendEmail as jest.Mock

const contactBody = {
  firstName: 'Ana',
  lastName: 'Lopez',
  phone: '5512345678',
  email: 'ana@example.com',
  companyName: 'Cafe Ana',
  source: 'landing_restaurantes',
}

function makeResponse(): Response & { body?: unknown } {
  const res = { statusCode: 200 } as Response & { body?: unknown }
  res.status = jest.fn((statusCode: number) => {
    res.statusCode = statusCode
    return res
  }) as Response['status']
  res.json = jest.fn((body: unknown) => {
    res.body = body
    return res
  }) as Response['json']
  return res
}

async function submit(overrides: Record<string, unknown> = {}) {
  const req = { body: { ...contactBody, ...overrides } } as Request
  const res = makeResponse()
  const next = jest.fn() as NextFunction

  await submitContact(req, res, next)

  return { res, next }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSendEmail.mockResolvedValue(true)
})

describe('submitContact conversion signals', () => {
  it('marks both a delivered lead and a newly created account', async () => {
    mockSignupFromLanding.mockResolvedValue({
      staff: { id: 'staff-new', email: contactBody.email },
      organizationId: 'org-new',
      magicLinkToken: 'token-new',
      alreadyExisted: false,
      yaEsCliente: false,
    })

    const { res, next } = await submit()

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      success: true,
      message: 'Demo solicitada exitosamente',
      conversion: { leadCreated: true, registrationCompleted: true },
    })
  })

  it('does not report a new registration when the account already existed', async () => {
    mockSignupFromLanding.mockResolvedValue({
      staff: { id: 'staff-existing', email: contactBody.email },
      organizationId: 'org-existing',
      magicLinkToken: null,
      alreadyExisted: true,
      yaEsCliente: true,
    })

    const { res } = await submit()

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(
      expect.objectContaining({
        conversion: { leadCreated: true, registrationCompleted: false },
      }),
    )
  })

  it('does not report a duplicate registration when an unfinished landing account gets a renewed link', async () => {
    mockSignupFromLanding.mockResolvedValue({
      staff: { id: 'staff-incomplete', email: contactBody.email },
      organizationId: 'org-incomplete',
      magicLinkToken: 'renewed-token',
      alreadyExisted: true,
      yaEsCliente: false,
    })

    const { res } = await submit()

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(
      expect.objectContaining({
        conversion: { leadCreated: true, registrationCompleted: false },
      }),
    )
  })

  it('reports only the delivered lead when account creation fails', async () => {
    mockSignupFromLanding.mockRejectedValue(new Error('database unavailable'))

    const { res, next } = await submit()

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(
      expect.objectContaining({
        conversion: { leadCreated: true, registrationCompleted: false },
      }),
    )
  })

  it('preserves a real registration signal even when every notification email fails', async () => {
    mockSignupFromLanding.mockResolvedValue({
      staff: { id: 'staff-new', email: contactBody.email },
      organizationId: 'org-new',
      magicLinkToken: 'token-new',
      alreadyExisted: false,
      yaEsCliente: false,
    })
    mockSendEmail.mockResolvedValue(false)

    const { res } = await submit()

    expect(res.statusCode).toBe(502)
    expect(res.body).toEqual({
      success: false,
      message: 'No se pudo notificar al equipo. Intenta de nuevo.',
      conversion: { leadCreated: false, registrationCompleted: true },
    })
  })
})
