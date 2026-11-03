/**
 * The landing form lands in the CRM (spec 2026-10-30 §5.3, plan task 5) without ever risking the signup: a CRM that
 * fails, a NUL byte in the form or the same email twice at once still answer exactly as before — and leave ONE account.
 */
jest.mock('@/services/onboarding/signup.service', () => ({ signupFromLanding: jest.fn() }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmail: jest.fn() } }))
jest.mock('@/services/crm/digest.service', () => ({ notifyNewProspect: jest.fn() }))

import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import logger from '@/config/logger'
import { submitContact } from '@/controllers/public/landing.public.controller'
import { notifyNewProspect } from '@/services/crm/digest.service'
import * as inbound from '@/services/crm/inbound.service'
import emailService from '@/services/email.service'
import { signupFromLanding } from '@/services/onboarding/signup.service'

const mockSignup = signupFromLanding as jest.Mock
const EMAIL = 'ana@cafe.mx'
const ORG = 'corglandn0000000000000001'

const FORM = {
  firstName: 'Ana',
  lastName: 'López',
  phone: '5512345678',
  email: EMAIL,
  companyName: 'Café Ana',
  employees: '3',
  revenue: '500k-1m',
  businessType: 'Cafetería',
  modules: 'mesas,cocina',
  source: 'landing_restaurantes',
}

/** What `signupFromLanding` returns for a brand-new account. */
const NEW_SIGNUP = {
  staff: { id: 'cstafflan0000000000000001', email: EMAIL },
  organizationId: ORG,
  magicLinkToken: 'token-new',
  alreadyExisted: false,
  yaEsCliente: false,
  codigoVerificacion: null,
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
  const req = { body: { ...FORM, ...overrides } } as Request
  const res = makeResponse()
  const next = jest.fn() as NextFunction
  await submitContact(req, res, next)
  return { res, next }
}

/** The answer the landing has always had for a brand-new account. */
const USUAL_ANSWER = {
  success: true,
  message: 'Demo solicitada exitosamente',
  conversion: { leadCreated: true, registrationCompleted: true, eventId: expect.any(String) },
}

let db: ReturnType<typeof installCrmInboundFake>

beforeEach(() => {
  db = installCrmInboundFake(prismaMock)
  ;(emailService.sendEmail as jest.Mock).mockResolvedValue(true)
  ;(notifyNewProspect as jest.Mock).mockResolvedValue(undefined)
})

describe('submitContact → CRM', () => {
  it('el_alta_lleva_la_hora_del_formulario (D7): la marca del alta dice cuándo llegó, no cuándo terminó', async () => {
    mockSignup.mockResolvedValue(NEW_SIGNUP)
    const before = Date.now()

    await submit()

    const { formAt } = mockSignup.mock.calls[0][0]
    expect(formAt).toBeInstanceOf(Date)
    expect(formAt.getTime()).toBeGreaterThanOrEqual(before)
    // Taken before the entry is saved: never later than the entry's own date.
    expect(formAt.getTime()).toBeLessThanOrEqual(db.entries[0].receivedAt.getTime())
  })

  it('falla_el_crm_el_alta_queda', async () => {
    mockSignup.mockResolvedValue(NEW_SIGNUP)
    // `applyEntry` itself never throws; this proves the controller's own guard holds if it ever did.
    const crmDown = jest.spyOn(inbound, 'applyEntry').mockRejectedValueOnce(new Error('the CRM is down'))

    const { res, next } = await submit()
    crmDown.mockRestore()

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(USUAL_ANSWER)
    // The signup ran once, with exactly the arguments it always had — plus when the form came (D7).
    expect(mockSignup).toHaveBeenCalledTimes(1)
    expect(mockSignup).toHaveBeenCalledWith({
      email: EMAIL,
      firstName: 'Ana',
      lastName: 'López',
      organizationName: 'Café Ana',
      phone: '5512345678',
      source: 'landing_restaurantes',
      utm: undefined,
      launchCampaignCode: undefined,
      formAt: expect.any(Date),
    })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('CRM'), expect.objectContaining({ entryId: db.entries[0].id }))
    // The raw entry went in BEFORE the signup, and holds the signup's real outcome for the sweep.
    expect(prismaMock.crmInboundEntry.create.mock.invocationCallOrder[0]).toBeLessThan(mockSignup.mock.invocationCallOrder[0])
    expect(db.entries[0]).toMatchObject({
      signupOutcome: { organizationId: ORG, alreadyExisted: false, yaEsCliente: false },
      signupResolvedAt: expect.any(Date),
      appliedAt: null,
    })
  })

  it('nulo_en_businessType_no_tumba_el_alta', async () => {
    mockSignup.mockResolvedValue(NEW_SIGNUP)

    const { res } = await submit({ businessType: 'Cafe\u0000tería' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(USUAL_ANSWER)
    expect(mockSignup).toHaveBeenCalledTimes(1)
    expect(db.entries[0].payload.businessType).toBe('Cafetería')
    expect(db.accounts).toHaveLength(1)
    expect(db.accounts[0]).toMatchObject({ giro: 'Cafetería', organizationId: ORG })
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: db.accounts[0].id })
  })

  it('mismo_correo_dos_veces_a_la_vez_un_negocio', async () => {
    // Two submits at once: one signup creates the account a moment later, the other loses the race on Staff.email.
    mockSignup
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(NEW_SIGNUP), 20)))
      .mockImplementationOnce(() => Promise.reject(new Error('Unique constraint failed on the fields: (`email`)')))

    const [first, second] = await Promise.all([submit(), submit()])

    expect(first.res.statusCode).toBe(200)
    expect(second.res.statusCode).toBe(200)
    expect(db.accounts).toHaveLength(1)
    expect(db.accounts[0]).toMatchObject({ source: 'LANDING', externalKey: EMAIL, organizationId: ORG })
    expect(db.entries).toHaveLength(2)
    for (const entry of db.entries) expect(entry).toMatchObject({ appliedAt: expect.any(Date), accountId: db.accounts[0].id })
    expect(
      db.events
        .filter(event => event.kind === 'ENTRY_APPLIED')
        .map(event => event.sourceKey)
        .sort(),
    ).toEqual(db.entries.map(entry => `entry:${entry.id}`).sort())
    // One new account, one «Nuevo prospecto».
    expect(notifyNewProspect).toHaveBeenCalledTimes(1)
  })
})
