/**
 * La cuenta de tarjetas contra Postgres REAL (Tarea A5): nace con sus sobres PENDING sin encender la marca de IVA mixto,
 * deduplica por llave, no admite descuentos aunque los pida una app vieja, y cancelarla sin cobrar desactiva sus sobres.
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/cuentaDeTarjetas.integration.test.ts --ci --runInBand
 *
 * El plan (`GIFT_CARDS`) lo registra C2: aquí `venueHasFeatureAccess` se fija en `true`. La libreta no se borra (trigger):
 * la base es desechable y este archivo no limpia.
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createGiftCardOrder } from '@/services/giftCards/giftCardOrder.service'
import {
  applyOrderDiscount,
  cancelOrder,
  createOrderWithItems,
  getOrder,
  listOrders,
  payGiftCardBalanceOnOrder,
  returnGiftBalanceAndCancelOrder,
} from '@/services/mobile/order.mobile.service'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { leerSiEsCuentaDeTarjetas } from '@/services/giftCards/giftCardMarks'
import { deleteOrder, updateOrder } from '@/services/dashboard/order.dashboard.service'
import { limpiarNegocioDePrueba } from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

const SUF = `cuenta-${process.pid}-${Date.now()}`
let orgId: string
let venueId: string
let staffId: string

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: SUF, email: `${SUF}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: SUF, slug: SUF } })).id
  staffId = (await prisma.staff.create({ data: { email: `${SUF}@staff.test`, firstName: 'Caja', lastName: 'QA', active: true } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER', active: true } })
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
})

// Cierre (punto 16): sus órdenes no se quedan en la base desechable para el barrido de otras suites.
afterAll(async () => {
  await limpiarNegocioDePrueba(venueId)
})

const venta = (llave: string, montos: number[]) =>
  createGiftCardOrder(venueId, staffId, {
    idempotencyKey: llave,
    purchaserName: 'Ana',
    sobres: montos.map(amount => ({ amount, deliveryChannel: 'PRINTED' as const })),
  })

describe('cuenta de tarjetas · Postgres real', () => {
  it('nace con un sobre PENDING por tarjeta, líneas NO_OBJETO sin producto, y NO enciende la marca de IVA mixto', async () => {
    const r = await venta(`${SUF}-a`, [500, 1000])
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId }, include: { items: { include: { giftCard: true } } } })
    expect(cuenta.total.toFixed(2)).toBe('1500.00')
    expect(
      cuenta.items.map(i => [i.productId, i.ivaTratamiento, i.taxAmount.toFixed(2), i.giftCard?.status, i.giftCard?.balance.toFixed(2)]),
    ).toEqual([
      [null, 'NO_OBJETO', '0.00', 'PENDING', '0.00'],
      [null, 'NO_OBJETO', '0.00', 'PENDING', '0.00'],
    ])
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).ivaMixtoAlgunaVez).toBe(false)
  })

  it('la misma llave devuelve la misma cuenta y los mismos códigos; con otro contenido, IDEMPOTENCY_KEY_REUSED', async () => {
    const a = await venta(`${SUF}-b`, [700])
    const b = await venta(`${SUF}-b`, [700])
    expect(b).toMatchObject({ replay: true, orderId: a.orderId })
    expect(b.sobres.map(s => s.codigo)).toEqual(a.sobres.map(s => s.codigo))
    await expect(venta(`${SUF}-b`, [800])).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(await prisma.giftCard.count({ where: { venueId, initialAmount: 700 } })).toBe(1)
  })

  it('🔴 no admite descuentos (lo pida quien lo pida): GIFT_CARD_ORDER_IMMUTABLE y la cuenta no cambia', async () => {
    const r = await venta(`${SUF}-c`, [500])
    await expect(applyOrderDiscount(venueId, r.orderId, 'cualquier-descuento', staffId)).rejects.toMatchObject({
      code: 'GIFT_CARD_ORDER_IMMUTABLE',
      statusCode: 409,
    })
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
    expect(cuenta.discountAmount.toFixed(2)).toBe('0.00')
    expect(cuenta.total.toFixed(2)).toBe('500.00')
  })

  it('cancelarla sin cobrar deja sus sobres DEACTIVATED (nunca activados) con su DEACTIVATE', async () => {
    const r = await venta(`${SUF}-d`, [500, 600])
    await cancelOrder(venueId, r.orderId, 'El cliente ya no la quiso', staffId)
    const sobres = await prisma.giftCard.findMany({ where: { venueId, id: { in: r.sobres.map(s => s.id) } }, take: 5 })
    expect(sobres.map(s => [s.status, s.activatedAt])).toEqual([
      ['DEACTIVATED', null],
      ['DEACTIVATED', null],
    ])
    const filas = await prisma.giftCardActivity.findMany({ where: { venueId, giftCardId: { in: r.sobres.map(s => s.id) } }, take: 5 })
    expect(filas.map(f => [f.type, f.reason, f.amount.toFixed(2)])).toEqual([
      ['DEACTIVATE', 'SALE_CANCELLED', '0.00'],
      ['DEACTIVATE', 'SALE_CANCELLED', '0.00'],
    ])

    // A5 r1: el reintento de la MISMA venta después de cancelarla dice que está cancelada y que sus sobres no sirven.
    const reintento = await venta(`${SUF}-d`, [500, 600])
    expect(reintento).toMatchObject({ replay: true, orderId: r.orderId, status: 'CANCELLED' })
    expect(reintento.sobres.map(s => s.status)).toEqual(['DEACTIVATED', 'DEACTIVATED'])
  })

  /** A5 r1: los dos caminos del dashboard que cancelan, sobre una cuenta de tarjetas REAL con sobres. */
  async function sobresTrasCancelar(llave: string, cancelar: (orderId: string) => Promise<unknown>) {
    const r = await venta(llave, [500, 700])
    expect(r.sobres.map(s => s.status)).toEqual(['PENDING', 'PENDING'])
    await cancelar(r.orderId)
    const sobres = await prisma.giftCard.findMany({ where: { venueId, id: { in: r.sobres.map(s => s.id) } }, take: 5 })
    const filas = await prisma.giftCardActivity.findMany({ where: { venueId, giftCardId: { in: r.sobres.map(s => s.id) } }, take: 5 })
    return {
      cuenta: (await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).status,
      sobres: sobres.map(s => [s.status, s.balance.toFixed(2), s.activatedAt]),
      filas: filas.map(f => [f.type, f.reason, f.orderId === r.orderId]),
    }
  }

  it.each([
    ['dashboard · updateOrder a CANCELLED', (orderId: string) => updateOrder(venueId, orderId, { status: 'CANCELLED' })],
    ['dashboard · deleteOrder', (orderId: string) => deleteOrder(venueId, orderId)],
  ])('%s deja los sobres PENDING DEACTIVATED (nunca activados) con su DEACTIVATE', async (caso, cancelar) => {
    expect(await sobresTrasCancelar(`${SUF}-${caso.includes('update') ? 'u' : 'x'}`, cancelar)).toEqual({
      cuenta: 'CANCELLED',
      sobres: [
        ['DEACTIVATED', '0.00', null],
        ['DEACTIVATED', '0.00', null],
      ],
      filas: [
        ['DEACTIVATE', 'SALE_CANCELLED', true],
        ['DEACTIVATE', 'SALE_CANCELLED', true],
      ],
    })
  })
})

/**
 * 1b S4 (S-1, Q27, Q28, Q47, Q49, A3): lo que el POS lee en sus órdenes para decidir, sin mirar el texto del renglón: si es una
 * cuenta de tarjetas, cuántos cobros con saldo vivos tiene, qué pago es saldo de tarjeta y si es de mesa.
 */
describe('1b S4 · las órdenes del POS dicen lo de tarjetas', () => {
  const D = (v: number) => new Prisma.Decimal(v)
  let k = 0
  const folio = (p: string) => `${SUF}-${p}-${++k}`

  async function mercancia(p: { total: number; tableId?: string; conTarjeta?: string }) {
    return (
      await prisma.order.create({
        data: {
          venueId,
          orderNumber: folio('m'),
          contratoDePrecio: 'IVA_INCLUIDO',
          subtotal: D(p.total),
          taxAmount: D(0),
          total: D(p.total),
          remainingBalance: D(p.total),
          status: 'CONFIRMED',
          paymentStatus: 'PENDING',
          tableId: p.tableId ?? null,
          items: {
            create: [
              { productName: 'Blusa', quantity: 1, unitPrice: D(p.total), taxAmount: D(0), total: D(p.total) },
              ...(p.conTarjeta
                ? [
                    {
                      productName: 'Tarjeta de regalo',
                      quantity: 1,
                      unitPrice: D(0),
                      taxAmount: D(0),
                      total: D(0),
                      giftCardId: p.conTarjeta,
                    },
                  ]
                : []),
            ],
          },
        },
      })
    ).id
  }

  /** Un sobre ACTIVE con su ACTIVATE y su liga (la prueba de posesión del cobro). */
  async function tarjetaActiva(monto: number) {
    const c = generateGiftCardCode()
    const pageToken = generateOpaqueToken()
    const t = await prisma.giftCard.create({
      data: {
        venueId,
        organizationId: orgId,
        codeHash: hashGiftCardCode(c.normalized),
        codeEnc: encryptGiftCardCode(c.normalized),
        codeLast4: c.last4,
        pageToken,
        initialAmount: D(monto),
        balance: D(monto),
        status: 'ACTIVE',
        activatedAt: new Date(),
        termsVersion: '2026-10-14',
        deliveryChannel: 'PRINTED',
      },
    })
    await prisma.giftCardActivity.create({
      data: { giftCardId: t.id, venueId, type: 'ACTIVATE', amount: D(monto), balanceAfter: D(monto) },
    })
    return { id: t.id, pageToken }
  }

  async function cobrarConSaldo(orderId: string, monto: number) {
    const { pageToken } = await tarjetaActiva(1000)
    return payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: folio('saldo')
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(-64),
      proof: { kind: 'PAGE_TOKEN', pageToken },
      amount: D(monto),
      tip: D(0),
      staffId,
      deviceId: 'caja-s4',
    })
  }

  const enLista = async (ids: string[]) => {
    const { data } = await listOrders(venueId, { page: 1, pageSize: 100 })
    return ids.map(id => data.find(o => o.id === id))
  }

  beforeAll(async () => {
    await ensureGiftCardTender(prisma, venueId)
  })

  it('S-1: la lista y el detalle dicen esCuentaDeTarjetas: true en la cuenta de tarjetas y false en la de mercancía', async () => {
    const tarjetas = (await venta(`${SUF}-s4a`, [500])).orderId
    const blusa = await mercancia({ total: 500 })
    expect((await enLista([tarjetas, blusa])).map(o => o?.esCuentaDeTarjetas)).toEqual([true, false])
    expect((await getOrder(venueId, tarjetas)).esCuentaDeTarjetas).toBe(true)
    expect((await getOrder(venueId, blusa)).esCuentaDeTarjetas).toBe(false)
  })

  it('Q27/Q28: un cobro con saldo vivo ⇒ cobrosConSaldo: 1 y su pago esSaldoDeTarjeta; tras «regresar el saldo y cancelar» ⇒ 0', async () => {
    const orderId = await mercancia({ total: 500 })
    await cobrarConSaldo(orderId, 200)
    const detalle = await getOrder(venueId, orderId)
    expect(detalle.cobrosConSaldo).toBe(1)
    expect(detalle.payments.map(p => p.esSaldoDeTarjeta)).toEqual([true])

    await returnGiftBalanceAndCancelOrder(venueId, orderId, { staffId, operationKey: folio('regresa') })
    expect((await getOrder(venueId, orderId)).cobrosConSaldo).toBe(0)
  })

  it('Codex r11: la lista trae cobrosConSaldo: 1 para la cuenta con un cobro con saldo y 0 para la que no tiene', async () => {
    const conSaldo = await mercancia({ total: 500 })
    await cobrarConSaldo(conSaldo, 150)
    const sinSaldo = await mercancia({ total: 500 })
    expect((await enLista([conSaldo, sinSaldo])).map(o => o?.cobrosConSaldo)).toEqual([1, 0])
  })

  it('Q49: una cuenta con mesa ⇒ esDeMesa: true en la lista y el detalle; una de mostrador DINE_IN sin mesa ⇒ false', async () => {
    const mesa = await prisma.table.create({ data: { venueId, number: folio('t'), capacity: 4, qrCode: folio('qr') } })
    const deMesa = await mercancia({ total: 500, tableId: mesa.id })
    const mostrador = await createOrderWithItems(venueId, {
      staffId,
      orderType: 'DINE_IN',
      items: [{ name: 'Blusa', quantity: 1, unitPrice: 50000 }],
    } as any)
    expect((await enLista([deMesa, mostrador.id])).map(o => o?.esDeMesa)).toEqual([true, false])
    expect([(await getOrder(venueId, deMesa)).esDeMesa, (await getOrder(venueId, mostrador.id)).esDeMesa]).toEqual([true, false])
  })

  it('Q47 (vecindad): createOrderWithItems dos veces con el mismo externalId ⇒ la misma cuenta', async () => {
    const externalId = folio('q47')
    const pedido = { staffId, externalId, orderType: 'TAKEOUT', items: [{ name: 'Blusa', quantity: 1, unitPrice: 50000 }] } as any
    const a = await createOrderWithItems(venueId, pedido)
    const b = await createOrderWithItems(venueId, pedido)
    expect(b.id).toBe(a.id)
    expect(await prisma.order.count({ where: { venueId, externalId } })).toBe(1)
  })

  it('A3: leerSiEsCuentaDeTarjetas (con la constante compartida) sigue dando true en la de tarjetas y false en la mixta y en la de mercancía', async () => {
    const tarjetas = await venta(`${SUF}-s4b`, [500])
    const mixta = await mercancia({ total: 500, conTarjeta: (await tarjetaActiva(100)).id })
    const blusa = await mercancia({ total: 500 })
    expect([
      await leerSiEsCuentaDeTarjetas(prisma, tarjetas.orderId),
      await leerSiEsCuentaDeTarjetas(prisma, mixta),
      await leerSiEsCuentaDeTarjetas(prisma, blusa),
    ]).toEqual([true, false, false])
  })
})
