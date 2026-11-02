/**
 * S8a contra Postgres REAL (spec 2026-10-30-saldo-a-favor §5.2): lo que el doble de la prueba unitaria no puede probar.
 *  - El predicado del saldo a favor (EXISTS en SQL) frena reenviar y mostrar el código de un sobre de saldo, y no a una tarjeta regalada.
 *  - Cambiar el teléfono: un código pedido con el número viejo ya no verifica, una prueba firmada con el viejo ya no COBRA (el cobro de
 *    verdad, `payGiftCardOnNewOrder`), y el número nuevo pide, verifica y cobra.
 *  - El resumen: el `NOT` con dos condiciones y el `refundPaymentId` nulo en Postgres dejan el saldo a favor fuera de «vendidas» y de
 *    «ajustes», en su propia línea.
 *
 * 🔴 Nada sale a nadie: `sendOtpWhatsApp` es un doble que recuerda a quién y qué código, y `fetch` truena si algo intentara salir.
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "telefonoYReporteDelSaldo" --ci
 *
 * La libreta no se puede borrar (trigger): la base es desechable; el negocio es propio y sólo se limpian sus órdenes al final.
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
import cuid from 'cuid'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { hashOtpCode } from '@/lib/otp'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { abonarSaldoAFavorEnTx, operarSobreDeGerenteEnTx, prepararSobreDeSaldoAFavorEnTx } from '@/services/giftCards/giftCardLedger'
import {
  cambiarTelefonoDeSaldoAFavor,
  reenviarTarjeta,
  revelarCodigo,
  type QuienPregunta,
} from '@/services/giftCards/giftCardCuenta.service'
import { PROPOSITO_TELEFONO_DE_TARJETA, pedirCodigoDeTelefono, verificarCodigoDeTelefono } from '@/services/giftCards/giftCardPhone.service'
import { getGiftCardDetail, getGiftCardSummary, listGiftCards } from '@/services/giftCards/giftCardReports.service'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { reiniciarSellosParaPruebas } from '@/services/giftCards/giftCardPayKey'
import { payGiftCardOnNewOrder } from '@/services/mobile/order.mobile.service'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

jest.setTimeout(90000)

const D = (v: number) => new Prisma.Decimal(v)
const SUF = `s8a-${process.pid}-${Date.now()}`
const APARATO = 'caja-s8a-1'
const VIEJO = '+525512340081'
const NUEVO = '+525598760082'
const fetchOriginal = global.fetch

let venueId: string
let organizationId: string
let staffId: string
let gerente: QuienPregunta
let saldoId: string
let regaladaId: string
let anaId: string
let n = 0

const llave = (que: string) => `${SUF}-${que}-${(n += 1)}`.slice(-60)
const saldoDe = async (id: string) => (await prisma.giftCard.findUniqueOrThrow({ where: { id } })).balance.toFixed(2)
const codigoMandadoA = (telefono: string): string => {
  const llamadas = mockEnviarCodigo.mock.calls.filter(([destino]) => destino === telefono)
  if (llamadas.length === 0) throw new Error(`No salió ningún código por WhatsApp a ${telefono}`)
  return llamadas[llamadas.length - 1][1]
}
const ventaNueva = (proofToken: string, monto: number) => ({
  items: [{ name: 'Blusa', quantity: 1, unitPrice: monto * 100 }],
  staffId,
  orderType: 'TAKEOUT' as const,
  source: 'AVOQADO_ANDROID' as const,
  idempotencyKey: llave('venta'),
  proof: { kind: 'PHONE_OTP' as const, proofToken, giftCardId: saldoId },
  amount: D(monto),
  tip: D(0),
  deviceId: APARATO,
  procesadoPor: staffId,
})

const abonar = (customerId: string, monto: number, tipo: 'CAMBIO' | 'REEMBOLSO') =>
  prisma.$transaction(async tx => {
    const preparado = await prepararSobreDeSaldoAFavorEnTx(tx, { venueId, customerId })
    return abonarSaldoAFavorEnTx(tx, {
      preparado,
      monto: D(monto),
      staffId,
      origen: { orderId: cuid(), refundPaymentId: cuid() },
      folio: `F-${monto}`,
      tipo,
    })
  })

beforeAll(async () => {
  ;({ organizationId, venueId, staffId } = await crearNegocioDePrueba('s8a-telefono'))
  gerente = { staffId, puedeVender: true, puedeGestionar: true }
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000] } })
  await ensureGiftCardTender(prisma, venueId)
  global.fetch = jest.fn(async () => {
    throw new Error('fetch real prohibido en esta prueba')
  }) as unknown as typeof global.fetch

  // Una tarjeta REGALADA vendida hoy ($1,000): su ACTIVATE no trae refundPaymentId.
  const c = generateGiftCardCode()
  regaladaId = (
    await prisma.giftCard.create({
      data: {
        venueId,
        organizationId,
        codeHash: hashGiftCardCode(c.normalized),
        codeEnc: encryptGiftCardCode(c.normalized),
        codeLast4: c.last4,
        pageToken: generateOpaqueToken(),
        initialAmount: D(1000),
        balance: D(1000),
        status: 'ACTIVE',
        activatedAt: new Date(),
        termsVersion: '2026-10-14',
        deliveryChannel: 'WHATSAPP',
        recipientPhone: '+525511110083',
        deliveryStatus: 'SENT',
      },
    })
  ).id
  await prisma.giftCardActivity.create({
    data: { giftCardId: regaladaId, venueId, type: 'ACTIVATE', amount: D(1000), balanceAfter: D(1000), orderId: cuid() },
  })

  // El saldo a favor de Ana: nace con un Cambio ($300), se recarga con un Reembolso ($150) y un gerente lo ajusta (+$40, es ajuste).
  const ana = await prisma.customer.create({ data: { venueId, firstName: 'Ana', lastName: 'López', phone: '55 1234 0081' } })
  anaId = ana.id
  saldoId = (await abonar(ana.id, 300, 'CAMBIO')).giftCardId
  await abonar(ana.id, 150, 'REEMBOLSO')
  // La regalada queda guardada en la cartera de Ana: también tiene cliente y NO es saldo a favor.
  await prisma.giftCard.update({ where: { id: regaladaId }, data: { customerId: ana.id } })
  await prisma.$transaction(tx =>
    operarSobreDeGerenteEnTx(tx, {
      venueId,
      giftCardId: saldoId,
      staffId,
      operationKey: llave('ajuste'),
      op: { tipo: 'AJUSTE', direccion: 'INCREMENT', amount: D(40), reason: 'CASHIER_ERROR', note: 'faltó cargar' },
    }),
  )
})

beforeEach(() => {
  reiniciarSellosParaPruebas()
  mockEnviarCodigo.mockReset()
  mockEnviarCodigo.mockResolvedValue(true)
})

afterAll(async () => {
  global.fetch = fetchOriginal
  await limpiarNegocioDePrueba(venueId)
})

describe('S8a · saldo a favor contra Postgres', () => {
  it('el resumen de hoy: la regalada en «vendidas», el saldo a favor en su línea y el ajuste de gerente en «ajustes»', async () => {
    const { timezone } = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
    const hoy = formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd')
    const r = await getGiftCardSummary(venueId, { from: hoy, to: hoy })
    expect(r.sold).toEqual({ cards: 1, amount: 1000 })
    expect(r.storeCredit).toEqual({ cards: 1, movements: 2, amount: 450 })
    expect(r.adjustments).toEqual({ increments: 40, decrements: 0, net: 40 })
    // Lo que se debe hoy sí incluye el saldo a favor: el negocio se lo debe a la clienta.
    expect(r.liveBalance).toMatchObject({ cards: 2, amount: 1490 })
  })

  it('el detalle y la lista del panel dicen cuál es saldo a favor (con su clienta); la regalada guardada no', async () => {
    const ana = { customerId: anaId, customerName: 'Ana López' }
    expect((await getGiftCardDetail(venueId, saldoId, {})).storeCredit).toEqual(ana)
    expect((await getGiftCardDetail(venueId, regaladaId, {})).storeCredit).toBeNull()
    const pagina = await listGiftCards(venueId, {})
    expect(Object.fromEntries(pagina.items.map(i => [i.id, i.storeCredit]))).toEqual({ [saldoId]: ana, [regaladaId]: null })
  })

  it('el predicado frena reenviar y mostrar el código del sobre de saldo; la regalada no se frena', async () => {
    const auditoria = { staffId, ruta: 'POST /prueba' }
    const NO_ELEGIBLE = { code: 'STORE_CREDIT_CARD_NOT_ELIGIBLE', statusCode: 409 }
    await expect(reenviarTarjeta(venueId, saldoId, gerente, { operationKey: llave('reenvia') })).rejects.toMatchObject(NO_ELEGIBLE)
    await expect(
      revelarCodigo(venueId, saldoId, gerente, { operationKey: llave('revela'), motivo: 'SHOW_QR', comoGerente: true, auditoria }),
    ).rejects.toMatchObject(NO_ELEGIBLE)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: saldoId, action: 'GIFT_CARD_CODE_REVEALED' } })).toBe(0)
    expect(
      await prisma.giftCard.findUniqueOrThrow({ where: { id: saldoId }, select: { deliveryStatus: true, deliveryOperationKey: true } }),
    ).toEqual({ deliveryStatus: 'SENT', deliveryOperationKey: null })

    await expect(
      revelarCodigo(venueId, regaladaId, gerente, { operationKey: llave('revela'), motivo: 'SHOW_QR', comoGerente: true, auditoria }),
    ).resolves.toMatchObject({ ultimos4: expect.any(String) })
  })

  it('🔴 cambiar el teléfono: el código y la prueba del viejo ya no sirven; el nuevo pide, verifica y cobra', async () => {
    // Antes del cambio: una prueba firmada con el viejo (pedir + verificar de verdad) y otro código vivo del viejo, sin usar.
    await pedirCodigoDeTelefono(venueId, { phone: VIEJO, deviceId: APARATO })
    const viejo = await verificarCodigoDeTelefono(venueId, { phone: VIEJO, code: codigoMandadoA(VIEJO), deviceId: APARATO })
    expect(viejo.cards.map(c => c.giftCardId)).toEqual([saldoId])
    await prisma.otpChallenge.create({
      data: {
        venueId,
        destination: VIEJO,
        channel: 'whatsapp',
        purpose: PROPOSITO_TELEFONO_DE_TARJETA,
        codeHash: hashOtpCode('246810'),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    })
    mockEnviarCodigo.mockClear()

    // Comparar y cambiar: con un esperado que ya no es el actual, nada cambia (409); con el bueno, cambia.
    await expect(
      cambiarTelefonoDeSaldoAFavor(venueId, saldoId, { telefono: '55 9876 0082', staffId, expectedPhoneLast4: '9999' }),
    ).rejects.toMatchObject({ code: 'STORE_CREDIT_PHONE_OUTDATED', statusCode: 409, details: { phoneLast4: '0081' } })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: saldoId } })).recipientPhone).toBe(VIEJO)
    const cambio = { telefono: '55 9876 0082', staffId, expectedPhoneLast4: '0081', ipAddress: '10.0.0.7', userAgent: 'panel' }
    await expect(cambiarTelefonoDeSaldoAFavor(venueId, saldoId, cambio)).resolves.toEqual({ phoneLast4: '0082' })
    // La MISMA petición repetida: éxito, sin otra bitácora (se revisa abajo: una sola).
    await expect(cambiarTelefonoDeSaldoAFavor(venueId, saldoId, cambio)).resolves.toEqual({ phoneLast4: '0082' })
    // Sin mandar nada y sin tocar la entrega; la bitácora quedó con los teléfonos enmascarados.
    expect(mockEnviarCodigo).not.toHaveBeenCalled()
    expect(
      await prisma.giftCard.findUniqueOrThrow({ where: { id: saldoId }, select: { recipientPhone: true, deliveryStatus: true } }),
    ).toEqual({ recipientPhone: NUEVO, deliveryStatus: 'SENT' })
    const bitacora = await prisma.activityLog.findMany({ where: { venueId, entityId: saldoId, action: 'STORE_CREDIT_PHONE_CHANGED' } })
    expect(bitacora).toHaveLength(1)
    expect(bitacora[0]).toMatchObject({
      staffId,
      ipAddress: '10.0.0.7',
      userAgent: 'panel',
      data: { telefonoAnterior: '55•••••081', telefonoNuevo: '55•••••082' },
    })

    // El código pedido con el viejo ya no verifica.
    await expect(verificarCodigoDeTelefono(venueId, { phone: VIEJO, code: '246810', deviceId: APARATO })).rejects.toMatchObject({
      code: 'GIFT_CARD_PHONE_CODE_INVALID',
    })
    // La prueba firmada con el viejo ya no cobra (el saldo no se mueve).
    await expect(payGiftCardOnNewOrder(venueId, ventaNueva(viejo.proofToken, 50))).rejects.toMatchObject({
      code: 'GIFT_CARD_PHONE_PROOF_INVALID',
    })
    expect(await saldoDe(saldoId)).toBe('490.00')

    // El nuevo pide, verifica y cobra.
    await pedirCodigoDeTelefono(venueId, { phone: '5598760082', deviceId: APARATO })
    const nuevo = await verificarCodigoDeTelefono(venueId, { phone: '5598760082', code: codigoMandadoA(NUEVO), deviceId: APARATO })
    expect(nuevo.cards).toEqual([expect.objectContaining({ giftCardId: saldoId, usable: true })])
    await expect(payGiftCardOnNewOrder(venueId, ventaNueva(nuevo.proofToken, 50))).resolves.toMatchObject({
      amount: 50,
      orderPaymentStatus: 'PAID',
    })
    expect(await saldoDe(saldoId)).toBe('440.00')
  })
})
