// tests/integration/fiscal/sellosHeredados.test.ts
//
// IVA por producto, plan 6b, Tarea 4 (D11 ampliada, D21, §5.2b): una factura HEREDADA (sin `protocoloIva`, timbrada por la ruta vieja)
// no selló sus renglones. Se sella con la tasa ÚNICA de su XML —lo que tiene el SAT— aunque el producto hoy diga otra, y la regla no
// depende de si el negocio está encendido. Contra Postgres real: el sellado es SQL y la restricción de las heredadas vive en la base.
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  aplicarSelladoHeredado,
  planDeSelladoHeredado,
  SelloHeredadoDivergente,
  SIN_REPARAR,
  MOTIVO_CAMBIO_AL_REVISAR,
  MOTIVO_NO_INDIVIDUAL,
  MOTIVO_SELLO_DISTINTO,
  MOTIVO_XML_ILEGIBLE,
  MOTIVO_XML_SIN_TASA_UNICA,
} from '@/services/fiscal/sellosHeredados'
import { resolverTratamiento } from '@/services/fiscal/ivaDeRenglon'
import { sellarRenglones } from '@/services/fiscal/sellosIva'
import { apagarIvaPorProducto, encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

// Antes de registrar cualquier siembra o limpieza: nunca aceptar la base compartida.
const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const testDatabase = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(testDatabase.hostname) ||
  !(
    ['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808', '/avoqado_cambio_r5_test_20261024'].includes(
      testDatabase.pathname,
    ) || isDisposableH1Url(testDatabase)
  )
) {
  throw new Error('Esta suite exige la base local av_db_25_iva_test o una base H1 desechable validada.')
}

const traslado = (tipoFactor: 'Tasa' | 'Exento', tasa: string | null) => ({
  impuesto: '002',
  tipoFactor,
  tasa,
  base: '100.00',
  importe: tipoFactor === 'Exento' ? null : tasa === '0.000000' ? '0.00' : '16.00',
})
const xmlDe = (...tasas: Array<'0.160000' | '0.000000'>) => ({
  version: 1,
  subTotal: '100.00',
  descuento: '0.00',
  total: '116.00',
  totalImpuestosTrasladados: '16.00',
  conceptos: tasas.map(t => ({
    noIdentificacion: null,
    objetoImp: '02',
    importe: '100.00',
    descuento: '0.00',
    traslados: [traslado('Tasa', t)],
  })),
})
const XML_16 = xmlDe('0.160000')
const XML_0 = xmlDe('0.000000')

describe('sellosHeredados (integración): sellar las facturas heredadas con la tasa única de su XML', () => {
  const venues: string[] = []
  let sufijo = 0

  afterAll(async () => {
    for (const venueId of venues) {
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.orderItemSelloIva.deleteMany({ where: { orderItem: { order: { venueId } } } })
      await prisma.cfdi.deleteMany({ where: { venueId } })
      await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
      await prisma.venueIvaPorProducto.deleteMany({ where: { venueId } })
      const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      if (v) await prisma.organization.deleteMany({ where: { id: v.organizationId } })
    }
    await prisma.$disconnect()
  })

  /** Un negocio propio por prueba: el plan es por negocio y así ninguna prueba ve las facturas de otra. */
  async function armarNegocio(o: { productoIva?: 'IVA_0'; encendido?: boolean } = {}) {
    const id = `sh-${randomUUID().slice(0, 8)}-${sufijo++}`
    await prisma.organization.create({ data: { id, name: id, email: `${id}@example.test`, phone: '5500000000' } })
    const venueId = (await prisma.venue.create({ data: { id, organizationId: id, name: id, slug: id } })).id
    venues.push(venueId)
    const category = await prisma.menuCategory.create({ data: { venueId, name: id, slug: id } })
    const productId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: id, sku: id, price: 116 } })).id
    const fiscalEmisorId = (
      await prisma.fiscalEmisor.create({
        data: { venueId, rfc: 'AAA010101AAA', legalName: id, regimenFiscal: '601', lugarExpedicion: '01000', csdStatus: 'ACTIVE' },
      })
    ).id
    if (o.productoIva || o.encendido) await encenderIvaPorProducto(venueId)
    if (o.productoIva) await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: o.productoIva } })
    if (o.encendido === false) await apagarIvaPorProducto(venueId)
    return { venueId, productId, fiscalEmisorId }
  }
  type Negocio = Awaited<ReturnType<typeof armarNegocio>>

  /** Una orden con 2 renglones del producto del negocio, sin sellar. */
  async function nuevaOrden(n: Negocio) {
    const orden = await prisma.order.create({
      data: {
        venueId: n.venueId,
        orderNumber: `sh-${randomUUID().slice(0, 8)}`,
        subtotal: new Prisma.Decimal(200),
        taxAmount: new Prisma.Decimal(32),
        total: new Prisma.Decimal(232),
      } as Prisma.OrderUncheckedCreateInput,
    })
    for (let i = 0; i < 2; i++) {
      await prisma.orderItem.create({
        data: {
          orderId: orden.id,
          productId: n.productId,
          productName: `Artículo ${i + 1}`,
          quantity: 1,
          unitPrice: new Prisma.Decimal(100),
          taxAmount: new Prisma.Decimal(16),
          total: new Prisma.Decimal(116),
        } as Prisma.OrderItemUncheckedCreateInput,
      })
    }
    const items = await prisma.orderItem.findMany({ where: { orderId: orden.id }, select: { id: true }, orderBy: { id: 'asc' } })
    return { orderId: orden.id, itemIds: items.map(i => i.id) }
  }

  /** Una factura. Por omisión es heredada (`protocoloIva` nulo), individual, de ingreso y timbrada, con attempts 3. */
  const nuevoCfdi = (n: Negocio, orderId: string | null, extra: Partial<Prisma.CfdiUncheckedCreateInput> = {}) =>
    prisma.cfdi.create({
      data: {
        venueId: n.venueId,
        fiscalEmisorId: n.fiscalEmisorId,
        type: 'INGRESO',
        status: 'STAMPED',
        flow: 'AUTOFACTURA_A',
        orderId,
        serie: 'A',
        folio: String(Math.floor(Math.random() * 1_000_000)),
        receptorRfc: 'EKU9003173C9',
        receptorNombre: 'ESCUELA KEMPER URGATE',
        receptorRegimen: '601',
        receptorCp: '64000',
        usoCfdi: 'G03',
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        idempotencyKey: `sh-${randomUUID()}`,
        attempts: 3,
        updatedAt: new Date(),
        ...extra,
      } as Prisma.CfdiUncheckedCreateInput,
    })

  const tratamientos = async (orderId: string) =>
    (await prisma.orderItem.findMany({ where: { orderId }, select: { ivaTratamiento: true }, orderBy: { id: 'asc' } })).map(
      i => i.ivaTratamiento,
    )
  const sellosDe = (cfdiId: string) => prisma.orderItemSelloIva.findMany({ where: { cfdiId } })
  const aplicar = (plan: Awaited<ReturnType<typeof planDeSelladoHeredado>>) =>
    prisma.$transaction(tx => aplicarSelladoHeredado(tx, plan, { staffId: null, origen: 'PUESTA_AL_DIA' }))

  it('1 · §5.2b, el caso del café: el producto hoy es 0 %, la factura salió al 16 % ⇒ los renglones se sellan al 16 %', async () => {
    const n = await armarNegocio({ productoIva: 'IVA_0', encendido: true })
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })

    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.noSellables).toEqual([])
    expect(plan.sellables).toEqual([
      expect.objectContaining({ cfdiId: f.id, orderId: o.orderId, attempts: 3, tratamiento: 'IVA_16', folio: `A-${f.folio}` }),
    ])

    const r = await aplicar(plan)
    expect(r.cambiaron).toEqual([])
    expect(r.sellados).toEqual([{ cfdiId: f.id, folio: `A-${f.folio}`, tratamiento: 'IVA_16', renglones: 2 }])
    expect(await tratamientos(o.orderId)).toEqual(['IVA_16', 'IVA_16'])
    const sellos = await sellosDe(f.id)
    expect(sellos).toHaveLength(2)
    expect(sellos.every(s => s.intento === 3)).toBe(true)

    const log = await prisma.activityLog.findMany({ where: { venueId: n.venueId, action: 'CFDI_HEREDADA_SELLADA' } })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ entity: 'Cfdi', entityId: f.id })
    expect(log[0].data).toMatchObject({ factura: `A-${f.folio}`, tratamiento: 'IVA_16', renglones: 2, origen: 'PUESTA_AL_DIA' })

    // El renglón sellado manda sobre el producto, que sigue diciendo 0 %.
    const producto = await prisma.product.findUniqueOrThrow({ where: { id: n.productId }, select: { ivaTratamiento: true } })
    expect(producto.ivaTratamiento).toBe('IVA_0')
    const [renglon] = await prisma.orderItem.findMany({ where: { orderId: o.orderId }, select: { ivaTratamiento: true } })
    expect(resolverTratamiento({ selladoIva: renglon.ivaTratamiento, productoIva: producto.ivaTratamiento, tieneProducto: true })).toBe(
      'IVA_16',
    )
  })

  it('2 · la A-36: una heredada con XML todo al 0 % se sella IVA_0', async () => {
    const n = await armarNegocio({ encendido: true })
    const o = await nuevaOrden(n)
    await nuevoCfdi(n, o.orderId, { serie: 'A', folio: '36', xmlConceptos: XML_0 })

    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.sellables).toEqual([expect.objectContaining({ folio: 'A-36', tratamiento: 'IVA_0' })])
    await aplicar(plan)
    expect(await tratamientos(o.orderId)).toEqual(['IVA_0', 'IVA_0'])
  })

  it('3 · ya sellada: plan + aplicar DOS veces; la segunda el plan viene vacío y nada se duplica (idempotente)', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })

    await aplicar(await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR }))
    const antes = { sellos: (await sellosDe(f.id)).length, log: await prisma.activityLog.count({ where: { venueId: n.venueId } }) }
    expect(antes).toEqual({ sellos: 2, log: 1 })

    const plan2 = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan2).toEqual({ venueId: n.venueId, sellables: [], noSellables: [] })
    const r2 = await aplicar(plan2)
    expect(r2).toEqual({ sellados: [], cambiaron: [] })
    expect({ sellos: (await sellosDe(f.id)).length, log: await prisma.activityLog.count({ where: { venueId: n.venueId } }) }).toEqual(antes)
  })

  it('4 · XML mixto (16 % y 0 %) ⇒ no sellable con su motivo, y nada escrito', async () => {
    const n = await armarNegocio({ encendido: true })
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: xmlDe('0.160000', '0.000000') })

    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.sellables).toEqual([])
    expect(plan.noSellables).toEqual([{ cfdiId: f.id, folio: `A-${f.folio}`, motivo: MOTIVO_XML_SIN_TASA_UNICA }])
    expect(await aplicar(plan)).toEqual({ sellados: [], cambiaron: [] })
    expect(await tratamientos(o.orderId)).toEqual([null, null])
    expect(await sellosDe(f.id)).toHaveLength(0)
    expect(await prisma.activityLog.count({ where: { venueId: n.venueId } })).toBe(0)
  })

  it('5 · sin XML y el PAC tampoco lo da: se pide UNA vez y queda como ilegible', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: Prisma.DbNull })
    const reparar = jest.fn().mockResolvedValue('XML_NO_DISPONIBLE')

    const plan = await planDeSelladoHeredado(n.venueId, { reparar })
    expect(reparar).toHaveBeenCalledTimes(1)
    expect(reparar).toHaveBeenCalledWith(f.id)
    expect(plan.sellables).toEqual([])
    expect(plan.noSellables).toEqual([{ cfdiId: f.id, folio: `A-${f.folio}`, motivo: MOTIVO_XML_ILEGIBLE }])
  })

  it('5b · sin XML pero el PAC lo da: la reparación lo escribe, el plan lo relee y la sella', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: Prisma.DbNull })
    const reparar = jest.fn(async (id: string) => {
      await prisma.cfdi.update({ where: { id }, data: { xmlConceptos: XML_0 } })
      return 'OK'
    })

    const plan = await planDeSelladoHeredado(n.venueId, { reparar })
    expect(reparar).toHaveBeenCalledTimes(1)
    expect(plan.sellables).toEqual([expect.objectContaining({ cfdiId: f.id, tratamiento: 'IVA_0' })])
    await aplicar(plan)
    expect(await tratamientos(o.orderId)).toEqual(['IVA_0', 'IVA_0'])
  })

  it('6 · una CANCELLED no aparece en el plan (no hay nada que sellar)', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    await nuevoCfdi(n, o.orderId, { status: 'CANCELLED', xmlConceptos: XML_16 })

    expect(await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })).toEqual({ venueId: n.venueId, sellables: [], noSellables: [] })
  })

  it('6b · una CANCEL_REQUESTED sí entra (todavía vale ante el SAT)', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { status: 'CANCEL_REQUESTED', xmlConceptos: XML_16 })

    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.sellables).toEqual([expect.objectContaining({ cfdiId: f.id, tratamiento: 'IVA_16' })])
  })

  it('6c · las de protocolo nuevo (C3, F6, la ruta nueva) nunca entran al plan, aunque sus renglones estén sin sellar', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    await nuevoCfdi(n, o.orderId, { protocoloIva: 1, xmlConceptos: XML_16 })

    expect(await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })).toEqual({ venueId: n.venueId, sellables: [], noSellables: [] })
  })

  it('7 · un renglón ya sellado con OTRA tasa por otro documento ⇒ no sellable (sin 500) y nada a medias', async () => {
    const n = await armarNegocio({ encendido: true })
    const o = await nuevaOrden(n)
    const nueva = await nuevoCfdi(n, o.orderId, { protocoloIva: 1, status: 'DRAFT' })
    await prisma.$transaction(tx =>
      sellarRenglones(tx, { cfdiId: nueva.id, intento: 1, renglones: [{ orderItemId: o.itemIds[1], tratamiento: 'IVA_0' }] }),
    )
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })

    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.sellables).toEqual([])
    expect(plan.noSellables).toEqual([{ cfdiId: f.id, folio: `A-${f.folio}`, motivo: MOTIVO_SELLO_DISTINTO }])
    expect(await aplicar(plan)).toEqual({ sellados: [], cambiaron: [] })
    expect(await tratamientos(o.orderId)).toEqual([null, 'IVA_0'])
    expect(await sellosDe(f.id)).toHaveLength(0)
  })

  it('7b · un renglón sellado con la MISMA tasa por otro documento no estorba: se sella y se registra su vínculo', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const nueva = await nuevoCfdi(n, o.orderId, { protocoloIva: 1, status: 'DRAFT' })
    await prisma.$transaction(tx =>
      sellarRenglones(tx, { cfdiId: nueva.id, intento: 1, renglones: [{ orderItemId: o.itemIds[1], tratamiento: 'IVA_16' }] }),
    )
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })

    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.sellables).toEqual([expect.objectContaining({ cfdiId: f.id, tratamiento: 'IVA_16' })])
    await aplicar(plan)
    expect(await tratamientos(o.orderId)).toEqual(['IVA_16', 'IVA_16'])
    expect(await sellosDe(f.id)).toHaveLength(2)
  })

  it('8 · un sello distinto aparece ENTRE el plan y el candado ⇒ lanza SelloHeredadoDivergente y, al revertir, nada quedó sellado', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })
    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.sellables).toHaveLength(1)

    // Después del plan, otro documento sella el ÚLTIMO renglón con otra tasa: el primero ya se habría sellado cuando truene el segundo.
    const nueva = await nuevoCfdi(n, o.orderId, { protocoloIva: 1, status: 'DRAFT' })
    await prisma.$transaction(tx =>
      sellarRenglones(tx, { cfdiId: nueva.id, intento: 1, renglones: [{ orderItemId: o.itemIds[1], tratamiento: 'IVA_0' }] }),
    )

    const err = await aplicar(plan).catch(e => e)
    expect(err).toBeInstanceOf(SelloHeredadoDivergente)
    expect(err.folio).toBe(`A-${f.folio}`)
    expect(await tratamientos(o.orderId)).toEqual([null, 'IVA_0'])
    expect(await sellosDe(f.id)).toHaveLength(0)
    expect(await prisma.activityLog.count({ where: { venueId: n.venueId, action: 'CFDI_HEREDADA_SELLADA' } })).toBe(0)
  })

  it('9 · cambió al revisar: attempts subió entre el plan y el candado ⇒ va a `cambiaron` y no se sella', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })
    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })

    await prisma.cfdi.update({ where: { id: f.id }, data: { attempts: { increment: 1 } } })
    const r = await aplicar(plan)
    expect(r.sellados).toEqual([])
    expect(r.cambiaron).toEqual([{ cfdiId: f.id, folio: `A-${f.folio}`, motivo: MOTIVO_CAMBIO_AL_REVISAR }])
    expect(await tratamientos(o.orderId)).toEqual([null, null])
  })

  it('9b · cambió al revisar: el XML se corrigió entre el plan y el candado (otra huella) ⇒ `cambiaron`', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })
    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })

    await prisma.cfdi.update({ where: { id: f.id }, data: { xmlConceptos: XML_0 } })
    const r = await aplicar(plan)
    expect(r.sellados).toEqual([])
    expect(r.cambiaron).toEqual([expect.objectContaining({ cfdiId: f.id, motivo: MOTIVO_CAMBIO_AL_REVISAR })])
    expect(await tratamientos(o.orderId)).toEqual([null, null])
  })

  it('9c · se canceló entre el plan y el candado ⇒ ya no necesita sello: ni sellada ni "cambió"', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })
    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })

    await prisma.cfdi.update({ where: { id: f.id }, data: { status: 'CANCELLED' } })
    expect(await aplicar(plan)).toEqual({ sellados: [], cambiaron: [] })
    expect(await tratamientos(o.orderId)).toEqual([null, null])
  })

  it.each([
    ['global heredada (isGlobal, sin orden)', { isGlobal: true, flow: 'GLOBAL_C' as const }, false],
    ['nota de crédito heredada (EGRESO con su orden)', { type: 'EGRESO' as const }, true],
  ])('10 · %s ⇒ MOTIVO_NO_INDIVIDUAL', async (_nombre, extra, conOrden) => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    const f = await nuevoCfdi(n, conOrden ? o.orderId : null, { xmlConceptos: XML_16, ...extra })

    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.sellables).toEqual([])
    expect(plan.noSellables).toEqual([{ cfdiId: f.id, folio: `A-${f.folio}`, motivo: MOTIVO_NO_INDIVIDUAL }])
  })

  it('11a · D11 ampliada, negocio APAGADO: una heredada con XML todo al 0 % es sellable IVA_0', async () => {
    const n = await armarNegocio({ encendido: false })
    const o = await nuevaOrden(n)
    await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_0 })

    expect(await prisma.venueIvaPorProducto.count({ where: { venueId: n.venueId } })).toBe(0)
    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.noSellables).toEqual([])
    expect(plan.sellables).toEqual([expect.objectContaining({ tratamiento: 'IVA_0' })])
  })

  it('11b · D11 ampliada, negocio APAGADO con un producto heredado en IVA_0: el XML al 16 % manda ⇒ sellable IVA_16', async () => {
    const n = await armarNegocio({ productoIva: 'IVA_0', encendido: false })
    const o = await nuevaOrden(n)
    await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })

    expect(await prisma.venueIvaPorProducto.count({ where: { venueId: n.venueId } })).toBe(0)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: n.productId } })).ivaTratamiento).toBe('IVA_0')
    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.noSellables).toEqual([])
    expect(plan.sellables).toEqual([expect.objectContaining({ tratamiento: 'IVA_16' })])
    await aplicar(plan)
    expect(await tratamientos(o.orderId)).toEqual(['IVA_16', 'IVA_16'])
  })

  it('12 · el plan recorre por páginas: más facturas que una página (200) se ven todas', async () => {
    const n = await armarNegocio()
    const o = await nuevaOrden(n)
    // 201 heredadas globales (no sellables, sin XML que leer): basta para cruzar la página de 200 sin 201 órdenes.
    await prisma.cfdi.createMany({
      data: Array.from({ length: 201 }, (_x, i) => ({
        venueId: n.venueId,
        fiscalEmisorId: n.fiscalEmisorId,
        type: 'INGRESO' as const,
        status: 'STAMPED' as const,
        flow: 'GLOBAL_C' as const,
        isGlobal: true,
        serie: 'G',
        folio: String(i),
        receptorRfc: 'XAXX010101000',
        receptorNombre: 'PÚBLICO EN GENERAL',
        receptorRegimen: '616',
        receptorCp: '01000',
        usoCfdi: 'S01',
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        idempotencyKey: `sh-${randomUUID()}`,
        updatedAt: new Date(),
      })),
    })
    await nuevoCfdi(n, o.orderId, { xmlConceptos: XML_16 })

    const plan = await planDeSelladoHeredado(n.venueId, { reparar: SIN_REPARAR })
    expect(plan.noSellables).toHaveLength(201)
    expect(plan.sellables).toHaveLength(1)
  })
})
