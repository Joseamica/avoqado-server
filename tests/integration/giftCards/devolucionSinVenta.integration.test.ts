/**
 * Pendientes de tarjetas 1a · Task 3 · la devolución SIN venta (`POST /mobile/venues/:venueId/refunds`) contra Postgres real.
 *
 * En un negocio que ya COBRÓ alguna tarjeta la devolución sin venta se rechaza (409 GIFT_CARD_UNLINKED_REFUND_BLOCKED): es una
 * medida de trazabilidad para que el saldo de una tarjeta no pueda convertirse en efectivo (Ley Fintech, art. 24 fr. II). La
 * condición es «alguna tarjeta activada alguna vez», NO el switch de la función (Review Focus 4) ni «existe alguna fila»: una
 * cuenta de tarjetas creada y nunca pagada (sobres PENDING) no bloquea (Codex r1 #5).
 *
 * Correr: source ../urls-tarjetas.sh && export TEST_DATABASE_URL="${TEST_DATABASE_URL%/*}/avoqado_tarjetas_test_20261017" && \
 *   TZ=UTC npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/giftCards/devolucionSinVenta.integration.test.ts
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import prisma from '@/utils/prismaClient'
import { createRefund } from '@/services/mobile/refund.mobile.service'
import { assertGiftCardsSellable } from '@/services/giftCards/giftCardSettings.service'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import {
  crearNegocioDePrueba,
  limpiarNegocioDePrueba,
  sembrarVentaDeTarjetas,
  sembrarVentaDeTarjetasSinPagar,
} from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

const TEXTO_409 =
  'En un negocio que vende tarjetas de regalo, la devolución se hace desde su venta, para que el saldo de una tarjeta nunca se devuelva en efectivo.'

describe('Task 3 · la devolución sin venta en negocios con tarjetas', () => {
  const negocios: string[] = []

  // Negocio propio con nombre único por prueba (la libreta es de sólo inserción: ver la cabecera de la siembra).
  const nuevoNegocio = async (prefijo: string) => {
    const n = await crearNegocioDePrueba(prefijo)
    negocios.push(n.venueId)
    return n
  }

  afterAll(async () => {
    for (const venueId of negocios) await limpiarNegocioDePrueba(venueId)
  })

  /** Lo que una devolución sin venta escribe: la orden testigo, el pago REFUND y su VenueTransaction. */
  const escrituras = async (venueId: string) => ({
    ordenes: await prisma.order.count({ where: { venueId } }),
    pagos: await prisma.payment.count({ where: { venueId } }),
    transacciones: await prisma.venueTransaction.count({ where: { venueId } }),
  })

  const devolverSinVenta = (venueId: string, staffId: string) =>
    createRefund({ venueId, amount: 5000, reason: 'Producto defectuoso', method: 'CASH', staffId })

  it('🔴 con tarjetas en el negocio, la devolución sin venta responde 409 GIFT_CARD_UNLINKED_REFUND_BLOCKED y no escribe Order, Payment ni VenueTransaction', async () => {
    const { venueId, staffId, organizationId } = await nuevoNegocio('t3-bloquea')
    // La función ENCENDIDA y una tarjeta cobrada (activada) en efectivo.
    await prisma.giftCardSettings.create({ data: { venueId, enabled: true } })
    await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [100], metodo: 'CASH' })
    const antes = await escrituras(venueId)

    const error = await devolverSinVenta(venueId, staffId).catch(e => e)

    expect(error).toBeInstanceOf(GiftCardError)
    expect(error.code).toBe('GIFT_CARD_UNLINKED_REFUND_BLOCKED')
    expect(error.statusCode).toBe(409)
    expect(error.message).toBe(TEXTO_409)
    expect(await escrituras(venueId)).toEqual(antes)
  })

  it('🔴 también con la función APAGADA si ya cobró tarjetas (saldos vivos)', async () => {
    const { venueId, staffId, organizationId } = await nuevoNegocio('t3-apagada')
    await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [100], metodo: 'CASH' })
    // La apagó después de cobrar: los saldos siguen vivos aunque ya no pueda vender.
    await prisma.giftCardSettings.create({ data: { venueId, enabled: false } })
    await expect(assertGiftCardsSellable(venueId)).rejects.toMatchObject({ code: 'GIFT_CARDS_DISABLED' })
    const antes = await escrituras(venueId)

    const error = await devolverSinVenta(venueId, staffId).catch(e => e)

    expect(error).toBeInstanceOf(GiftCardError)
    expect(error.code).toBe('GIFT_CARD_UNLINKED_REFUND_BLOCKED')
    expect(error.statusCode).toBe(409)
    expect(await escrituras(venueId)).toEqual(antes)
  })

  it('🔴 una cuenta de tarjetas creada y nunca pagada (sobre PENDING) NO bloquea: 201', async () => {
    const { venueId, staffId, organizationId } = await nuevoNegocio('t3-pendiente')
    const { giftCardIds } = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [100] })
    // El sobre existe pero nunca se activó: no hay saldo que convertir en efectivo.
    const sobre = await prisma.giftCard.findUniqueOrThrow({ where: { id: giftCardIds[0] }, select: { status: true, activatedAt: true } })
    expect(sobre).toEqual({ status: 'PENDING', activatedAt: null })
    const antes = await escrituras(venueId)

    const resultado = await devolverSinVenta(venueId, staffId)

    expect(resultado.amount).toBe(5000)
    const despues = await escrituras(venueId)
    expect(despues).toEqual({ ordenes: antes.ordenes + 1, pagos: antes.pagos + 1, transacciones: antes.transacciones + 1 })
  })

  it('un negocio sin tarjetas sigue igual: 201 y su Payment REFUND', async () => {
    const { venueId, staffId } = await nuevoNegocio('t3-sin-tarjetas')

    const resultado = await devolverSinVenta(venueId, staffId)

    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: resultado.refundId } })
    expect(pago.type).toBe('REFUND')
    expect(pago.status).toBe('COMPLETED')
    expect(pago.amount.toNumber()).toBe(-50)
    expect(await prisma.venueTransaction.count({ where: { venueId, paymentId: pago.id, type: 'REFUND' } })).toBe(1)
  })
})
