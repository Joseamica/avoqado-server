/**
 * S7 (P2-1): `verifyOtp` con `purpose: 'SESSION'` y `entrarConGoogle`. La sesión es la de S6 (`customer_session`); aquí se fija
 * qué contactos lleva, que NO activa reservas y que «¿ya eres cliente?» no crea nada. El recorrido real está en la integración.
 */
const mockVerifyIdToken = jest.fn()
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: (...a: unknown[]) => mockVerifyIdToken(...a) })),
}))
jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  activateCustomerAccount: jest.fn(async () => ({ approvalStatus: 'PENDING', requestsApproval: true, approvalVersion: 0 })),
}))
jest.mock('@/services/whatsapp.service', () => ({ __esModule: true, sendOtpWhatsApp: jest.fn(async () => undefined) }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendOtpCodeEmail: jest.fn(async () => true) } }))

import jwt from 'jsonwebtoken'
import { prismaMock } from '@tests/__helpers__/setup'
import { hashOtpCode } from '@/lib/otp'
import { verifyCustomerSession } from '@/jwt.service'
import { activateCustomerAccount } from '@/services/public/customerBookingAccess.service'
import emailService from '@/services/email.service'
import { verifyOtp, entrarConGoogle } from '@/services/public/otpAuth.public.service'
import { firmarPruebaPendiente, verificarPruebaPendiente } from '@/services/public/sesionDeCliente.service'
import { otpVerifySchema } from '@/schemas/dashboard/creditPack.schema'

const VENUE = 'cvenue000000000000000000a'
const PHONE = '+525511110000'
const EMAIL = 'ana@empresa.com'
const CODE = '123456'
const FICHA = {
  id: 'cficha00000000000000000a1',
  venueId: VENUE,
  phone: null as string | null,
  email: EMAIL as string | null,
  firstName: 'Ana',
  lastName: null,
  active: true,
  consumerId: 'ccons000000000000000000a1',
  versionDeSesion: 3,
  approvalStatus: 'APPROVED',
}

function armarReto(destination: string) {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.otpChallenge.findFirst.mockResolvedValue({
    id: 'creto000000000000000000a1',
    venueId: VENUE,
    destination,
    codeHash: hashOtpCode(CODE),
    attempts: 0,
    maxAttempts: 5,
    expiresAt: new Date(Date.now() + 600_000),
    consumedAt: null,
  } as any)
  ;(prismaMock.otpChallenge.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  ;(prismaMock.$queryRaw as jest.Mock).mockReset().mockResolvedValue([])
  for (const m of [
    prismaMock.customer.findFirst,
    prismaMock.customer.findUnique,
    prismaMock.customer.findUniqueOrThrow,
    prismaMock.customer.create,
    prismaMock.customer.update,
    prismaMock.customer.updateMany,
  ])
    (m as jest.Mock).mockReset()
  prismaMock.customer.findFirst.mockResolvedValue(null)
  prismaMock.customer.findUnique.mockResolvedValue(null)
  prismaMock.reservation.findFirst.mockResolvedValue(null)
  prismaMock.consumer.findMany.mockResolvedValue([])
  prismaMock.consumer.findFirst.mockResolvedValue(null)
  prismaMock.consumer.create.mockResolvedValue({ id: 'ccons000000000000000000n1' } as any)
}

/** La ficha que halla la búsqueda y la que relee el candado (`bloquearFicha`): la misma, salvo que un caso diga otra cosa. */
const fichaEncontrada = (extra: Partial<typeof FICHA> = {}) => {
  prismaMock.customer.findFirst.mockImplementation(async (q: any) =>
    q?.where?.id?.not ? null : q?.where?.email || q?.where?.phone ? ({ ...FICHA, ...extra } as any) : null,
  )
  prismaMock.customer.findUniqueOrThrow.mockResolvedValue({ ...FICHA, ...extra } as any)
}

describe('verifyOtp · SESSION (S7)', () => {
  it('con correo emite la sesión única con el contacto EMAIL (ya no ORDERING_REQUIRES_PHONE) y la versión de la ficha', async () => {
    armarReto(EMAIL)
    fichaEncontrada()
    const r: any = await verifyOtp({ venueId: VENUE, channel: 'email', destination: EMAIL, code: CODE, purpose: 'SESSION' })
    const sesion = verifyCustomerSession(r.token)
    expect(sesion).toMatchObject({ sub: FICHA.id, venueId: VENUE, v: 3 })
    expect(sesion.contactos).toEqual([{ tipo: 'EMAIL', valor: EMAIL, metodo: 'EMAIL_CODE', probadoEn: expect.any(Number) }])
    expect(r.contactos).toEqual(sesion.contactos)
    expect(r.customer).toEqual({ id: FICHA.id, firstName: 'Ana', lastName: null, email: EMAIL, phone: null })
    expect(r).not.toHaveProperty('approvalStatus')
  })

  it('NO activa la cuenta de reservas (eso lo hace S6 al reservar o abrir el portal)', async () => {
    armarReto(PHONE)
    fichaEncontrada({ phone: PHONE })
    await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE, purpose: 'SESSION' })
    expect(activateCustomerAccount).not.toHaveBeenCalled()
  })

  it('«¿ya eres cliente?» sin ficha: consume el reto y NO crea Customer ni Consumer; devuelve la prueba del contacto', async () => {
    armarReto(PHONE)
    const r: any = await verifyOtp({
      venueId: VENUE,
      channel: 'whatsapp',
      destination: PHONE,
      code: CODE,
      purpose: 'SESSION',
      alNoEncontrar: 'PREGUNTAR',
    })
    expect(r.fichaNueva).toBe(true)
    expect(verificarPruebaPendiente(r.pruebaPendiente, VENUE)).toMatchObject({ tipo: 'PHONE', valor: PHONE, metodo: 'WHATSAPP' })
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
    expect(prismaMock.consumer.create).not.toHaveBeenCalled()
    expect(prismaMock.otpChallenge.updateMany).toHaveBeenCalledWith({
      where: { id: 'creto000000000000000000a1', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    })
  })

  it('la ficha que sólo se halla por el Consumer ligado (su contacto cambió) NO da la sesión', async () => {
    armarReto(PHONE)
    prismaMock.consumer.findMany.mockResolvedValue([{ id: FICHA.consumerId, phone: PHONE }] as any)
    prismaMock.customer.findFirst.mockImplementation(async (q: any) => (q?.where?.consumerId ? (FICHA as any) : null))
    const r: any = await verifyOtp({
      venueId: VENUE,
      channel: 'whatsapp',
      destination: PHONE,
      code: CODE,
      purpose: 'SESSION',
      alNoEncontrar: 'PREGUNTAR',
    })
    expect(r.fichaNueva).toBe(true)
  })

  it('vincular: ficha sólo con correo + teléfono probado ⇒ el teléfono entra a ESA ficha y la sesión trae los dos', async () => {
    armarReto(EMAIL)
    fichaEncontrada()
    ;(prismaMock.customer.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    prismaMock.customer.findUniqueOrThrow
      .mockResolvedValueOnce({ ...FICHA } as any) // el candado
      .mockResolvedValueOnce({ ...FICHA, phone: PHONE } as any) // la relectura después de ligar
    const prueba = firmarPruebaPendiente(VENUE, { tipo: 'PHONE', valor: PHONE, metodo: 'WHATSAPP', probadoEn: 1_800_000_000 })
    const r: any = await verifyOtp({
      venueId: VENUE,
      channel: 'email',
      destination: EMAIL,
      code: CODE,
      purpose: 'SESSION',
      vincular: prueba,
    })
    expect(r.contactos.map((c: any) => [c.tipo, c.valor])).toEqual([
      ['EMAIL', EMAIL],
      ['PHONE', PHONE],
    ])
    expect(r.contactos[1].probadoEn).toBe(1_800_000_000)
    expect(r.customer.phone).toBe(PHONE)
    expect(r.avisos ?? []).toEqual([])
    expect(prismaMock.customer.updateMany).toHaveBeenCalledTimes(1)
  })

  it('codex-s7-r1 #1: el panel cambió el correo entre la búsqueda y el candado ⇒ 409, nada escrito, ninguna sesión', async () => {
    armarReto(EMAIL)
    fichaEncontrada()
    prismaMock.customer.findUniqueOrThrow.mockReset().mockResolvedValue({ ...FICHA, email: 'otra@persona.com' } as any)
    const prueba = firmarPruebaPendiente(VENUE, { tipo: 'PHONE', valor: PHONE, metodo: 'WHATSAPP', probadoEn: 1_800_000_000 })
    await expect(
      verifyOtp({ venueId: VENUE, channel: 'email', destination: EMAIL, code: CODE, purpose: 'SESSION', vincular: prueba }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CUSTOMER_CONTACT_CHANGED' })
    expect(prismaMock.customer.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.$queryRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('FOR NO KEY UPDATE')]),
      expect.anything(),
      expect.anything(),
    )
  })

  it('vincular con la ficha ya con OTRO teléfono ⇒ no lo pisa, avisa y la sesión NO lleva el teléfono rechazado', async () => {
    armarReto(EMAIL)
    fichaEncontrada({ phone: '+525599990000' })
    const prueba = firmarPruebaPendiente(VENUE, { tipo: 'PHONE', valor: PHONE, metodo: 'WHATSAPP', probadoEn: 1_800_000_000 })
    const r: any = await verifyOtp({
      venueId: VENUE,
      channel: 'email',
      destination: EMAIL,
      code: CODE,
      purpose: 'SESSION',
      vincular: prueba,
    })
    expect(r.avisos).toEqual(['FICHA_CON_OTRO_TELEFONO'])
    expect(verifyCustomerSession(r.token).contactos.map(c => c.tipo)).toEqual(['EMAIL'])
    expect(prismaMock.customer.updateMany).not.toHaveBeenCalled()
  })

  it('vincular con una prueba de otro negocio ⇒ 400 y el reto queda intacto (no gasta intento)', async () => {
    armarReto(EMAIL)
    const prueba = firmarPruebaPendiente('cvenue000000000000000000b', { tipo: 'PHONE', valor: PHONE, metodo: 'WHATSAPP', probadoEn: 1 })
    await expect(
      verifyOtp({ venueId: VENUE, channel: 'email', destination: EMAIL, code: CODE, purpose: 'SESSION', vincular: prueba }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CUSTOMER_PROOF_INVALID' })
    expect(prismaMock.otpChallenge.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.otpChallenge.updateMany).not.toHaveBeenCalled()
  })

  it('una ficha desactivada no recibe sesión', async () => {
    armarReto(EMAIL)
    fichaEncontrada({ active: false })
    await expect(verifyOtp({ venueId: VENUE, channel: 'email', destination: EMAIL, code: CODE, purpose: 'SESSION' })).rejects.toMatchObject(
      {
        code: 'CUSTOMER_INACTIVE',
      },
    )
  })

  it('el esquema acepta SESSION, PREGUNTAR y vincular; rechaza otros propósitos', () => {
    expect(
      otpVerifySchema.safeParse({ email: EMAIL, code: CODE, purpose: 'SESSION', alNoEncontrar: 'PREGUNTAR', vincular: 'x.y.z' }).success,
    ).toBe(true)
    expect(otpVerifySchema.safeParse({ email: EMAIL, code: CODE, purpose: 'OTRO' }).success).toBe(false)
    expect(otpVerifySchema.safeParse({ email: EMAIL, code: CODE, alNoEncontrar: 'CREAR' }).success).toBe(false)
  })
})

describe('S8 · páginas de hoy después de un cambio de número (codex-s8-r1 #2)', () => {
  it('ficha con versionDeSesion > 0: ORDERING y reservas sin purpose reciben la sesión única (versión de la ficha) en vez del token viejo', async () => {
    for (const purpose of ['ORDERING', undefined] as const) {
      armarReto(PHONE)
      prismaMock.customer.findUnique.mockResolvedValue({ ...FICHA, phone: PHONE, versionDeSesion: 2 } as any)
      const r: any = await verifyOtp({
        venueId: VENUE,
        channel: 'whatsapp',
        destination: PHONE,
        code: CODE,
        ...(purpose ? { purpose } : {}),
      })
      expect(verifyCustomerSession(r.token)).toMatchObject({
        sub: FICHA.id,
        v: 2,
        contactos: [expect.objectContaining({ tipo: 'PHONE', valor: PHONE })],
      })
    }
  })
})

describe('S8 · el número viejo no recupera la ficha (codex-s8-r2 #1)', () => {
  it('ficha con versión > 0 hallada por el Consumer ligado (su teléfono ya es otro) ⇒ token de hoy (S6 lo rechaza), nunca una sesión', async () => {
    armarReto(PHONE)
    prismaMock.consumer.findMany.mockResolvedValue([{ id: FICHA.consumerId, phone: PHONE }] as any)
    prismaMock.customer.findFirst.mockImplementation(async (q: any) =>
      q?.where?.consumerId ? ({ ...FICHA, phone: '+525599990000', versionDeSesion: 1 } as any) : null,
    )
    const r: any = await verifyOtp({ venueId: VENUE, channel: 'whatsapp', destination: PHONE, code: CODE, purpose: 'ORDERING' })
    expect(() => verifyCustomerSession(r.token)).toThrow()
    expect((jwt.decode(r.token) as jwt.JwtPayload).type).toBe('customer_ordering')
  })
})

describe('entrarConGoogle (S7)', () => {
  const google = (payload: Record<string, unknown>) =>
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: 'google-sub-1', email_verified: true, ...payload }) })

  it('correo confiable (Gmail verificado) ⇒ sesión con el contacto EMAIL por GOOGLE', async () => {
    armarReto(EMAIL)
    google({ email: 'Ana@Gmail.com' })
    fichaEncontrada({ email: 'ana@gmail.com' })
    const r: any = await entrarConGoogle(VENUE, 'id-token', {})
    expect(verifyCustomerSession(r.token).contactos).toEqual([
      { tipo: 'EMAIL', valor: 'ana@gmail.com', metodo: 'GOOGLE', probadoEn: expect.any(Number) },
    ])
    expect(activateCustomerAccount).not.toHaveBeenCalled()
  })

  it('correo NO confiable ⇒ manda el código por correo y responde 409 sin sesión', async () => {
    armarReto(EMAIL)
    google({ email: 'ana@empresa.com' }) // ni Gmail ni `hd`
    prismaMock.otpChallenge.count.mockResolvedValue(0)
    await expect(entrarConGoogle(VENUE, 'id-token', {})).rejects.toMatchObject({
      statusCode: 409,
      code: 'GOOGLE_EMAIL_NOT_TRUSTED',
      message: 'Te mandamos un código a tu correo para confirmarlo',
    })
    expect(emailService.sendOtpCodeEmail).toHaveBeenCalledWith('ana@empresa.com', expect.any(String))
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
  })

  it('codex-s7-r1 #2: correo NO confiable y el correo no salió ⇒ 503 honesto, nunca «te mandamos»', async () => {
    armarReto(EMAIL)
    google({ email: 'ana@empresa.com' })
    prismaMock.otpChallenge.count.mockResolvedValue(0)
    ;(emailService.sendOtpCodeEmail as jest.Mock).mockResolvedValueOnce(false)
    await expect(entrarConGoogle(VENUE, 'id-token', {})).rejects.toMatchObject({ statusCode: 503, code: 'OTP_SEND_FAILED' })
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
  })

  it('sin correo de Google ⇒ 400 sin sesión ni código', async () => {
    armarReto(EMAIL)
    google({ email: undefined, email_verified: false })
    await expect(entrarConGoogle(VENUE, 'id-token', {})).rejects.toMatchObject({ statusCode: 400, code: 'GOOGLE_EMAIL_MISSING' })
    expect(emailService.sendOtpCodeEmail).not.toHaveBeenCalled()
  })
})
