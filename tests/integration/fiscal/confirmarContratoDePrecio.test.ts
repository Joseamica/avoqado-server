// tests/integration/fiscal/confirmarContratoDePrecio.test.ts
//
// IVA por producto, plan 2, tarea 6: confirmar a mano que una venta VIEJA (contrato DESCONOCIDO)
// se cobró con IVA incluido. Cubre los 6 casos del brief (Review Focus 4 incluido: la vista
// previa fija una versión, y si la venta cambió desde entonces el CAS rechaza sin tocar nada) más
// un séptimo caso que prueba que el registro de auditoría vive en la MISMA transacción que el
// cambio de contrato — si el log no se puede escribir, el contrato tampoco cambia.
import { randomUUID } from 'crypto'
import { Client } from 'pg'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { vistaPreviaContrato, confirmarContratoIvaIncluido } from '@/services/fiscal/confirmarContratoDePrecio.service'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('confirmarContratoDePrecio (integración)', () => {
  beforeAll(() => {
    const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '')
    expect(['localhost', '127.0.0.1']).toContain(url.hostname)
    expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_|av_db_25_iva_test)/)
  })

  const fixture = `confirmar-contrato-${randomUUID().slice(0, 8)}`
  let venueId: string
  let otroVenueId: string
  let staffId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' },
    })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: org.id, name: fixture, slug: fixture } })).id
    otroVenueId = (
      await prisma.venue.create({
        data: { id: `${fixture}-otro`, organizationId: org.id, name: `${fixture}-otro`, slug: `${fixture}-otro` },
      })
    ).id
    staffId = (await prisma.staff.create({ data: { email: `${fixture}@staff.test`, firstName: 'Confirmar', lastName: 'Contrato' } })).id
  })

  afterAll(async () => {
    await prisma.activityLog.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
    await prisma.order.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
    await prisma.venue.deleteMany({ where: { id: { in: [venueId, otroVenueId] } } })
    await prisma.staff.deleteMany({ where: { id: staffId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
    await prisma.$disconnect()
  })

  /** Una orden mínima, con los campos que decide cada caso. */
  async function nuevaOrden(opts: {
    venueId?: string
    taxAmount?: number
    source?: 'TPV' | 'POS'
    contratoDePrecio?: 'DESCONOCIDO' | 'IVA_INCLUIDO'
    status?: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'DELETED'
    paymentStatus?: 'PENDING' | 'PARTIAL' | 'PAID' | 'REFUNDED'
    paidAmount?: number
  }) {
    const orden = await prisma.order.create({
      data: {
        venueId: opts.venueId ?? venueId,
        orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
        subtotal: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(opts.taxAmount ?? 0),
        total: new Prisma.Decimal(100 + (opts.taxAmount ?? 0)),
        source: opts.source ?? 'TPV',
        status: opts.status ?? 'PENDING',
        paymentStatus: opts.paymentStatus ?? 'PENDING',
        paidAmount: new Prisma.Decimal(opts.paidAmount ?? 0),
      } as Prisma.OrderUncheckedCreateInput,
    })
    if (opts.contratoDePrecio && opts.contratoDePrecio !== 'DESCONOCIDO') {
      await prisma.$executeRawUnsafe(
        `UPDATE "Order" SET "contratoDePrecio" = $1::"ContratoDePrecio" WHERE id = $2`,
        opts.contratoDePrecio,
        orden.id,
      )
    }
    return orden
  }

  async function ordenActual(orderId: string) {
    return prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  }

  async function logDe(orderId: string) {
    return prisma.activityLog.findMany({ where: { action: 'ORDER_PRICE_CONTRACT_CONFIRMED', entityId: orderId } })
  }

  it('1. DESCONOCIDO + taxAmount 0 + source TPV ⇒ confirmable; confirmar sube la versión y deja rastro de auditoría', async () => {
    const orden = await nuevaOrden({})

    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview).not.toBeNull()
    expect(preview!.confirmable).toBe(true)
    expect(preview!.motivo).toBeUndefined()
    expect(preview!.version).toBe(orden.version)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: preview!.version,
      staffId,
      motivo: 'Cliente confirmó por WhatsApp que el ticket ya traía el IVA incluido.',
    })
    expect(r).toEqual({ ok: true })

    const row = await ordenActual(orden.id)
    expect(row.contratoDePrecio).toBe('IVA_INCLUIDO')
    expect(row.version).toBe(orden.version + 1)

    const logs = await logDe(orden.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      entityId: orden.id,
      staffId,
      data: expect.objectContaining({ motivo: 'Cliente confirmó por WhatsApp que el ticket ya traía el IVA incluido.' }),
    })
  })

  it('2. (Review Focus 4) la venta cambió DESPUÉS de la vista previa ⇒ CAMBIO_DESDE_LA_VISTA; no cambia nada y no hay auditoría', async () => {
    const orden = await nuevaOrden({})
    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(true)

    // Alguien más tocó la venta entre la vista previa y la confirmación.
    await prisma.order.update({ where: { id: orden.id }, data: { version: { increment: 1 } } })

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: preview!.version, // la versión VIEJA, ya obsoleta
      staffId,
      motivo: 'motivo',
    })
    expect(r).toEqual({ ok: false, code: 'CAMBIO_DESDE_LA_VISTA', message: expect.any(String) })

    const row = await ordenActual(orden.id)
    expect(row.contratoDePrecio).toBe('DESCONOCIDO')
    expect(await logDe(orden.id)).toHaveLength(0)
  })

  it('3. taxAmount 16 (impuesto aparte) ⇒ NO_CONFIRMABLE, mensaje en español', async () => {
    const orden = await nuevaOrden({ taxAmount: 16 })

    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(false)
    expect(preview!.motivo).toMatch(/impuesto/i)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: preview!.version,
      staffId,
      motivo: 'motivo',
    })
    expect(r).toMatchObject({ ok: false, code: 'NO_CONFIRMABLE' })
    expect((r as { message: string }).message).toMatch(/[a-záéíóúñ]/) // mensaje en español, no un código en inglés
    expect(await ordenActual(orden.id)).toMatchObject({ contratoDePrecio: 'DESCONOCIDO' })
  })

  it('4. source POS ⇒ NO_CONFIRMABLE', async () => {
    const orden = await nuevaOrden({ source: 'POS' })

    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(false)
    expect(preview!.motivo).toMatch(/SoftRestaurant/)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: preview!.version,
      staffId,
      motivo: 'motivo',
    })
    expect(r).toMatchObject({ ok: false, code: 'NO_CONFIRMABLE' })
  })

  it('5. orden de OTRO venue ⇒ NO_ENCONTRADA, y la vista previa devuelve null', async () => {
    const orden = await nuevaOrden({ venueId: otroVenueId })

    expect(await vistaPreviaContrato(venueId, orden.id)).toBeNull()

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: orden.version,
      staffId,
      motivo: 'motivo',
    })
    expect(r).toMatchObject({ ok: false, code: 'NO_ENCONTRADA' })
    expect(await ordenActual(orden.id)).toMatchObject({ contratoDePrecio: 'DESCONOCIDO', venueId: otroVenueId })
  })

  it('6. orden ya IVA_INCLUIDO ⇒ NO_CONFIRMABLE («ya tiene un contrato»)', async () => {
    const orden = await nuevaOrden({ contratoDePrecio: 'IVA_INCLUIDO' })

    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(false)
    expect(preview!.motivo).toMatch(/ya tiene un contrato/)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: preview!.version,
      staffId,
      motivo: 'motivo',
    })
    expect(r).toMatchObject({ ok: false, code: 'NO_CONFIRMABLE', message: expect.stringMatching(/ya tiene un contrato/) })
  })

  // ─── Step 7: el log vive en la MISMA transacción ───────────────────────────────────────────
  //
  // Si `writeLegacyActivityAuditTx` se moviera FUERA de la transacción, un fallo al escribir el
  // log (aquí: un staffId que viola la FK de ActivityLog.staffId → Staff) dejaría el UPDATE del
  // contrato ya comprometido mientras la excepción revienta después. Con el log DENTRO de la
  // transacción, la misma excepción revierte también el cambio de contrato.
  it('7. si el registro de auditoría no se puede escribir (staffId inexistente ⇒ FK), la venta NO cambia', async () => {
    const orden = await nuevaOrden({})
    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(true)

    const staffInexistente = `staff-que-no-existe-${randomUUID()}`

    await expect(
      confirmarContratoIvaIncluido({
        venueId,
        orderId: orden.id,
        versionVista: preview!.version,
        staffId: staffInexistente,
        motivo: 'motivo',
      }),
    ).rejects.toThrow()

    const row = await ordenActual(orden.id)
    expect(row.contratoDePrecio).toBe('DESCONOCIDO')
    expect(row.version).toBe(orden.version)
    expect(await logDe(orden.id)).toHaveLength(0)
  })

  // ─── F1 (revisión final): taxAmount < 0 tiene SU PROPIO mensaje ────────────────────────────
  //
  // El motor de descuentos viejo le resta un 16% estimado a `taxAmount` aunque la venta haya
  // cobrado con IVA incluido, dejando `taxAmount < 0`. Decir «separó el impuesto» (el mensaje de
  // taxAmount > 0) ahí sería mentira: son dos causas distintas.
  it('8. (F1) taxAmount NEGATIVO (ajuste del motor de descuentos viejo) ⇒ NO_CONFIRMABLE con SU PROPIO mensaje, distinto de «separó el impuesto»', async () => {
    const orden = await nuevaOrden({ taxAmount: -5 })

    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(false)
    expect(preview!.motivo).toMatch(/motor de descuentos/i)
    expect(preview!.motivo).not.toMatch(/separó el impuesto/i)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: preview!.version,
      staffId,
      motivo: 'motivo',
    })
    expect(r).toMatchObject({ ok: false, code: 'NO_CONFIRMABLE' })
    expect((r as { message: string }).message).toMatch(/motor de descuentos/i)
    expect(await ordenActual(orden.id)).toMatchObject({ contratoDePrecio: 'DESCONOCIDO' })
  })

  // ─── F3: una venta cancelada o borrada nunca se confirma ───────────────────────────────────
  it('9. (F3) orden CANCELLED ⇒ NO_CONFIRMABLE, «Esta venta está cancelada; no se factura.»', async () => {
    const orden = await nuevaOrden({ status: 'CANCELLED' })

    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(false)
    expect(preview!.motivo).toBe('Esta venta está cancelada; no se factura.')
    expect(preview!.status).toBe('CANCELLED')

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: preview!.version,
      staffId,
      motivo: 'motivo',
    })
    expect(r).toMatchObject({ ok: false, code: 'NO_CONFIRMABLE', message: 'Esta venta está cancelada; no se factura.' })
    expect(await ordenActual(orden.id)).toMatchObject({ contratoDePrecio: 'DESCONOCIDO' })
  })

  // ─── F3: la vista previa nunca dice «cobrada» de una venta que no se ha cobrado ────────────
  it('10. (F3) orden SIN COBRAR (paymentStatus PENDING) ⇒ sigue confirmable, y la vista previa trae los datos para NO decir «cobrada»', async () => {
    const orden = await nuevaOrden({ paymentStatus: 'PENDING', paidAmount: 0 })

    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(true)
    expect(preview!.status).toBe('PENDING')
    expect(preview!.paymentStatus).toBe('PENDING')
    expect(preview!.paidAmountMxn).toBe(0)

    // Sigue siendo confirmable — no cobrar no es motivo para bloquear el contrato de precio.
    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: preview!.version,
      staffId,
      motivo: 'motivo',
    })
    expect(r).toEqual({ ok: true })
  })

  it('11. (F3) orden PAGADA ⇒ la vista previa trae paymentStatus/paidAmountMxn correctos', async () => {
    const orden = await nuevaOrden({ paymentStatus: 'PAID', paidAmount: 100 })

    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(true)
    expect(preview!.paymentStatus).toBe('PAID')
    expect(preview!.paidAmountMxn).toBe(100)
  })

  // ─── F8: la bitácora lleva el snapshot de la venta ─────────────────────────────────────────
  it('12. (F8) el log de auditoría lleva orderNumber/total/paidAmount de la venta confirmada', async () => {
    const orden = await nuevaOrden({ paymentStatus: 'PAID', paidAmount: 100 })
    const preview = await vistaPreviaContrato(venueId, orden.id)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: preview!.version,
      staffId,
      motivo: 'motivo',
    })
    expect(r).toEqual({ ok: true })

    const logs = await logDe(orden.id)
    expect(logs).toHaveLength(1)
    expect(logs[0].data).toMatchObject({
      orderNumber: orden.orderNumber,
      total: 100,
      paidAmount: 100,
    })
  })

  // ─── F2 (TOCTOU): el CAS se re-comprueba contra el dato COMMITEADO, no contra el que se leyó ──
  //
  // Reproduce con una carrera de Postgres REAL (no un mock): un segundo cliente toma el candado
  // de la fila ANTES de arrancar la confirmación, así que el SELECT de `confirmarContratoIvaIncluido`
  // lee taxAmount=0 (todavía no comprometido el cambio) y decide "confirmable", pero su propio
  // UPDATE se queda BLOQUEADO esperando el candado — exactamente la ventana entre la vista previa
  // y el CAS que el motor de descuentos viejo (que no toca `version`) puede colar un taxAmount
  // distinto de cero. Al soltar el candado, Postgres vuelve a evaluar el WHERE del UPDATE contra
  // el dato YA comprometido (EvalPlanQual bajo READ COMMITTED): si el WHERE no incluye taxAmount,
  // el viejo CAS lo deja pasar de todas formas.
  it('13. (F2) el motor de descuentos cambia taxAmount SIN tocar version, exactamente entre la lectura y el CAS ⇒ no confirma', async () => {
    const orden = await nuevaOrden({})
    const preview = await vistaPreviaContrato(venueId, orden.id)
    expect(preview!.confirmable).toBe(true)

    const racer = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await racer.connect()
    let confirmSettled = false
    try {
      await racer.query('BEGIN')
      // Toma el candado de la fila y deja taxAmount=16 SIN COMMITEAR — y sin tocar `version`,
      // que es justo el bug del motor de descuentos viejo (F1).
      await racer.query('UPDATE "Order" SET "taxAmount" = 16 WHERE id = $1', [orden.id])

      const confirmPromise = confirmarContratoIvaIncluido({
        venueId,
        orderId: orden.id,
        versionVista: preview!.version,
        staffId,
        motivo: 'motivo',
      }).finally(() => {
        confirmSettled = true
      })

      // Confirma que la confirmación de verdad está BLOQUEADA esperando el candado de la fila
      // — si esto no fuera cierto, la carrera no estaría probando nada.
      await delay(75)
      expect(confirmSettled).toBe(false)

      // Suelta el candado: taxAmount=16 pasa a ser el valor COMMITEADO justo cuando el UPDATE
      // de la confirmación por fin se ejecuta.
      await racer.query('COMMIT')

      const r = await confirmPromise
      expect(r.ok).toBe(false)
      expect((r as { code: string }).code).toBe('CAMBIO_DESDE_LA_VISTA')
    } finally {
      await racer.end()
    }

    const row = await ordenActual(orden.id)
    expect(row.contratoDePrecio).toBe('DESCONOCIDO')
    expect(await logDe(orden.id)).toHaveLength(0)
  })
})
