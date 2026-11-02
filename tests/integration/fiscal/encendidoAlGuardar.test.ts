// tests/integration/fiscal/encendidoAlGuardar.test.ts
//
// IVA por producto, plan 6b, Tarea 6 (spec §5.2, §5.7, D10, D11, H14): la PRIMERA vez que el dueño elige un IVA distinto de 16 % en un
// negocio apagado, el guardado revisa todo bajo el orden único de candados; con bloqueos responde 409 con TODOS y no escribe nada; sin
// ellos sella las facturas viejas, enciende, deja auditoría y guarda. Sólo dueño/administrador de la sede o un SUPERADMIN activo enciende
// (decisión del founder, 12-oct). Contra Postgres real: candados, triggers y la transacción son SQL.
import { randomUUID } from 'crypto'
import { Prisma, StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createProduct, updateProduct, type CreateProductDto } from '@/services/dashboard/product.dashboard.service'
import * as admisionIva from '@/services/fiscal/admisionIva'
import * as sellosHeredados from '@/services/fiscal/sellosHeredados'
import { MOTIVO_SELLO_DISTINTO } from '@/services/fiscal/sellosHeredados'
import { MENSAJES } from '@/services/fiscal/normalizarIvaDeProducto'
import { sellarRenglones } from '@/services/fiscal/sellosIva'
import { apagarIvaPorProducto, encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'
import { desenlace, limpiarNegocios, nuevoNegocio, retener, type Negocio } from './exclusionContable.fixtures'

// La observación de 30 días se da por cumplida (su valor real lo prueba la Tarea 3).
jest.mock('@/services/mobile/deviceRegistry.service', () => ({
  ...jest.requireActual('@/services/mobile/deviceRegistry.service'),
  OBSERVADOR_POS_DESDE: new Date('2026-08-01T00:00:00Z'),
}))
// Nunca el PAC de verdad; y así se ve si alguien pidió el XML (Review Focus 8, Codex r2 N5).
const mockReparar = jest.fn(async (_cfdiId: string): Promise<unknown> => undefined)
jest.mock('@/services/fiscal/finalizadorCfdi', () => ({
  ...jest.requireActual('@/services/fiscal/finalizadorCfdi'),
  repararArchivosDe: (cfdiId: string) => mockReparar(cfdiId),
}))

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

jest.setTimeout(120_000)

const MENSAJE_BLOQUEADO = 'Para vender productos con un IVA distinto de 16 % falta resolver esto:'
const MENSAJE_SOLO_DUENO =
  'Es el primer producto con un IVA distinto de 16 %: encenderlo pausa la contabilidad automática de toda la organización, así que sólo lo puede hacer el dueño o un administrador.'
const DIA = 24 * 60 * 60 * 1000

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
    traslados: [{ impuesto: '002', tipoFactor: 'Tasa', tasa: t, base: '100.00', importe: t === '0.000000' ? '0.00' : '16.00' }],
  })),
})

type Humano = { type: 'HUMAN'; staffId: string; impersonating: false }

describe('encendido del IVA por producto al guardar un producto (integración)', () => {
  const venueIds: string[] = []
  const staffs: string[] = []

  afterAll(async () => {
    await prisma.terminal.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.staffVenue.deleteMany({ where: { staffId: { in: staffs } } })
    await prisma.staff.deleteMany({ where: { id: { in: staffs } } })
    await limpiarNegocios()
    await prisma.$disconnect()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    mockReparar.mockClear()
  })

  const negocio = async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    venueIds.push(x.venueId)
    return x
  }
  /** Un `Staff` real con su rol en la sede (el autor de la auditoría). */
  const persona = async (venueId: string, role: StaffRole): Promise<Humano> => {
    const staffId = (await prisma.staff.create({ data: { email: `enc6-${randomUUID()}@t.mx`, firstName: 'IVA', lastName: 'Tarea6' } })).id
    staffs.push(staffId)
    await prisma.staffVenue.create({ data: { staffId, venueId, role, active: true } })
    return { type: 'HUMAN', staffId, impersonating: false }
  }
  const categoriaDe = async (x: Negocio) =>
    (await prisma.menuCategory.create({ data: { venueId: x.venueId, name: 'IVA', slug: `iva-${randomUUID().slice(0, 8)}` } })).id
  const productoDe = async (x: Negocio, name: string) =>
    prisma.product.create({
      data: { venueId: x.venueId, categoryId: await categoriaDe(x), sku: `E6-${randomUUID().slice(0, 8)}`, name, price: 100 },
    })
  /** Negocio apagado y limpio, su dueño y un producto al 16 %. */
  const armar = async () => {
    const x = await negocio()
    const humano = await persona(x.venueId, StaffRole.OWNER)
    const p = await productoDe(x, 'Café en grano')
    return { x, humano, p }
  }

  const emisorDe = async (venueId: string) =>
    (
      (await prisma.fiscalEmisor.findFirst({ where: { venueId }, select: { id: true } })) ??
      (await prisma.fiscalEmisor.create({
        data: {
          venueId,
          rfc: 'AAA010101AAA',
          legalName: 'Negocio de prueba',
          regimenFiscal: '601',
          lugarExpedicion: '01000',
          csdStatus: 'ACTIVE',
        },
      }))
    ).id
  const cfdi = async (venueId: string, extra: Partial<Prisma.CfdiUncheckedCreateInput> = {}) =>
    prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId: await emisorDe(venueId),
        type: 'INGRESO',
        status: 'STAMPED',
        flow: 'AUTOFACTURA_A',
        protocoloIva: 1,
        serie: 'A',
        folio: String(Math.floor(Math.random() * 1_000_000)),
        receptorRfc: 'EKU9003173C9',
        receptorNombre: 'ESCUELA KEMPER URGATE',
        receptorRegimen: '601',
        receptorCp: '64000',
        usoCfdi: 'G03',
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 20000,
        taxCents: 3200,
        totalCents: 23200,
        idempotencyKey: `enc6-${randomUUID()}`,
        attempts: 1,
        updatedAt: new Date(),
        ...extra,
      } as Prisma.CfdiUncheckedCreateInput,
    })
  /** Una heredada (sin `protocoloIva`) de una venta del producto con DOS renglones sin sellar, con el XML que se le dé. */
  const heredada = async (x: Negocio, productId: string, xmlConceptos: unknown) => {
    const o = await prisma.order.create({
      data: { venueId: x.venueId, orderNumber: `enc6-${randomUUID().slice(0, 8)}`, subtotal: 200, taxAmount: 32, total: 232 },
    })
    for (const n of [1, 2])
      await prisma.orderItem.create({
        data: { orderId: o.id, productId, productName: `Renglón ${n}`, quantity: 1, unitPrice: 100, taxAmount: 16, total: 116 },
      })
    const items = (await prisma.orderItem.findMany({ where: { orderId: o.id }, select: { id: true }, orderBy: { id: 'asc' } })).map(
      i => i.id,
    )
    const f = await cfdi(x.venueId, {
      orderId: o.id,
      protocoloIva: null,
      xmlConceptos: xmlConceptos === null ? Prisma.DbNull : (xmlConceptos as Prisma.InputJsonValue),
    })
    return { orderId: o.id, items, cfdiId: f.id, folio: `A-${f.folio}` }
  }
  /** Otro documento (de la ruta nueva, timbrado: no está «en vuelo») sella un renglón con otra tasa. */
  const selloAjeno = async (x: Negocio, orderId: string, orderItemId: string) => {
    const nueva = await cfdi(x.venueId, { orderId })
    await prisma.$transaction(tx =>
      sellarRenglones(tx, { cfdiId: nueva.id, intento: 1, renglones: [{ orderItemId, tratamiento: 'IVA_0' }] }),
    )
  }

  const iva = async (productId: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { ivaTratamiento: true } })).ivaTratamiento
  const bandera = (venueId: string) => prisma.venueIvaPorProducto.findUnique({ where: { venueId } })
  const bitacora = (venueId: string, action?: string) =>
    prisma.activityLog.findMany({ where: { venueId, ...(action ? { action } : {}) }, orderBy: { createdAt: 'asc' } })
  /** 409 / 403 del encendido: nada escrito (ni bandera, ni auditoría, ni sellos) y el producto sigue como estaba. */
  const nadaEscrito = async (x: Negocio, productId: string, antes = 'IVA_16') => {
    expect(await iva(productId)).toBe(antes)
    expect(await bandera(x.venueId)).toBeNull()
    expect(await bitacora(x.venueId)).toEqual([])
    expect(await prisma.orderItemSelloIva.count({ where: { orderItem: { order: { venueId: x.venueId } } } })).toBe(0)
  }

  it('apagado y limpio: elegir 0 % enciende, sella, deja rastro y guarda', async () => {
    const { x, humano, p } = await armar()
    const { staffId } = humano
    await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).ivaTratamiento).toBe('IVA_0')
    expect(await prisma.venueIvaPorProducto.findUnique({ where: { venueId: x.venueId } })).toMatchObject({ habilitadoPorStaffId: staffId })
    const log = await prisma.activityLog.findMany({ where: { venueId: x.venueId }, orderBy: { createdAt: 'asc' } })
    expect(log.filter(l => l.action === 'IVA_POR_PRODUCTO_ACTIVADO')).toHaveLength(1)
    expect(log.find(l => l.action === 'IVA_POR_PRODUCTO_ACTIVADO')).toMatchObject({
      staffId,
      entityId: x.venueId,
      data: { origen: 'DASHBOARD', productoId: p.id, facturasSelladas: [] },
    })
    expect(log.find(l => l.action === 'PRODUCT_IVA_CHANGED')).toMatchObject({
      staffId,
      entityId: p.id,
      data: { producto: 'Café en grano', antes: { ivaTratamiento: 'IVA_16' }, despues: { ivaTratamiento: 'IVA_0' }, origen: 'DASHBOARD' },
    })
  })

  it('bloqueado: un iPad del POS en 1.14.0 visto ayer ⇒ 409 con APARATO_VIEJO y nada escrito', async () => {
    const { x, humano, p } = await armar()
    await prisma.terminal.create({
      data: {
        venueId: x.venueId,
        name: 'iPad de la barra',
        type: 'POS_IOS',
        version: '1.14.0',
        status: 'ACTIVE',
        lastHeartbeat: new Date(Date.now() - DIA),
      },
    })
    await expect(updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IVA_ENCENDIDO_BLOQUEADO',
      message: MENSAJE_BLOQUEADO,
      details: { bloqueos: [expect.objectContaining({ codigo: 'APARATO_VIEJO' })] },
    })
    await nadaEscrito(x, p.id)
  })

  it('contabilidad: un cierre de periodo de la organización ⇒ 409 con CONTABILIDAD', async () => {
    const { x, humano, p } = await armar()
    await prisma.accountingPeriodLock.create({ data: { organizationId: x.organizationId, rfc: x.rfc, period: '2026-06' } })
    await expect(updateProduct(x.venueId, p.id, { ivaTratamiento: 'EXENTO' } as any, humano)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IVA_ENCENDIDO_BLOQUEADO',
      details: { bloqueos: [expect.objectContaining({ codigo: 'CONTABILIDAD' })] },
    })
    await nadaEscrito(x, p.id)
  })

  // Revisión final, I-1 paso 2 y Minor nuevo 2: lo que no depende de la admisión ni del XML se revisa FUERA de la transacción. Un producto
  // con ajuste de Uber (el MCP no deshabilita el selector) ya no corre plan + PAC + exclusiva para tronar al final en el trigger.
  it('I-1 · producto con ajuste de Uber y POS externo ⇒ 409 con LOS DOS, sin exclusiva ni PAC (el plan de heredadas sólo LEE); nada escrito', async () => {
    const { x, humano, p } = await armar()
    await prisma.product.update({ where: { id: p.id }, data: { ajusteDeliveryAlgunaVez: true } })
    await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'SOFTRESTAURANT' } })
    await heredada(x, p.id, null) // sin XML: el plan se lo pediría al PAC
    const exclusiva = jest.spyOn(admisionIva, 'tomarAdmisionExclusiva')
    const plan = jest.spyOn(sellosHeredados, 'planDeSelladoHeredado')

    const e = await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano).catch((err: unknown) => err)
    expect(e).toMatchObject({ statusCode: 409, code: 'IVA_ENCENDIDO_BLOQUEADO', message: MENSAJE_BLOQUEADO })
    const bloqueos = (e as { details: { bloqueos: Array<{ codigo: string; mensaje: string; comoArreglar: string }> } }).details.bloqueos
    expect(new Set(bloqueos.map(b => b.codigo))).toEqual(new Set(['AJUSTE_DE_DELIVERY', 'POS_EXTERNO']))
    expect(bloqueos.find(b => b.codigo === 'AJUSTE_DE_DELIVERY')).toEqual({
      codigo: 'AJUSTE_DE_DELIVERY',
      mensaje: 'Este producto ya tuvo ajustes de delivery (Uber) y no puede cambiar de IVA',
      comoArreglar: 'Crea un producto nuevo con el IVA correcto.',
    })
    expect(exclusiva).not.toHaveBeenCalled()
    // Codex código r1 #6 (Ruling CX-6): la pre-revisión mira las heredadas por lectura (la sin XML no bloquea), nunca con la reparación
    // por omisión, que es la que llama al PAC.
    expect(plan).toHaveBeenCalledTimes(1)
    expect(plan).not.toHaveBeenCalledWith(x.venueId)
    expect(mockReparar).not.toHaveBeenCalled()
    await nadaEscrito(x, p.id)
  })

  describe('facturas viejas (heredadas)', () => {
    it('XML al 16 %: enciende y en la MISMA transacción la sella; la activación nombra la factura', async () => {
      const { x, humano, p } = await armar()
      const h = await heredada(x, p.id, xmlDe('0.160000', '0.160000'))
      await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano)
      expect(await iva(p.id)).toBe('IVA_0')
      expect(await prisma.orderItem.findMany({ where: { orderId: h.orderId }, select: { ivaTratamiento: true } })).toEqual([
        { ivaTratamiento: 'IVA_16' },
        { ivaTratamiento: 'IVA_16' },
      ])
      expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: h.cfdiId } })).toBe(2)
      expect(await bitacora(x.venueId, 'CFDI_HEREDADA_SELLADA')).toEqual([
        expect.objectContaining({ entityId: h.cfdiId, staffId: humano.staffId, data: expect.objectContaining({ origen: 'ENCENDIDO' }) }),
      ])
      const [activado] = await bitacora(x.venueId, 'IVA_POR_PRODUCTO_ACTIVADO')
      expect(activado.data).toMatchObject({ facturasSelladas: [h.folio] })
    })

    it('D11 ampliada (founder, 12-oct): XML todo al 0 % en un negocio apagado ⇒ enciende y la sella IVA_0', async () => {
      const { x, humano, p } = await armar()
      const h = await heredada(x, p.id, xmlDe('0.000000', '0.000000'))
      await updateProduct(x.venueId, p.id, { ivaTratamiento: 'EXENTO' } as any, humano)
      expect(await iva(p.id)).toBe('EXENTO')
      expect(await prisma.orderItem.findMany({ where: { orderId: h.orderId }, select: { ivaTratamiento: true } })).toEqual([
        { ivaTratamiento: 'IVA_0' },
        { ivaTratamiento: 'IVA_0' },
      ])
      const [activado] = await bitacora(x.venueId, 'IVA_POR_PRODUCTO_ACTIVADO')
      expect(activado.data).toMatchObject({ facturasSelladas: [h.folio] })
    })

    it('XML mixto ⇒ 409 FACTURA_VIEJA_SIN_SELLO con su folio; nada escrito', async () => {
      const { x, humano, p } = await armar()
      const h = await heredada(x, p.id, xmlDe('0.160000', '0.000000'))
      await expect(updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano)).rejects.toMatchObject({
        statusCode: 409,
        code: 'IVA_ENCENDIDO_BLOQUEADO',
        details: { bloqueos: [expect.objectContaining({ codigo: 'FACTURA_VIEJA_SIN_SELLO', mensaje: expect.stringContaining(h.folio) })] },
      })
      await nadaEscrito(x, p.id)
    })

    it('Review Focus 6: un renglón ya sellado con OTRA tasa ⇒ 409 FACTURA_VIEJA_SIN_SELLO con folio y motivo; ningún 500; nada escrito', async () => {
      const { x, humano, p } = await armar()
      const h = await heredada(x, p.id, xmlDe('0.160000', '0.160000'))
      await selloAjeno(x, h.orderId, h.items[1])
      const sellosAntes = await prisma.orderItemSelloIva.count({ where: { orderItem: { orderId: h.orderId } } })

      const r = await desenlace(updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano))
      expect(r).toMatchObject({
        statusCode: 409,
        code: 'IVA_ENCENDIDO_BLOQUEADO',
        details: {
          bloqueos: [
            expect.objectContaining({ codigo: 'FACTURA_VIEJA_SIN_SELLO', mensaje: `La factura ${h.folio}: ${MOTIVO_SELLO_DISTINTO}` }),
          ],
        },
      })
      expect(await iva(p.id)).toBe('IVA_16')
      expect(await bandera(x.venueId)).toBeNull()
      expect(await bitacora(x.venueId)).toEqual([])
      expect(await prisma.orderItemSelloIva.count({ where: { orderItem: { orderId: h.orderId } } })).toBe(sellosAntes)
      expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: h.cfdiId } })).toBe(0)
    })

    it('Review Focus 6 (contrato T4): el sello distinto aparece ENTRE el plan y el candado ⇒ el mismo 409, sin 500 y nada a medias', async () => {
      const { x, humano, p } = await armar()
      const h = await heredada(x, p.id, xmlDe('0.160000', '0.160000'))
      const real = jest.requireActual('@/services/fiscal/sellosHeredados').planDeSelladoHeredado
      jest.spyOn(sellosHeredados, 'planDeSelladoHeredado').mockImplementationOnce(async (venueId, deps) => {
        const plan = await real(venueId, deps)
        await selloAjeno(x, h.orderId, h.items[1]) // el ÚLTIMO renglón: el primero ya se habría sellado cuando truene
        return plan
      })

      const r = await desenlace(updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano))
      expect(r).toMatchObject({
        statusCode: 409,
        code: 'IVA_ENCENDIDO_BLOQUEADO',
        details: {
          bloqueos: [
            {
              codigo: 'FACTURA_VIEJA_SIN_SELLO',
              mensaje: `La factura ${h.folio}: ${MOTIVO_SELLO_DISTINTO}`,
              comoArreglar: expect.any(String),
            },
          ],
        },
      })
      expect(await iva(p.id)).toBe('IVA_16')
      expect(await bandera(x.venueId)).toBeNull()
      expect(await bitacora(x.venueId)).toEqual([])
      expect(
        await prisma.orderItem.findMany({ where: { orderId: h.orderId }, select: { ivaTratamiento: true }, orderBy: { id: 'asc' } }),
      ).toEqual([{ ivaTratamiento: null }, { ivaTratamiento: 'IVA_0' }])
      expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: h.cfdiId } })).toBe(0)
    })
  })

  it('Review Focus 1 (Testarudo): YA encendido, con un aparato viejo y una factura en vuelo, cambiar otro producto a EXENTO pasa sin revisiones', async () => {
    const { x, humano } = await armar()
    await encenderIvaPorProducto(x.venueId)
    await prisma.terminal.create({
      data: { venueId: x.venueId, name: 'iPad viejo', type: 'POS_IOS', version: '1.14.0', status: 'ACTIVE', lastHeartbeat: new Date() },
    })
    await cfdi(x.venueId, { status: 'STAMPING' })
    const otro = await productoDe(x, 'Consulta')
    const exclusiva = jest.spyOn(admisionIva, 'tomarAdmisionExclusiva')
    const plan = jest.spyOn(sellosHeredados, 'planDeSelladoHeredado')

    await updateProduct(x.venueId, otro.id, { ivaTratamiento: 'EXENTO' } as any, humano)
    expect(await iva(otro.id)).toBe('EXENTO')
    expect(exclusiva).not.toHaveBeenCalled()
    expect(plan).not.toHaveBeenCalled()
    expect(await bitacora(x.venueId, 'IVA_POR_PRODUCTO_ACTIVADO')).toEqual([])
    expect(await bitacora(x.venueId, 'PRODUCT_IVA_CHANGED')).toEqual([
      expect.objectContaining({
        entityId: otro.id,
        data: expect.objectContaining({ antes: { ivaTratamiento: 'IVA_16' }, despues: { ivaTratamiento: 'EXENTO' } }),
      }),
    ])
  })

  describe('Review Focus 3: pedir el MISMO tratamiento no enciende', () => {
    it('heredado IVA_0 en un negocio apagado: reenviar IVA_0 con otro nombre pasa, sin bandera ni auditoría de IVA', async () => {
      const { x, humano, p } = await armar()
      await encenderIvaPorProducto(x.venueId)
      await prisma.product.update({ where: { id: p.id }, data: { ivaTratamiento: 'IVA_0' } })
      await apagarIvaPorProducto(x.venueId)
      const plan = jest.spyOn(sellosHeredados, 'planDeSelladoHeredado')

      await updateProduct(x.venueId, p.id, { name: 'Café 2', ivaTratamiento: 'IVA_0' } as any, humano)
      expect(await prisma.product.findUniqueOrThrow({ where: { id: p.id }, select: { name: true, ivaTratamiento: true } })).toEqual({
        name: 'Café 2',
        ivaTratamiento: 'IVA_0',
      })
      expect(plan).not.toHaveBeenCalled()
      expect(await bandera(x.venueId)).toBeNull()
      expect(await bitacora(x.venueId, 'IVA_POR_PRODUCTO_ACTIVADO')).toEqual([])
      expect(await bitacora(x.venueId, 'PRODUCT_IVA_CHANGED')).toEqual([])
    })

    it('IVA_16 sobre un IVA_16: pasa igual', async () => {
      const { x, humano, p } = await armar()
      await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_16' } as any, humano)
      expect(await iva(p.id)).toBe('IVA_16')
      expect(await bandera(x.venueId)).toBeNull()
      expect(await bitacora(x.venueId, 'PRODUCT_IVA_CHANGED')).toEqual([])
    })
  })

  it('Review Focus 2: dos guardados a la vez que encienden ⇒ los dos guardan, UNA bandera y UNA activación (sin P2002)', async () => {
    const { x, humano, p } = await armar()
    const q = await productoDe(x, 'Fruta')
    const [a, b] = await Promise.all([
      desenlace(updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano)),
      desenlace(updateProduct(x.venueId, q.id, { ivaTratamiento: 'IVA_0' } as any, humano)),
    ])
    expect(a).toHaveProperty('ok')
    expect(b).toHaveProperty('ok')
    expect([await iva(p.id), await iva(q.id)]).toEqual(['IVA_0', 'IVA_0'])
    expect(await prisma.venueIvaPorProducto.count({ where: { venueId: x.venueId } })).toBe(1)
    expect(await bitacora(x.venueId, 'IVA_POR_PRODUCTO_ACTIVADO')).toHaveLength(1)
    expect(await bitacora(x.venueId, 'PRODUCT_IVA_CHANGED')).toHaveLength(2)
  })

  describe('alta (no enciende)', () => {
    const alta = async (x: Negocio, ivaTratamiento: string): Promise<CreateProductDto> =>
      ({
        name: `Alta ${ivaTratamiento}`,
        price: 100,
        type: 'REGULAR',
        sku: `A6-${randomUUID().slice(0, 8)}`,
        categoryId: await categoriaDe(x),
        ivaTratamiento,
      }) as CreateProductDto

    it('negocio apagado: un alta EXENTO ⇒ 409 IVA_POR_PRODUCTO_APAGADO con el texto nuevo, sin bandera', async () => {
      const x = await negocio()
      const humano = await persona(x.venueId, StaffRole.OWNER)
      await expect(createProduct(x.venueId, await alta(x, 'EXENTO'), humano)).rejects.toMatchObject({
        statusCode: 409,
        code: 'IVA_POR_PRODUCTO_APAGADO',
        message: MENSAJES.IVA_POR_PRODUCTO_APAGADO,
      })
      expect(await bandera(x.venueId)).toBeNull()
      expect(await bitacora(x.venueId)).toEqual([])
    })

    it('negocio YA encendido: nace EXENTO y deja PRODUCT_IVA_CHANGED con antes null; un alta a 16 % no deja nada', async () => {
      const x = await negocio()
      const humano = await persona(x.venueId, StaffRole.OWNER)
      await encenderIvaPorProducto(x.venueId)
      const exento = await createProduct(x.venueId, await alta(x, 'EXENTO'), humano)
      expect(exento.ivaTratamiento).toBe('EXENTO')
      expect(await bitacora(x.venueId, 'PRODUCT_IVA_CHANGED')).toEqual([
        expect.objectContaining({
          staffId: humano.staffId,
          entityId: exento.id,
          data: { producto: 'Alta EXENTO', antes: { ivaTratamiento: null }, despues: { ivaTratamiento: 'EXENTO' }, origen: 'DASHBOARD' },
        }),
      ])
      const normal = await createProduct(x.venueId, await alta(x, 'IVA_16'), humano)
      expect(await bitacora(x.venueId, 'PRODUCT_IVA_CHANGED')).toEqual([expect.objectContaining({ entityId: exento.id })])
      expect(normal.ivaTratamiento).toBe('IVA_16')
    })
  })

  it('origen MCP: el rastro lo dice', async () => {
    const { x, humano, p } = await armar()
    await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano, undefined, { origen: 'MCP' } as any)
    const [cambio] = await bitacora(x.venueId, 'PRODUCT_IVA_CHANGED')
    expect((cambio.data as { origen?: string }).origen).toBe('MCP')
    const [activado] = await bitacora(x.venueId, 'IVA_POR_PRODUCTO_ACTIVADO')
    expect((activado.data as { origen?: string }).origen).toBe('MCP')
  })

  it('Codex r1 P1-2: el negocio se traslada de organización mientras el guardado espera la admisión ⇒ 409, nada escrito', async () => {
    const { x, humano, p } = await armar()
    const destino = await negocio() // otra organización limpia
    const { pid, soltar } = await retener(
      prisma,
      tx => tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('iva-emision:' || ${x.organizationId}, 0))`,
    )
    let guardado: Promise<unknown> | null = null
    try {
      guardado = desenlace(updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano))
      await hastaQueEspereDetrasDe(pid)
      await prisma.venue.update({ where: { id: x.venueId }, data: { organizationId: destino.organizationId } })
    } finally {
      await soltar()
    }
    expect(await guardado).toMatchObject({ statusCode: 409, code: 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION' })
    await nadaEscrito(x, p.id)
  })

  it('Codex r1 P2-5: una vista previa vieja (decía IVA_16) sobre un producto que ya pasó a IVA_0 ⇒ «cambió desde la vista previa»', async () => {
    const { x, humano, p } = await armar()
    await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano) // el otro guardado (enciende)
    const vista = { name: p.name, price: p.price, active: p.active, ivaTratamiento: 'IVA_16' }
    await expect(updateProduct(x.venueId, p.id, { ivaTratamiento: 'EXENTO' } as any, humano, vista as any)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('El producto cambió desde la vista previa'),
    })
    expect(await iva(p.id)).toBe('IVA_0')
  })

  describe('Paso 4b: quién enciende (decisión del founder, 12-oct)', () => {
    it('un MANAGER en un negocio apagado ⇒ 403 IVA_ENCENDIDO_SOLO_DUENO y nada escrito', async () => {
      const x = await negocio()
      const gerente = await persona(x.venueId, StaffRole.MANAGER)
      const p = await productoDe(x, 'Café en grano')
      await expect(updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, gerente)).rejects.toMatchObject({
        statusCode: 403,
        code: 'IVA_ENCENDIDO_SOLO_DUENO',
        message: MENSAJE_SOLO_DUENO,
      })
      await nadaEscrito(x, p.id)
    })

    it('el mismo MANAGER en un negocio YA encendido ⇒ pasa', async () => {
      const x = await negocio()
      const gerente = await persona(x.venueId, StaffRole.MANAGER)
      const p = await productoDe(x, 'Café en grano')
      await encenderIvaPorProducto(x.venueId)
      await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, gerente)
      expect(await iva(p.id)).toBe('IVA_0')
    })

    it('un ADMIN en un negocio apagado ⇒ enciende', async () => {
      const x = await negocio()
      const admin = await persona(x.venueId, StaffRole.ADMIN)
      const p = await productoDe(x, 'Café en grano')
      await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, admin)
      expect(await iva(p.id)).toBe('IVA_0')
      expect(await bandera(x.venueId)).toMatchObject({ habilitadoPorStaffId: admin.staffId })
    })

    it('Codex r2 N4: un SUPERADMIN activo SIN membresía en esta sede (su SUPERADMIN está en otra) ⇒ enciende', async () => {
      const x = await negocio()
      const otra = await negocio()
      const superadmin = await persona(otra.venueId, StaffRole.SUPERADMIN)
      expect(await prisma.staffVenue.count({ where: { staffId: superadmin.staffId, venueId: x.venueId } })).toBe(0)
      const p = await productoDe(x, 'Café en grano')
      await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, superadmin)
      expect(await iva(p.id)).toBe('IVA_0')
      expect(await bandera(x.venueId)).toMatchObject({ habilitadoPorStaffId: superadmin.staffId })
    })

    it('Codex r2 N5: un MANAGER con una heredada SIN XML ⇒ 403 y NO se le pide el XML al PAC (la factura no cambia)', async () => {
      const x = await negocio()
      const gerente = await persona(x.venueId, StaffRole.MANAGER)
      const p = await productoDe(x, 'Café en grano')
      const h = await heredada(x, p.id, null)
      const antes = await prisma.cfdi.findUniqueOrThrow({ where: { id: h.cfdiId } })
      await expect(updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, gerente)).rejects.toMatchObject({
        statusCode: 403,
        code: 'IVA_ENCENDIDO_SOLO_DUENO',
      })
      expect(mockReparar).not.toHaveBeenCalled()
      expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: h.cfdiId } })).toEqual(antes)
      await nadaEscrito(x, p.id)
    })

    it('la comprobación definitiva va BAJO los candados: degradado a MANAGER entre el plan y el candado ⇒ 403 y nada escrito', async () => {
      const { x, humano, p } = await armar()
      const real = jest.requireActual('@/services/fiscal/sellosHeredados').planDeSelladoHeredado
      jest.spyOn(sellosHeredados, 'planDeSelladoHeredado').mockImplementationOnce(async (venueId, deps) => {
        const plan = await real(venueId, deps)
        await prisma.staffVenue.updateMany({ where: { staffId: humano.staffId, venueId: x.venueId }, data: { role: StaffRole.MANAGER } })
        return plan
      })
      await expect(updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, humano)).rejects.toMatchObject({
        statusCode: 403,
        code: 'IVA_ENCENDIDO_SOLO_DUENO',
      })
      await nadaEscrito(x, p.id)
    })
  })

  /** Alguien espera un candado (pg_stat_activity) que retiene el bloqueador. */
  async function hastaQueEspereDetrasDe(pid: number): Promise<void> {
    const limite = Date.now() + 30_000
    while (Date.now() < limite) {
      const [fila] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND ${pid}::int = ANY(pg_blocking_pids(a.pid))`
      if (fila.n > 0) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('El guardado nunca quedó esperando la admisión exclusiva')
  }
})
