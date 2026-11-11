/**
 * S7 (P2-1): la prueba pendiente de un contacto, ligar ese contacto a una ficha sin pisar ni juntar, y la otra ficha tapada.
 * La autoridad real (Postgres, middleware S6) vive en `tests/integration/public/sesionUnica.integration.test.ts`; aquí, la forma.
 */
import jwt from 'jsonwebtoken'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  firmarPruebaPendiente,
  verificarPruebaPendiente,
  ligarContacto,
  otraFichaDe,
  fichaConContacto,
  repetirSiChoca,
} from '@/services/public/sesionDeCliente.service'
import type { ContactoProbado } from '@/jwt.service'
import type { TxConReintento } from '@/utils/serializableRetry'

const VENUE = 'cvenue000000000000000000a'
const SECRET = process.env.ACCESS_TOKEN_SECRET!
const tx = prismaMock as unknown as TxConReintento
const ahora = () => Math.floor(Date.now() / 1000)
const TEL: ContactoProbado = { tipo: 'PHONE', valor: '+525511112222', metodo: 'WHATSAPP', probadoEn: 1_800_000_000 }
const CORREO: ContactoProbado = { tipo: 'EMAIL', valor: 'ana@gmail.com', metodo: 'EMAIL_CODE', probadoEn: 1_800_000_000 }
const ficha = (extra: Record<string, unknown> = {}) =>
  ({ id: 'cficha00000000000000000a1', venueId: VENUE, phone: null, email: 'ana@gmail.com', active: true, ...extra }) as any

beforeEach(() => {
  // `clearAllMocks` del setup no borra implementaciones: cada caso arma las suyas desde cero.
  for (const m of [
    prismaMock.customer.findFirst,
    prismaMock.customer.findUnique,
    prismaMock.customer.findUniqueOrThrow,
    prismaMock.customer.updateMany,
  ])
    (m as jest.Mock).mockReset()
  ;(prismaMock.$queryRaw as jest.Mock).mockReset().mockResolvedValue([])
  prismaMock.customer.findFirst.mockResolvedValue(null)
})

describe('prueba pendiente (customer_contact_proof, 15 min)', () => {
  it('firma y verifica: devuelve EXACTAMENTE el contacto firmado y vence en 15 minutos', () => {
    const token = firmarPruebaPendiente(VENUE, TEL)
    const crudo = jwt.verify(token, SECRET) as jwt.JwtPayload
    expect(crudo.type).toBe('customer_contact_proof')
    expect(crudo.exp! - crudo.iat!).toBe(900)
    expect(crudo.sub).toBeUndefined()
    expect(verificarPruebaPendiente(token, VENUE)).toEqual(TEL)
  })

  it.each([
    ['vencida', () => jwt.sign({ type: 'customer_contact_proof', venueId: VENUE, contacto: TEL }, SECRET, { expiresIn: -1 })],
    ['de otro negocio', () => firmarPruebaPendiente('cvenue000000000000000000b', TEL)],
    ['otra llave', () => jwt.sign({ type: 'customer_contact_proof', venueId: VENUE, contacto: TEL }, 'otra-llave', { expiresIn: 900 })],
    [
      'sesión común en vez de prueba',
      () => jwt.sign({ type: 'customer_session', sub: 'c1', venueId: VENUE, v: 0, contactos: [TEL] }, SECRET, { expiresIn: 900 }),
    ],
    ['id en claro', () => 'cficha00000000000000000a1'],
    [
      'contacto sin normalizar',
      () =>
        jwt.sign({ type: 'customer_contact_proof', venueId: VENUE, contacto: { ...TEL, valor: '55 1111 2222' } }, SECRET, {
          expiresIn: 900,
        }),
    ],
    [
      'método de contraseña',
      () =>
        jwt.sign({ type: 'customer_contact_proof', venueId: VENUE, contacto: { ...CORREO, metodo: 'PASSWORD' } }, SECRET, {
          expiresIn: 900,
        }),
    ],
    [
      'correo con método de WhatsApp',
      () =>
        jwt.sign({ type: 'customer_contact_proof', venueId: VENUE, contacto: { ...CORREO, metodo: 'WHATSAPP' } }, SECRET, {
          expiresIn: 900,
        }),
    ],
  ])('%s ⇒ 400 CUSTOMER_PROOF_INVALID', (_caso, token) => {
    expect(() => verificarPruebaPendiente(token(), VENUE)).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'CUSTOMER_PROOF_INVALID' }),
    )
  })
})

describe('ligarContacto', () => {
  it('campo vacío ⇒ lo llena con CAS sobre el campo en null y deja CUSTOMER_CONTACT_LINKED', async () => {
    ;(prismaMock.customer.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
    prismaMock.customer.findUniqueOrThrow.mockResolvedValue(ficha({ phone: TEL.valor }))
    const r = await ligarContacto(tx, VENUE, ficha(), TEL)
    expect(r).toMatchObject({ ligado: true, ficha: { phone: TEL.valor } })
    expect(prismaMock.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'cficha00000000000000000a1', venueId: VENUE, OR: [{ phone: null }, { phone: '' }] },
      data: { phone: TEL.valor },
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'CUSTOMER_CONTACT_LINKED',
        entity: 'Customer',
        entityId: 'cficha00000000000000000a1',
        venueId: VENUE,
        data: { contacto: 'PHONE', metodo: 'WHATSAPP', valor: TEL.valor },
      }),
    })
  })

  it('el mismo teléfono en otro formato ⇒ ya es suyo: no escribe y lo acepta', async () => {
    const r = await ligarContacto(tx, VENUE, ficha({ phone: '55 1111 2222' }), TEL)
    expect(r).toMatchObject({ ligado: true })
    expect(prismaMock.customer.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('la ficha ya tiene OTRO teléfono ⇒ no lo pisa y avisa FICHA_CON_OTRO_TELEFONO', async () => {
    const r = await ligarContacto(tx, VENUE, ficha({ phone: '+525599990000' }), TEL)
    expect(r).toMatchObject({ ligado: false, aviso: 'FICHA_CON_OTRO_TELEFONO' })
    expect(prismaMock.customer.updateMany).not.toHaveBeenCalled()
  })

  it('la ficha ya tiene OTRO correo ⇒ avisa FICHA_CON_OTRO_CORREO', async () => {
    const r = await ligarContacto(tx, VENUE, ficha({ email: 'otra@gmail.com' }), CORREO)
    expect(r).toMatchObject({ ligado: false, aviso: 'FICHA_CON_OTRO_CORREO' })
  })

  it('el teléfono es de OTRA ficha activa ⇒ no mueve nada y responde otraFicha tapada', async () => {
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'cficha00000000000000000b2', phone: '5511112222' }])
    prismaMock.customer.findUnique.mockResolvedValue(ficha({ id: 'cficha00000000000000000b2', phone: '5511112222' }))
    const r = await ligarContacto(tx, VENUE, ficha(), TEL)
    expect(r).toMatchObject({ ligado: false, otraFicha: { contacto: 'PHONE', enmascarado: '55•••••222' } })
    expect(prismaMock.customer.updateMany).not.toHaveBeenCalled()
  })

  it('el CAS pierde (otra petición llenó el campo) ⇒ relee y avisa, sin bitácora', async () => {
    ;(prismaMock.customer.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
    prismaMock.customer.findUniqueOrThrow.mockResolvedValue(ficha({ phone: '+525533334444' }))
    const r = await ligarContacto(tx, VENUE, ficha(), TEL)
    expect(r).toMatchObject({ ligado: false, aviso: 'FICHA_CON_OTRO_TELEFONO', ficha: { phone: '+525533334444' } })
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})

describe('otraFichaDe', () => {
  it('busca OTRA ficha ACTIVA del negocio por correo sin mayúsculas y la tapa', async () => {
    prismaMock.customer.findFirst
      .mockResolvedValueOnce(null) // exacta
      .mockResolvedValueOnce(ficha({ id: 'cficha00000000000000000b2', email: 'Ana@Gmail.com' }))
    expect(await otraFichaDe(prismaMock as any, VENUE, 'cficha00000000000000000a1', [CORREO])).toEqual({
      contacto: 'EMAIL',
      enmascarado: 'a•••@gmail.com',
    })
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          venueId: VENUE,
          id: { not: 'cficha00000000000000000a1' },
          active: true,
          email: { equals: 'ana@gmail.com', mode: 'insensitive' },
        },
      }),
    )
  })

  it('codex-s7-r2: sólo busca entre fichas ACTIVAS (una desactivada no tapa a otra activa) y por teléfono también', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(null)
    expect(await otraFichaDe(prismaMock as any, VENUE, 'cficha00000000000000000a1', [CORREO, TEL])).toBeNull()
    for (const [q] of (prismaMock.customer.findFirst as jest.Mock).mock.calls) expect(q.where.active).toBe(true)
    const [sql, ...valores] = (prismaMock.$queryRaw as jest.Mock).mock.calls[0]
    expect(sql.join('?')).toContain('"active" = true')
    expect(valores).toContain(false) // `${!soloActivas}`: el filtro de activas está PRENDIDO
  })
})

describe('fichaConContacto · correo (R6, codex-s7-r1 #4)', () => {
  it('la coincidencia EXACTA gana sobre una ficha más antigua con otras mayúsculas', async () => {
    const exacta = ficha({ id: 'cficha00000000000000000ex', email: 'ana@gmail.com' })
    prismaMock.customer.findFirst.mockImplementation(async (q: any) =>
      typeof q.where.email === 'string' ? exacta : ficha({ id: 'vieja' }),
    )
    expect(await fichaConContacto(prismaMock as any, VENUE, CORREO)).toBe(exacta)
    expect(prismaMock.customer.findFirst).toHaveBeenCalledTimes(1)
  })
})

describe('repetirSiChoca', () => {
  const choque = () =>
    new Prisma.PrismaClientKnownRequestError('único', { code: 'P2002', clientVersion: 'x', meta: { modelName: 'Customer' } })

  it('un choque del único de Customer se repite UNA vez', async () => {
    const fn = jest.fn().mockRejectedValueOnce(choque()).mockResolvedValueOnce('ok')
    await expect(repetirSiChoca(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('también el único de Consumer.email (dos entradas con el mismo correo nuevo a la vez)', async () => {
    const deConsumer = new Prisma.PrismaClientKnownRequestError('único', {
      code: 'P2002',
      clientVersion: 'x',
      meta: { modelName: 'Consumer' },
    })
    const fn = jest.fn().mockRejectedValueOnce(deConsumer).mockResolvedValueOnce('ok')
    await expect(repetirSiChoca(fn)).resolves.toBe('ok')
    const deOtro = new Prisma.PrismaClientKnownRequestError('único', { code: 'P2002', clientVersion: 'x', meta: { modelName: 'Order' } })
    const otro = jest.fn().mockRejectedValue(deOtro)
    await expect(repetirSiChoca(otro)).rejects.toBe(deOtro)
    expect(otro).toHaveBeenCalledTimes(1)
  })

  it('dos choques seguidos salen; otro error sale al primero', async () => {
    const dos = jest.fn().mockRejectedValue(choque())
    await expect(repetirSiChoca(dos)).rejects.toMatchObject({ code: 'P2002' })
    expect(dos).toHaveBeenCalledTimes(2)
    const otro = jest.fn().mockRejectedValue(new Error('otro'))
    await expect(repetirSiChoca(otro)).rejects.toThrow('otro')
    expect(otro).toHaveBeenCalledTimes(1)
  })
})

it('sanity: la prueba no dura más de lo prometido', () => {
  const token = firmarPruebaPendiente(VENUE, CORREO)
  expect((jwt.decode(token) as jwt.JwtPayload).exp).toBeLessThanOrEqual(ahora() + 900)
})
