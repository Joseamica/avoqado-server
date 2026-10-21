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

import { createHash } from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import { submitContact } from '@/controllers/public/landing.public.controller'
import emailService from '@/services/email.service'
import { signupFromLanding } from '@/services/onboarding/signup.service'

const mockSignupFromLanding = signupFromLanding as jest.Mock
const mockSendEmail = emailService.sendEmail as jest.Mock

/** El identificador de conversión que la landing pasa al píxel de ChatGPT como `event_id`. */
const huella = (organizationId: string) => createHash('sha256').update(organizationId).digest('hex').slice(0, 32)

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
      conversion: { leadCreated: true, registrationCompleted: true, eventId: huella('org-new') },
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
        conversion: { leadCreated: true, registrationCompleted: false, eventId: huella('org-existing') },
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
        conversion: { leadCreated: true, registrationCompleted: false, eventId: huella('org-incomplete') },
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
      conversion: { leadCreated: false, registrationCompleted: true, eventId: huella('org-new') },
    })
  })

  // El píxel de ChatGPT descarta un evento repetido si trae el mismo `event_id`. Quien vuelve a
  // mandar el formulario con el MISMO correo cae en la MISMA cuenta, así que debe recibir el
  // MISMO identificador: así ChatGPT no lo cuenta dos veces.
  it('gives the same eventId to the same account when the form is sent again', async () => {
    mockSignupFromLanding.mockResolvedValueOnce({
      staff: { id: 'staff-new', email: contactBody.email },
      organizationId: 'org-repetida',
      magicLinkToken: 'token-new',
      alreadyExisted: false,
      yaEsCliente: false,
    })
    mockSignupFromLanding.mockResolvedValueOnce({
      staff: { id: 'staff-new', email: contactBody.email },
      organizationId: 'org-repetida',
      magicLinkToken: 'renewed-token',
      alreadyExisted: true,
      yaEsCliente: false,
    })

    const primera = await submit()
    const segunda = await submit()

    const id1 = (primera.res.body as { conversion: { eventId?: string } }).conversion.eventId
    const id2 = (segunda.res.body as { conversion: { eventId?: string } }).conversion.eventId
    expect(id1).toBe(huella('org-repetida'))
    expect(id2).toBe(id1)
  })

  it('never exposes the internal organization id in the public response', async () => {
    mockSignupFromLanding.mockResolvedValue({
      staff: { id: 'staff-new', email: contactBody.email },
      organizationId: 'cmorgsecreta000000000000',
      magicLinkToken: 'token-new',
      alreadyExisted: false,
      yaEsCliente: false,
    })

    const { res } = await submit()

    expect(JSON.stringify(res.body)).not.toContain('cmorgsecreta000000000000')
  })

  it('sends no eventId when the signup returns no organization', async () => {
    mockSignupFromLanding.mockResolvedValue({
      staff: { id: 'staff-new', email: contactBody.email },
      organizationId: null,
      magicLinkToken: null,
      alreadyExisted: true,
      yaEsCliente: false,
    })

    const { res } = await submit()

    expect((res.body as { conversion: Record<string, unknown> }).conversion).toEqual({
      leadCreated: true,
      registrationCompleted: false,
    })
  })
})

describe('submitContact: aviso interno del prospecto', () => {
  // Founder (18-oct-2026): hola@ y onboarding@ son alias del mismo buzón; mandar una copia a cada uno le llegaba doble.
  // El prospecto es de onboarding: el aviso interno va UNA vez y sólo a onboarding@.
  it('manda el aviso interno una sola vez y sólo a onboarding@avoqado.io', async () => {
    mockSignupFromLanding.mockResolvedValue({
      staff: { id: 'staff-new', email: contactBody.email },
      organizationId: 'org-new',
      magicLinkToken: 'token-new',
      alreadyExisted: false,
      yaEsCliente: false,
    })

    await submit()

    const internos = mockSendEmail.mock.calls.map(([correo]) => correo).filter(correo => correo.to !== contactBody.email)
    expect(internos).toHaveLength(1)
    expect(internos[0]).toEqual(expect.objectContaining({ to: 'onboarding@avoqado.io', subject: 'Nuevo prospecto - Cafe Ana' }))
  })
})
