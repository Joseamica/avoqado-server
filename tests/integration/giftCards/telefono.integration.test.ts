/**
 * 1b S5 contra Postgres REAL (RF5): teléfono + código en la caja. Pedir un código desde la caja no toca el inicio de sesión del
 * cliente (ni su código ni su límite), un teléfono sin tarjetas recibe la misma respuesta, una prueba de otro teléfono, aparato o
 * venue no cobra, y el cobro con `PHONE_OTP` sigue Q91 (el reintento con la prueba vencida espera al primer envío y recibe su
 * cobro; un rechazo queda sellado).
 *
 * 🔴 Nada sale a nadie: `sendOtpWhatsApp` es un doble que recuerda a quién y qué código (así la prueba lo lee) y `fetch` truena si
 * algo intentara salir.
 *
 * Correr: source ~/.claude/worktrees/tarjetas-1b/urls-tarjetas-1b.sh && TZ=UTC npx jest --selectProjects=integration \
 *   --runInBand --testPathPattern "giftCards/telefono" --ci
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
  postCashRefundToDrawer: jest.fn().mockResolvedValue('NOT_DRAWER_CASH'),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/whatsapp.service', () => ({
  ...jest.requireActual('@/services/whatsapp.service'),
  sendOtpWhatsApp: (...args: unknown[]) => mockEnviarCodigo(...args),
}))

const mockEnviarCodigo = jest.fn()

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { hashOtpCode } from '@/lib/otp'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { lockGiftCardsForUpdate } from '@/services/giftCards/giftCardLedger'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { reiniciarSellosParaPruebas } from '@/services/giftCards/giftCardPayKey'
import { PRUEBA_DE_TELEFONO_MS, firmarPruebaDeTelefono } from '@/services/giftCards/giftCardProof'
import { lookupGiftCards } from '@/services/giftCards/giftCardLookup.service'
import { cambiarDestinoDeTarjeta } from '@/services/giftCards/giftCardCuenta.service'
import { PROPOSITO_TELEFONO_DE_TARJETA, pedirCodigoDeTelefono, verificarCodigoDeTelefono } from '@/services/giftCards/giftCardPhone.service'
import { requestOtp, verifyOtp } from '@/services/public/otpAuth.public.service'
import { payGiftCardBalanceOnOrder, payGiftCardOnNewOrder } from '@/services/mobile/order.mobile.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { crearNegocioDePrueba, esperarAQueAlguienEspereA, limpiarNegocioDePrueba, pidDe } from './sembrarTarjetasDeRegalo'

jest.setTimeout(90000)

const D = (v: number) => new Prisma.Decimal(v)
const PRESUPUESTO = { timeout: 15_000, maxWait: 5_000 }
const SUF = `tel-${process.pid}-${Date.now()}`
const APARATO = 'caja-telefono-1'
/** Cuánto le queda a la prueba del primer envío en Q91-a y en los reintentos: lo justo para entrar antes de que venza. */
const MARGEN_MS = 5_000
const INVALIDO = { code: 'GIFT_CARD_PHONE_CODE_INVALID', statusCode: 409, message: 'El código no es correcto o ya venció. Pide otro.' }
const PRUEBA_INVALIDA = {
  code: 'GIFT_CARD_PHONE_PROOF_INVALID',
  statusCode: 409,
  message: 'La verificación por teléfono venció. Pide otro código.',
}

let venueId: string
let organizationId: string
let staffId: string
let otroVenueId: string
let n = 0
const fetchOriginal = global.fetch

beforeAll(async () => {
  ;({ organizationId, venueId, staffId } = await crearNegocioDePrueba('telefono'))
  otroVenueId = (await crearNegocioDePrueba('telefono-otro')).venueId
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
  await ensureGiftCardTender(prisma, venueId)
  global.fetch = jest.fn(async () => {
    throw new Error('fetch real prohibido en esta prueba')
  }) as unknown as typeof global.fetch
})

beforeEach(() => {
  reiniciarSellosParaPruebas()
  mockEnviarCodigo.mockReset()
  mockEnviarCodigo.mockResolvedValue(true)
})

afterAll(async () => {
  global.fetch = fetchOriginal
  await limpiarNegocioDePrueba(venueId)
  await limpiarNegocioDePrueba(otroVenueId)
})

/** Un celular de CDMX nuevo (10 dígitos): cada prueba el suyo, así los límites por teléfono no se cruzan. */
function telefonoNuevo(): string {
  n += 1
  return `55${String((Date.now() * 7 + n * 7919) % 100_000_000).padStart(8, '0')}`
}
const e164 = (diez: string) => `+52${diez}`

/** Un sobre ACTIVE con su ACTIVATE, mandado por WhatsApp a `phone` (como se escribió, igual que una fila de la 1a). */
async function tarjeta(
  monto: number,
  p: { phone?: string; canal?: 'WHATSAPP' | 'PRINTED'; status?: 'ACTIVE' | 'BLOCKED' | 'DEACTIVATED' } = {},
) {
  const c = generateGiftCardCode()
  const s = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId,
      codeHash: hashGiftCardCode(c.normalized),
      codeEnc: encryptGiftCardCode(c.normalized),
      codeLast4: c.last4,
      pageToken: generateOpaqueToken(),
      initialAmount: D(monto),
      balance: D(monto),
      status: p.status ?? 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: p.canal ?? 'WHATSAPP',
      recipientPhone: p.phone ?? null,
      recipientName: 'Ana',
      purchaserName: 'Luis',
      deliveryStatus: 'SENT',
    },
  })
  await prisma.giftCardActivity.create({ data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: D(monto), balanceAfter: D(monto) } })
  return { id: s.id, codigo: c.display }
}

async function cuentaDeMercancia(monto: number): Promise<string> {
  n += 1
  return (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${SUF}-o${n}`,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: D(monto),
        taxAmount: D(0),
        total: D(monto),
        remainingBalance: D(monto),
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        items: { create: [{ productName: 'Blusa', quantity: 1, unitPrice: D(monto), taxAmount: D(0), total: D(monto) }] },
      },
    })
  ).id
}

const llaveNueva = (que: string) => `${SUF}-${que}-${(n += 1)}`.slice(-60)
const saldoDe = async (id: string) => (await prisma.giftCard.findUniqueOrThrow({ where: { id } })).balance.toFixed(2)
const retosDe = (destination: string, purpose = PROPOSITO_TELEFONO_DE_TARJETA) =>
  prisma.otpChallenge.findMany({ where: { venueId, destination, purpose }, orderBy: { createdAt: 'asc' }, take: 20 })

/** El código que el doble de WhatsApp «mandó» por última vez a ese teléfono. */
function codigoEnviadoA(destino: string): string {
  const llamada = [...mockEnviarCodigo.mock.calls].reverse().find(c => c[0] === destino)
  if (!llamada) throw new Error(`no salió ningún código a ${destino}`)
  return llamada[1] as string
}
const otroCodigo = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, '0')

async function pedirYVerificar(diez: string, deviceId = APARATO) {
  await pedirCodigoDeTelefono(venueId, { phone: diez, deviceId })
  return verificarCodigoDeTelefono(venueId, { phone: diez, code: codigoEnviadoA(e164(diez)), deviceId })
}

/** Retos sembrados a mano (para los límites): `segundosAtras` de cada uno. Sin `purpose`, el default (inicio de sesión). */
async function sembrarRetos(diez: string, segundosAtras: number[], purpose?: string) {
  for (const s of segundosAtras) {
    await prisma.otpChallenge.create({
      data: {
        venueId,
        channel: 'whatsapp',
        destination: e164(diez),
        codeHash: hashOtpCode('000000'),
        expiresAt: new Date(Date.now() + 10 * 60_000),
        createdAt: new Date(Date.now() - s * 1000),
        ...(purpose ? { purpose } : {}),
      },
    })
  }
}

const cobrar = (orderId: string, llave: string, proofToken: string, giftCardId: string, monto: number, deviceId: string | null = APARATO) =>
  payGiftCardBalanceOnOrder(venueId, orderId, {
    idempotencyKey: llave,
    proof: { kind: 'PHONE_OTP', proofToken, giftCardId },
    amount: D(monto),
    tip: D(0),
    staffId,
    deviceId,
  })

const ventaNueva = (llave: string, proofToken: string, giftCardId: string, monto: number) => ({
  items: [{ name: 'Blusa', quantity: 1, unitPrice: monto * 100 }],
  staffId,
  orderType: 'TAKEOUT' as const,
  source: 'AVOQADO_ANDROID' as const,
  idempotencyKey: llave,
  proof: { kind: 'PHONE_OTP' as const, proofToken, giftCardId },
  amount: D(monto),
  tip: D(0),
  deviceId: APARATO,
  procesadoPor: staffId,
})

async function horaDeLaBase(): Promise<number> {
  const [r] = await prisma.$queryRaw<Array<{ ms: bigint }>>`SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint AS ms`
  return Number(r.ms)
}
/** Q91: se espera a que la BASE (no el reloj de la prueba) diga que la prueba ya venció. */
async function esperarAQueLaBaseDigaQueVencio(expiresAt: Date): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if ((await horaDeLaBase()) > expiresAt.getTime()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('la prueba nunca venció según la base')
}

/** Una prueba que vence en `MARGEN_MS` (firmada como si se hubiera pedido hace casi 15 min). */
const pruebaPorVencer = (diez: string) =>
  firmarPruebaDeTelefono({ venueId, phone: e164(diez), deviceId: APARATO, ahora: new Date(Date.now() - PRUEBA_DE_TELEFONO_MS + MARGEN_MS) })

describe('teléfono + código (1b S5) · Postgres real', () => {
  it('sin tarjetas y con tarjetas la respuesta es la misma; sólo con tarjetas sale el WhatsApp', async () => {
    const sin = telefonoNuevo()
    const con = telefonoNuevo()
    await tarjeta(500, { phone: con })

    const a = await pedirCodigoDeTelefono(venueId, { phone: sin, deviceId: APARATO })
    expect(mockEnviarCodigo).toHaveBeenCalledTimes(0)
    const b = await pedirCodigoDeTelefono(venueId, { phone: con, deviceId: APARATO })
    expect(a).toEqual({ enviado: true })
    expect(b).toEqual(a)
    expect(mockEnviarCodigo).toHaveBeenCalledTimes(1)
    expect(mockEnviarCodigo.mock.calls[0][0]).toBe(e164(con))
    const codigo = codigoEnviadoA(e164(con))
    expect(codigo).toMatch(/^\d{6}$/)

    for (const diez of [sin, con]) {
      const retos = await retosDe(e164(diez))
      expect(retos).toHaveLength(1)
      expect(retos[0]).toMatchObject({ channel: 'whatsapp', consumedAt: null, attempts: 0 })
    }
    // 🔴 En la base, sólo la huella del código.
    const [reto] = await retosDe(e164(con))
    expect(reto.codeHash).toBe(hashOtpCode(codigo))
    expect(JSON.stringify(reto)).not.toContain(codigo)
  })

  it('🔴 el envío no se espera, y su fallo deja un log SIN el código ni el teléfono completo', async () => {
    const diez = telefonoNuevo()
    await tarjeta(300, { phone: diez })
    let fallar!: (e: Error) => void
    mockEnviarCodigo.mockReturnValueOnce(new Promise((_r, rej) => (fallar = rej)))
    ;(logger.warn as jest.Mock).mockClear()

    // El envío sigue «en vuelo» y la respuesta ya salió.
    await expect(pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: APARATO })).resolves.toEqual({ enviado: true })
    const codigo = codigoEnviadoA(e164(diez))
    fallar(new Error('Error al enviar WhatsApp: (#131030) Recipient phone number not in allowed list'))
    await new Promise(resolve => setImmediate(resolve))

    const linea = (logger.warn as jest.Mock).mock.calls.find(c => String(c[0]).includes('no salió el código por WhatsApp'))
    expect(linea).toBeDefined()
    expect(linea![1]).toMatchObject({ venueId, destino: `${diez.slice(0, 2)}•••••${diez.slice(-3)}` })
    expect(JSON.stringify(linea)).not.toContain(codigo)
    expect(JSON.stringify(linea)).not.toContain(diez)
  })

  it('pedir el código de la caja no invalida el de inicio de sesión', async () => {
    const diez = telefonoNuevo()
    await tarjeta(300, { phone: diez })
    await requestOtp({ venueId, channel: 'whatsapp', destination: diez })
    const deLogin = codigoEnviadoA(e164(diez))
    await pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: APARATO })
    expect(mockEnviarCodigo).toHaveBeenCalledTimes(2) // el de inicio de sesión y el de la caja

    const r = await verifyOtp({ venueId, channel: 'whatsapp', destination: diez, code: deLogin })
    expect(r.token).toEqual(expect.any(String))
    // Y el de la caja sigue vivo.
    const [reto] = await retosDe(e164(diez))
    expect(reto.consumedAt).toBeNull()
  })

  it('los códigos de la caja no gastan el límite del inicio de sesión (y al revés)', async () => {
    // Cinco en la última hora, uno de hace 10 s: con cualquiera de los dos conteos del otro propósito, el otro se frenaría.
    const ATRAS = [10, 300, 600, 900, 1200]
    const deLaCaja = telefonoNuevo()
    await sembrarRetos(deLaCaja, ATRAS, PROPOSITO_TELEFONO_DE_TARJETA)
    await expect(requestOtp({ venueId, channel: 'whatsapp', destination: deLaCaja })).resolves.toEqual({ ok: true })

    const deLogin = telefonoNuevo()
    await sembrarRetos(deLogin, ATRAS)
    await expect(pedirCodigoDeTelefono(venueId, { phone: deLogin, deviceId: APARATO })).resolves.toEqual({ enviado: true })
    expect(await retosDe(e164(deLogin))).toHaveLength(1)
    // Y el código nuevo de la caja no dejó sin efecto los del inicio de sesión.
    expect(
      await prisma.otpChallenge.count({ where: { venueId, destination: e164(deLogin), purpose: 'CUSTOMER_LOGIN', consumedAt: null } }),
    ).toBe(5)
  })

  it('el código de inicio de sesión no sirve en la caja y viceversa', async () => {
    const uno = telefonoNuevo()
    await tarjeta(300, { phone: uno })
    await requestOtp({ venueId, channel: 'whatsapp', destination: uno })
    const deLogin = codigoEnviadoA(e164(uno))
    await expect(verificarCodigoDeTelefono(venueId, { phone: uno, code: deLogin, deviceId: APARATO })).rejects.toMatchObject(INVALIDO)

    const dos = telefonoNuevo()
    await tarjeta(300, { phone: dos })
    await pedirCodigoDeTelefono(venueId, { phone: dos, deviceId: APARATO })
    const deLaCaja = codigoEnviadoA(e164(dos))
    await expect(verifyOtp({ venueId, channel: 'whatsapp', destination: dos, code: deLaCaja })).rejects.toMatchObject({
      message: 'El código expiró. Pide uno nuevo.',
    })
    // Ninguno de los dos gastó el reto del otro.
    expect((await retosDe(e164(dos)))[0]).toMatchObject({ consumedAt: null, attempts: 0 })
  })

  it.each([false, true])('30 s y 5 por hora por teléfono, iguales con o sin tarjetas (con tarjetas: %s)', async conTarjetas => {
    const diez = telefonoNuevo()
    if (conTarjetas) await tarjeta(200, { phone: diez })
    await pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: APARATO })
    const otra = await pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: 'otra-caja' }).catch(e => e)
    expect(otra).toMatchObject({
      code: 'GIFT_CARD_PHONE_RATE_LIMITED',
      statusCode: 429,
      message: 'Ya pedimos varios códigos para ese teléfono. Espera unos minutos.',
    })
    expect(otra.details.retryAfter).toBeGreaterThan(0)
    expect(otra.details.retryAfter).toBeLessThanOrEqual(30)

    const lleno = telefonoNuevo()
    if (conTarjetas) await tarjeta(200, { phone: lleno })
    await sembrarRetos(lleno, [40, 600, 1200, 1800, 2400], PROPOSITO_TELEFONO_DE_TARJETA)
    mockEnviarCodigo.mockClear()
    const quinto = await pedirCodigoDeTelefono(venueId, { phone: lleno, deviceId: APARATO }).catch(e => e)
    expect(quinto).toMatchObject({ code: 'GIFT_CARD_PHONE_RATE_LIMITED', statusCode: 429 })
    // El más viejo de los cinco (hace 40 min) libera el lugar en ~20 min.
    expect(quinto.details.retryAfter).toBeGreaterThan(30)
    expect(quinto.details.retryAfter).toBeLessThanOrEqual(1200)
    expect(await retosDe(e164(lleno))).toHaveLength(5)
    expect(mockEnviarCodigo).not.toHaveBeenCalled()
  })

  it('verificar lista sólo las de ese teléfono mandadas por WhatsApp, también con la entrega FAILED', async () => {
    const diez = telefonoNuevo()
    const fallida = await tarjeta(500, { phone: diez })
    await prisma.giftCard.update({
      where: { id: fallida.id },
      data: { deliveryStatus: 'FAILED', deliveryErrorCode: 'WHATSAPP_SEND_FAILED' },
    })
    const bloqueada = await tarjeta(100, { phone: diez, status: 'BLOCKED' })
    await tarjeta(700, { phone: diez, canal: 'PRINTED' })
    await tarjeta(800, { phone: diez, status: 'DEACTIVATED' })
    await tarjeta(900, { phone: telefonoNuevo() })

    const v = await pedirYVerificar(diez)
    expect(v.cards.map(c => c.giftCardId).sort()).toEqual([fallida.id, bloqueada.id].sort())
    expect(v.usableBalance).toBe(500)
    expect(v.hayMas).toBeUndefined()
    expect(Math.abs(new Date(v.expiresAt).getTime() - (Date.now() + PRUEBA_DE_TELEFONO_MS))).toBeLessThan(60_000)
    // La misma forma que `lookup`.
    const porCodigo = await lookupGiftCards(venueId, { code: fallida.codigo }, { deviceId: APARATO })
    expect(v.cards.find(c => c.giftCardId === fallida.id)).toEqual(porCodigo.cards[0])
    expect(v.cards.find(c => c.giftCardId === bloqueada.id)).toMatchObject({ usable: false, notUsableReason: 'BLOCKED' })

    const orderId = await cuentaDeMercancia(300)
    const r = await cobrar(orderId, llaveNueva('lista'), v.proofToken, fallida.id, 300)
    expect(r).toMatchObject({ replay: false, redeemed: [{ giftCardId: fallida.id, amount: 300, balanceAfter: 200 }] })
    expect(await saldoDe(fallida.id)).toBe('200.00')
  })

  it('una prueba de otro teléfono, aparato o venue no cobra', async () => {
    const diez = telefonoNuevo()
    const t = await tarjeta(500, { phone: diez })
    const orderId = await cuentaDeMercancia(100)
    const deOtroAparato = await pedirYVerificar(diez, 'caja-telefono-2')
    const casos: Array<[string, string]> = [
      ['otro teléfono', firmarPruebaDeTelefono({ venueId, phone: e164(telefonoNuevo()), deviceId: APARATO }).proofToken],
      ['otro aparato', deOtroAparato.proofToken],
      ['otro venue', firmarPruebaDeTelefono({ venueId: otroVenueId, phone: e164(diez), deviceId: APARATO }).proofToken],
    ]
    for (const [caso, proofToken] of casos) {
      const e = await cobrar(orderId, llaveNueva('ajena'), proofToken, t.id, 100).catch(err => err)
      expect({ caso, error: { code: e.code, statusCode: e.statusCode, message: e.message } }).toEqual({ caso, error: PRUEBA_INVALIDA })
    }
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
    expect(await saldoDe(t.id)).toBe('500.00')
  })

  it('tras cambiar el destino (S4), la prueba del teléfono viejo ya no cobra', async () => {
    const diez = telefonoNuevo()
    const t = await tarjeta(500, { phone: diez })
    const v = await pedirYVerificar(diez)
    await cambiarDestinoDeTarjeta(
      venueId,
      t.id,
      { staffId, puedeVender: true, puedeGestionar: true },
      { operationKey: llaveNueva('destino'), destino: { deliveryChannel: 'WHATSAPP', recipientPhone: telefonoNuevo() } },
    )
    const orderId = await cuentaDeMercancia(100)
    await expect(cobrar(orderId, llaveNueva('viejo'), v.proofToken, t.id, 100)).rejects.toMatchObject(PRUEBA_INVALIDA)
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(0)
    expect(await saldoDe(t.id)).toBe('500.00')
  })

  it('Q25: el mismo teléfono en tres formas', async () => {
    const diez = telefonoNuevo()
    const t = await tarjeta(500, { phone: diez }) // vendida a '55…' (10 dígitos, como la 1a)
    await pedirCodigoDeTelefono(venueId, { phone: `+521${diez}`, deviceId: APARATO })
    expect(mockEnviarCodigo.mock.calls.map(c => c[0])).toEqual([e164(diez)])
    expect(await retosDe(e164(diez))).toHaveLength(1)
    const v = await verificarCodigoDeTelefono(venueId, { phone: e164(diez), code: codigoEnviadoA(e164(diez)), deviceId: APARATO })
    expect(v.cards.map(c => c.giftCardId)).toEqual([t.id])
    const orderId = await cuentaDeMercancia(200)
    await expect(cobrar(orderId, llaveNueva('q25'), v.proofToken, t.id, 200)).resolves.toMatchObject({ replay: false })
    expect(await saldoDe(t.id)).toBe('300.00')
  })

  it('reintento con la misma llave y la prueba ya vencida devuelve el mismo cobro', async () => {
    const diez = telefonoNuevo()
    const t = await tarjeta(500, { phone: diez })
    const orderId = await cuentaDeMercancia(300)
    const llave = llaveNueva('reintento')
    const { proofToken, expiresAt } = pruebaPorVencer(diez)
    const a = await cobrar(orderId, llave, proofToken, t.id, 200)
    expect(a.replay).toBe(false)

    await esperarAQueLaBaseDigaQueVencio(expiresAt)
    const b = await cobrar(orderId, llave, proofToken, t.id, 200)
    expect(b).toMatchObject({ replay: true, paymentId: a.paymentId, amount: 200 })
    // De veras venció: con otra llave ya no cobra.
    await expect(cobrar(orderId, llaveNueva('vencida'), proofToken, t.id, 50)).rejects.toMatchObject(PRUEBA_INVALIDA)
    expect(await prisma.payment.count({ where: { venueId, orderId } })).toBe(1)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(1)
    expect(await saldoDe(t.id)).toBe('300.00')
  })

  it('PHONE_OTP en pay-new-order (S2b)', async () => {
    const diez = telefonoNuevo()
    const t = await tarjeta(500, { phone: diez })
    const llave = llaveNueva('nueva')
    const { proofToken, expiresAt } = pruebaPorVencer(diez)
    const a = await payGiftCardOnNewOrder(venueId, ventaNueva(llave, proofToken, t.id, 300))
    expect(a).toMatchObject({ replay: false, amount: 300, orderPaymentStatus: 'PAID' })
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: a.orderId } })
    expect(cuenta.externalId).toBe(`giftpay:${llave}`)

    await esperarAQueLaBaseDigaQueVencio(expiresAt)
    const b = await payGiftCardOnNewOrder(venueId, ventaNueva(llave, proofToken, t.id, 300))
    expect(b).toMatchObject({ replay: true, orderId: a.orderId, paymentId: a.paymentId })
    const otra = llaveNueva('nueva-vencida')
    await expect(payGiftCardOnNewOrder(venueId, ventaNueva(otra, proofToken, t.id, 50))).rejects.toMatchObject(PRUEBA_INVALIDA)
    expect(await prisma.order.count({ where: { venueId, externalId: { in: [`giftpay:${llave}`, `giftpay:${otra}`] } } })).toBe(1)
    expect(await saldoDe(t.id)).toBe('200.00')
  })

  /** T sostiene el sobre: el primer envío (el servicio de verdad) queda detenido DENTRO de su transacción, con la llave tomada. */
  const retenerElSobre = (giftCardId: string) => {
    let avisar!: (pid: number) => void
    const pid = new Promise<number>(resolve => (avisar = resolve))
    let soltar!: () => void
    const puedeSoltar = new Promise<void>(resolve => (soltar = resolve))
    const transaccion = prisma.$transaction(async tx => {
      await lockGiftCardsForUpdate(tx, [giftCardId])
      avisar(await pidDe(tx))
      await puedeSoltar
    }, PRESUPUESTO)
    transaccion.catch(() => undefined)
    return { pid, soltar, transaccion }
  }

  it.each(['pay-gift-card', 'pay-new-order'] as const)(
    '🔴 Q91-a: el primer envío sigue dentro de su transacción y el reintento con la prueba vencida lo espera y devuelve su cobro (%s)',
    async ruta => {
      const diez = telefonoNuevo()
      const t = await tarjeta(500, { phone: diez })
      const llave = llaveNueva(`q91a-${ruta}`)
      const { proofToken, expiresAt } = pruebaPorVencer(diez)
      const orderId = ruta === 'pay-gift-card' ? await cuentaDeMercancia(300) : null
      const enviar = () =>
        ruta === 'pay-gift-card'
          ? cobrar(orderId!, llave, proofToken, t.id, 300)
          : payGiftCardOnNewOrder(venueId, ventaNueva(llave, proofToken, t.id, 300))
      const T = retenerElSobre(t.id)
      const enVuelo: Promise<unknown>[] = [T.transaccion]
      try {
        const pidT = await T.pid
        const uno = enviar()
        enVuelo.push(uno.catch(() => undefined))
        const pid1 = await esperarAQueAlguienEspereA(pidT) // (2) ya tomó la llave, leyó su hora y espera el sobre
        expect(await horaDeLaBase()).toBeLessThan(expiresAt.getTime()) // así su hora (leída antes) era vigente
        expect(await prisma.payment.count({ where: { venueId, idempotencyKey: llave } })).toBe(0)

        await esperarAQueLaBaseDigaQueVencio(expiresAt) // (3)
        const dos = enviar()
        enVuelo.push(dos.catch(() => undefined))
        await esperarAQueAlguienEspereA(pid1) // el 2 espera la LLAVE del 1 (sin Q91 ya habría salido con 409)

        T.soltar() // (4) T confirma sin cambios
        const [a, b] = await Promise.all([uno, dos])
        expect(a).toMatchObject({ replay: false, amount: 300 })
        expect(b).toMatchObject({ replay: true, paymentId: a.paymentId, orderId: a.orderId })
        // (5)
        expect(await prisma.payment.count({ where: { venueId, idempotencyKey: llave } })).toBe(1)
        expect(await prisma.giftCardActivity.count({ where: { giftCardId: t.id, type: 'REDEEM' } })).toBe(1)
        expect(await saldoDe(t.id)).toBe('200.00')
        if (ruta === 'pay-new-order') expect(await prisma.order.count({ where: { venueId, externalId: `giftpay:${llave}` } })).toBe(1)
      } finally {
        T.soltar()
        await Promise.allSettled(enVuelo)
      }
    },
    30_000,
  )

  it.each(['pay-gift-card', 'pay-new-order'] as const)(
    '🔴 Q91-b: un rechazo por saldo queda sellado aunque el saldo cambie (%s)',
    async ruta => {
      const diez = telefonoNuevo()
      const t = await tarjeta(400, { phone: diez })
      const { proofToken } = firmarPruebaDeTelefono({ venueId, phone: e164(diez), deviceId: APARATO })
      const cuentaK = ruta === 'pay-gift-card' ? await cuentaDeMercancia(300) : null
      const enviar = async (llave: string, cuenta: string | null) =>
        ruta === 'pay-gift-card'
          ? cobrar(cuenta!, llave, proofToken, t.id, 300)
          : payGiftCardOnNewOrder(venueId, ventaNueva(llave, proofToken, t.id, 300))

      const cobroA = await enviar(llaveNueva('q91b-a'), ruta === 'pay-gift-card' ? await cuentaDeMercancia(300) : null)
      expect(await saldoDe(t.id)).toBe('100.00')

      const K = llaveNueva('q91b-k')
      const primero = await enviar(K, cuentaK).catch(e => e)
      expect(primero).toMatchObject({
        code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
        message: 'Quedan $100.00 en la tarjeta de regalo.',
        details: { saldoDisponible: 100 },
      })

      await issueRefund({ venueId, paymentId: cobroA.paymentId, amount: 30000, reason: 'RETURNED_GOODS', staffId })
      expect(await saldoDe(t.id)).toBe('400.00')

      const repetido = await enviar(K, cuentaK).catch(e => e)
      expect(repetido).toBe(primero) // el MISMO rechazo (code, message y saldoDisponible: 100), aunque ya alcance
      expect(await prisma.payment.count({ where: { venueId, idempotencyKey: K } })).toBe(0)
      expect(await saldoDe(t.id)).toBe('400.00')

      await expect(enviar(llaveNueva('q91b-k2'), cuentaK)).resolves.toMatchObject({ replay: false })
      expect(await saldoDe(t.id)).toBe('100.00')
    },
  )

  it('🔴 dos verify a la vez con el código bueno ⇒ una sola proofToken (CAS de consumo)', async () => {
    const diez = telefonoNuevo()
    await tarjeta(300, { phone: diez })
    await pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: APARATO })
    const codigo = codigoEnviadoA(e164(diez))
    const [reto] = await retosDe(e164(diez))

    // T sostiene la fila del reto: las dos verificaciones ya la LEYERON (sin consumir) y esperan en su primera escritura.
    let avisar!: (pid: number) => void
    const pid = new Promise<number>(resolve => (avisar = resolve))
    let soltar!: () => void
    const puedeSoltar = new Promise<void>(resolve => (soltar = resolve))
    const T = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "OtpChallenge" WHERE "id" = ${reto.id} FOR UPDATE`
      avisar(await pidDe(tx))
      await puedeSoltar
    }, PRESUPUESTO)
    T.catch(() => undefined)
    const enVuelo: Promise<unknown>[] = [T]
    try {
      const pidT = await pid
      const verificar = () => verificarCodigoDeTelefono(venueId, { phone: diez, code: codigo, deviceId: APARATO })
      const uno = verificar()
      enVuelo.push(uno.catch(() => undefined))
      const dos = verificar()
      enVuelo.push(dos.catch(() => undefined))
      await esperarAQueEsperen(pidT, 2)
      soltar()
      const r = await Promise.allSettled([uno, dos])
      const bien = r.filter(x => x.status === 'fulfilled')
      const mal = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected')
      expect(bien).toHaveLength(1)
      expect(mal).toHaveLength(1)
      expect(mal[0].reason).toMatchObject(INVALIDO)
      const despues = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: reto.id } })
      expect(despues.consumedAt).not.toBeNull()
      expect(despues.attempts).toBe(2)
    } finally {
      soltar()
      await Promise.allSettled(enVuelo)
    }
  })

  it('🔴 seis verify a la vez con códigos malos ⇒ sólo cinco prueban su código (CAS de intentos)', async () => {
    const diez = telefonoNuevo()
    await tarjeta(300, { phone: diez })
    await pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: APARATO })
    const codigo = codigoEnviadoA(e164(diez))
    const [reto] = await retosDe(e164(diez))
    expect(reto.maxAttempts).toBe(5)

    // T sostiene la fila del reto: las seis ya LEYERON `attempts: 0` (según su lectura, todas tienen lugar) y esperan en la
    // escritura de su intento. Al soltar, sólo la condición de la BASE (`attempts < maxAttempts`) puede frenar a la sexta: un
    // «leer y luego sumar» dejaría probar seis códigos. `attempts` cuenta los códigos que se compararon.
    let avisar!: (pid: number) => void
    const pid = new Promise<number>(resolve => (avisar = resolve))
    let soltar!: () => void
    const puedeSoltar = new Promise<void>(resolve => (soltar = resolve))
    const T = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "OtpChallenge" WHERE "id" = ${reto.id} FOR UPDATE`
      avisar(await pidDe(tx))
      await puedeSoltar
    }, PRESUPUESTO)
    T.catch(() => undefined)
    const enVuelo: Promise<unknown>[] = [T]
    try {
      const pidT = await pid
      const malas = Array.from({ length: 6 }, (_, i) =>
        verificarCodigoDeTelefono(venueId, {
          phone: diez,
          code: String((Number(codigo) + i + 1) % 1_000_000).padStart(6, '0'),
          deviceId: APARATO,
        }),
      )
      enVuelo.push(...malas.map(m => m.catch(() => undefined)))
      await esperarAQueEsperen(pidT, 6)
      soltar()
      const r = await Promise.allSettled(malas)
      expect(r.map(x => (x.status === 'rejected' ? x.reason.code : 'PASÓ'))).toEqual(Array(6).fill(INVALIDO.code))
      expect(await prisma.otpChallenge.findUniqueOrThrow({ where: { id: reto.id } })).toMatchObject({ attempts: 5, consumedAt: null })

      // Agotado: ni el código bueno entra, y no aparta otro intento.
      await expect(verificarCodigoDeTelefono(venueId, { phone: diez, code: codigo, deviceId: APARATO })).rejects.toMatchObject(INVALIDO)
      expect(await prisma.otpChallenge.findUniqueOrThrow({ where: { id: reto.id } })).toMatchObject({ attempts: 5, consumedAt: null })
    } finally {
      soltar()
      await Promise.allSettled(enVuelo)
    }
  })

  it.each(['sin reto', 'vencido', 'ya usado', 'sin intentos', 'código distinto'] as const)(
    'verify ⇒ 409 GIFT_CARD_PHONE_CODE_INVALID (%s)',
    async caso => {
      const diez = telefonoNuevo()
      await tarjeta(300, { phone: diez })
      const verificar = (code: string) => verificarCodigoDeTelefono(venueId, { phone: diez, code, deviceId: APARATO })
      let codigo = '123456'
      if (caso !== 'sin reto') {
        await pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: APARATO })
        codigo = codigoEnviadoA(e164(diez))
      }
      if (caso === 'vencido') {
        await prisma.otpChallenge.updateMany({
          where: { venueId, destination: e164(diez) },
          data: { expiresAt: new Date(Date.now() - 1000) },
        })
      }
      if (caso === 'ya usado') await expect(verificar(codigo)).resolves.toMatchObject({ proofToken: expect.any(String) })
      if (caso === 'sin intentos') {
        for (let i = 0; i < 5; i++) await expect(verificar(otroCodigo(codigo))).rejects.toMatchObject(INVALIDO)
      }
      if (caso === 'código distinto') codigo = otroCodigo(codigo)

      await expect(verificar(codigo)).rejects.toMatchObject(INVALIDO)
      if (caso === 'sin intentos') {
        // CAS de intentos: el sexto, aunque traiga el código bueno, no aparta lugar ni consume el reto.
        const [reto] = await retosDe(e164(diez))
        expect(reto).toMatchObject({ attempts: 5, consumedAt: null })
      }
    },
  )

  it('🔴 m1: dos «pedir código» a la vez al mismo teléfono ⇒ uno responde y el otro 429; un solo reto vivo y un solo WhatsApp', async () => {
    const diez = telefonoNuevo()
    await tarjeta(300, { phone: diez })
    // Un reto viejo de la caja, SIN consumir y de hace 2 h (no cuenta para los límites), que T sostiene: cada pedido se detiene al
    // invalidarlo. Sin candado, los dos ya contaron cero retos recientes y, al soltar, cada uno crea el suyo y manda su WhatsApp
    // (y el primero que llega puede no servir). Con el candado por (venue, teléfono), el segundo espera al primero ANTES de
    // contar y ve su reto.
    await sembrarRetos(diez, [2 * 3600], PROPOSITO_TELEFONO_DE_TARJETA)
    const [viejo] = await retosDe(e164(diez))

    let avisar!: (pid: number) => void
    const pid = new Promise<number>(resolve => (avisar = resolve))
    let soltar!: () => void
    const puedeSoltar = new Promise<void>(resolve => (soltar = resolve))
    const T = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "OtpChallenge" WHERE "id" = ${viejo.id} FOR UPDATE`
      avisar(await pidDe(tx))
      await puedeSoltar
    }, PRESUPUESTO)
    T.catch(() => undefined)
    const enVuelo: Promise<unknown>[] = [T]
    try {
      const pidT = await pid
      const uno = pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: APARATO })
      enVuelo.push(uno.catch(() => undefined))
      const dos = pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: 'otra-caja' })
      enVuelo.push(dos.catch(() => undefined))
      await esperarAQueEsperen(pidT, 2)
      soltar()
      const r = await Promise.allSettled([uno, dos])

      expect(r.filter((x): x is PromiseFulfilledResult<{ enviado: true }> => x.status === 'fulfilled').map(x => x.value)).toEqual([
        { enviado: true },
      ])
      const frenados = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map(x => x.reason)
      expect(frenados).toHaveLength(1)
      expect(frenados[0]).toMatchObject({
        code: 'GIFT_CARD_PHONE_RATE_LIMITED',
        statusCode: 429,
        message: 'Ya pedimos varios códigos para ese teléfono. Espera unos minutos.',
      })
      expect(frenados[0].details.retryAfter).toBeGreaterThan(0)
      expect(frenados[0].details.retryAfter).toBeLessThanOrEqual(30)

      // Un solo reto vivo, un solo WhatsApp, y el código que llegó es el que sirve.
      const vivos = (await retosDe(e164(diez))).filter(x => x.consumedAt === null)
      expect(vivos).toHaveLength(1)
      expect(mockEnviarCodigo).toHaveBeenCalledTimes(1)
      const codigo = codigoEnviadoA(e164(diez))
      expect(vivos[0].codeHash).toBe(hashOtpCode(codigo))
      await expect(verificarCodigoDeTelefono(venueId, { phone: diez, code: codigo, deviceId: APARATO })).resolves.toMatchObject({
        proofToken: expect.any(String),
      })
    } finally {
      soltar()
      await Promise.allSettled(enVuelo)
    }
  })

  it.each(['faltan las llaves', 'la lista de tarjetas no contesta'] as const)(
    '🔴 m2: si falla lo que va antes de entregar la prueba (%s), el código bueno NO se quema: el mismo sirve al reintentar',
    async caso => {
      const diez = telefonoNuevo()
      await tarjeta(300, { phone: diez })
      await pedirCodigoDeTelefono(venueId, { phone: diez, deviceId: APARATO })
      const codigo = codigoEnviadoA(e164(diez))
      const verificar = () => verificarCodigoDeTelefono(venueId, { phone: diez, code: codigo, deviceId: APARATO })

      if (caso === 'faltan las llaves') {
        const llave = process.env.GIFT_CARD_HMAC_KEY
        delete process.env.GIFT_CARD_HMAC_KEY
        try {
          await expect(verificar()).rejects.toMatchObject({ code: 'GIFT_CARD_KEYS_MISSING' })
        } finally {
          process.env.GIFT_CARD_HMAC_KEY = llave
        }
      } else {
        // La única consulta en crudo de `verify` es la lista de tarjetas del teléfono.
        const espia = jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('la base no contestó'))
        try {
          await expect(verificar()).rejects.toThrow('la base no contestó')
        } finally {
          espia.mockRestore()
        }
      }
      expect((await retosDe(e164(diez)))[0].consumedAt).toBeNull()

      // Ya con todo bien, el MISMO código entrega la prueba y la lista (y ahora sí consume el reto).
      const r = await verificar()
      expect(r.proofToken).toEqual(expect.any(String))
      expect(r.cards).toHaveLength(1)
      expect((await retosDe(e164(diez)))[0].consumedAt).not.toBeNull()
    },
  )
})

/**
 * Espera a que `cuantas` sesiones estén detenidas detrás de `pidQueTiene` (~5 s): esperándolo a él o a quien lo espera (en un
 * candado de fila, la segunda en la fila espera a la primera, no al dueño).
 */
async function esperarAQueEsperen(pidQueTiene: number, cuantas: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [fila] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      WITH primeros AS (
        SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${pidQueTiene}::int = ANY(pg_blocking_pids(pid))
      )
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND (${pidQueTiene}::int = ANY(pg_blocking_pids(pid)) OR pg_blocking_pids(pid) && ARRAY(SELECT pid FROM primeros))`
    if (Number(fila.n) >= cuantas) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`No llegaron ${cuantas} sesiones a esperar el candado que sostiene el proceso ${pidQueTiene}`)
}
