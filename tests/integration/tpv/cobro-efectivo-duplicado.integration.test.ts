/**
 * Integration: la RÁFAGA de toques en «Efectivo» contra POSTGRES REAL.
 *
 * 🔴 POR QUÉ EL UNIT NO BASTA. El candado de este defecto NO es una comparación en
 * JavaScript: es el `SELECT … FOR UPDATE` que `lockExistingOrderForPayment` toma sobre la
 * orden dentro de la transacción. Eso es lo que SERIALIZA los cinco cobros simultáneos y
 * hace que el segundo vea el primero YA comiteado. Un `prismaMock` no bloquea nada: con
 * mocks los cinco «ganan» y el defecto sería invisible por muchos casos unitarios que haya.
 *
 * El escenario es el de producción, ids reales: orden `cmtm7fu5n074di12aegipj432`
 * (SN00396, BAE MEZQUITAL, $0, 1 artículo), terminal `AVQD-2840744206` v2.7.2 — cinco
 * `Payment` COMPLETED en 1.7 s, referencias `CASH-<ms>` acuñadas a 5 ms entre sí y
 * `idempotencyKey` NULL, así que ni la defensa por llave ni la de referencia los vieron.
 *
 * La segunda prueba es el falso positivo que hay que NO cometer: partes iguales sobre una
 * cuenta de $100 son dos cobros LEGÍTIMOS de $50 y los dos tienen que entrar.
 */

import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.setTimeout(120000)

describe('cobro en efectivo: 5 toques concurrentes sobre una orden de $0 dejan UN solo Payment', () => {
  let organizationId: string
  let venueId: string
  let staffId: string
  let ordenCeroId: string
  let ordenCienId: string
  let ordenViejaId: string
  let ordenRafagaId: string
  let terminalId: string
  let terminalSerial: string

  const sufijo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Cash Dup Org ${sufijo}`, email: `cashdup-${sufijo}@test.com`, phone: '5550000000' },
    })
    organizationId = org.id

    const venue = await prisma.venue.create({
      data: {
        name: `Cash Dup Venue ${sufijo}`,
        slug: `cash-dup-${sufijo}`,
        organizationId: org.id,
        address: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'MX',
        zipCode: '12345',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id

    const staff = await prisma.staff.create({
      data: {
        email: `cashdup-staff-${sufijo}@test.com`,
        firstName: 'Promotor',
        lastName: 'Mezquital',
        phone: '5551110000',
        organizations: { create: { organizationId: org.id, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId: venue.id, role: 'CASHIER', active: true } },
      },
    })
    staffId = staff.id

    // La orden del incidente: total $0 (línea gratis de PlayTelecom), un artículo, PENDING.
    const ordenCero = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `SN-CERO-${sufijo}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: 0,
        taxAmount: 0,
        total: 0,
        createdById: staffId,
        items: { create: [{ quantity: 1, unitPrice: 0, taxAmount: 0, total: 0, productName: 'Línea Bait $0' }] },
      },
    })
    ordenCeroId = ordenCero.id

    // La cuenta de $100 que se paga en dos partes iguales — el falso positivo a evitar.
    const ordenCien = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `SN-CIEN-${sufijo}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        createdById: staffId,
        items: { create: [{ quantity: 1, unitPrice: 100, taxAmount: 0, total: 100, productName: 'Cuenta compartida' }] },
      },
    })
    ordenCienId = ordenCien.id

    // La PAX del incidente. La firma de la ráfaga exige que el cobro previo y el entrante
    // vengan de la MISMA terminal, así que aquí hay una de verdad y el cobro manda su serial.
    terminalSerial = `AVQD-DUP-${sufijo}`
    const terminal = await prisma.terminal.create({
      data: { venueId, serialNumber: terminalSerial, name: `PAX Dup ${sufijo}`, type: 'TPV_ANDROID' },
    })
    terminalId = terminal.id

    const ordenVieja = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `SN-VIEJA-${sufijo}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: 0,
        taxAmount: 0,
        total: 0,
        createdById: staffId,
        items: { create: [{ quantity: 1, unitPrice: 0, taxAmount: 0, total: 0, productName: 'Línea Bait $0' }] },
      },
    })
    ordenViejaId = ordenVieja.id

    const ordenRafaga = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `SN-RAFAGA-${sufijo}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: 0,
        taxAmount: 0,
        total: 0,
        createdById: staffId,
        items: { create: [{ quantity: 1, unitPrice: 0, taxAmount: 0, total: 0, productName: 'Línea Bait $0' }] },
      },
    })
    ordenRafagaId = ordenRafaga.id
  })

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.staffOrganization.deleteMany({ where: { organizationId } })
    await prisma.staff.deleteMany({ where: { id: staffId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  it('los cinco reciben el MISMO id y la base tiene una sola fila', async () => {
    const base = {
      venueId,
      amount: 0,
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      source: 'TPV',
      splitType: 'FULLPAYMENT',
      staffId,
      authorizationNumber: 'EFECTIVO',
      paidProductsId: [],
      currency: 'MXN',
      isInternational: false,
    }

    // Las cinco referencias reales del incidente (los milisegundos de las 00:17:57 UTC).
    const respuestas = await Promise.all(
      [698, 703, 709, 714, 719].map(ms =>
        recordOrderPayment(venueId, ordenCeroId, { ...base, referenceNumber: `CASH-1788481077${ms}` } as any, staffId),
      ),
    )

    const ids = new Set(respuestas.map(r => r.id))
    expect(ids.size).toBe(1)
    const filas = await prisma.payment.count({ where: { venueId, orderId: ordenCeroId, status: 'COMPLETED' } })
    expect(filas).toBe(1)
  })

  it('con $100 y partes iguales, dos cobros de $50 en efectivo SÍ entran los dos', async () => {
    const base = {
      venueId,
      amount: 5000, // centavos → $50
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      source: 'TPV',
      splitType: 'EQUALPARTS',
      staffId,
      authorizationNumber: 'EFECTIVO',
      paidProductsId: [],
      currency: 'MXN',
      isInternational: false,
      equalPartsPartySize: 2,
      equalPartsPayedFor: 1,
    }

    const primero: any = await recordOrderPayment(venueId, ordenCienId, { ...base, referenceNumber: `CASH-A-${sufijo}` } as any, staffId)
    const segundo: any = await recordOrderPayment(venueId, ordenCienId, { ...base, referenceNumber: `CASH-B-${sufijo}` } as any, staffId)

    expect(primero.id).not.toBe(segundo.id)
    const filas = await prisma.payment.count({ where: { venueId, orderId: ordenCienId, status: 'COMPLETED' } })
    expect(filas).toBe(2)

    const orden = await prisma.order.findUnique({ where: { id: ordenCienId }, select: { paymentStatus: true } })
    expect(orden?.paymentStatus).toBe('PAID')
  })
  // ── RONDA 2 — la FIRMA de la ráfaga, contra Postgres (auditoría de Codex, P1-1) ──────
  // «La orden está saldada» a secas confunde dos entregas físicas de efectivo distintas: una
  // fila encolada que se reproduce mucho después, sobre una orden que ya se cobró, se leería
  // como un toque repetido y ese dinero desaparecería del turno. Estas dos pruebas fijan los
  // dos lados de la frontera contra la base real, con la orden bloqueada y todo.

  it('un efectivo previo de hace 20 minutos NO es un toque repetido: el cobro entra y quedan DOS filas', async () => {
    await prisma.payment.create({
      data: {
        venueId,
        orderId: ordenViejaId,
        amount: 0,
        tipAmount: 0,
        feeAmount: 0,
        feePercentage: 0,
        netAmount: 0,
        method: 'CASH',
        source: 'TPV',
        status: 'COMPLETED',
        type: 'REGULAR',
        splitType: 'FULLPAYMENT',
        terminalId,
        referenceNumber: `CASH-VIEJO-${sufijo}`,
        createdAt: new Date(Date.now() - 20 * 60_000),
      },
    })

    await recordOrderPayment(
      venueId,
      ordenViejaId,
      {
        venueId,
        amount: 0,
        tip: 0,
        status: 'COMPLETED',
        method: 'CASH',
        source: 'TPV',
        splitType: 'FULLPAYMENT',
        staffId,
        authorizationNumber: 'EFECTIVO',
        paidProductsId: [],
        currency: 'MXN',
        isInternational: false,
        deviceSerialNumber: terminalSerial,
        referenceNumber: `CASH-NUEVO-${sufijo}`,
      } as any,
      staffId,
    )

    const filas = await prisma.payment.count({ where: { venueId, orderId: ordenViejaId, status: 'COMPLETED' } })
    expect(filas).toBe(2)
  })

  it('misma terminal, mismo monto y hace 30 s: es la ráfaga — se devuelve el existente y sigue habiendo UNA fila', async () => {
    const previo = await prisma.payment.create({
      data: {
        venueId,
        orderId: ordenRafagaId,
        amount: 0,
        tipAmount: 0,
        feeAmount: 0,
        feePercentage: 0,
        netAmount: 0,
        method: 'CASH',
        source: 'TPV',
        status: 'COMPLETED',
        type: 'REGULAR',
        splitType: 'FULLPAYMENT',
        terminalId,
        referenceNumber: `CASH-RAFAGA-A-${sufijo}`,
        createdAt: new Date(Date.now() - 30_000),
      },
    })

    const respuesta: any = await recordOrderPayment(
      venueId,
      ordenRafagaId,
      {
        venueId,
        amount: 0,
        tip: 0,
        status: 'COMPLETED',
        method: 'CASH',
        source: 'TPV',
        splitType: 'FULLPAYMENT',
        staffId,
        authorizationNumber: 'EFECTIVO',
        paidProductsId: [],
        currency: 'MXN',
        isInternational: false,
        deviceSerialNumber: terminalSerial,
        referenceNumber: `CASH-RAFAGA-B-${sufijo}`,
      } as any,
      staffId,
    )

    expect(respuesta.id).toBe(previo.id)
    const filas = await prisma.payment.count({ where: { venueId, orderId: ordenRafagaId, status: 'COMPLETED' } })
    expect(filas).toBe(1)

    // El cobro que el servidor decidió NO registrar deja rastro en la bitácora del negocio.
    // ⚠️ Aquí se comprueba la LLAMADA, no la fila: `integration-setup.ts` mockea
    // `activity-log.service` para toda la suite de integración («fire-and-forget, not relevant
    // for integration test assertions»), así que ninguna prueba de este carril puede leer un
    // `ActivityLog` real. Lo que esto sí demuestra es que el camino REAL del cobro —con la
    // orden bloqueada y Postgres de verdad— llega a escribir la bitácora con el cobro correcto.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CASH_PAYMENT_DEDUPLICATED',
        entity: 'Payment',
        entityId: previo.id,
        venueId,
      }),
    )
  })
})
