// tests/integration/fiscal/confirmarContratoDePrecio.test.ts
//
// IVA por producto, plan 2, tarea 6: confirmar a mano que una venta VIEJA (contrato DESCONOCIDO)
// se cobró con IVA incluido. Cubre los 6 casos del brief (Review Focus 4 incluido: la vista
// previa fija una versión, y si la venta cambió desde entonces el CAS rechaza sin tocar nada) más
// un séptimo caso que prueba que el registro de auditoría vive en la MISMA transacción que el
// cambio de contrato — si el log no se puede escribir, el contrato tampoco cambia.
//
// B3b, Tarea 2: la vista previa trae una `huella` de todo lo que enseña, y confirmar exige la
// huella vista — comprobada antes del UPDATE y repetida, campo por campo, en su WHERE (casos al
// final del archivo, incluida la carrera real de Postgres por campo).
import { randomUUID } from 'crypto'
import { Client } from 'pg'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { vistaPreviaContrato, confirmarContratoIvaIncluido } from '@/services/fiscal/confirmarContratoDePrecio.service'
import { confirmPriceContractSchema } from '@/schemas/dashboard/cfdi.schema'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Espera, con tope, a que PostgreSQL MUESTRE el UPDATE de la confirmación esperando un candado que tiene el racer
 * (`pg_blocking_pids` del proceso bloqueado contiene el PID del racer, y su consulta es el UPDATE de "Order").
 *
 * 🔴 Codex (B3b, código r1, P2 #3): antes había `delay(75)` + «la promesa sigue pendiente». Eso también es cierto si
 * la confirmación todavía esperaba conexión y NO había leído la orden: el racer hacía COMMIT antes de esa lectura, la
 * comparación previa de la huella devolvía CAMBIO_DESDE_LA_VISTA y la carrera quedaba verde aunque faltara la igualdad
 * del WHERE que decía probar (reproducido: sin `total` en el WHERE y la confirmación 300 ms tarde, la fila pasaba).
 * Sólo con el UPDATE bloqueado por el racer el COMMIT obliga a Postgres a re-evaluar el WHERE.
 */
async function esperarConfirmacionBloqueadaPor(racerPid: number, topeMs = 20_000): Promise<void> {
  const limite = Date.now() + topeMs
  while (Date.now() < limite) {
    const bloqueados = await prisma.$queryRawUnsafe<Array<{ pid: number }>>(
      `SELECT pid FROM pg_stat_activity
        WHERE $1::int = ANY(pg_blocking_pids(pid))
          AND wait_event_type = 'Lock'
          AND query ILIKE 'UPDATE %"Order"%'`,
      racerPid,
    )
    if (bloqueados.length > 0) return
    await delay(10)
  }
  throw new Error(`La confirmación nunca quedó bloqueada por el racer (pid ${racerPid}): la carrera no probaría el WHERE.`)
}

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
      huellaVista: preview!.huella,
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
      huellaVista: preview!.huella,
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
      huellaVista: preview!.huella,
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
      huellaVista: preview!.huella,
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
      huellaVista: 'sin-vista-previa', // no llega a compararse: la venta no es de este negocio
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
      huellaVista: preview!.huella,
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
        huellaVista: preview!.huella,
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
      huellaVista: preview!.huella,
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
      huellaVista: preview!.huella,
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
      huellaVista: preview!.huella,
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
      huellaVista: preview!.huella,
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
      const racerPid = (await racer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await racer.query('BEGIN')
      // Toma el candado de la fila y deja taxAmount=16 SIN COMMITEAR — y sin tocar `version`,
      // que es justo el bug del motor de descuentos viejo (F1).
      await racer.query('UPDATE "Order" SET "taxAmount" = 16 WHERE id = $1', [orden.id])

      const confirmPromise = confirmarContratoIvaIncluido({
        venueId,
        orderId: orden.id,
        versionVista: preview!.version,
        huellaVista: preview!.huella,
        staffId,
        motivo: 'motivo',
      }).finally(() => {
        confirmSettled = true
      })

      // La confirmación de verdad está BLOQUEADA esperando el candado de la fila — lo dice Postgres, no un reloj.
      // Si esto no fuera cierto, la carrera no estaría probando nada.
      await esperarConfirmacionBloqueadaPor(racerPid)
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

  // ─── B3b, Tarea 2: la huella de la vista previa ────────────────────────────────────────────
  //
  // El motor de descuentos, el cierre del cobro y el editor de órdenes del dashboard cambian la
  // venta SIN subir `version`. La vista previa trae una huella de todo lo que le enseña a la
  // persona (y de lo que identifica la venta), y confirmar la vuelve a comprobar. Un cambio por
  // campo, AISLADO: si un campo se cae de la huella, cae SU fila.
  it.each([
    ['discountAmount', { discountAmount: new Prisma.Decimal(10) }],
    ['total', { total: new Prisma.Decimal(90) }],
    ['paidAmount', { paidAmount: new Prisma.Decimal(50) }],
    ['paymentStatus', { paymentStatus: 'PARTIAL' as const }],
    ['orderNumber', { orderNumber: `otro-${randomUUID().slice(0, 8)}` }],
    ['createdAt', { createdAt: new Date('2026-09-15T18:00:00Z') }],
    ['status', { status: 'CONFIRMED' as const }],
  ])('vista previa → cambia SÓLO %s sin subir version → confirmar ⇒ CAMBIO_DESDE_LA_VISTA, nada cambia', async (_campo, data) => {
    const orden = await nuevaOrden({})
    const vista = await vistaPreviaContrato(venueId, orden.id)
    expect(vista!.confirmable).toBe(true)
    await prisma.order.update({ where: { id: orden.id }, data }) // como los escritores reales: sin version
    expect((await ordenActual(orden.id)).version).toBe(vista!.version) // la versión sola no lo detectaría

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: vista!.version,
      huellaVista: vista!.huella,
      staffId,
      motivo: 'm',
    })
    expect(r).toMatchObject({ ok: false, code: 'CAMBIO_DESDE_LA_VISTA' })
    expect((await prisma.order.findUnique({ where: { id: orden.id } }))!.contratoDePrecio).toBe('DESCONOCIDO')
    expect(await logDe(orden.id)).toHaveLength(0)
  })

  it('con la huella intacta confirma igual que hoy (contrato, version+1 y ActivityLog en la misma tx)', async () => {
    const orden = await nuevaOrden({})
    const vista = await vistaPreviaContrato(venueId, orden.id)
    expect(typeof vista!.huella).toBe('string')
    expect(vista!.huella.length).toBeGreaterThan(0)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: vista!.version,
      huellaVista: vista!.huella,
      staffId,
      motivo: 'm',
    })
    expect(r).toEqual({ ok: true })
    const row = await ordenActual(orden.id)
    expect(row.contratoDePrecio).toBe('IVA_INCLUIDO')
    expect(row.version).toBe(orden.version + 1)
    expect(await logDe(orden.id)).toHaveLength(1)
  })

  it('una huella que no es la de la vista previa ⇒ CAMBIO_DESDE_LA_VISTA aunque la venta no haya cambiado', async () => {
    const orden = await nuevaOrden({})
    const vista = await vistaPreviaContrato(venueId, orden.id)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: vista!.version,
      huellaVista: `${vista!.huella}-otra`,
      staffId,
      motivo: 'm',
    })
    expect(r).toMatchObject({ ok: false, code: 'CAMBIO_DESDE_LA_VISTA' })
    expect(await ordenActual(orden.id)).toMatchObject({ contratoDePrecio: 'DESCONOCIDO', version: orden.version })
    expect(await logDe(orden.id)).toHaveLength(0)
  })

  // Codex (B3b, código r1, P2 #4): la huella llevaba el folio completo y la ruta topa la huella. Con un folio largo
  // (el campo no tiene límite) la ruta rechazaba una huella que el propio servidor había generado.
  it('🔴 folio de 250 caracteres ⇒ la huella de la vista previa pasa el esquema de la ruta y la venta se confirma', async () => {
    const orden = await nuevaOrden({})
    const folioLargo = `${fixture}-${randomUUID()}-`.padEnd(250, 'F')
    expect(folioLargo).toHaveLength(250)
    await prisma.order.update({ where: { id: orden.id }, data: { orderNumber: folioLargo } })

    const vista = await vistaPreviaContrato(venueId, orden.id)
    expect(vista!.confirmable).toBe(true)
    const cuerpo = confirmPriceContractSchema.safeParse({
      params: { venueId, orderId: orden.id },
      body: { version: vista!.version, huella: vista!.huella },
    })
    expect(cuerpo.success).toBe(true)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: vista!.version,
      huellaVista: vista!.huella,
      staffId,
      motivo: 'm',
    })
    expect(r).toEqual({ ok: true })
    expect((await ordenActual(orden.id)).contratoDePrecio).toBe('IVA_INCLUIDO')
  })

  it('una venta que salió de una cotización no se confirma por la puerta nueva', async () => {
    const orden = await nuevaOrden({})
    const estimate = await prisma.estimate.create({
      data: {
        venueId,
        estimateNumber: `${fixture}-cot-${randomUUID().slice(0, 6)}`,
        subtotal: new Prisma.Decimal(100),
        total: new Prisma.Decimal(116),
        createdByName: 'FULLTEST',
        convertedOrderId: orden.id,
      } as Prisma.EstimateUncheckedCreateInput,
    })
    try {
      const vista = await vistaPreviaContrato(venueId, orden.id)
      expect(vista).toMatchObject({ confirmable: false })
      const r = await confirmarContratoIvaIncluido({
        venueId,
        orderId: orden.id,
        versionVista: vista!.version,
        huellaVista: vista!.huella,
        staffId,
        motivo: 'm',
      })
      expect(r).toMatchObject({ ok: false, code: 'NO_CONFIRMABLE' })
      expect(await ordenActual(orden.id)).toMatchObject({ contratoDePrecio: 'DESCONOCIDO' })
    } finally {
      await prisma.estimate.delete({ where: { id: estimate.id } })
    }
  })

  // ─── B3b, Tarea 2: la carrera REAL de Postgres, un campo a la vez ──────────────────────────
  //
  // El `it.each` de arriba lo atrapa la comparación PREVIA de la huella. Ésta prueba las
  // igualdades del WHERE: el escritor toma el candado de la fila y cambia un campo SIN commitear
  // (y sin subir `version`), así que la confirmación LEE la fila sin el cambio — la huella
  // coincide — y su UPDATE se bloquea. Al hacer COMMIT, Postgres vuelve a evaluar el WHERE
  // contra el dato ya comprometido (EvalPlanQual bajo READ COMMITTED): sin la igualdad de ESE
  // campo en el WHERE, la confirmación pasaría. Mismo arnés que el caso 13.
  const CARRERAS: Array<[string, string]> = [
    ['discountAmount', 'UPDATE "Order" SET "discountAmount" = 10 WHERE id = $1'],
    ['total', 'UPDATE "Order" SET "total" = 90 WHERE id = $1'],
    ['paidAmount', 'UPDATE "Order" SET "paidAmount" = 50 WHERE id = $1'],
    ['paymentStatus', `UPDATE "Order" SET "paymentStatus" = 'PARTIAL' WHERE id = $1`],
    ['orderNumber', 'UPDATE "Order" SET "orderNumber" = "orderNumber" || \'-x\' WHERE id = $1'],
    ['createdAt', `UPDATE "Order" SET "createdAt" = "createdAt" - interval '1 day' WHERE id = $1`],
    // Un estado NO terminal (PENDING → COMPLETED, como lo escribe el editor del dashboard sin subir `version`): el
    // filtro viejo `status notIn [CANCELLED, DELETED]` lo dejaba pasar; sólo la igualdad `status: o.status` lo atrapa.
    ['status', `UPDATE "Order" SET "status" = 'COMPLETED' WHERE id = $1`],
    ['status a cancelada', `UPDATE "Order" SET "status" = 'CANCELLED' WHERE id = $1`],
  ]

  it.each(CARRERAS)('carrera real: otro escritor cambia %s entre la lectura y el UPDATE ⇒ no confirma', async (_campo, sql) => {
    const orden = await nuevaOrden({})
    const vista = await vistaPreviaContrato(venueId, orden.id)
    expect(vista!.confirmable).toBe(true)

    const racer = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await racer.connect()
    let confirmSettled = false
    try {
      const racerPid = (await racer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await racer.query('BEGIN')
      // Toma el candado de la fila y deja el cambio SIN COMMITEAR, sin tocar `version`.
      await racer.query(sql, [orden.id])

      const confirmPromise = confirmarContratoIvaIncluido({
        venueId,
        orderId: orden.id,
        versionVista: vista!.version,
        huellaVista: vista!.huella,
        staffId,
        motivo: 'motivo',
      }).finally(() => {
        confirmSettled = true
      })

      // Codex B3b r1 P2 #3: Postgres tiene que MOSTRAR el UPDATE de la confirmación esperando el candado del racer
      // (la lectura ya pasó, con la huella intacta). Sólo entonces el COMMIT prueba la igualdad del WHERE.
      await esperarConfirmacionBloqueadaPor(racerPid)
      expect(confirmSettled).toBe(false)

      await racer.query('COMMIT')

      const r = await confirmPromise
      expect(r).toMatchObject({ ok: false, code: 'CAMBIO_DESDE_LA_VISTA' })
    } finally {
      await racer.end()
    }

    expect((await ordenActual(orden.id)).contratoDePrecio).toBe('DESCONOCIDO')
    expect(await logDe(orden.id)).toHaveLength(0)
  })

  it('caso Mavericks: venta de $6,040 con $2,958 de descuento ⇒ confirmar con la huella deja IVA_INCLUIDO y ya no es confirmable', async () => {
    const orden = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-mav-${randomUUID().slice(0, 8)}`,
        subtotal: new Prisma.Decimal(6040),
        taxAmount: new Prisma.Decimal(0),
        discountAmount: new Prisma.Decimal(2958),
        total: new Prisma.Decimal(3082),
        source: 'TPV',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        paidAmount: new Prisma.Decimal(3082),
      } as Prisma.OrderUncheckedCreateInput,
    })
    const vista = await vistaPreviaContrato(venueId, orden.id)
    expect(vista!.confirmable).toBe(true)

    const r = await confirmarContratoIvaIncluido({
      venueId,
      orderId: orden.id,
      versionVista: vista!.version,
      huellaVista: vista!.huella,
      staffId,
      motivo: 'Mavericks pagó con IVA incluido.',
    })
    expect(r).toEqual({ ok: true })
    // Con el contrato IVA_INCLUIDO el motivo «confírmalo antes de facturar» ya no aplica
    // (la prueba unitaria del caso Mavericks fija que entonces se factura un concepto al 0 %).
    expect((await ordenActual(orden.id)).contratoDePrecio).toBe('IVA_INCLUIDO')
    const despues = await vistaPreviaContrato(venueId, orden.id)
    expect(despues!.confirmable).toBe(false)
  })
})
