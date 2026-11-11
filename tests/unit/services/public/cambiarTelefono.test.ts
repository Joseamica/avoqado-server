/**
 * S8 (P2-1): cambiar de número. El número nuevo REEMPLAZA al viejo en la ficha y en su Consumer, sube la versión de sesión en la misma
 * transacción y la respuesta es una sesión nueva. La autoridad real (Postgres + middleware S6) está en `sesionUnica.integration.test.ts`.
 */
jest.mock('@/services/whatsapp.service', () => ({ __esModule: true, sendOtpWhatsApp: jest.fn(async () => true) }))

import { prismaMock } from '@tests/__helpers__/setup'
import { hashOtpCode } from '@/lib/otp'
import { verifyCustomerSession } from '@/jwt.service'
import type { CustomerAuthContext } from '@/middlewares/customerAuth.middleware'
import { pedirCambioDeTelefono, confirmarCambioDeTelefono } from '@/services/public/customerPortal.public.service'

const VENUE = 'cvenue000000000000000000a'
const VIEJO = '+525511110000'
const NUEVO = '+525522223333'
const CODE = '123456'
const FICHA = {
  id: 'cficha00000000000000000a1',
  venueId: VENUE,
  phone: VIEJO,
  email: 'ana@gmail.com',
  firstName: 'Ana',
  lastName: null,
  active: true,
  consumerId: 'ccons000000000000000000a1',
  versionDeSesion: 0,
}
const sesion = (contactos: CustomerAuthContext['contactos'], extra: Partial<CustomerAuthContext> = {}): CustomerAuthContext => ({
  customerId: FICHA.id,
  venueId: VENUE,
  tipo: 'SESION',
  contactos,
  accountActivatedAt: new Date(),
  ...extra,
})
const TEL_VIEJO = { tipo: 'PHONE' as const, valor: VIEJO, metodo: 'WHATSAPP' as const, probadoEn: 1_800_000_000 }
const CORREO = { tipo: 'EMAIL' as const, valor: 'ana@gmail.com', metodo: 'EMAIL_CODE' as const, probadoEn: 1_800_000_000 }

function armar() {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  for (const m of [
    prismaMock.customer.findFirst,
    prismaMock.customer.findUnique,
    prismaMock.customer.findUniqueOrThrow,
    prismaMock.customer.update,
    prismaMock.consumer.findUnique,
    prismaMock.consumer.update,
    prismaMock.consumer.updateMany,
    prismaMock.otpChallenge.updateMany,
    prismaMock.otpChallenge.findFirst,
  ])
    (m as jest.Mock).mockReset()
  ;(prismaMock.$queryRaw as jest.Mock).mockReset().mockResolvedValue([])
  prismaMock.otpChallenge.count.mockResolvedValue(0)
  prismaMock.otpChallenge.findFirst.mockResolvedValue({
    id: 'creto000000000000000000a1',
    venueId: VENUE,
    destination: NUEVO,
    codeHash: hashOtpCode(CODE),
    attempts: 0,
    maxAttempts: 5,
    expiresAt: new Date(Date.now() + 600_000),
    consumedAt: null,
  } as any)
  ;(prismaMock.otpChallenge.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  // Sin otra ficha con el número nuevo (`id: { not }`); la ficha propia tiene el viejo.
  prismaMock.customer.findFirst.mockImplementation(async (q: any) => (q?.where?.id?.not ? null : ({ phone: VIEJO } as any)))
  prismaMock.customer.findUniqueOrThrow.mockResolvedValue({ ...FICHA } as any)
  prismaMock.customer.update.mockResolvedValue({ ...FICHA, phone: NUEVO, versionDeSesion: 1 } as any)
  prismaMock.consumer.findUnique.mockResolvedValue({ id: FICHA.consumerId, phone: '+5511110000' } as any) // forma vieja del OTP
  ;(prismaMock.consumer.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
}

describe('pedirCambioDeTelefono', () => {
  it('pide el reto propio CUSTOMER_PHONE_CHANGE al número nuevo, en su forma canónica', async () => {
    armar()
    await pedirCambioDeTelefono(VENUE, sesion([TEL_VIEJO]), '55 2222 3333')
    expect(prismaMock.otpChallenge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ venueId: VENUE, channel: 'whatsapp', destination: NUEVO, purpose: 'CUSTOMER_PHONE_CHANGE' }),
    })
    expect(prismaMock.otpChallenge.count).toHaveBeenCalledWith({ where: expect.objectContaining({ purpose: 'CUSTOMER_PHONE_CHANGE' }) })
  })

  it('una sesión SIN contactos probados (contraseña) ⇒ 401 CUSTOMER_REAUTH_REQUIRED, sin reto', async () => {
    armar()
    await expect(pedirCambioDeTelefono(VENUE, sesion([]), NUEVO)).rejects.toMatchObject({
      statusCode: 401,
      code: 'CUSTOMER_REAUTH_REQUIRED',
      message: 'Entra otra vez para cambiar tu número',
    })
    expect(prismaMock.otpChallenge.create).not.toHaveBeenCalled()
  })

  it('el token de pedidos de hoy (teléfono firmado) sí puede', async () => {
    armar()
    await pedirCambioDeTelefono(VENUE, sesion([], { tipo: 'PEDIDOS_DE_HOY', verifiedPhone: VIEJO }), NUEVO)
    expect(prismaMock.otpChallenge.create).toHaveBeenCalled()
  })

  it('el mismo número que ya tiene ⇒ 400 CUSTOMER_PHONE_SAME', async () => {
    armar()
    await expect(pedirCambioDeTelefono(VENUE, sesion([TEL_VIEJO]), '5511110000')).rejects.toMatchObject({ code: 'CUSTOMER_PHONE_SAME' })
  })
})

describe('confirmarCambioDeTelefono', () => {
  it('en UNA transacción: consume el reto, cambia Customer.phone y Consumer.phone, sube versionDeSesion y deja bitácora', async () => {
    armar()
    const r = await confirmarCambioDeTelefono(VENUE, sesion([TEL_VIEJO, CORREO]), NUEVO, CODE)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.otpChallenge.updateMany).toHaveBeenCalledWith({
      where: { id: 'creto000000000000000000a1', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    })
    expect(prismaMock.customer.update).toHaveBeenCalledWith({
      where: { id: FICHA.id },
      data: { phone: NUEVO, versionDeSesion: { increment: 1 } },
    })
    // codex-s8-r1 #3: CAS sobre el teléfono que se leyó del Consumer.
    expect(prismaMock.consumer.updateMany).toHaveBeenCalledWith({
      where: { id: FICHA.consumerId, phone: '+5511110000' },
      data: { phone: NUEVO },
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'CUSTOMER_PHONE_CHANGED_BY_CUSTOMER', entityId: FICHA.id, data: { de: VIEJO, a: NUEVO } }),
    })
    const nueva = verifyCustomerSession(r.token)
    expect(nueva.v).toBe(1)
    expect(nueva.contactos.map(c => [c.tipo, c.valor])).toEqual([
      ['EMAIL', 'ana@gmail.com'],
      ['PHONE', NUEVO],
    ])
    expect(r.customer.phone).toBe(NUEVO)
  })

  it('un Consumer con OTRO teléfono no se toca', async () => {
    armar()
    prismaMock.consumer.findUnique.mockResolvedValue({ id: FICHA.consumerId, phone: '+525599999999' } as any)
    await confirmarCambioDeTelefono(VENUE, sesion([TEL_VIEJO]), NUEVO, CODE)
    expect(prismaMock.consumer.updateMany).not.toHaveBeenCalled()
  })

  it('codex-s8-r1 #3: si otra ficha cambió el Consumer entre la lectura y la escritura, el CAS no lo pisa y no truena', async () => {
    armar()
    ;(prismaMock.consumer.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    await expect(confirmarCambioDeTelefono(VENUE, sesion([TEL_VIEJO]), NUEVO, CODE)).resolves.toMatchObject({ customer: { phone: NUEVO } })
  })

  it('codex-s8-r1 #1: una sesión de versión vieja que esperaba el candado ⇒ 401 sin escribir; ficha desactivada ⇒ CUSTOMER_INACTIVE', async () => {
    armar()
    prismaMock.customer.findUniqueOrThrow.mockResolvedValue({ ...FICHA, versionDeSesion: 1 } as any)
    await expect(confirmarCambioDeTelefono(VENUE, sesion([CORREO], { v: 0 }), NUEVO, CODE)).rejects.toMatchObject({
      code: 'CUSTOMER_TOKEN_INVALID',
    })
    prismaMock.customer.findUniqueOrThrow.mockResolvedValue({ ...FICHA, active: false } as any)
    await expect(confirmarCambioDeTelefono(VENUE, sesion([CORREO], { v: 0 }), NUEVO, CODE)).rejects.toMatchObject({
      code: 'CUSTOMER_INACTIVE',
    })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it('número de otra ficha ⇒ 409 TELEFONO_DE_OTRA_FICHA con otraFicha tapada y nada cambia', async () => {
    armar()
    prismaMock.customer.findFirst.mockImplementation(async (q: any) =>
      q?.where?.id?.not ? ({ ...FICHA, id: 'cficha00000000000000000b2', phone: NUEVO } as any) : ({ phone: VIEJO } as any),
    )
    await expect(confirmarCambioDeTelefono(VENUE, sesion([TEL_VIEJO]), NUEVO, CODE)).rejects.toMatchObject({
      statusCode: 409,
      code: 'TELEFONO_DE_OTRA_FICHA',
      details: { otraFicha: { contacto: 'PHONE', enmascarado: '55•••••333' } },
    })
    // codex-s8-r2 #2: lo ya guardado se ve ANTES de escribir: ni la ficha, ni el Consumer, ni la bitácora se tocan.
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
    expect(prismaMock.consumer.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('codex-s8-r1 #4: otra ficha que guardó el número (otro formato) DESPUÉS de la primera búsqueda ⇒ 409 tras escribir (rollback)', async () => {
    armar()
    let busquedas = 0
    prismaMock.customer.findFirst.mockImplementation(async (q: any) => {
      if (!q?.where?.id?.not) return { phone: VIEJO } as any
      busquedas += 1
      return busquedas > 1 ? ({ ...FICHA, id: 'cficha00000000000000000b2', phone: '5522223333' } as any) : null
    })
    await expect(confirmarCambioDeTelefono(VENUE, sesion([TEL_VIEJO]), NUEVO, CODE)).rejects.toMatchObject({
      code: 'TELEFONO_DE_OTRA_FICHA',
    })
    expect(prismaMock.customer.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('R3: el panel cambió el teléfono de la sesión a media petición ⇒ 401 sin escribir', async () => {
    armar()
    prismaMock.customer.findUniqueOrThrow.mockResolvedValue({ ...FICHA, phone: '+525588887777' } as any)
    await expect(confirmarCambioDeTelefono(VENUE, sesion([TEL_VIEJO]), NUEVO, CODE)).rejects.toMatchObject({
      statusCode: 401,
      code: 'CUSTOMER_TOKEN_INVALID',
    })
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it('sesión sin contactos ⇒ 401 CUSTOMER_REAUTH_REQUIRED antes de tocar el reto', async () => {
    armar()
    await expect(confirmarCambioDeTelefono(VENUE, sesion([]), NUEVO, CODE)).rejects.toMatchObject({ code: 'CUSTOMER_REAUTH_REQUIRED' })
    expect(prismaMock.otpChallenge.findFirst).not.toHaveBeenCalled()
  })

  it('el reto que busca es el de CUSTOMER_PHONE_CHANGE, no el de entrar', async () => {
    armar()
    await confirmarCambioDeTelefono(VENUE, sesion([TEL_VIEJO]), NUEVO, CODE)
    expect(prismaMock.otpChallenge.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ purpose: 'CUSTOMER_PHONE_CHANGE', destination: NUEVO }) }),
    )
  })
})
