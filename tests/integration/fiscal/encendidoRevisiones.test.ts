// tests/integration/fiscal/encendidoRevisiones.test.ts
//
// IVA por producto, plan 6b, Tarea 5 (spec §5.2, §5.1 «Estado del negocio», §11 «Encendido»): las cinco revisiones del encendido —contabilidad,
// documentos en vuelo, facturas viejas, POS externo y aparatos— cada una en rojo SOLA y todas juntas, más el estado informativo del negocio
// y su ruta. Contra Postgres real: las revisiones son SQL (triggers, ventanas de fechas, recorridos por páginas).
import { randomUUID } from 'crypto'
import type { Server } from 'http'
import { Prisma, StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { estadoIvaPorProducto, prepararEncendido, revisarEncendido } from '@/services/fiscal/encendidoIva.service'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'
import * as admisionIva from '@/services/fiscal/admisionIva'
import { llaveDeExtraccion } from '@/services/fiscal/cfdiExtraccion.service'
import * as cfdiService from '@/services/fiscal/cfdi.service'
import * as finalizadorCfdi from '@/services/fiscal/finalizadorCfdi'
import * as sellosHeredados from '@/services/fiscal/sellosHeredados'
import {
  MOTIVO_ORDEN_EN_OTRA_ORGANIZACION,
  MOTIVO_XML_ILEGIBLE,
  planDeSelladoHeredado,
  SIN_REPARAR,
} from '@/services/fiscal/sellosHeredados'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'
import { limpiarNegocios, nuevoNegocio, type Negocio } from './exclusionContable.fixtures'

// Antes de registrar cualquier siembra o limpieza: nunca aceptar la base compartida.
const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const testDatabase = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(testDatabase.hostname) ||
  !(
    ['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808'].includes(testDatabase.pathname) ||
    isDisposableH1Url(testDatabase)
  )
) {
  throw new Error('Esta suite exige la base local av_db_25_iva_test o una base H1 desechable validada.')
}

const DIA = 24 * 60 * 60 * 1000
const AHORA = new Date('2026-11-05T12:00:00Z') // observación completa (30 días desde 2026-10-01T22:00Z)
const hace = (dias: number) => new Date(AHORA.getTime() - dias * DIA)

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
const XML_MIXTO = xmlDe('0.160000', '0.000000')

describe('encendido del IVA por producto — las revisiones (integración)', () => {
  const negocios: Negocio[] = []
  /** Negocios hermanos (misma organización) y masivos: se borran ANTES de `limpiarNegocios`, que sólo conoce los suyos. */
  const hermanos: string[] = []
  const staffs: string[] = []
  let server: Server

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(listo => server.once('listening', () => listo()))
  })

  afterAll(async () => {
    await new Promise<void>(listo => server.close(() => listo()))
    const venueIds = [...hermanos, ...negocios.map(n => n.venueId)]
    await prisma.terminal.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.cfdi.deleteMany({ where: { venueId: { in: hermanos } } })
    await prisma.order.deleteMany({ where: { venueId: { in: hermanos } } })
    await prisma.venue.deleteMany({ where: { id: { in: hermanos } } })
    await prisma.staffVenue.deleteMany({ where: { staffId: { in: staffs } } })
    await prisma.staff.deleteMany({ where: { id: { in: staffs } } })
    await limpiarNegocios()
    await prisma.$disconnect()
  })

  const negocio = async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    negocios.push(x)
    return x
  }
  /** Otro negocio de la MISMA organización (`nuevoNegocio` siempre crea una organización nueva). */
  const hermano = async (x: Negocio, name?: string) => {
    const id = `enc-${randomUUID().slice(0, 12)}`
    await prisma.venue.create({ data: { id, organizationId: x.organizationId, name: name ?? id, slug: id } })
    hermanos.push(id)
    return id
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
  const orden = (venueId: string, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
    prisma.order.create({
      data: {
        venueId,
        orderNumber: `enc-${randomUUID().slice(0, 8)}`,
        subtotal: 100,
        taxAmount: 16,
        total: 116,
        ...extra,
      } as Prisma.OrderUncheckedCreateInput,
    })
  /** Por omisión: de la ruta nueva (`protocoloIva` 1), individual, de ingreso y timbrada, sin orden. */
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
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        idempotencyKey: `enc-${randomUUID()}`,
        attempts: 1,
        updatedAt: new Date(),
        ...extra,
      } as Prisma.CfdiUncheckedCreateInput,
    })
  /** Una heredada (sin `protocoloIva`) con un renglón sin sellar y el XML que se le dé. */
  const heredada = async (venueId: string, xmlConceptos: unknown, folio = '7731') => {
    const o = await orden(venueId)
    await prisma.orderItem.create({
      data: {
        orderId: o.id,
        productName: 'Artículo',
        quantity: 1,
        unitPrice: 100,
        taxAmount: 16,
        total: 116,
      } as Prisma.OrderItemUncheckedCreateInput,
    })
    return cfdi(venueId, { orderId: o.id, protocoloIva: null, folio, xmlConceptos: xmlConceptos as Prisma.InputJsonValue })
  }
  /** Como la siembra la prueba de `extraccionesPendientes` de C3: la nota de extracción timbrada y NINGUNA factura del cliente viva. */
  const extraccionPendiente = async (venueId: string, folio = String(Math.floor(Math.random() * 1_000_000))) => {
    const o = await orden(venueId, { paymentStatus: 'PAID' })
    return cfdi(venueId, {
      type: 'EGRESO',
      flow: 'STAFF_B',
      serie: 'E',
      folio,
      orderId: o.id,
      idempotencyKey: llaveDeExtraccion('global-de-prueba', o.id),
      uuid: randomUUID(),
      usoCfdi: 'G02',
      formaPago: '04',
      stampedAt: hace(1),
    })
  }
  const terminal = (venueId: string, over: { type: 'POS_IOS'; version: string; visto: Date }) =>
    prisma.terminal.create({
      data: { venueId, name: 'iPad de la barra', type: over.type, version: over.version, status: 'ACTIVE', lastHeartbeat: over.visto },
    })

  const bloqueosDe = async (x: Negocio, ahora = AHORA) =>
    revisarEncendido(prisma, {
      venueId: x.venueId,
      organizationId: x.organizationId,
      plan: await planDeSelladoHeredado(x.venueId, { reparar: SIN_REPARAR }),
      ahora,
    })
  const revisar = async (x: Negocio, ahora = AHORA) => (await bloqueosDe(x, ahora)).map(b => b.codigo)

  it('un negocio limpio no tiene bloqueos', async () => {
    expect(await revisar(await negocio())).toEqual([])
  })

  it('contabilidad: un cierre de periodo de la organización', async () => {
    const x = await negocio()
    await prisma.accountingPeriodLock.create({ data: { organizationId: x.organizationId, rfc: x.rfc, period: '2026-06' } })
    expect(await revisar(x)).toEqual(['CONTABILIDAD'])
  })

  describe('documentos en vuelo (de TODA la organización)', () => {
    it('un STAMPING de OTRO negocio de la misma organización', async () => {
      const x = await negocio()
      await cfdi(await hermano(x), { status: 'STAMPING' })
      expect(await revisar(x)).toEqual(['DOCUMENTOS_EN_VUELO'])
    })
    it('un STAMP_FAILED que no es definitivo (se reintenta solo)', async () => {
      const x = await negocio()
      await cfdi(await hermano(x), { status: 'STAMP_FAILED', falloDefinitivo: false })
      expect(await revisar(x)).toEqual(['DOCUMENTOS_EN_VUELO'])
    })
    it('un STAMPED con la cancelación solicitada', async () => {
      const x = await negocio()
      await cfdi(await hermano(x), { status: 'STAMPED', cancelStatus: 'REQUESTED' })
      expect(await revisar(x)).toEqual(['DOCUMENTOS_EN_VUELO'])
    })
    it('un STAMP_FAILED DEFINITIVO ya no está en vuelo', async () => {
      const x = await negocio()
      await cfdi(await hermano(x), { status: 'STAMP_FAILED', falloDefinitivo: true })
      expect(await revisar(x)).toEqual([])
    })
    it('una factura en vuelo de OTRA organización no cuenta', async () => {
      const x = await negocio()
      const otro = await negocio()
      await cfdi(otro.venueId, { status: 'STAMPING' })
      expect(await revisar(x)).toEqual([])
    })
    // Codex código r1 #4 (Ruling CX-4): quien revisa una sucursal no necesariamente tiene acceso a las demás. Lo de la MISMA sucursal se
    // nombra (folio, UUID corto o fecha); lo de OTRA sucursal sólo se cuenta: sin folio, UUID, fecha ni nombre de la sucursal.
    it('CX-4 · la misma sucursal se nombra; otra sucursal sólo se cuenta (sin folio, UUID, fecha ni nombre)', async () => {
      const x = await negocio()
      await cfdi(x.venueId, { status: 'STAMPING', folio: '1234' })
      const propio = await bloqueosDe(x)
      expect(propio.map(b => b.mensaje)).toEqual(['La factura A-1234 se está procesando o cancelando'])

      const y = await negocio()
      const norte = await hermano(y, 'Sucursal Norte')
      const uuid = randomUUID().toUpperCase()
      await cfdi(norte, { status: 'STAMPING', folio: '4321' })
      await cfdi(norte, { status: 'STAMPED', cancelStatus: 'REQUESTED', serie: null, folio: null, uuid })
      await cfdi(norte, { status: 'DRAFT', serie: null, folio: null, uuid: null, createdAt: new Date('2026-10-14T19:05:00Z') })
      const ajenos = await bloqueosDe(y)
      expect(ajenos).toEqual([
        {
          codigo: 'DOCUMENTOS_EN_VUELO',
          mensaje: 'Hay 3 facturas en proceso en otras sucursales de tu organización',
          comoArreglar: 'Quien las administra debe terminarlas o cancelarlas en Facturación; después vuelve a guardar.',
        },
      ])
      expect(JSON.stringify(ajenos)).not.toMatch(new RegExp(`4321|${uuid.slice(0, 8)}|Sucursal Norte|14/10/2026|13:05`))
    })
    it('CX-4 · una sola de otra sucursal, en singular', async () => {
      const y = await negocio()
      await cfdi(await hermano(y, 'Sucursal Este'), { status: 'STAMPING', folio: '999' })
      expect(await bloqueosDe(y)).toEqual([
        {
          codigo: 'DOCUMENTOS_EN_VUELO',
          mensaje: 'Hay 1 factura en proceso en otra sucursal de tu organización',
          comoArreglar: 'Quien la administra debe terminarla o cancelarla en Facturación; después vuelve a guardar.',
        },
      ])
    })
    it('CX-4 · la extracción pendiente de la misma sucursal nombra su folio; la de otra sucursal sólo se cuenta', async () => {
      const x = await negocio()
      await extraccionPendiente(x.venueId, '555')
      const [propia] = await bloqueosDe(x)
      expect(propia.codigo).toBe('DOCUMENTOS_EN_VUELO')
      expect(propia.mensaje).toContain('E-555')
      expect(propia.mensaje).not.toContain(' en ')

      const y = await negocio()
      await extraccionPendiente(await hermano(y, 'Sucursal Sur'), '556')
      const ajenas = await bloqueosDe(y)
      expect(ajenas).toEqual([expect.objectContaining({ mensaje: 'Hay 1 factura en proceso en otra sucursal de tu organización' })])
      expect(JSON.stringify(ajenas)).not.toMatch(/556|Sucursal Sur/)
    })
    it('T6-1 · sin serie, folio ni UUID (un STAMPING recién creado) se nombra por cuándo se creó, en la hora del negocio; nunca «anterior»', async () => {
      const x = await negocio()
      await cfdi(x.venueId, { status: 'STAMPING', serie: null, folio: null, uuid: null, createdAt: new Date('2026-10-14T19:05:00Z') })
      await cfdi(x.venueId, { status: 'DRAFT', serie: null, folio: null, uuid: null, createdAt: new Date('2026-10-14T19:20:00Z') })
      const mensajes = (await bloqueosDe(x)).map(b => b.mensaje)
      expect(mensajes.sort()).toEqual([
        'Una factura creada el 14/10/2026 a las 13:05 se está procesando o cancelando',
        'Una factura creada el 14/10/2026 a las 13:20 se está procesando o cancelando',
      ])
      expect(mensajes.join()).not.toContain('anterior')
    })
    it('T6-1 · con UUID pero sin serie ni folio, el UUID corto', async () => {
      const x = await negocio()
      const uuid = randomUUID().toUpperCase()
      await cfdi(x.venueId, { status: 'STAMPED', cancelStatus: 'REQUESTED', serie: null, folio: null, uuid })
      const [b] = await bloqueosDe(x)
      expect(b.mensaje).toBe(`La factura con UUID ${uuid.slice(0, 8)}… se está procesando o cancelando`)
    })
    it('T5-1 · con más de 10 en vuelo, se nombran 10 y una línea dice cuántas más hay', async () => {
      const x = await negocio()
      for (let i = 0; i < 12; i++) await cfdi(x.venueId, { status: 'STAMPING', folio: String(5000 + i) })
      const docs = (await bloqueosDe(x)).filter(b => b.codigo === 'DOCUMENTOS_EN_VUELO')
      expect(docs).toHaveLength(11)
      expect(docs.slice(0, 10).every(b => /^La factura A-50\d\d se está procesando o cancelando$/.test(b.mensaje))).toBe(true)
      expect(docs[10].mensaje).toBe('Y 2 facturas más se están procesando o cancelando')
      expect(docs[10].comoArreglar.trim()).not.toBe('')
    })
    it('una extracción pendiente de la factura global (C3) de un negocio hermano', async () => {
      const x = await negocio()
      await extraccionPendiente(await hermano(x))
      expect(await revisar(x)).toEqual(['DOCUMENTOS_EN_VUELO'])
    })
    it('Codex r1 P2-10: 201 negocios en la organización y la extracción en el de id MAYOR ⇒ se ve (sin tope de 200)', async () => {
      const x = await negocio()
      const prefijo = `zz-${randomUUID().slice(0, 8)}`
      const ids = Array.from({ length: 201 }, (_, i) => `${prefijo}-${String(i).padStart(3, '0')}`)
      await prisma.venue.createMany({ data: ids.map(id => ({ id, organizationId: x.organizationId, name: id, slug: id })) })
      hermanos.push(...ids)
      await extraccionPendiente(ids[ids.length - 1])
      expect(await revisar(x)).toEqual(['DOCUMENTOS_EN_VUELO'])
    })
  })

  it('factura vieja: una heredada STAMPED con XML mixto detiene el encendido y se nombra por su folio', async () => {
    const x = await negocio()
    await heredada(x.venueId, XML_MIXTO, '7731')
    const bloqueos = await revisarEncendido(prisma, {
      venueId: x.venueId,
      organizationId: x.organizationId,
      plan: await planDeSelladoHeredado(x.venueId, { reparar: SIN_REPARAR }),
      ahora: AHORA,
    })
    expect(bloqueos.map(b => b.codigo)).toEqual(['FACTURA_VIEJA_SIN_SELLO'])
    expect(bloqueos[0].mensaje).toContain('A-7731')
  })

  // Codex código r1 #1 (Ruling CX-1): el encendido nunca pide la admisión de otra organización. Una heredada cuya venta hoy vive en otra
  // organización no se puede sellar desde aquí: es un bloqueo PERMANENTE con su motivo (no un 409 de reintento).
  it('CX-1 · una heredada cuya venta hoy vive en OTRA organización ⇒ FACTURA_VIEJA_SIN_SELLO con su motivo', async () => {
    const x = await negocio()
    const otra = await negocio()
    const f = await heredada(x.venueId, xmlDe('0.160000'), '7741') // por su XML sería sellable
    await prisma.order.update({ where: { id: f.orderId! }, data: { venueId: otra.venueId } })
    const bloqueos = await bloqueosDe(x)
    expect(bloqueos.map(b => b.codigo)).toEqual(['FACTURA_VIEJA_SIN_SELLO'])
    expect(bloqueos[0].mensaje).toBe('La factura A-7741: Su venta pertenece a otra organización; pide ayuda a soporte')
    expect(MOTIVO_ORDEN_EN_OTRA_ORGANIZACION).toBe('Su venta pertenece a otra organización; pide ayuda a soporte')
  })

  describe('POS externo', () => {
    it('el negocio tiene un tipo de POS (SoftRestaurant)', async () => {
      const x = await negocio()
      await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'SOFTRESTAURANT' } })
      expect(await revisar(x)).toEqual(['POS_EXTERNO'])
    })
    it('sin tipo (NONE) pero con un latido del POS hace 10 días', async () => {
      const x = await negocio()
      await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'NONE' } })
      await prisma.posConnectionStatus.create({ data: { venueId: x.venueId, lastHeartbeatAt: hace(10) } })
      expect(await revisar(x)).toEqual(['POS_EXTERNO'])
    })
    it('un latido de hace 40 días ya no cuenta', async () => {
      const x = await negocio()
      await prisma.posConnectionStatus.create({ data: { venueId: x.venueId, lastHeartbeatAt: hace(40) } })
      expect(await revisar(x)).toEqual([])
    })
    it('una orden del POS recibida (syncedAt) hace 5 días', async () => {
      const x = await negocio()
      await orden(x.venueId, { originSystem: 'POS_SOFTRESTAURANT', syncedAt: hace(5) })
      expect(await revisar(x)).toEqual(['POS_EXTERNO'])
    })
    it('se mide lo RECIBIDO: recibida hace 40 días aunque su createdAt diga ayer ⇒ nada', async () => {
      const x = await negocio()
      await orden(x.venueId, { originSystem: 'POS_SOFTRESTAURANT', syncedAt: hace(40), createdAt: hace(1) })
      expect(await revisar(x)).toEqual([])
    })
  })

  describe('aparatos', () => {
    it('APARATO_VIEJO: un iPad del POS en 1.14.0 visto hace 2 días', async () => {
      const x = await negocio()
      await terminal(x.venueId, { type: 'POS_IOS', version: '1.14.0', visto: hace(2) })
      expect(await revisar(x)).toEqual(['APARATO_VIEJO'])
    })
    it('POS_SIN_IDENTIDAD: una sesión del POS sin identidad hace 3 días', async () => {
      const x = await negocio()
      await prisma.venuePosSinAparato.create({ data: { venueId: x.venueId, ultimaVez: hace(3) } })
      expect(await revisar(x)).toEqual(['POS_SIN_IDENTIDAD'])
    })
    it('APARATOS_VERIFICACION_PENDIENTE: antes de los 30 días de observación, aunque el negocio esté limpio', async () => {
      const x = await negocio()
      expect(await revisar(x, new Date('2026-10-20T00:00:00Z'))).toEqual(['APARATOS_VERIFICACION_PENDIENTE'])
    })
    it('CX-6 · antes de los 30 días la fecha se SUMA a los aparatos viejos ya vistos (no los tapa)', async () => {
      const x = await negocio()
      await terminal(x.venueId, { type: 'POS_IOS', version: '1.14.0', visto: new Date('2026-10-18T00:00:00Z') })
      expect(await revisar(x, new Date('2026-10-20T00:00:00Z'))).toEqual(['APARATOS_VERIFICACION_PENDIENTE', 'APARATO_VIEJO'])
    })
  })

  it('TODAS JUNTAS: un negocio con todo ⇒ los seis códigos, cada uno con su mensaje y cómo arreglarlo', async () => {
    const x = await negocio()
    await prisma.accountingPeriodLock.create({ data: { organizationId: x.organizationId, rfc: x.rfc, period: '2026-06' } })
    await cfdi(await hermano(x), { status: 'STAMPING' })
    await heredada(x.venueId, XML_MIXTO)
    await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'SOFTRESTAURANT' } })
    await terminal(x.venueId, { type: 'POS_IOS', version: '1.14.0', visto: hace(2) })
    await prisma.venuePosSinAparato.create({ data: { venueId: x.venueId, ultimaVez: hace(3) } })

    const bloqueos = await revisarEncendido(prisma, {
      venueId: x.venueId,
      organizationId: x.organizationId,
      plan: await planDeSelladoHeredado(x.venueId, { reparar: SIN_REPARAR }),
      ahora: AHORA,
    })
    expect(new Set(bloqueos.map(b => b.codigo))).toEqual(
      new Set(['CONTABILIDAD', 'DOCUMENTOS_EN_VUELO', 'FACTURA_VIEJA_SIN_SELLO', 'POS_EXTERNO', 'APARATO_VIEJO', 'POS_SIN_IDENTIDAD']),
    )
    for (const b of bloqueos) {
      expect(b.mensaje.trim()).not.toBe('')
      expect(b.comoArreglar.trim()).not.toBe('')
    }
  })

  describe('estadoIvaPorProducto (informativo)', () => {
    const CON_REVISION = { conRevision: true }

    it('con revisión · apagado con un aparato viejo ⇒ el aparato BLOQUEA; no hay avisos', async () => {
      const x = await negocio()
      await terminal(x.venueId, { type: 'POS_IOS', version: '1.14.0', visto: hace(2) })
      const e = await estadoIvaPorProducto(x.venueId, AHORA, CON_REVISION)
      expect(e).toMatchObject({
        encendido: false,
        habilitadoAt: null,
        contabilidad: false,
        avisos: [],
        facturasSinSello: [],
        revisado: true,
      })
      expect(e.bloqueos.map(b => b.codigo)).toEqual(['APARATO_VIEJO'])
    })

    it('encendido, el mismo aparato viejo sólo AVISA (nunca bloquea una venta), con o sin revisión', async () => {
      const x = await negocio()
      await terminal(x.venueId, { type: 'POS_IOS', version: '1.14.0', visto: hace(2) })
      await encenderIvaPorProducto(x.venueId)
      const sin = await estadoIvaPorProducto(x.venueId, AHORA)
      expect(sin).toMatchObject({ encendido: true, contabilidad: false, bloqueos: [], facturasSinSello: [], revisado: false })
      expect(typeof sin.habilitadoAt).toBe('string')
      expect(sin.avisos).toEqual([expect.objectContaining({ codigo: 'APARATO_VIEJO' })])
      const con = await estadoIvaPorProducto(x.venueId, AHORA, CON_REVISION)
      expect(con).toMatchObject({ encendido: true, bloqueos: [], revisado: true })
      expect(con.avisos).toEqual(sin.avisos)
    })

    // Codex código r1 #7 (Ruling CX-7): la respuesta del GET lleva a lo más 20 avisos y, si hay más, `avisosTotal`.
    it('CX-7 · encendido con 25 aparatos viejos: 20 avisos + `avisosTotal: 25`; con 20 o menos, sin `avisosTotal`', async () => {
      const x = await negocio()
      await prisma.terminal.createMany({
        data: Array.from({ length: 25 }, (_, i) => ({
          venueId: x.venueId,
          name: `iPad ${String(i).padStart(2, '0')}`,
          type: 'POS_IOS' as const,
          version: '1.14.0',
          status: 'ACTIVE' as const,
          lastHeartbeat: hace(2),
        })),
      })
      await encenderIvaPorProducto(x.venueId)
      const e = await estadoIvaPorProducto(x.venueId, AHORA)
      expect(e.avisos).toHaveLength(20)
      expect(e.avisosTotal).toBe(25)

      const y = await negocio()
      await terminal(y.venueId, { type: 'POS_IOS', version: '1.14.0', visto: hace(2) })
      await encenderIvaPorProducto(y.venueId)
      const pocos = await estadoIvaPorProducto(y.venueId, AHORA)
      expect(pocos.avisos).toHaveLength(1)
      expect(pocos).not.toHaveProperty('avisosTotal')
    })

    it('con un cierre de periodo ⇒ `contabilidad: true` en los dos estados (con revisión, además bloquea apagado)', async () => {
      const x = await negocio()
      await prisma.accountingPeriodLock.create({ data: { organizationId: x.organizationId, rfc: x.rfc, period: '2026-06' } })
      const apagado = await estadoIvaPorProducto(x.venueId, AHORA, CON_REVISION)
      expect(apagado).toMatchObject({ encendido: false, contabilidad: true })
      expect(apagado.bloqueos.map(b => b.codigo)).toEqual(['CONTABILIDAD'])
      expect(await estadoIvaPorProducto(x.venueId, AHORA)).toMatchObject({ encendido: false, contabilidad: true, bloqueos: [] })
      await encenderIvaPorProducto(x.venueId)
      expect(await estadoIvaPorProducto(x.venueId, AHORA)).toMatchObject({ encendido: true, contabilidad: true, bloqueos: [] })
      expect(await estadoIvaPorProducto(x.venueId, AHORA, CON_REVISION)).toMatchObject({
        encendido: true,
        contabilidad: true,
        bloqueos: [],
      })
    })

    it('con revisión · apagado: una heredada sin XML sale como «no se pudo leer» y NUNCA llama al PAC', async () => {
      const x = await negocio()
      const reparar = jest.spyOn(finalizadorCfdi, 'repararArchivosDe')
      try {
        const f = await heredada(x.venueId, null, '9002')
        const e = await estadoIvaPorProducto(x.venueId, AHORA, CON_REVISION)
        expect(e.bloqueos.map(b => b.codigo)).toEqual(['FACTURA_VIEJA_SIN_SELLO'])
        expect(e.bloqueos[0].mensaje).toContain(MOTIVO_XML_ILEGIBLE)
        expect(e.bloqueos[0].mensaje).toContain(`A-${f.folio}`)
        expect(reparar).not.toHaveBeenCalled()
      } finally {
        reparar.mockRestore()
      }
    })

    it('con revisión · encendido: las facturas viejas que la puesta al día todavía tiene que sellar salen en `facturasSinSello`', async () => {
      const x = await negocio()
      await encenderIvaPorProducto(x.venueId)
      const sellable = await heredada(x.venueId, xmlDe('0.160000'), '7001')
      const mixta = await heredada(x.venueId, XML_MIXTO, '7002')
      const e = await estadoIvaPorProducto(x.venueId, AHORA, CON_REVISION)
      expect(e.bloqueos).toEqual([])
      expect(e.facturasSinSello.map(f => f.cfdiId).sort()).toEqual([sellable.id, mixta.id].sort())
    })

    it('T5-a · SIN revisión (lo que usa el GET) un negocio apagado no corre NINGUNA revisión: ni plan de heredadas ni extracciones; con revisión, sí', async () => {
      const x = await negocio()
      // Todo lo que una revisión encontraría: aparato viejo, POS externo, factura vieja mixta, factura en vuelo y extracción pendiente.
      await terminal(x.venueId, { type: 'POS_IOS', version: '1.14.0', visto: hace(2) })
      await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'SOFTRESTAURANT' } })
      await heredada(x.venueId, XML_MIXTO)
      await cfdi(await hermano(x), { status: 'STAMPING' })
      await extraccionPendiente(x.venueId)
      const plan = jest.spyOn(sellosHeredados, 'planDeSelladoHeredado')
      const extracciones = jest.spyOn(cfdiService, 'extraccionesPendientes')
      try {
        const sin = await estadoIvaPorProducto(x.venueId, AHORA)
        expect(sin).toMatchObject({
          encendido: false,
          habilitadoAt: null,
          contabilidad: false,
          bloqueos: [],
          avisos: [],
          facturasSinSello: [],
          revisado: false,
        })
        expect(plan).not.toHaveBeenCalled()
        expect(extracciones).not.toHaveBeenCalled()

        const con = await estadoIvaPorProducto(x.venueId, AHORA, CON_REVISION)
        expect(con.revisado).toBe(true)
        expect(new Set(con.bloqueos.map(b => b.codigo))).toEqual(
          new Set(['DOCUMENTOS_EN_VUELO', 'FACTURA_VIEJA_SIN_SELLO', 'POS_EXTERNO', 'APARATO_VIEJO']),
        )
        expect(plan).toHaveBeenCalledTimes(1) // los espías sí ven las llamadas: la ausencia de arriba no es vacua
        expect(extracciones).toHaveBeenCalled()
      } finally {
        plan.mockRestore()
        extracciones.mockRestore()
      }
    })
  })

  // Codex código r1 #6 (Ruling CX-6): la pre-revisión (fuera de la transacción, sin exclusiva ni PAC) junta TODO lo que se puede comprobar
  // leyendo; una heredada SIN XML no bloquea aquí (se le pide al PAC al encender). La revisión definitiva bajo candados no cambia.
  describe('CX-6 · prepararEncendido: el 409 trae todos los bloqueos comprobables', () => {
    const duenoDe = async (x: Negocio) => {
      const staffId = (await prisma.staff.create({ data: { email: `enc-${randomUUID()}@t.mx`, firstName: 'IVA', lastName: 'CX6' } })).id
      staffs.push(staffId)
      await prisma.staffVenue.create({ data: { staffId, venueId: x.venueId, role: StaffRole.OWNER, active: true } })
      return staffId
    }

    it('antes de la observación: fecha, aparato viejo, contabilidad, POS, delivery, documentos en vuelo y heredadas no sellables, juntos; sin PAC ni exclusiva', async () => {
      const x = await negocio()
      const otra = await negocio()
      const staffId = await duenoDe(x)
      await prisma.accountingPeriodLock.create({ data: { organizationId: x.organizationId, rfc: x.rfc, period: '2026-06' } })
      const norte = await hermano(x, 'Sucursal Norte')
      const uuidAjeno = randomUUID().toUpperCase()
      await cfdi(norte, { status: 'STAMPING', folio: '8881', uuid: uuidAjeno })
      await cfdi(x.venueId, { status: 'STAMPING', folio: '8882' })
      await heredada(x.venueId, XML_MIXTO, '7801')
      await heredada(x.venueId, null, '7802') // sin XML: NO bloquea en la pre-revisión
      const movida = await heredada(x.venueId, xmlDe('0.160000'), '7803')
      await prisma.order.update({ where: { id: movida.orderId! }, data: { venueId: otra.venueId } })
      await prisma.venue.update({ where: { id: x.venueId }, data: { posType: 'SOFTRESTAURANT' } })
      await terminal(x.venueId, { type: 'POS_IOS', version: '1.14.0', visto: new Date('2026-10-18T00:00:00Z') })
      const exclusiva = jest.spyOn(admisionIva, 'tomarAdmisionExclusiva')
      const reparar = jest.spyOn(finalizadorCfdi, 'repararArchivosDe')
      try {
        const e = await prepararEncendido(
          x.venueId,
          'IVA_0',
          { ivaTratamiento: 'IVA_16', ajusteDeliveryAlgunaVez: true },
          staffId,
          new Date('2026-10-20T00:00:00Z'),
        ).catch((err: unknown) => err)
        expect(e).toMatchObject({ statusCode: 409, code: 'IVA_ENCENDIDO_BLOQUEADO' })
        const bloqueos = (e as { details: { bloqueos: Array<{ codigo: string; mensaje: string }> } }).details.bloqueos
        expect(new Set(bloqueos.map(b => b.codigo))).toEqual(
          new Set([
            'CONTABILIDAD',
            'DOCUMENTOS_EN_VUELO',
            'FACTURA_VIEJA_SIN_SELLO',
            'POS_EXTERNO',
            'APARATOS_VERIFICACION_PENDIENTE',
            'APARATO_VIEJO',
            'AJUSTE_DE_DELIVERY',
          ]),
        )
        const mensajes = bloqueos.map(b => b.mensaje)
        expect(mensajes).toContain('La factura A-8882 se está procesando o cancelando')
        expect(mensajes).toContain('Hay 1 factura en proceso en otra sucursal de tu organización')
        expect(mensajes.filter(m => m.startsWith('La factura A-78')).sort()).toEqual([
          expect.stringContaining('A-7801'),
          `La factura A-7803: ${MOTIVO_ORDEN_EN_OTRA_ORGANIZACION}`,
        ])
        expect(JSON.stringify(bloqueos)).not.toMatch(new RegExp(`7802|8881|${uuidAjeno.slice(0, 8)}|Sucursal Norte`))
        expect(exclusiva).not.toHaveBeenCalled()
        expect(reparar).not.toHaveBeenCalled()
      } finally {
        exclusiva.mockRestore()
        reparar.mockRestore()
      }
    })

    it('con la observación completa y sólo una heredada SIN XML: la pre-revisión no la bloquea y el plan se la pide al PAC una vez', async () => {
      const x = await negocio()
      const staffId = await duenoDe(x)
      const f = await heredada(x.venueId, null, '7811')
      const reparar = jest.spyOn(finalizadorCfdi, 'repararArchivosDe').mockResolvedValue(undefined as never)
      try {
        const plan = await prepararEncendido(
          x.venueId,
          'IVA_0',
          { ivaTratamiento: 'IVA_16', ajusteDeliveryAlgunaVez: false },
          staffId,
          AHORA,
        )
        expect(plan).not.toBeNull()
        expect(reparar).toHaveBeenCalledTimes(1)
        expect(reparar).toHaveBeenCalledWith(f.id)
      } finally {
        reparar.mockRestore()
      }
    })
  })

  describe('GET /api/v1/dashboard/venues/:venueId/iva-por-producto', () => {
    it('con token ⇒ 200 y `data.encendido`; sin token ⇒ 401', async () => {
      const x = await negocio()
      const staffId = (await prisma.staff.create({ data: { email: `enc-${randomUUID()}@t.mx`, firstName: 'IVA', lastName: 'Tarea5' } })).id
      staffs.push(staffId)
      await prisma.staffVenue.create({ data: { staffId, venueId: x.venueId, role: StaffRole.OWNER, active: true } })
      const token = jwt.sign(
        { sub: staffId, orgId: x.organizationId, venueId: x.venueId, role: StaffRole.OWNER },
        process.env.ACCESS_TOKEN_SECRET as string,
        {
          expiresIn: '15m',
        },
      )
      const ruta = `/api/v1/dashboard/venues/${x.venueId}/iva-por-producto`

      // El GET se llama en cada carga de Productos: nunca corre la revisión (T5-a). Un aparato viejo la haría bloquear.
      await terminal(x.venueId, { type: 'POS_IOS', version: '1.14.0', visto: new Date() })
      const plan = jest.spyOn(sellosHeredados, 'planDeSelladoHeredado')
      let res
      try {
        res = await request(server).get(ruta).set('Authorization', `Bearer ${token}`)
        expect(plan).not.toHaveBeenCalled()
      } finally {
        plan.mockRestore()
      }
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({
        encendido: false,
        contabilidad: false,
        bloqueos: [],
        avisos: [],
        facturasSinSello: [],
        revisado: false,
      })

      await encenderIvaPorProducto(x.venueId)
      const encendido = await request(server).get(ruta).set('Authorization', `Bearer ${token}`)
      expect(encendido.status).toBe(200)
      expect(encendido.body.data.encendido).toBe(true)

      expect((await request(server).get(ruta)).status).toBe(401)
    })

    it('Minor T5-3 · un SUPERADMIN con un negocio que no existe ⇒ 404 (no 500); con un id mal formado ⇒ 400, como la ruta vecina', async () => {
      const x = await negocio()
      const staffId = (await prisma.staff.create({ data: { email: `enc-${randomUUID()}@t.mx`, firstName: 'IVA', lastName: 'Super' } })).id
      staffs.push(staffId)
      await prisma.staffVenue.create({ data: { staffId, venueId: x.venueId, role: StaffRole.SUPERADMIN, active: true } })
      const token = jwt.sign(
        { sub: staffId, orgId: x.organizationId, venueId: x.venueId, role: StaffRole.SUPERADMIN },
        process.env.ACCESS_TOKEN_SECRET as string,
        { expiresIn: '15m' },
      )
      const get = (venueId: string) =>
        request(server).get(`/api/v1/dashboard/venues/${venueId}/iva-por-producto`).set('Authorization', `Bearer ${token}`)

      const inexistente = await get('cnoexiste0000000000000000')
      expect(inexistente.status).toBe(404)
      expect(inexistente.body.message).toBeTruthy()
      expect((await get('no-es-un-id')).status).toBe(400)
      expect((await get(x.venueId)).status).toBe(200)
    })
  })

  // Revisión final, I-1 paso 2: lo que NO depende de la admisión se revisa FUERA de la transacción. Con la fecha REAL (sin mock), antes del
  // 31-oct 22:00Z todo encendido está condenado («Verificación pendiente»): 409 sin tomar la exclusiva ni pedirle el XML al PAC.
  describe('I-1 · encendido condenado antes del 31-oct (fecha real)', () => {
    const antesDelCorte = Date.now() < new Date('2026-10-31T22:00:00Z').getTime()
    ;(antesDelCorte ? it : it.skip)(
      '409 IVA_ENCENDIDO_BLOQUEADO sin exclusiva y sin PAC (el plan de heredadas sólo LEE); nada escrito',
      async () => {
        const x = await negocio()
        const staffId = (await prisma.staff.create({ data: { email: `enc-${randomUUID()}@t.mx`, firstName: 'IVA', lastName: 'Dueño' } })).id
        staffs.push(staffId)
        await prisma.staffVenue.create({ data: { staffId, venueId: x.venueId, role: StaffRole.OWNER, active: true } })
        const categoryId = (
          await prisma.menuCategory.create({ data: { venueId: x.venueId, name: 'IVA', slug: `iva-${randomUUID().slice(0, 8)}` } })
        ).id
        const p = await prisma.product.create({
          data: { venueId: x.venueId, categoryId, sku: `I1-${randomUUID().slice(0, 8)}`, name: 'Café en grano', price: 100 },
        })
        await heredada(x.venueId, null, '9100') // sin XML: el plan de sellado se lo pediría al PAC
        const exclusiva = jest.spyOn(admisionIva, 'tomarAdmisionExclusiva')
        const plan = jest.spyOn(sellosHeredados, 'planDeSelladoHeredado')
        const reparar = jest.spyOn(finalizadorCfdi, 'repararArchivosDe').mockResolvedValue(undefined as never)
        try {
          const e = await updateProduct(x.venueId, p.id, { ivaTratamiento: 'IVA_0' } as any, {
            type: 'HUMAN',
            staffId,
            impersonating: false,
          }).catch((err: unknown) => err)
          expect(e).toMatchObject({ statusCode: 409, code: 'IVA_ENCENDIDO_BLOQUEADO' })
          // CX-6: la heredada sin XML no bloquea en la pre-revisión; sólo la fecha.
          expect((e as { details: { bloqueos: Array<{ codigo: string }> } }).details.bloqueos.map(b => b.codigo)).toEqual([
            'APARATOS_VERIFICACION_PENDIENTE',
          ])
          expect(exclusiva).not.toHaveBeenCalled()
          expect(plan).toHaveBeenCalledTimes(1) // CX-6: la pre-revisión mira las heredadas por lectura...
          expect(plan).not.toHaveBeenCalledWith(x.venueId) // ...nunca con la reparación por omisión (la que llama al PAC)
          expect(reparar).not.toHaveBeenCalled()
        } finally {
          exclusiva.mockRestore()
          plan.mockRestore()
          reparar.mockRestore()
        }
        expect(await prisma.venueIvaPorProducto.count({ where: { venueId: x.venueId } })).toBe(0)
        expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).ivaTratamiento).toBe('IVA_16')
      },
    )
  })
})
