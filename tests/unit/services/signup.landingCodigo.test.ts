/**
 * Alta desde la landing CON CÓDIGO de 6 dígitos (Task 2 del plan «Alta desde la landing con código»).
 *
 * Con el interruptor `ALTA_LANDING_CON_CODIGO=true` la cuenta nace SIN verificar y con un código de
 * 6 dígitos (10 min); con el interruptor apagado todo queda EXACTAMENTE como hoy.
 */
import crypto from 'crypto'
import { OrgRole } from '@prisma/client'

const mockStaffCreate = jest.fn()
const mockTx = {
  organization: { create: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Cafe Ana' }) },
  staff: { create: mockStaffCreate },
  staffOrganization: { create: jest.fn().mockResolvedValue({}) },
  onboardingProgress: { create: jest.fn().mockResolvedValue({}) },
  activityLog: { create: jest.fn().mockResolvedValue({}) },
}

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(mockTx)),
  },
}))
jest.mock('@/services/staffOrganization.service', () => ({
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-previa'),
}))
jest.mock('@/services/launchCampaigns/launchCampaignClaim.service', () => ({ claimLaunchCampaign: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/launchCampaigns/launchCampaign.service', () => ({ findClaimableByCodeOrSlug: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/onboarding/nuevoNegocio', () => ({
  resolverAtribucionDelAlta: jest.fn().mockResolvedValue({}),
  crearNegocioNuevo: jest.fn(async (_tx: unknown, d: { email: string }) => ({
    staff: { id: 'staff-signup', email: d.email, firstName: 'Ana', lastName: 'Lopez', photoUrl: null },
    organization: { id: 'org-signup', name: 'Cafe Ana' },
  })),
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendEmailVerification: jest.fn().mockResolvedValue(true) },
}))
jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('hashed') }))

import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import {
  altaLandingConCodigo,
  esProspectoDeLanding,
  nuevoCodigoDeVerificacion,
  resendVerificationCode,
  signupFromLanding,
  signupUser,
} from '@/services/onboarding/signup.service'

const staffFindUnique = prisma.staff.findUnique as jest.Mock
const staffFindFirst = prisma.staff.findFirst as jest.Mock
const staffUpdate = prisma.staff.update as jest.Mock
const staffUpdateMany = prisma.staff.updateMany as jest.Mock

const DIEZ_MINUTOS = 10 * 60 * 1000
const SEIS_DIGITOS = /^\d{6}$/
const entrada = { email: 'Ana@Example.com ', firstName: 'Ana', lastName: 'Lopez', organizationName: 'Cafe Ana', phone: '5512345678' }

function interruptor(valor: string | undefined) {
  if (valor === undefined) delete process.env.ALTA_LANDING_CON_CODIGO
  else process.env.ALTA_LANDING_CON_CODIGO = valor
}

const interruptorOriginal = process.env.ALTA_LANDING_CON_CODIGO

beforeEach(() => {
  jest.clearAllMocks()
  mockStaffCreate.mockResolvedValue({ id: 'staff-nuevo', email: 'ana@example.com' })
  staffUpdate.mockResolvedValue({})
  staffUpdateMany.mockResolvedValue({ count: 1 })
  staffFindUnique.mockResolvedValue(null)
  staffFindFirst.mockResolvedValue(null)
  interruptor(undefined)
})

afterAll(() => interruptor(interruptorOriginal))

describe('altaLandingConCodigo: el interruptor se lee en CADA llamada', () => {
  it('sólo el texto exacto «true» lo prende, y se puede cambiar sin reimportar el módulo', () => {
    interruptor(undefined)
    expect(altaLandingConCodigo()).toBe(false)
    interruptor('true')
    expect(altaLandingConCodigo()).toBe(true)
    interruptor('1')
    expect(altaLandingConCodigo()).toBe(false)
    interruptor('TRUE')
    expect(altaLandingConCodigo()).toBe(false)
    interruptor('false')
    expect(altaLandingConCodigo()).toBe(false)
  })
})

describe('nuevoCodigoDeVerificacion', () => {
  afterEach(() => jest.restoreAllMocks())

  it('6 dígitos y vigencia de 10 minutos', () => {
    const antes = Date.now()
    const { codigo, expira } = nuevoCodigoDeVerificacion()
    expect(codigo).toMatch(SEIS_DIGITOS)
    expect(expira.getTime() - antes).toBeGreaterThanOrEqual(DIEZ_MINUTOS - 50)
    expect(expira.getTime() - antes).toBeLessThanOrEqual(DIEZ_MINUTOS + 2000)
  })

  it('el rango incluye 999999 (randomInt excluye el tope: era randomInt(100000, 999999))', () => {
    const randomInt = jest.spyOn(crypto, 'randomInt').mockImplementation(((_min: number, _max: number) => 999999) as never)
    expect(nuevoCodigoDeVerificacion().codigo).toBe('999999')
    expect(randomInt).toHaveBeenCalledWith(100000, 1000000)
  })
})

describe('signupUser y resendVerificationCode usan el mismo generador', () => {
  afterEach(() => jest.restoreAllMocks())

  it('signupUser guarda el código y la vigencia que salen del generador', async () => {
    const randomInt = jest.spyOn(crypto, 'randomInt').mockImplementation(((_min: number, _max: number) => 999999) as never)

    await signupUser({ email: 'nuevo@example.com', password: 'Cl4ve-segura-2026', firstName: 'Ana' })

    const data = staffUpdate.mock.calls[0][0].data
    expect(randomInt).toHaveBeenCalledWith(100000, 1000000)
    expect(data.emailVerificationCode).toBe('999999')
    expect(data.emailVerificationExpires.getTime() - Date.now()).toBeGreaterThan(DIEZ_MINUTOS - 5000)
    expect(emailService.sendEmailVerification).toHaveBeenCalledWith(
      'nuevo@example.com',
      expect.objectContaining({ verificationCode: '999999' }),
    )
  })

  it('resendVerificationCode también', async () => {
    const randomInt = jest.spyOn(crypto, 'randomInt').mockImplementation(((_min: number, _max: number) => 999999) as never)
    staffFindUnique.mockResolvedValue({ id: 'staff-9', email: 'pendiente@example.com', firstName: 'Ana', emailVerified: false })

    await resendVerificationCode('pendiente@example.com')

    const data = staffUpdate.mock.calls[0][0].data
    expect(randomInt).toHaveBeenCalledWith(100000, 1000000)
    expect(data.emailVerificationCode).toBe('999999')
    expect(data.emailVerificationExpires).toBeInstanceOf(Date)
  })
})

describe('esProspectoDeLanding: una sola consulta, todas las condiciones', () => {
  /** Mini intérprete del `where` que usa la función, para probar el COMPORTAMIENTO y no sólo la forma. */
  type Fila = Record<string, unknown> & { organizations: Array<Record<string, unknown> & { organization: Record<string, unknown> }> }
  const coincide = (fila: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([campo, esperado]) => {
      if (esperado !== null && typeof esperado === 'object' && 'some' in (esperado as object)) {
        const hijos = fila[campo] as Array<Record<string, unknown>>
        return hijos.some(hijo => coincide(hijo, (esperado as { some: Record<string, unknown> }).some))
      }
      if (esperado !== null && typeof esperado === 'object')
        return coincide(fila[campo] as Record<string, unknown>, esperado as Record<string, unknown>)
      return fila[campo] === esperado
    })
  const sembrar = (fila: Fila) => staffFindFirst.mockImplementation(async ({ where }) => (coincide(fila, where) ? { id: fila.id } : null))

  const prospecto = (cambios: Partial<Fila> = {}, org: Record<string, unknown> = {}, membresia: Record<string, unknown> = {}): Fila => ({
    id: 'staff-p',
    active: true,
    googleId: null,
    password: null,
    organizations: [
      { role: OrgRole.OWNER, isActive: true, isPrimary: true, organization: { onboardingCompletedAt: null, ...org }, ...membresia },
    ],
    ...cambios,
  })

  it('OWNER primario sin contraseña, sin Google y con el alta sin terminar → true', async () => {
    sembrar(prospecto())
    expect(await esProspectoDeLanding('staff-p')).toBe(true)
  })

  it('una cuenta de Google → false', async () => {
    sembrar(prospecto({ googleId: 'google-123' }))
    expect(await esProspectoDeLanding('staff-p')).toBe(false)
  })

  it('una cuenta inactiva → false', async () => {
    sembrar(prospecto({ active: false }))
    expect(await esProspectoDeLanding('staff-p')).toBe(false)
  })

  it('un empleado (rol MEMBER) → false', async () => {
    sembrar(prospecto({}, {}, { role: OrgRole.MEMBER }))
    expect(await esProspectoDeLanding('staff-p')).toBe(false)
  })

  it('un OWNER cuya organización NO es la primaria → false', async () => {
    sembrar(prospecto({}, {}, { isPrimary: false }))
    expect(await esProspectoDeLanding('staff-p')).toBe(false)
  })

  it('un OWNER NO primario + OTRA membresía MEMBER primaria → false (las condiciones deben cumplirse en la MISMA fila)', async () => {
    const fila = prospecto()
    fila.organizations = [
      { role: OrgRole.OWNER, isActive: true, isPrimary: false, organization: { onboardingCompletedAt: null } },
      { role: OrgRole.MEMBER, isActive: true, isPrimary: true, organization: { onboardingCompletedAt: null } },
    ]
    sembrar(fila)
    expect(await esProspectoDeLanding('staff-p')).toBe(false)
  })

  it('una membresía desactivada → false', async () => {
    sembrar(prospecto({}, {}, { isActive: false }))
    expect(await esProspectoDeLanding('staff-p')).toBe(false)
  })

  it('el alta ya se completó → false', async () => {
    sembrar(prospecto({}, { onboardingCompletedAt: new Date('2026-10-01T00:00:00Z') }))
    expect(await esProspectoDeLanding('staff-p')).toBe(false)
  })

  it('con contraseña → false, salvo exigirSinContrasena:false', async () => {
    sembrar(prospecto({ password: 'hash-de-bcrypt' }))
    expect(await esProspectoDeLanding('staff-p')).toBe(false)
    expect(await esProspectoDeLanding('staff-p', { exigirSinContrasena: false })).toBe(true)
    expect(await esProspectoDeLanding('staff-p', {})).toBe(false)
  })

  it('con exigirSinContrasena:false las demás condiciones siguen valiendo', async () => {
    sembrar(prospecto({ password: 'hash-de-bcrypt', googleId: 'google-123' }))
    expect(await esProspectoDeLanding('staff-p', { exigirSinContrasena: false })).toBe(false)
  })

  it('es UNA consulta acotada a esa persona (sin N+1)', async () => {
    sembrar(prospecto())
    await esProspectoDeLanding('staff-p')
    expect(staffFindFirst).toHaveBeenCalledTimes(1)
    expect(staffFindFirst.mock.calls[0][0].where.id).toBe('staff-p')
    expect(staffFindFirst.mock.calls[0][0].select).toEqual({ id: true })
  })
})

describe('signupFromLanding con el interruptor PRENDIDO', () => {
  beforeEach(() => interruptor('true'))

  it('cuenta nueva: nace SIN verificar, con código de 6 dígitos a +10 min y el resetToken de hoy', async () => {
    const antes = Date.now()
    const r = await signupFromLanding(entrada)

    const data = mockStaffCreate.mock.calls[0][0].data
    expect(data.emailVerified).toBe(false)
    expect(data.emailVerificationCode).toMatch(SEIS_DIGITOS)
    expect(data.emailVerificationExpires.getTime() - antes).toBeGreaterThanOrEqual(DIEZ_MINUTOS - 50)
    expect(data.emailVerificationExpires.getTime() - antes).toBeLessThanOrEqual(DIEZ_MINUTOS + 2000)
    expect(data.password).toBeNull()
    expect(data.resetToken).toMatch(/^[0-9a-f]{64}$/)
    expect(data.resetTokenExpiry.getTime() - antes).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(data.resetTokenUsedAt).toBeNull()
    expect(r).toMatchObject({ alreadyExisted: false, yaEsCliente: false, codigoVerificacion: data.emailVerificationCode })
    expect(r.magicLinkToken).toEqual(expect.any(String))
  })

  it('cuenta existente que SÍ es prospecto (aunque ya esté verificada): código nuevo, resetToken renovado y emailVerified intacto', async () => {
    staffFindUnique.mockResolvedValue({ id: 'staff-p', email: 'ana@example.com', password: null, emailVerified: true })
    staffFindFirst.mockResolvedValue({ id: 'staff-p' })

    const r = await signupFromLanding(entrada)

    expect(staffUpdate).not.toHaveBeenCalled()
    expect(staffUpdateMany).toHaveBeenCalledTimes(1)
    const { where, data } = staffUpdateMany.mock.calls[0][0]
    expect(where).toEqual({ id: 'staff-p', email: 'ana@example.com' })
    expect(data.emailVerificationCode).toMatch(SEIS_DIGITOS)
    expect(data.emailVerificationExpires.getTime() - Date.now()).toBeGreaterThan(DIEZ_MINUTOS - 5000)
    expect(data).toEqual(
      expect.objectContaining({ resetToken: expect.any(String), resetTokenExpiry: expect.any(Date), resetTokenUsedAt: null }),
    )
    expect(data).not.toHaveProperty('emailVerified')
    expect(staffFindFirst.mock.calls[0][0].where.id).toBe('staff-p')
    expect(r).toMatchObject({ alreadyExisted: true, yaEsCliente: false, codigoVerificacion: data.emailVerificationCode })
    expect(r.magicLinkToken).toEqual(expect.any(String))
  })

  it('si la cuenta cambió de correo a media escritura (0 filas): error y ningún código guardado ni devuelto', async () => {
    staffFindUnique.mockResolvedValue({ id: 'staff-p', email: 'ana@example.com', password: null, emailVerified: true })
    staffFindFirst.mockResolvedValue({ id: 'staff-p' })
    staffUpdateMany.mockResolvedValue({ count: 0 })

    await expect(signupFromLanding(entrada)).rejects.toMatchObject({ code: 'CUENTA_CAMBIO' })
    expect(staffUpdate).not.toHaveBeenCalled()
  })

  it('una cuenta de Google o un empleado sin contraseña (no es prospecto): sin código, se comporta como hoy', async () => {
    staffFindUnique.mockResolvedValue({ id: 'staff-g', email: 'ana@example.com', password: null, emailVerified: true })
    staffFindFirst.mockResolvedValue(null)

    const r = await signupFromLanding(entrada)

    const { data } = staffUpdate.mock.calls[0][0]
    expect(Object.keys(data).sort()).toEqual(['resetToken', 'resetTokenExpiry', 'resetTokenUsedAt'])
    expect(r.codigoVerificacion).toBeNull()
    expect(r.magicLinkToken).toEqual(expect.any(String))
    expect(r).toMatchObject({ alreadyExisted: true, yaEsCliente: false })
  })

  it('un cliente con contraseña: sin código y no se toca nada', async () => {
    staffFindUnique.mockResolvedValue({ id: 'staff-c', email: 'ana@example.com', password: 'hash', emailVerified: true })

    const r = await signupFromLanding(entrada)

    expect(staffUpdate).not.toHaveBeenCalled()
    expect(staffFindFirst).not.toHaveBeenCalled()
    expect(mockStaffCreate).not.toHaveBeenCalled()
    expect(r).toMatchObject({ yaEsCliente: true, alreadyExisted: true, magicLinkToken: null, codigoVerificacion: null })
  })
})

describe('signupFromLanding con el interruptor APAGADO: idéntico a hoy', () => {
  it('cuenta nueva: emailVerified true, sin código, mismas llaves de siempre', async () => {
    const r = await signupFromLanding(entrada)

    const data = mockStaffCreate.mock.calls[0][0].data
    expect(data.emailVerified).toBe(true)
    expect(data).not.toHaveProperty('emailVerificationCode')
    expect(data).not.toHaveProperty('emailVerificationExpires')
    expect(Object.keys(data).sort()).toEqual(
      [
        'active',
        'email',
        'emailVerified',
        'firstName',
        'lastName',
        'password',
        'phone',
        'resetToken',
        'resetTokenExpiry',
        'resetTokenUsedAt',
      ].sort(),
    )
    expect(r.codigoVerificacion).toBeNull()
    expect(r.magicLinkToken).toEqual(expect.any(String))
  })

  it('cuenta existente sin contraseña: sólo renueva el resetToken, sin ni preguntar si es prospecto', async () => {
    staffFindUnique.mockResolvedValue({ id: 'staff-p', email: 'ana@example.com', password: null, emailVerified: true })
    staffFindFirst.mockResolvedValue({ id: 'staff-p' })

    const r = await signupFromLanding(entrada)

    const { data } = staffUpdate.mock.calls[0][0]
    expect(Object.keys(data).sort()).toEqual(['resetToken', 'resetTokenExpiry', 'resetTokenUsedAt'])
    expect(staffFindFirst).not.toHaveBeenCalled()
    expect(r.codigoVerificacion).toBeNull()
  })

  it('cliente con contraseña: igual que hoy', async () => {
    staffFindUnique.mockResolvedValue({ id: 'staff-c', email: 'ana@example.com', password: 'hash' })

    const r = await signupFromLanding(entrada)

    expect(staffUpdate).not.toHaveBeenCalled()
    expect(r).toMatchObject({ yaEsCliente: true, magicLinkToken: null, codigoVerificacion: null })
  })
})
