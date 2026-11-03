/**
 * 🔴 Los dos correos del formulario de la landing (la confirmación a quien lo llenó y el aviso interno a onboarding@) pasan
 * por la lista de prueba: llenar el formulario en local no le escribe a nadie fuera de la lista. Y en producción todo sigue
 * igual: se mandan los dos, con lo mismo de siempre.
 */
jest.mock('@/services/onboarding/signup.service', () => ({ signupFromLanding: jest.fn() }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmail: jest.fn() } }))
jest.mock('@/services/crm/digest.service', () => ({ notifyNewProspect: jest.fn() }))

import type { NextFunction, Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import logger from '@/config/logger'
import { ONBOARDING_NOTIFY_EMAIL, submitContact } from '@/controllers/public/landing.public.controller'
import emailService from '@/services/email.service'
import { signupFromLanding } from '@/services/onboarding/signup.service'

const send = emailService.sendEmail as jest.Mock
const EMAIL = 'ana@cafe.mx'

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

const NEW_SIGNUP = {
  staff: { id: 'cstafflan0000000000000001', email: EMAIL },
  organizationId: 'corglandn0000000000000001',
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

async function submit() {
  const res = makeResponse()
  const next = jest.fn() as NextFunction
  await submitContact({ body: { ...FORM } } as Request, res, next)
  return { res, next }
}

const ENV = { ...process.env }
const destinatarios = () => send.mock.calls.map(([email]) => email.to)

beforeEach(() => {
  installCrmInboundFake(prismaMock)
  ;(signupFromLanding as jest.Mock).mockResolvedValue(NEW_SIGNUP)
  send.mockReset().mockResolvedValue(true)
  delete process.env.CRM_CORREO_PRUEBAS
})

afterEach(() => {
  process.env.NODE_ENV = ENV.NODE_ENV
  if (ENV.CRM_CORREO_PRUEBAS === undefined) delete process.env.CRM_CORREO_PRUEBAS
  else process.env.CRM_CORREO_PRUEBAS = ENV.CRM_CORREO_PRUEBAS
})

describe('submitContact fuera de producción', () => {
  it('con la lista vacía no sale NINGUNO de los dos correos, y el formulario contesta lo de siempre (no un 502)', async () => {
    const { res, next } = await submit()

    expect(send).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ success: true, conversion: { leadCreated: true, registrationCompleted: true } })
    // Lo que no sale se dice en el log, sin la dirección de nadie.
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('lista de prueba'),
      expect.not.objectContaining({ to: expect.anything() }),
    )
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('Internal notification failed'), expect.anything())
  })

  it('con sólo la dirección tecleada en la lista, sale la confirmación y no el aviso interno', async () => {
    process.env.CRM_CORREO_PRUEBAS = EMAIL

    const { res } = await submit()

    expect(destinatarios()).toEqual([EMAIL])
    expect(send.mock.calls[0][0].subject).toBe('Ya quedó tu registro en Avoqado')
    expect(res.statusCode).toBe(200)
  })

  it('con sólo onboarding@ en la lista, sale el aviso interno y no la confirmación', async () => {
    process.env.CRM_CORREO_PRUEBAS = ONBOARDING_NOTIFY_EMAIL

    const { res } = await submit()

    expect(destinatarios()).toEqual([ONBOARDING_NOTIFY_EMAIL])
    expect(send.mock.calls[0][0].subject).toBe('Nuevo prospecto - Café Ana')
    expect(res.statusCode).toBe(200)
  })

  it('si el aviso interno SÍ está en la lista y falla de verdad, sigue siendo 502: la lista no esconde una falla', async () => {
    process.env.CRM_CORREO_PRUEBAS = ONBOARDING_NOTIFY_EMAIL
    send.mockResolvedValue(false)

    const { res } = await submit()

    expect(res.statusCode).toBe(502)
  })
})

describe('submitContact en producción', () => {
  it('manda los dos correos, a los mismos de siempre y con la lista vacía', async () => {
    process.env.NODE_ENV = 'production'

    const { res } = await submit()

    expect(res.statusCode).toBe(200)
    expect(destinatarios().sort()).toEqual([EMAIL, ONBOARDING_NOTIFY_EMAIL].sort())
    expect(send.mock.calls.map(([email]) => email.subject).sort()).toEqual([
      'Nuevo prospecto - Café Ana',
      'Ya quedó tu registro en Avoqado',
    ])
  })
})
