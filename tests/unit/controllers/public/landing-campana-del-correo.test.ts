/**
 * Campaña $10 (13-oct-2026): el correo de bienvenida dice la oferta que la cuenta reclamó, y el
 * enlace del correo conserva la oferta y las UTM al volver al dashboard. Ninguna de las dos lecturas
 * puede tumbar el alta, el correo ni la entrada.
 */
jest.mock('@/services/onboarding/signup.service', () => ({
  signupFromLanding: jest.fn(),
}))

jest.mock('@/services/onboarding/campanaDelCorreo.service', () => ({
  ofertaReclamadaEnTexto: jest.fn(),
  parametrosDeCampanaDelStaff: jest.fn(),
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
import prisma from '@/utils/prismaClient'
import { continuarOnboarding, submitContact } from '@/controllers/public/landing.public.controller'
import emailService from '@/services/email.service'
import { signupFromLanding } from '@/services/onboarding/signup.service'
import { ofertaReclamadaEnTexto, parametrosDeCampanaDelStaff } from '@/services/onboarding/campanaDelCorreo.service'

const mockSignup = signupFromLanding as jest.Mock
const mockSendEmail = emailService.sendEmail as jest.Mock
const mockOferta = ofertaReclamadaEnTexto as jest.Mock
const mockParametros = parametrosDeCampanaDelStaff as jest.Mock
const mockStaffFindFirst = prisma.staff.findFirst as jest.Mock
const mockActivityLog = prisma.activityLog.create as jest.Mock

const OFERTA = 'Avoqado Pro a $10.00 al mes, IVA incluido, por 3 meses; después $1,158.84 al mes'

const body = {
  firstName: 'Ana',
  lastName: 'Lopez',
  phone: '5512345678',
  email: 'ana@example.com',
  companyName: 'Cafe Ana',
  source: 'landing_oferta',
}

function makeResponse() {
  const res = { statusCode: 200 } as Response & { body?: unknown; redirectedTo?: string }
  res.status = jest.fn((code: number) => {
    res.statusCode = code
    return res
  }) as Response['status']
  res.json = jest.fn((b: unknown) => {
    res.body = b
    return res
  }) as Response['json']
  res.redirect = jest.fn((code: number, url: string) => {
    res.statusCode = code
    res.redirectedTo = url
  }) as unknown as Response['redirect']
  return res
}

async function submit(overrides: Record<string, unknown> = {}) {
  const res = makeResponse()
  await submitContact({ body: { ...body, ...overrides } } as Request, res, jest.fn() as NextFunction)
  return res
}

/** El correo que recibe el cliente (no el interno). */
function correoDelCliente() {
  const llamada = mockSendEmail.mock.calls.find(([m]) => m.to === body.email)
  return llamada?.[0] as { html: string; text: string }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSendEmail.mockResolvedValue(true)
  mockSignup.mockResolvedValue({
    staff: { id: 'staff-1', email: body.email },
    organizationId: 'org-1',
    magicLinkToken: 'token-1',
    alreadyExisted: false,
    yaEsCliente: false,
  })
})

describe('correo de bienvenida de una campaña', () => {
  it('dice la oferta reclamada en el HTML y en el texto', async () => {
    mockOferta.mockResolvedValue(OFERTA)

    const res = await submit({ launchCampaignCode: 'pos-10-rest' })

    expect(res.statusCode).toBe(200)
    expect(mockOferta).toHaveBeenCalledWith('org-1')
    const correo = correoDelCliente()
    expect(correo.html).toContain(`Tu oferta: <strong>${OFERTA}</strong>. Se activa con tarjeta`)
    expect(correo.text).toContain(`Tu oferta: ${OFERTA}. Se activa con tarjeta`)
  })

  it('sin oferta disponible deja el texto genérico de campaña (nunca un precio que no se cobra)', async () => {
    mockOferta.mockResolvedValue(null)

    await submit({ launchCampaignCode: 'pos-10-rest' })

    const correo = correoDelCliente()
    expect(correo.html).toContain('Tu oferta se activa con tarjeta')
    expect(correo.html).not.toContain('Tu oferta: ')
  })

  it('si leer la oferta falla, el alta y el correo salen igual con el texto genérico', async () => {
    mockOferta.mockRejectedValue(new Error('db caída'))

    const res = await submit({ launchCampaignCode: 'pos-10-rest' })

    expect(res.statusCode).toBe(200)
    expect(correoDelCliente().text).toContain('Tu oferta se activa con tarjeta')
  })

  it('sin campaña ni oferta reclamada sigue «gratis para siempre» (regresión)', async () => {
    mockOferta.mockResolvedValue(null)

    await submit()

    expect(correoDelCliente().html).toContain('gratis para siempre')
  })

  // Auditoría de Codex (13-oct): quien ya reclamó los $10 y reenvía el formulario desde una página sin
  // código conserva su oferta guardada; el correo no puede decirle «gratis y sin tarjeta».
  it('reenviado sin código pero con oferta ya reclamada: dice la oferta, no «gratis para siempre»', async () => {
    mockOferta.mockResolvedValue(OFERTA)

    await submit()

    expect(mockOferta).toHaveBeenCalledWith('org-1')
    const correo = correoDelCliente()
    expect(correo.html).toContain(`Tu oferta: <strong>${OFERTA}</strong>`)
    expect(correo.html).not.toContain('gratis para siempre')
    expect(correo.text).not.toContain('no pedimos tarjeta')
  })

  // Codex, 2ª pasada: «no pude consultar» no es «no tiene oferta». Sin saberlo, no se promete nada.
  it('sin código y con la lectura fallida no promete «gratis» ni «sin tarjeta»', async () => {
    mockOferta.mockRejectedValue(new Error('db caída'))

    const res = await submit()

    expect(res.statusCode).toBe(200)
    const correo = correoDelCliente()
    expect(correo.html).not.toContain('gratis para siempre')
    expect(correo.text).not.toContain('no pedimos tarjeta')
    expect(correo.html).not.toContain('Tu oferta')
  })

  it('a quien ya es cliente no le lee ninguna oferta', async () => {
    mockSignup.mockResolvedValue({
      staff: { id: 'staff-1', email: body.email },
      organizationId: 'org-1',
      magicLinkToken: null,
      alreadyExisted: true,
      yaEsCliente: true,
    })

    await submit({ launchCampaignCode: 'pos-10-rest' })

    expect(mockOferta).not.toHaveBeenCalled()
  })
})

// Founder (16-oct): el lead no entendía que tenía que instalar la app. El correo trae un botón por tienda.
describe('botones para descargar la app', () => {
  const TIENDAS = [
    'https://apps.apple.com/mx/app/avoqado/id6758351745',
    'https://play.google.com/store/apps/details?id=com.avoqado.pos',
    'https://apps.microsoft.com/detail/9PCZG05M3PVC',
  ]

  it('el lead nuevo recibe iPhone/iPad, Android y Windows en el HTML y en el texto', async () => {
    mockOferta.mockResolvedValue(null)

    await submit({ launchCampaignCode: 'pos-10-rest' })

    const correo = correoDelCliente()
    for (const url of TIENDAS) {
      expect(correo.html).toContain(`href="${url}"`)
      expect(correo.text).toContain(url)
    }
    // Insignias oficiales en PNG (Gmail y Outlook no pintan SVG) y el aparato escrito debajo.
    for (const insignia of ['app-store-es.png', 'google-play-es.png', 'microsoft-store-es.png']) {
      expect(correo.html).toContain(`src="https://avoqado.io/badges/${insignia}"`)
    }
    for (const aparato of ['iPhone y iPad', 'Android', 'PC con Windows']) {
      expect(correo.html).toContain(aparato)
    }
    expect(correo.html).toContain('Descarga y empieza a usar tu punto de venta')
  })

  it('el orden es claro: paso 1 la contraseña, paso 2 la app', async () => {
    mockOferta.mockResolvedValue(null)

    await submit()

    const { html, text } = correoDelCliente()
    expect(html.indexOf('Paso 1')).toBeGreaterThan(-1)
    expect(html.indexOf('Paso 1')).toBeLessThan(html.indexOf('Paso 2'))
    expect(html.indexOf('Elige tu contraseña')).toBeLessThan(html.indexOf('/badges/'))
    expect(text.indexOf('Paso 1')).toBeLessThan(text.indexOf('Paso 2'))
  })

  it('a quien ya es cliente no le cambia el correo', async () => {
    mockSignup.mockResolvedValue({
      staff: { id: 'staff-1', email: body.email },
      organizationId: 'org-1',
      magicLinkToken: null,
      alreadyExisted: true,
      yaEsCliente: true,
    })

    await submit()

    expect(correoDelCliente().html).not.toContain('/badges/')
  })
})

describe('enlace del correo (continuarOnboarding)', () => {
  const continuar = async () => {
    const res = makeResponse()
    await continuarOnboarding({ params: { token: 'tok' }, headers: {} } as unknown as Request, res, jest.fn() as NextFunction)
    return res
  }

  beforeEach(() => {
    mockActivityLog.mockResolvedValue({})
  })

  it('agrega la oferta y las UTM de la cuenta al destino', async () => {
    mockStaffFindFirst.mockResolvedValue({
      id: 'staff-1',
      email: body.email,
      resetTokenExpiry: new Date(Date.now() + 1e6),
      resetTokenUsedAt: null,
    })
    mockParametros.mockResolvedValue('oferta=pos-10-rest&utm_source=meta')

    const res = await continuar()

    expect(mockParametros).toHaveBeenCalledWith('staff-1')
    expect(res.statusCode).toBe(302)
    expect(res.redirectedTo).toMatch(/\/auth\/reset-password\/tok\?lang=es&oferta=pos-10-rest&utm_source=meta$/)
  })

  it('si leer la campaña falla, entra igual sin parámetros', async () => {
    mockStaffFindFirst.mockResolvedValue({ id: 'staff-1', email: body.email, resetTokenExpiry: null, resetTokenUsedAt: null })
    mockParametros.mockRejectedValue(new Error('sin organización'))

    const res = await continuar()

    expect(res.redirectedTo).toMatch(/\/auth\/reset-password\/tok\?lang=es$/)
  })

  // Auditoría de Codex (13-oct): medir el clic es lo de menos; si falla, el destino conserva la campaña.
  it('si falla registrar el clic, el destino conserva la oferta y las UTM', async () => {
    mockStaffFindFirst.mockResolvedValue({ id: 'staff-1', email: body.email, resetTokenExpiry: null, resetTokenUsedAt: null })
    mockActivityLog.mockRejectedValue(new Error('insert falló'))
    mockParametros.mockResolvedValue('oferta=pos-10-rest&utm_source=meta')

    const res = await continuar()

    expect(res.redirectedTo).toMatch(/\?lang=es&oferta=pos-10-rest&utm_source=meta$/)
  })

  it('con token desconocido no busca campaña y redirige igual', async () => {
    mockStaffFindFirst.mockResolvedValue(null)

    const res = await continuar()

    expect(mockParametros).not.toHaveBeenCalled()
    expect(res.redirectedTo).toMatch(/\/auth\/reset-password\/tok\?lang=es$/)
  })
})
