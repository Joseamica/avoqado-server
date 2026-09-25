// tests/integration/fiscal/orderContratoDePrecio.posSync.test.ts
//
// IVA por producto, plan 2, tarea 4: SoftRestaurant manda el impuesto APARTE del subtotal
// (`PosOrderData.taxAmount` es un campo separado) — la orden que nace de este bridge es el
// caso canónico de `IVA_APARTE`. Y una vez nacida, un REPROCESO del mismo evento (que cae en
// la rama `update:` del upsert) NUNCA debe reescribir el contrato: si alguien corrigió el
// valor a mano tras auditar el comercio, un reintento del bridge no puede deshacer esa
// corrección en silencio.
//
// No existe ningún harness de integración reusable para `processPosOrderEvent`
// (`grep -rln "posSyncOrder" tests/integration` da vacío el 25-sep): este archivo siembra
// el mínimo que la función pública exige — Organization + Venue — y pasa `staffData` /
// `tableData` / `shiftData` con `externalId: null`, que los tres helpers (`syncPosStaff`,
// `getOrCreatePosTable`, `getOrCreatePosShift`) tratan como "nada que sincronizar" y
// devuelven `null` sin tocar la base — así la orden nace sin depender de Staff/Table/Shift,
// que son ortogonales al contrato de precio que esta prueba verifica.
import prisma from '@/utils/prismaClient'
import { processPosOrderEvent, cleanupPaymentCache } from '@/services/pos-sync/posSyncOrder.service'
import { OrderStatus, PaymentStatus } from '@prisma/client'
import type { RichPosPayload } from '@/types/pos.types'

describe('Order.contratoDePrecio — pos-sync / SoftRestaurant (integración)', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `PS ${s}`, email: `ps-${s}@example.com`, phone: '5555555555' } })
    organizationId = org.id
    venueId = (await prisma.venue.create({ data: { organizationId, name: `PS ${s}`, slug: `ps-${s}`, seatCapExempt: true } })).id
  })

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    cleanupPaymentCache()
    await prisma.$disconnect()
  })

  function eventoDeOrden(externalId: string): RichPosPayload {
    return {
      venueId,
      orderData: {
        externalId,
        orderNumber: `ORD-${externalId}`,
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
        subtotal: 100,
        taxAmount: 16,
        discountAmount: 0,
        tipAmount: 0,
        total: 116,
        createdAt: new Date().toISOString(),
        completedAt: null,
        posRawData: { origen: 'integration-test' },
      },
      // externalId: null ⇒ los tres helpers devuelven `null` sin escribir en la base
      // (verificado leyendo `posSyncStaff.service.ts:21`, `posSyncTable.service.ts:10`,
      // `posSyncShift.service.ts:88`): esta prueba no necesita Staff/Table/Shift.
      staffData: { externalId: null, name: null, pin: null },
      tableData: { externalId: null },
      shiftData: { externalId: null, startTime: null },
      payments: [],
      paymentMethodsCatalog: [],
    }
  }

  it('la orden NUEVA nace IVA_APARTE (SoftRestaurant manda el impuesto aparte)', async () => {
    const externalId = `ps-${s}-nueva`

    const order = await processPosOrderEvent(eventoDeOrden(externalId))

    expect(order.contratoDePrecio).toBe('IVA_APARTE')
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(row.contratoDePrecio).toBe('IVA_APARTE')
  })

  it('reprocesar el MISMO evento (rama `update:`) no reescribe un contrato ya corregido a mano', async () => {
    const externalId = `ps-${s}-reprocesada`

    const primero = await processPosOrderEvent(eventoDeOrden(externalId))
    expect(primero.contratoDePrecio).toBe('IVA_APARTE')

    // Alguien corrige el contrato a mano (p. ej. tras auditar el comercio) — el reproceso
    // del bridge NO debe pisar esta corrección.
    await prisma.$executeRawUnsafe(`UPDATE "Order" SET "contratoDePrecio" = 'DESCONOCIDO' WHERE id = $1`, primero.id)
    const corregida = await prisma.order.findUniqueOrThrow({ where: { id: primero.id } })
    expect(corregida.contratoDePrecio).toBe('DESCONOCIDO')

    // Mismo externalId ⇒ `findExistingOrderWithSmartResolution` encuentra la fila exacta y
    // el upsert cae en la rama `update:`, que nunca declara `contratoDePrecio`.
    const segundo = await processPosOrderEvent(eventoDeOrden(externalId))
    expect(segundo.id).toBe(primero.id)

    const row = await prisma.order.findUniqueOrThrow({ where: { id: primero.id } })
    expect(row.contratoDePrecio).toBe('DESCONOCIDO')
  })
})
