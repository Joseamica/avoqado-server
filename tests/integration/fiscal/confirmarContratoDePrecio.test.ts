// tests/integration/fiscal/confirmarContratoDePrecio.test.ts
//
// IVA por producto, plan 2, tarea 6: confirmar a mano que una venta VIEJA (contrato DESCONOCIDO)
// se cobró con IVA incluido. Cubre los 6 casos del brief (Review Focus 4 incluido: la vista
// previa fija una versión, y si la venta cambió desde entonces el CAS rechaza sin tocar nada) más
// un séptimo caso que prueba que el registro de auditoría vive en la MISMA transacción que el
// cambio de contrato — si el log no se puede escribir, el contrato tampoco cambia.
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { vistaPreviaContrato, confirmarContratoIvaIncluido } from '@/services/fiscal/confirmarContratoDePrecio.service'

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
  }) {
    const orden = await prisma.order.create({
      data: {
        venueId: opts.venueId ?? venueId,
        orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
        subtotal: new Prisma.Decimal(100),
        taxAmount: new Prisma.Decimal(opts.taxAmount ?? 0),
        total: new Prisma.Decimal(100 + (opts.taxAmount ?? 0)),
        source: opts.source ?? 'TPV',
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
})
