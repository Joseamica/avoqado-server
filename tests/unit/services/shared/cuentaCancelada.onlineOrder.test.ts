/**
 * 🔴 Pedidos en línea 1c, Task S1: el dinero ya capturado sobre un pedido WEB cancelado no lo deja partido en dos.
 *
 * Antes: un `PAY_CASH` reproducido de la cola sin red (o la tarjeta de la terminal) sobre una cuenta web CANCELADA la reabría
 * (`reabrirSiRecibeDinero`) y la cerraba COMPLETED/PAID, pero el `OnlineOrder` se quedaba `CANCELLED_BY_STAFF` (o `ACCEPTED`, si
 * la canceló el panel y nadie leyó la bandeja) y nadie se enteraba. Además la venta reabierta volvía a marcar la cocina.
 *
 * Ahora, en la MISMA transacción que el dinero: el pedido se completa si el cobro salda la cuenta (CAS sobre el estado leído),
 * queda la bitácora `ONLINE_ORDER_COLLECTED_AFTER_CANCEL` y un aviso ALERT por cada gerente activo. Una cuenta CANCELADA que se
 * reabre por dinero capturado nunca vuelve a la cocina (ni la marca durable ni el armado inmediato).
 *
 * Partes: A) la regla con una transacción simulada que guarda sus escrituras; B) el camino del POS (`payCashOrder`, cola sin red);
 * C) el cierre transaccional de la terminal (`settleStandalonePaymentInTx`); D) el barrido de comandas. Los dos caminos de la TPV
 * por `recordOrderPayment` (marca y armado) se prueban con su arnés en `tests/unit/services/tpv/payment.inventory-post-commit.test.ts`.
 */

jest.mock('@/services/tpv/paymentEffects.service', () => ({
  asegurarAvisoDeVentaApartada: jest.fn().mockResolvedValue(undefined),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
  enqueuePaymentEffect: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))
jest.mock('@/services/tpv/payment.tpv.service', () => ({
  ...jest.requireActual('@/services/tpv/payment.tpv.service'),
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1' }),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED') }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  ...jest.requireActual('@/services/kds/kitchenDisplayStations'),
  debeMarcarCocina: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn().mockResolvedValue(undefined),
}))
// El aviso al gerente NO puede ir por aquí: escribe con el cliente global, fuera de la transacción del dinero.
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({
  createNotification: jest.fn(),
  sendBulkNotification: jest.fn(),
  sendVenueNotification: jest.fn(),
}))

import { Decimal } from '@prisma/client/runtime/library'

import logger from '@/config/logger'

import { KitchenTicketsReconciliationJob } from '@/jobs/kitchen-tickets-reconciliation.job'
import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'
import { createNotification, sendBulkNotification, sendVenueNotification } from '@/services/dashboard/notification.dashboard.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { notarDineroEnFolioCerradoEnTx, reabrirSiRecibeDinero, renovarRecuperacionDeFolioEnTx } from '@/services/shared/cuentaCancelada'
import { settleStandalonePaymentInTx } from '@/services/tpv/payment.tpv.service'
import { prismaMock } from '../../../__helpers__/setup'

// Ids con forma de cuid v1 (25 caracteres, empiezan con `c`): algunos validadores los revisan.
const VENUE = 'cvenue000000000000000001a'
const ORDER = 'corder000000000000000001a'
const ONLINE = 'conline00000000000000001a'
const GERENTE = 'cstaffgerente0000000001aa'
const DUENA = 'cstaffduena000000000001aa'
const MESERO = 'cstaffmesero00000000001aa'
const CAJERA = 'cstaffcajera00000000001aa'

const ACCION = 'ONLINE_ORDER_COLLECTED_AFTER_CANCEL'
const TITULO = 'Se cobró un pedido en línea cancelado'
// Fix r1, ruling 3: texto neutro. El dinero puede llegar por la terminal (tarjeta), no sólo en efectivo.
const mensaje = (folio: string) => `El pedido #${folio} se había cancelado y después se registró su cobro. Revisa con quien lo canceló.`

const PERSONAL = [
  { staffId: GERENTE, venueId: VENUE, role: 'MANAGER', active: true },
  { staffId: DUENA, venueId: VENUE, role: 'OWNER', active: true },
  { staffId: MESERO, venueId: VENUE, role: 'WAITER', active: true },
  // Un ADMIN dado de baja no recibe el aviso.
  { staffId: 'cstaffadminbaja000000001a', venueId: VENUE, role: 'ADMIN', active: false },
  // Ni el gerente de OTRO negocio.
  { staffId: 'cstaffotronegocio0000001a', venueId: 'cvenueotro00000000000001a', role: 'MANAGER', active: true },
]

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// A) La regla, con una transacción simulada que guarda lo que escribe
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

interface Base {
  order: { id: string; venueId: string; status: string; orderNumber: string; contratoDePrecio: string; taxAmount: number }
  online: {
    id: string
    orderId: string
    venueId: string
    status: string
    completedAt: Date | null
    cancelledAt?: Date | null
    cancelledBy?: string | null
    acceptedAt?: Date | null
    /** S9 v5: el sello de A0. */
    expiredAt?: Date | null
    /** Tienda híbrida: `false` = folio de «Nadie». */
    requiresAcceptance: boolean
  } | null
  personal: typeof PERSONAL
  bitacora: any[]
  avisos: any[]
  pagos: any[]
  /** S9: las filas de la cuenta (para la cortesía de un folio anulado). */
  descuentos?: Array<{ amount: Decimal; isComp: boolean; compReason: string | null }>
}

function nuevaBase(
  o: { online?: string | null; contrato?: string; taxAmount?: number; personal?: Base['personal']; folio?: boolean } = {},
): Base {
  return {
    order: {
      id: ORDER,
      venueId: VENUE,
      status: 'CANCELLED',
      orderNumber: 'WK7QX',
      contratoDePrecio: o.contrato ?? 'IVA_INCLUIDO',
      taxAmount: o.taxAmount ?? 0,
    },
    online:
      o.online === null
        ? null
        : {
            id: ONLINE,
            orderId: ORDER,
            venueId: VENUE,
            status: o.online ?? 'CANCELLED_BY_STAFF',
            completedAt: null,
            acceptedAt: null,
            requiresAcceptance: o.folio !== true,
          },
    personal: o.personal ?? PERSONAL,
    bitacora: [],
    avisos: [],
    pagos: [],
  }
}

/** La transacción: lee y escribe sobre `b` y lleva la cuenta de cada llamada (que todo pase por ESTE objeto). */
function txSobre(b: Base) {
  return {
    order: {
      // S9 v5: la nota lee número, estado y la cortesía de la cuenta.
      findFirst: jest.fn(async () => ({
        orderNumber: b.order.orderNumber,
        status: b.order.status,
        orderDiscounts: (b.descuentos ?? []).filter(d => d.isComp).map(d => ({ amount: d.amount })),
      })),
      update: jest.fn(async ({ where, data, select }: any) => {
        if (where.id !== b.order.id || where.venueId !== b.order.venueId) throw new Error('order.update fuera de la orden')
        if (data.status) b.order.status = data.status
        // S9: el doble aplica el filtro que la conciliación pide para las cortesías de un folio anulado.
        const filtro = select?.orderDiscounts?.where
        return {
          ...(filtro
            ? {
                orderDiscounts: (b.descuentos ?? [])
                  .filter(d => d.isComp === filtro.isComp && d.compReason === filtro.compReason)
                  .map(d => ({ amount: d.amount })),
              }
            : {}),
          orderNumber: b.order.orderNumber,
          contratoDePrecio: b.order.contratoDePrecio,
          taxAmount: new Decimal(b.order.taxAmount),
          onlineOrder: b.online
            ? ({ id: b.online.id, status: b.online.status, requiresAcceptance: b.online.requiresAcceptance } as {
                id: string
                status: string
                requiresAcceptance?: boolean
              })
            : null,
        }
      }),
    },
    onlineOrder: {
      findUnique: jest.fn(async ({ where }: any) =>
        b.online && where.orderId === b.online.orderId ? { id: b.online.id, status: b.online.status } : null,
      ),
      // S9 v5: la lectura de la nota (folio «Nadie» de la cuenta, con su sello).
      findFirst: jest.fn(async ({ where }: any) =>
        b.online && where.orderId === b.online.orderId && where.requiresAcceptance === b.online.requiresAcceptance
          ? {
              id: b.online.id,
              status: b.online.status,
              expiredAt: b.online.expiredAt ?? null,
              cancelledAt: b.online.cancelledAt ?? null,
              rejectedAt: null,
            }
          : null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!b.online || where.id !== b.online.id || (where.status !== undefined && where.status !== b.online.status)) return { count: 0 }
        if (where.requiresAcceptance !== undefined && where.requiresAcceptance !== b.online.requiresAcceptance) return { count: 0 }
        Object.assign(b.online, data)
        return { count: 1 }
      }),
    },
    staffVenue: {
      findMany: jest.fn(async ({ where }: any) =>
        b.personal
          .filter(s => s.venueId === where.venueId && (where.active === undefined || s.active === where.active))
          .filter(s => !where.role?.in || where.role.in.includes(s.role))
          .map(s => ({ staffId: s.staffId })),
      ),
    },
    notification: {
      create: jest.fn(async ({ data }: any) => {
        b.avisos.push(data)
        return data
      }),
      createMany: jest.fn(async ({ data }: any) => {
        b.avisos.push(...data)
        return { count: data.length }
      }),
    },
    activityLog: {
      create: jest.fn(async ({ data }: any) => {
        b.bitacora.push(data)
        return data
      }),
      count: jest.fn(async ({ where }: any) => b.bitacora.filter(d => d.action === where.action && d.entityId === where.entityId).length),
    },
    payment: {
      create: jest.fn(async ({ data }: any) => {
        b.pagos.push(data)
        return { id: 'cpayment0000000000000001a', ...data }
      }),
    },
  }
}

/** Una transacción de verdad en miniatura: trabaja sobre una copia y sólo al terminar sin error la deja en la base. */
async function enTransaccion(b: Base, cuerpo: (tx: ReturnType<typeof txSobre>) => Promise<void>) {
  const copia: Base = {
    ...b,
    order: { ...b.order },
    online: b.online ? { ...b.online } : null,
    bitacora: [...b.bitacora],
    avisos: [...b.avisos],
    pagos: [...b.pagos],
  }
  await cuerpo(txSobre(copia))
  Object.assign(b, copia)
}

const reabrir = (tx: any, o: { cobrado?: number; cubre?: boolean; originSystem?: string; status?: string; key?: string } = {}) =>
  reabrirSiRecibeDinero(tx, {
    venueId: VENUE,
    orderId: ORDER,
    status: (o.status ?? 'CANCELLED') as any,
    originSystem: o.originSystem ?? 'AVOQADO',
    cobrado: o.cobrado ?? 150,
    cubreComoCancelada: o.cubre ?? true,
    canal: 'payCashOrder:cola',
    idempotencyKey: o.key ?? 'cola-k1',
    staffId: GERENTE,
  })

const delPedido = (b: Base) => b.bitacora.filter(d => d.action === ACCION)
const reaperturas = (b: Base) => b.bitacora.filter(d => d.action === 'ORDER_REOPENED_BY_CAPTURED_PAYMENT')

/** El cliente global nunca escribe nada de esto: todo va con el `tx` del dinero. */
function nadaPorElClienteGlobal() {
  expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.notification.create).not.toHaveBeenCalled()
  expect(prismaMock.notification.createMany).not.toHaveBeenCalled()
  expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  expect(createNotification).not.toHaveBeenCalled()
  expect(sendBulkNotification).not.toHaveBeenCalled()
  expect(sendVenueNotification).not.toHaveBeenCalled()
}

const SELLO = {
  where: { orderId: ORDER, venueId: VENUE, requiresAcceptance: false, expiredAt: null, cancelledAt: null, rejectedAt: null },
  data: { cancelledAt: expect.any(Date) },
}
const RENUEVA = {
  where: {
    orderId: ORDER,
    venueId: VENUE,
    requiresAcceptance: false,
    status: { in: ['EXPIRED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_STAFF', 'REJECTED'] },
  },
  data: { updatedAt: expect.any(Date) },
}

describe('S9 v5 (U4) — la conciliación de un folio «Nadie»: sella, renueva y NO avisa (el aviso es de la nota del escritor)', () => {
  const MOTIVO = 'Beneficio regresado a la clienta al anular el folio'

  it.each([
    ['con cortesía', [{ amount: new Decimal('85.00'), isComp: true, compReason: MOTIVO }]],
    ['sin cortesía', []],
  ])('%s ⇒ sello y renovación en la transacción del dinero, sin bitácora del pedido ni aviso', async (_c, descuentos) => {
    const b = nuevaBase({ folio: true, online: 'EXPIRED' })
    b.descuentos = descuentos
    const tx = txSobre(b)

    expect(await reabrir(tx, { cobrado: 134, cubre: true })).toBe('PENDING')

    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(SELLO)
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(RENUEVA)
    expect(b.online?.status).toBe('EXPIRED') // R11: el dinero no mueve el folio cerrado
    expect(delPedido(b)).toEqual([])
    expect(b.avisos).toEqual([])
    expect(reaperturas(b)).toHaveLength(1) // la reapertura de la cuenta sí deja su rastro, como hoy
    nadaPorElClienteGlobal()
  })

  it('«Mi equipo» como hoy: sin sello ni renovación, y avisa en la conciliación', async () => {
    const b = nuevaBase({ online: 'EXPIRED' })
    const tx = txSobre(b)
    await reabrir(tx, { cobrado: 150, cubre: true })
    expect(tx.onlineOrder.updateMany).not.toHaveBeenCalledWith(SELLO)
    expect(tx.onlineOrder.updateMany).not.toHaveBeenCalledWith(RENUEVA)
    expect(delPedido(b)).toHaveLength(1)
    expect(b.avisos.map(a => a.message)).toEqual([mensaje('WK7QX'), mensaje('WK7QX')])
  })
})

describe('S1 — la regla dentro de `reabrirSiRecibeDinero` (transacción simulada)', () => {
  it('reopens a cancelled WEB order and completes its OnlineOrder when captured cash covers it', async () => {
    const b = nuevaBase()
    const tx = txSobre(b)

    // El retorno sigue siendo el `OrderStatus` de hoy (la TPV lo usa como estado): ni metadatos ni otro tipo.
    expect(await reabrir(tx, { cobrado: 150, cubre: true })).toBe('PENDING')

    expect(b.order.status).toBe('PENDING')
    expect(b.online).toMatchObject({ status: 'COMPLETED', completedAt: expect.any(Date) })
    // CAS sobre el estado que leyó; R15: la escritura de COMPLETED de «Mi equipo» exige `requiresAcceptance: true`.
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ONLINE, status: 'CANCELLED_BY_STAFF', requiresAcceptance: true } }),
    )
    expect(reaperturas(b)).toHaveLength(1)
    expect(delPedido(b)).toEqual([
      expect.objectContaining({
        action: ACCION,
        venueId: VENUE,
        staffId: GERENTE,
        data: expect.objectContaining({
          onlineOrderId: ONLINE,
          orderId: ORDER,
          estadoAnterior: 'CANCELLED_BY_STAFF',
          cobradoCents: 15000,
          canal: 'payCashOrder:cola',
          idempotencyKey: 'cola-k1',
        }),
      }),
    ])
    // Un aviso por gerente activo del negocio (MANAGER / ADMIN / OWNER), nadie más.
    expect(b.avisos.map(a => a.recipientId).sort()).toEqual([DUENA, GERENTE].sort())
    for (const aviso of b.avisos) {
      expect(aviso).toMatchObject({
        venueId: VENUE,
        type: 'ALERT',
        priority: 'HIGH',
        channels: ['IN_APP'],
        entityType: 'Order',
        entityId: ORDER,
        title: TITULO,
        message: mensaje('WK7QX'),
      })
    }
    nadaPorElClienteGlobal()
  })

  it('partial captured cash reopens the order but leaves OnlineOrder cancelled and still reports it', async () => {
    const b = nuevaBase()
    const tx = txSobre(b)

    expect(await reabrir(tx, { cobrado: 50, cubre: false })).toBe('PENDING')

    expect(b.order.status).toBe('PENDING')
    expect(b.online).toMatchObject({ status: 'CANCELLED_BY_STAFF', completedAt: null })
    expect(tx.onlineOrder.updateMany).not.toHaveBeenCalled()
    expect(delPedido(b)).toHaveLength(1)
    expect(delPedido(b)[0].data).toMatchObject({ estadoAnterior: 'CANCELLED_BY_STAFF', cobradoCents: 5000 })
    expect(b.avisos).toHaveLength(2)
    nadaPorElClienteGlobal()
  })

  it('🔴 con IVA aparte la cuenta viva debe más que la cancelada: «cubre como cancelada» no basta para completar el pedido', async () => {
    const b = nuevaBase({ contrato: 'IVA_APARTE', taxAmount: 16 })

    await reabrir(txSobre(b), { cobrado: 100, cubre: true })

    expect(b.online?.status).toBe('CANCELLED_BY_STAFF')
    expect([delPedido(b).length, b.avisos.length]).toEqual([1, 2])
  })

  // 🔴 Fix r1, ruling 4 (revisión r0 #1; Codex plan r2 #4): el panel canceló la cuenta y el pedido sigue ABIERTO porque nadie leyó la
  // bandeja. Un pago PARCIAL la reabre: el pedido se cierra igual que si la bandeja hubiera leído antes (`cancelledOrderSync.ts`), con
  // el mismo `tx`. Sin esto quedaba «En preparación», cobrable e IMPRIMIBLE en la cocina (`printClaim.service.ts`).
  it.each(['PENDING_ACCEPTANCE', 'ACCEPTED', 'READY'])(
    'dashboard cancel without an inbox read in between + partial captured cash ⇒ the OnlineOrder (%s) ends CANCELLED_BY_STAFF through the tx',
    async abierto => {
      const b = nuevaBase({ online: abierto })
      const tx = txSobre(b)

      expect(await reabrir(tx, { cobrado: 50, cubre: false })).toBe('PENDING')

      expect(b.order.status).toBe('PENDING')
      expect(b.online).toMatchObject({
        status: 'CANCELLED_BY_STAFF',
        cancelledAt: expect.any(Date),
        cancelledBy: 'ORDER_CANCELLED_ELSEWHERE',
        completedAt: null,
      })
      expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ONLINE, status: abierto } }))
      expect(delPedido(b)).toHaveLength(1)
      expect(delPedido(b)[0].data).toMatchObject({ estadoAnterior: abierto, cobradoCents: 5000 })
      expect(b.avisos).toHaveLength(2)
      nadaPorElClienteGlobal()
    },
  )

  it('🔴 fix r1: el resultado del pago parcial es el MISMO con o sin una lectura de la bandeja en medio', async () => {
    // Sin lectura: el panel dejó el pedido ACCEPTED.
    const sinLectura = nuevaBase({ online: 'ACCEPTED' })
    await reabrir(txSobre(sinLectura), { cobrado: 50, cubre: false })
    // Con lectura: la bandeja ya lo había cerrado como lo cierra `syncOnlineOrdersOfCancelledOrders`.
    const conLectura = nuevaBase()
    conLectura.online!.cancelledBy = 'ORDER_CANCELLED_ELSEWHERE'
    conLectura.online!.cancelledAt = new Date('2026-10-21T12:00:00Z')
    await reabrir(txSobre(conLectura), { cobrado: 50, cubre: false })

    const final = (b: Base) => [b.order.status, b.online?.status, b.online?.cancelledBy, delPedido(b).length, b.avisos.length]
    expect(final(sinLectura)).toEqual(final(conLectura))
    expect(final(sinLectura)).toEqual(['PENDING', 'CANCELLED_BY_STAFF', 'ORDER_CANCELLED_ELSEWHERE', 1, 2])
  })

  it('🔴 fix r1: si la bandeja lo cierra entre la lectura y el CAS del pago parcial, no se pisa y el resultado es el mismo', async () => {
    const b = nuevaBase({ online: 'ACCEPTED' })
    const tx = txSobre(b)
    tx.order.update.mockImplementationOnce(async ({ data }: any) => {
      b.order.status = data.status
      Object.assign(b.online!, { status: 'CANCELLED_BY_STAFF', cancelledBy: 'ORDER_CANCELLED_ELSEWHERE', cancelledAt: new Date() })
      return {
        orderNumber: 'WK7QX',
        contratoDePrecio: 'IVA_INCLUIDO',
        taxAmount: new Decimal(0),
        onlineOrder: { id: ONLINE, status: 'ACCEPTED' },
      }
    })

    await reabrir(tx, { cobrado: 50, cubre: false })

    expect(b.online).toMatchObject({ status: 'CANCELLED_BY_STAFF', cancelledBy: 'ORDER_CANCELLED_ELSEWHERE' })
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledTimes(1)
    expect(delPedido(b)[0].data.estadoAnterior).toBe('CANCELLED_BY_STAFF')
  })

  it('🔴 fix r1: con la página de gerentes llena (50) se avisa a esos 50 y queda un warn: nunca se recorta en silencio', async () => {
    const cincuenta = Array.from({ length: 50 }, (_, i) => ({
      staffId: `cstaffgerente${String(i).padStart(12, '0')}`,
      venueId: VENUE,
      role: 'MANAGER',
      active: true,
    }))
    const b = nuevaBase({ personal: cincuenta })

    await reabrir(txSobre(b))

    expect(b.avisos).toHaveLength(50)
    expect((logger.warn as jest.Mock).mock.calls.some(([m]) => String(m).includes('página llena de gerentes'))).toBe(true)
  })

  it('control — fix r1: con menos de 50 gerentes no hay warn de página llena', async () => {
    await reabrir(txSobre(nuevaBase()))
    expect((logger.warn as jest.Mock).mock.calls.some(([m]) => String(m).includes('página llena de gerentes'))).toBe(false)
  })

  it('idempotent replay does not log or notify twice', async () => {
    const b = nuevaBase()

    await enTransaccion(b, async tx => void (await reabrir(tx)))
    // El mismo cobro otra vez (misma llave): la cuenta ya no está cancelada, así que la regla no escribe nada.
    await enTransaccion(b, async tx => void (await reabrir(tx, { status: b.order.status })))

    expect([delPedido(b).length, b.avisos.length, reaperturas(b).length]).toEqual([1, 2, 1])
    expect(b.online?.status).toBe('COMPLETED')
  })

  it('manager notice is written in the same transaction as the money', async () => {
    // Revierte: el pago y el aviso se van juntos.
    const revertida = nuevaBase()
    await expect(
      enTransaccion(revertida, async tx => {
        await reabrir(tx)
        await tx.payment.create({ data: { orderId: ORDER, amount: 150 } })
        throw new Error('PAY_CASH_CAS_LOST')
      }),
    ).rejects.toThrow('PAY_CASH_CAS_LOST')
    expect([revertida.pagos.length, revertida.avisos.length, delPedido(revertida).length]).toEqual([0, 0, 0])
    expect([revertida.order.status, revertida.online?.status]).toEqual(['CANCELLED', 'CANCELLED_BY_STAFF'])

    // Confirma: quedan los dos.
    const confirmada = nuevaBase()
    await enTransaccion(confirmada, async tx => {
      await reabrir(tx)
      await tx.payment.create({ data: { orderId: ORDER, amount: 150 } })
    })
    expect([confirmada.pagos.length, confirmada.avisos.length, delPedido(confirmada).length]).toEqual([1, 2, 1])
    expect(confirmada.online?.status).toBe('COMPLETED')
    nadaPorElClienteGlobal()
  })

  it("non-WEB orders keep today's behavior", async () => {
    const b = nuevaBase({ online: null })
    const tx = txSobre(b)

    expect(await reabrir(tx)).toBe('PENDING')

    expect(reaperturas(b)).toHaveLength(1)
    expect([delPedido(b).length, b.avisos.length]).toEqual([0, 0])
    expect(tx.staffVenue.findMany).not.toHaveBeenCalled()
    expect(tx.onlineOrder.updateMany).not.toHaveBeenCalled()
  })

  it('control: un pedido ya ENTREGADO (COMPLETED) no se toca ni se reporta', async () => {
    const b = nuevaBase({ online: 'COMPLETED' })

    await reabrir(txSobre(b))

    expect([delPedido(b).length, b.avisos.length, reaperturas(b).length]).toEqual([0, 0, 1])
  })

  it('🔴 si la bandeja cambia el pedido entre la lectura y el CAS, relee una vez y lo completa', async () => {
    const b = nuevaBase({ online: 'ACCEPTED' })
    const tx = txSobre(b)
    // La bandeja sincroniza la cancelación justo después de que la regla leyó ACCEPTED.
    tx.order.update.mockImplementationOnce(async ({ data }: any) => {
      b.order.status = data.status
      const leido = { id: ONLINE, status: 'ACCEPTED' }
      b.online!.status = 'CANCELLED_BY_STAFF'
      return { orderNumber: 'WK7QX', contratoDePrecio: 'IVA_INCLUIDO', taxAmount: new Decimal(0), onlineOrder: leido }
    })

    await reabrir(tx)

    expect(b.online?.status).toBe('COMPLETED')
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledTimes(2)
    // El estado del que de verdad salió (el que ganó el CAS), no el de la primera lectura.
    expect(delPedido(b)[0].data.estadoAnterior).toBe('CANCELLED_BY_STAFF')
  })
})

describe('Tienda híbrida T9 (decisión 18) y S9: el dinero tardío que SALDA un folio lo deja «Por entregar», nunca «Entregado»', () => {
  it('folio PENDING_ACCEPTANCE ⇒ ACCEPTED con acceptedAt, en la MISMA transacción del dinero (como hoy); el CAS exige que sea folio', async () => {
    const b = nuevaBase({ folio: true, online: 'PENDING_ACCEPTANCE' })
    const tx = txSobre(b)

    expect(await reabrir(tx, { cobrado: 150, cubre: true })).toBe('PENDING')

    expect(b.online).toMatchObject({ status: 'ACCEPTED', acceptedAt: expect.any(Date), completedAt: null })
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith({
      where: { id: ONLINE, status: 'PENDING_ACCEPTANCE', requiresAcceptance: false },
      data: { status: 'ACCEPTED', acceptedAt: expect.any(Date) },
    })
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(SELLO) // el hueco anulado antes del despliegue queda sellado
    expect(b.avisos).toEqual([]) // S9 v5: el aviso es de la nota del escritor
    nadaPorElClienteGlobal()
  })

  // R11: un folio CERRADO no lo mueve el dinero; lo revive `syncPaidClosedFolios`, que publica. B2: el dinero le renueva la ventana.
  it.each(['EXPIRED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_STAFF', 'REJECTED'])(
    'folio %s ⇒ se queda como está; sello y renovación de la ventana del barrido, sin aviso',
    async desde => {
      const b = nuevaBase({ folio: true, online: desde })
      const tx = txSobre(b)

      expect(await reabrir(tx, { cobrado: 150, cubre: true })).toBe('PENDING')

      expect(b.online).toMatchObject({ status: desde, acceptedAt: null, completedAt: null })
      expect(tx.onlineOrder.updateMany.mock.calls.map((c: any[]) => c[0])).toEqual([SELLO, RENUEVA])
      expect(b.avisos).toEqual([])
      nadaPorElClienteGlobal()
    },
  )

  it.each(['ACCEPTED', 'READY'])('folio %s (ya en la lista o listo) se queda como está', async desde => {
    const b = nuevaBase({ folio: true, online: desde })
    const tx = txSobre(b)

    await reabrir(tx, { cobrado: 150, cubre: true })

    expect(b.online?.status).toBe(desde)
    expect(tx.onlineOrder.updateMany.mock.calls.map((c: any[]) => c[0])).toEqual([SELLO, RENUEVA])
  })

  it('folio con un abono (no salda): sigue cerrado, como hoy, y se renueva la ventana', async () => {
    const b = nuevaBase({ folio: true, online: 'EXPIRED' })
    const tx = txSobre(b)

    await reabrir(tx, { cobrado: 50, cubre: false })

    expect(b.online?.status).toBe('EXPIRED')
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(RENUEVA)
    expect(delPedido(b)).toEqual([])
  })

  it('si una lectura vieja lo movió entre la lectura y el CAS, relee una vez: ya cerrado ⇒ se queda (lo revive el barrido)', async () => {
    const b = nuevaBase({ folio: true, online: 'PENDING_ACCEPTANCE' })
    const tx = txSobre(b)
    tx.order.update.mockImplementationOnce(async ({ data }: any) => {
      b.order.status = data.status
      const leido = { id: ONLINE, status: 'PENDING_ACCEPTANCE', requiresAcceptance: false }
      b.online!.status = 'CANCELLED_BY_STAFF'
      return { orderNumber: 'WK7QX', contratoDePrecio: 'IVA_INCLUIDO', taxAmount: new Decimal(0), onlineOrder: leido }
    })

    await reabrir(tx)

    expect(b.online?.status).toBe('CANCELLED_BY_STAFF')
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(RENUEVA)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// B) El camino del POS: `payCashOrder` (la cola sin red `PAY_CASH` y el efectivo en vivo)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/** Base falsa con CAS real para `payCashOrder` (la de `payCashOrder.efectivoSinRed.test.ts`), con su pedido en línea. */
function instalarPos(o: { online: string | null; total?: number }) {
  const total = o.total ?? 150
  const row: any = {
    id: ORDER,
    orderNumber: 'WK7QX',
    venueId: VENUE,
    paymentStatus: 'PENDING',
    status: 'CANCELLED',
    source: 'WEB',
    subtotal: new Decimal(total),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    taxAmount: new Decimal(0),
    contratoDePrecio: 'IVA_INCLUIDO',
    originSystem: 'AVOQADO',
    total: new Decimal(total),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(total),
    version: 3,
    kitchenPendingAt: null as Date | null,
    areaTicketCode: null,
    areaTicketCheckoutSession: null,
    tableId: null,
    customerId: null,
    customer: null,
  }
  const online = o.online ? { id: ONLINE, orderId: ORDER, venueId: VENUE, status: o.online, completedAt: null as Date | null } : null
  const pagos: any[] = []
  const bitacora: any[] = []
  const avisos: any[] = []
  const cas: any[] = []

  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.order.findUnique.mockImplementation(async () => ({ ...row }))
  prismaMock.order.updateMany.mockImplementation(async ({ where, data }: any) => {
    const estado =
      where.paymentStatus === undefined ||
      (typeof where.paymentStatus === 'string'
        ? where.paymentStatus === row.paymentStatus
        : where.paymentStatus.in.includes(row.paymentStatus))
    if ((where.version !== undefined && where.version !== row.version) || !estado) return { count: 0 }
    cas.push({ where, data })
    for (const campo of ['paymentStatus', 'status', 'kitchenPendingAt'] as const) if (data[campo] !== undefined) row[campo] = data[campo]
    if (data.paidAmount !== undefined) row.paidAmount = new Decimal(data.paidAmount)
    if (data.remainingBalance !== undefined) row.remainingBalance = new Decimal(data.remainingBalance)
    if (data.version?.increment) row.version += data.version.increment
    return { count: 1 }
  })
  prismaMock.order.update.mockImplementation(async ({ data }: any) => {
    if (data.status) row.status = data.status
    return { ...row, onlineOrder: online ? { id: online.id, status: online.status } : null }
  })
  prismaMock.onlineOrder.findUnique.mockImplementation(async () => (online ? { id: online.id, status: online.status } : null))
  prismaMock.onlineOrder.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!online || where.id !== online.id || (where.status !== undefined && where.status !== online.status)) return { count: 0 }
    Object.assign(online, data)
    return { count: 1 }
  })
  prismaMock.staffVenue.findMany.mockImplementation(async ({ where }: any) =>
    PERSONAL.filter(s => s.venueId === where.venueId && s.active === (where.active ?? s.active))
      .filter(s => !where.role?.in || where.role.in.includes(s.role))
      .map(s => ({ staffId: s.staffId })),
  )
  prismaMock.notification.createMany.mockImplementation(async ({ data }: any) => {
    avisos.push(...data)
    return { count: data.length }
  })
  prismaMock.notification.create.mockImplementation(async ({ data }: any) => {
    avisos.push(data)
    return data
  })
  prismaMock.activityLog.create.mockImplementation(async ({ data }: any) => {
    bitacora.push(data)
    return data
  })
  prismaMock.payment.findMany.mockImplementation(async () =>
    pagos.map(p => ({ amount: new Decimal(p.amount), tipAmount: new Decimal(p.tipAmount), type: 'REGULAR' })),
  )
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    if (data.idempotencyKey && pagos.some(p => p.idempotencyKey === data.idempotencyKey)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    }
    const nuevo = {
      id: `cpaymentpos000000000000${pagos.length + 1}a`,
      amount: Number(data.amount),
      tipAmount: Number(data.tipAmount),
      method: data.method,
      idempotencyKey: data.idempotencyKey ?? null,
    }
    pagos.push(nuevo)
    return { ...nuevo, status: 'COMPLETED', type: 'REGULAR', createdAt: new Date(), receipts: [] }
  })
  prismaMock.payment.findUnique.mockImplementation(async ({ where }: any) => {
    const p = pagos.find(x => x.idempotencyKey && x.idempotencyKey === where?.venueId_idempotencyKey?.idempotencyKey)
    return p
      ? {
          ...p,
          orderId: ORDER,
          status: 'COMPLETED',
          type: 'REGULAR',
          amount: new Decimal(p.amount),
          tipAmount: new Decimal(p.tipAmount),
          receipts: [],
        }
      : null
  })
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'caja-1' })
  prismaMock.staff.findUnique.mockResolvedValue({ id: GERENTE })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: CAJERA, venueId: VENUE, active: true })
  return { row, online, pagos, bitacora, avisos, cas }
}

const cola = (amount: number, idempotencyKey: string) => ({ amount, tip: 0, staffId: CAJERA, idempotencyKey, isOfflineReplay: true })

describe('S1 — el camino del POS (`payCashOrder`)', () => {
  it('dashboard cancel without an inbox read in between', async () => {
    // Lo que deja la cancelación general del DASHBOARD (`order.dashboard.service.ts`, `cancelOrder`): la cuenta CANCELLED y el
    // pedido en línea todavía ACCEPTED (esa ruta no toca `OnlineOrder`; lo sincroniza la bandeja al LEER, y nadie leyó).
    const { row, online, bitacora, avisos } = instalarPos({ online: 'ACCEPTED' })

    await payCashOrder(VENUE, ORDER, cola(15000, 'cola-dash'))

    expect([row.status, row.paymentStatus]).toEqual(['COMPLETED', 'PAID'])
    expect(online).toMatchObject({ status: 'COMPLETED', completedAt: expect.any(Date) })
    expect(bitacora.filter(d => d.action === ACCION)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          estadoAnterior: 'ACCEPTED',
          cobradoCents: 15000,
          canal: 'payCashOrder:cola',
          idempotencyKey: 'cola-dash',
        }),
      }),
    ])
    expect(avisos.map(a => a.recipientId).sort()).toEqual([DUENA, GERENTE].sort())
    expect(avisos[0]).toMatchObject({ title: TITULO, message: mensaje('WK7QX'), type: 'ALERT', priority: 'HIGH' })
    expect(createNotification).not.toHaveBeenCalled()
  })

  it('idempotent replay does not log or notify twice (por `payCashOrder`, misma llave dos veces)', async () => {
    const { pagos, bitacora, avisos, online } = instalarPos({ online: 'CANCELLED_BY_STAFF' })

    await payCashOrder(VENUE, ORDER, cola(15000, 'cola-dos-veces'))
    await payCashOrder(VENUE, ORDER, cola(15000, 'cola-dos-veces'))

    expect(pagos).toHaveLength(1)
    expect([bitacora.filter(d => d.action === ACCION).length, avisos.length]).toEqual([1, 2])
    expect(online?.status).toBe('COMPLETED')
  })

  it('🔴 fix r1 — dashboard cancel without an inbox read in between + partial cash replay ⇒ OnlineOrder CANCELLED_BY_STAFF (por `payCashOrder`)', async () => {
    const { row, online, bitacora, avisos } = instalarPos({ online: 'ACCEPTED' })

    await payCashOrder(VENUE, ORDER, cola(5000, 'cola-parcial-dash'))

    expect([row.status, row.paymentStatus]).toEqual(['PENDING', 'PARTIAL'])
    expect(online).toMatchObject({ status: 'CANCELLED_BY_STAFF', cancelledBy: 'ORDER_CANCELLED_ELSEWHERE', cancelledAt: expect.any(Date) })
    expect(bitacora.filter(d => d.action === ACCION)).toHaveLength(1)
    expect(avisos).toHaveLength(2)
    expect(prismaMock.onlineOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ONLINE, status: 'ACCEPTED' } }))
  })

  it('a live drawer cash /pay on a cancelled WEB order is still rejected', async () => {
    const { row, online, pagos, bitacora, avisos } = instalarPos({ online: 'CANCELLED_BY_STAFF' })

    await expect(payCashOrder(VENUE, ORDER, { amount: 15000, tip: 0, staffId: CAJERA, idempotencyKey: 'vivo-1' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_CANCELLED_NO_NEW_CHARGE',
    })

    expect([row.status, online?.status, pagos.length, bitacora.length, avisos.length]).toEqual(['CANCELLED', 'CANCELLED_BY_STAFF', 0, 0, 0])
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// C) El cierre transaccional de la terminal (`settleStandalonePaymentInTx`)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

function txTerminal(b: Base, cobrado: number, source = 'WEB') {
  const base = txSobre(b)
  const escrituras: any[] = []
  return {
    ...base,
    escrituras,
    order: {
      ...base.order,
      findFirstOrThrow: jest.fn(async () => ({
        id: ORDER,
        venueId: VENUE,
        orderNumber: b.order.orderNumber,
        status: b.order.status,
        originSystem: 'AVOQADO',
        source,
        paymentStatus: 'PENDING',
        subtotal: new Decimal(150),
        discountAmount: new Decimal(0),
        serviceChargeAmount: new Decimal(0),
        tipAmount: new Decimal(0),
        taxAmount: new Decimal(b.order.taxAmount),
        contratoDePrecio: b.order.contratoDePrecio,
        completedAt: null,
        servedById: CAJERA,
        createdById: CAJERA,
        items: [],
      })),
      update: jest.fn(async (args: any) => {
        escrituras.push(args.data)
        return base.order.update(args)
      }),
    },
    payment: {
      ...base.payment,
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Decimal(cobrado), tipAmount: new Decimal(0) }, _count: 1 }),
    },
  }
}

describe('S1 — la terminal (`settleStandalonePaymentInTx`)', () => {
  it('same behavior when the captured money arrives through the TPV', async () => {
    const b = nuevaBase()
    const tx = txTerminal(b, 150)

    const r = await settleStandalonePaymentInTx(
      tx as any,
      VENUE,
      ORDER,
      { id: 'cpaymenttpv0000000000001a', amount: new Decimal(150), tipAmount: new Decimal(0) },
      CAJERA,
      true,
    )

    expect(b.order.status).toBe('COMPLETED')
    expect(b.online?.status).toBe('COMPLETED')
    expect(delPedido(b)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ canal: 'recordOrderPayment', cobradoCents: 15000, estadoAnterior: 'CANCELLED_BY_STAFF' }),
      }),
    ])
    expect(b.avisos.map(a => a.recipientId).sort()).toEqual([DUENA, GERENTE].sort())
    expect(r.firstSettlement).toBe(true)
    nadaPorElClienteGlobal()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// D) La cocina: una cuenta CANCELADA reabierta por dinero capturado no vuelve (ni marca, ni armado, ni barrido)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/** El barrido de comandas con una base cuya única fila es `fila`: su selección filtra por `kitchenPendingAt` como el job real. */
async function correrBarrido(filas: Array<{ id: string; venueId: string; kitchenPendingAt: Date | null }>) {
  const author = jest.fn().mockResolvedValue(undefined)
  const ahora = new Date('2026-10-21T15:00:00Z')
  const prismaDelJob = {
    order: {
      findMany: jest.fn(async ({ where }: any) =>
        filas.filter(f => f.kitchenPendingAt !== null && (!where.kitchenPendingAt?.lt || f.kitchenPendingAt < where.kitchenPendingAt.lt)),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }
  const job = new KitchenTicketsReconciliationJob({
    prisma: prismaDelJob as any,
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => ahora,
    author,
  })
  const r = await job.runNow()
  return { r, author, prismaDelJob }
}

describe('no kitchen tickets come back for a cancelled order reopened by captured payment', () => {
  it('POS: la cola sin red salda la cuenta cancelada ⇒ sin `kitchenPendingAt`, sin armado y el barrido no la toma', async () => {
    const { row, cas } = instalarPos({ online: 'CANCELLED_BY_STAFF' })

    await payCashOrder(VENUE, ORDER, cola(15000, 'cola-cocina'))

    expect([row.status, row.paymentStatus]).toEqual(['COMPLETED', 'PAID'])
    expect(cas.every(c => c.data.kitchenPendingAt === undefined)).toBe(true)
    expect(row.kitchenPendingAt).toBeNull()
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
    const { r, author } = await correrBarrido([{ id: row.id, venueId: VENUE, kitchenPendingAt: row.kitchenPendingAt }])
    expect([r.scanned, author.mock.calls.length]).toEqual([0, 0])
  })

  it('POS, cualquier cuenta (no sólo la web): una de mesa cancelada reabierta por la cola tampoco vuelve a la cocina', async () => {
    const { row, cas } = instalarPos({ online: null })

    await payCashOrder(VENUE, ORDER, cola(15000, 'cola-mesa'))

    expect(row.status).toBe('COMPLETED')
    expect(cas.every(c => c.data.kitchenPendingAt === undefined)).toBe(true)
    expect(armarComandasTrasCommit).not.toHaveBeenCalled()
  })

  it('control: una cuenta VIVA que la cola salda sí marca la cocina y la arma (como hoy)', async () => {
    const { row, cas } = instalarPos({ online: null })
    row.status = 'CONFIRMED'

    await payCashOrder(VENUE, ORDER, cola(15000, 'cola-viva'))

    expect(cas.some(c => c.data.kitchenPendingAt instanceof Date)).toBe(true)
    expect(armarComandasTrasCommit).toHaveBeenCalledWith(VENUE, ORDER, 'PAID')
    // El barrido SÍ la tomaría (lo que prueba que la selección de arriba es la del job, no un vacío).
    const { author } = await correrBarrido([{ id: row.id, venueId: VENUE, kitchenPendingAt: new Date('2026-10-21T14:58:00Z') }])
    expect(author).toHaveBeenCalledWith({ venueId: VENUE, orderId: ORDER, trigger: 'SWEEP' })
  })

  it('terminal (`settleStandalonePaymentInTx`): la cuenta cancelada que la tarjeta salda no lleva la marca de cocina', async () => {
    const b = nuevaBase()
    const tx = txTerminal(b, 150)

    const r = await settleStandalonePaymentInTx(
      tx as any,
      VENUE,
      ORDER,
      { id: 'cpaymenttpv0000000000002a', amount: new Decimal(150), tipAmount: new Decimal(0) },
      CAJERA,
      true,
    )

    expect(b.order.status).toBe('COMPLETED')
    expect(tx.escrituras.every((d: any) => d.kitchenPendingAt === undefined)).toBe(true)
    // El post-commit de la TPV lee esto para no armar (`updateOrderTotalsForStandalonePayment`).
    expect(r.reabiertaDeCancelada).toBe(true)
  })

  it('control — terminal: una cuenta VIVA saldada sí lleva la marca', async () => {
    const b = nuevaBase()
    b.order.status = 'PENDING'
    const tx = txTerminal(b, 150)

    const r = await settleStandalonePaymentInTx(
      tx as any,
      VENUE,
      ORDER,
      { id: 'cpaymenttpv0000000000003a', amount: new Decimal(150), tipAmount: new Decimal(0) },
      CAJERA,
      true,
    )

    expect(tx.escrituras.some((d: any) => d.kitchenPendingAt instanceof Date)).toBe(true)
    expect(r.reabiertaDeCancelada).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// S9 v5 (U1): la nota de los 7 escritores de dinero
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
describe('S9 v5 (U1) — notarDineroEnFolioCerradoEnTx: dinero que ENTRA a un folio «Nadie» sellado avisa UNA vez y renueva', () => {
  type Folio = { requiresAcceptance: boolean; status: string; expiredAt?: Date | null; cancelledAt?: Date | null; rejectedAt?: Date | null }
  function txNota(o: { folio?: Folio | null; cortesia?: number; cuentaStatus?: string; yaAvisado?: number } = {}) {
    const folio = o.folio === undefined ? { requiresAcceptance: false, status: 'EXPIRED', expiredAt: new Date('2026-11-01') } : o.folio
    const avisos: any[] = []
    const bitacora: any[] = []
    const tx = {
      onlineOrder: {
        findFirst: jest.fn(async ({ where }: any) =>
          folio && where.requiresAcceptance === folio.requiresAcceptance
            ? { id: ONLINE, expiredAt: null, cancelledAt: null, rejectedAt: null, ...folio }
            : null,
        ),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      order: {
        findFirst: jest.fn(async () => ({
          orderNumber: 'WK7QX',
          status: o.cuentaStatus ?? 'COMPLETED',
          orderDiscounts: o.cortesia ? [{ amount: new Decimal(o.cortesia) }] : [],
        })),
      },
      activityLog: {
        count: jest.fn(async () => o.yaAvisado ?? 0),
        create: jest.fn(async ({ data }: any) => bitacora.push(data)),
      },
      staffVenue: { findMany: jest.fn(async () => [{ staffId: GERENTE }]) },
      notification: { createMany: jest.fn(async ({ data }: any) => avisos.push(...data)) },
    }
    return { tx, avisos, bitacora }
  }
  const notar = (tx: any, extra: Partial<Parameters<typeof notarDineroEnFolioCerradoEnTx>[1]> = {}) =>
    notarDineroEnFolioCerradoEnTx(tx, {
      venueId: VENUE,
      orderId: ORDER,
      entra: new Decimal('34.00'),
      source: 'WEB',
      reabierta: false,
      canal: 'prueba',
      paymentId: 'cpay000000000000000000001',
      staffId: GERENTE,
      ...extra,
    })
  const S9 = 'Pedido #WK7QX: se cobró después de vencer y se respetó su precio; su beneficio de $85.00 ya había regresado a la clienta.'
  const D2 =
    'Pedido #WK7QX: llegó un cobro después de cancelarse y la cuenta sigue cancelada; su beneficio de $85.00 ya había regresado a la clienta. Decide si lo devuelves o reabres la cuenta.'

  it('fuera de WEB: cero consultas (la ruta caliente de la terminal y el POS)', async () => {
    const { tx } = txNota({ cortesia: 85 })
    await notar(tx, { source: 'TPV' })
    expect(tx.onlineOrder.findFirst).not.toHaveBeenCalled()
    expect(tx.order.findFirst).not.toHaveBeenCalled()
  })

  it('sin folio, o con un folio nunca anulado (sin sello): una sola lectura y nada más', async () => {
    for (const folio of [null, { requiresAcceptance: false, status: 'PENDING_ACCEPTANCE' }]) {
      const { tx, avisos } = txNota({ folio, cortesia: 85 })
      await notar(tx)
      expect(tx.onlineOrder.findFirst).toHaveBeenCalledTimes(1)
      expect(tx.onlineOrder.updateMany).not.toHaveBeenCalled()
      expect(tx.order.findFirst).not.toHaveBeenCalled()
      expect(avisos).toEqual([])
    }
  })

  it('sellado y cerrado, con cortesía: renueva la ventana y avisa con el texto S9 y el importe real que entró', async () => {
    const { tx, avisos, bitacora } = txNota({ cortesia: 85 })
    await notar(tx)
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(RENUEVA)
    expect(bitacora).toEqual([
      expect.objectContaining({
        action: ACCION,
        entity: 'OnlineOrder',
        entityId: ONLINE,
        data: expect.objectContaining({ estadoAnterior: 'EXPIRED', cobradoCents: 3400, canal: 'prueba' }),
      }),
    ])
    expect(avisos.map(a => a.message)).toEqual([S9])
  })

  it('sellado y abierto (el hueco: cuenta anulada, folio por pagar con cancelledAt): avisa', async () => {
    const { tx, avisos } = txNota({
      folio: { requiresAcceptance: false, status: 'PENDING_ACCEPTANCE', cancelledAt: new Date('2026-11-01') },
      cortesia: 85,
      cuentaStatus: 'PENDING',
    })
    await notar(tx, { reabierta: true })
    expect(avisos.map(a => a.message)).toEqual([S9])
  })

  it('ya avisado: renueva pero no repite', async () => {
    const { tx, avisos } = txNota({ cortesia: 85, yaAvisado: 1 })
    await notar(tx)
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(RENUEVA)
    expect(avisos).toEqual([])
  })

  it('sin cortesía: sólo la reapertura avisa, con el texto S1 de hoy', async () => {
    const sinReabrir = txNota()
    await notar(sinReabrir.tx)
    expect(sinReabrir.avisos).toEqual([])
    const reabierta = txNota()
    await notar(reabierta.tx, { reabierta: true })
    expect(reabierta.avisos.map(a => a.message)).toEqual([mensaje('WK7QX')])
  })

  it('la cuenta sigue cancelada (el cripto no reabre): texto D2', async () => {
    const { tx, avisos } = txNota({ cortesia: 85, cuentaStatus: 'CANCELLED' })
    await notar(tx, { source: undefined })
    expect(avisos.map(a => a.message)).toEqual([D2])
  })

  it('«Mi equipo»: nada (la lectura pide requiresAcceptance:false)', async () => {
    const { tx, avisos } = txNota({ folio: { requiresAcceptance: true, status: 'EXPIRED', expiredAt: new Date() }, cortesia: 85 })
    await notar(tx)
    expect(avisos).toEqual([])
    expect(tx.onlineOrder.updateMany).not.toHaveBeenCalled()
  })

  it('sin dinero que entra: nada', async () => {
    const { tx } = txNota({ cortesia: 85 })
    await notar(tx, { entra: new Decimal(0) })
    expect(tx.onlineOrder.findFirst).not.toHaveBeenCalled()
  })
})

describe('S9 v5 (B2) — renovarRecuperacionDeFolioEnTx', () => {
  it('una sola sentencia: updatedAt de ahora en el folio «Nadie» CERRADO de la cuenta; nunca avisa', async () => {
    const tx = { onlineOrder: { updateMany: jest.fn(async () => ({ count: 1 })) } }
    await renovarRecuperacionDeFolioEnTx(tx as any, { venueId: VENUE, orderId: ORDER })
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(RENUEVA)
  })
})

describe('S9 v5 (U5) — los recálculos de la terminal: con dinero, la nota; sin dinero y saldada en WEB, renueva; fuera de WEB, nada', () => {
  const MOTIVO = 'Beneficio regresado a la clienta al anular el folio'
  const r44 = () => {
    const b = nuevaBase({ folio: true, online: 'EXPIRED' })
    b.order.status = 'PENDING'
    b.online!.expiredAt = new Date('2026-11-01T12:00:00Z')
    b.descuentos = [{ amount: new Decimal('85.00'), isComp: true, compReason: MOTIVO }]
    return b
  }
  const cobrar = (tx: any, amount: number) =>
    settleStandalonePaymentInTx(
      tx,
      VENUE,
      ORDER,
      { id: 'cpaymenttpv0000000000001a', amount: new Decimal(amount), tipAmount: new Decimal(0) },
      CAJERA,
      true,
    )

  it('con dinero en un folio «Nadie» sellado: renueva y avisa UNA vez (la nota), aunque la cuenta no se reabrió', async () => {
    const b = r44()
    const tx = txTerminal(b, 150)
    await cobrar(tx, 34)
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(RENUEVA)
    expect(delPedido(b)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ cobradoCents: 3400, canal: 'recordOrderPayment' }) }),
    ])
    expect(b.avisos).toHaveLength(2) // un aviso por gerente
    nadaPorElClienteGlobal()
  })

  it('sin dinero (el origen de una reasignación) y saldada en WEB: sólo renueva, sin nota ni aviso', async () => {
    const b = r44()
    const tx = txTerminal(b, 150)
    await cobrar(tx, 0)
    expect(tx.onlineOrder.updateMany).toHaveBeenCalledWith(RENUEVA)
    expect(tx.onlineOrder.findFirst).not.toHaveBeenCalled()
    expect(b.avisos).toEqual([])
  })

  it('fuera de WEB: ni nota ni renovación', async () => {
    const b = r44()
    const tx = txTerminal(b, 150, 'TPV')
    await cobrar(tx, 34)
    await cobrar(txTerminal(b, 150, 'TPV'), 0)
    expect(tx.onlineOrder.findFirst).not.toHaveBeenCalled()
    expect(tx.onlineOrder.updateMany).not.toHaveBeenCalled()
    expect(b.avisos).toEqual([])
  })
})
