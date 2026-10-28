// tests/integration/fiscal/puestaAlDia6b.test.ts
//
// IVA por producto, plan 6b, Tarea 10 (spec §5.2b, condición D21): la puesta al día de los negocios YA encendidos (Testarudo, a mano el
// 30-sep). Sella desde su XML las facturas heredadas que se pueden, LISTA las que no, nunca bloquea nada y es idempotente. El ensayo
// (`aplicar: false`) sólo lee: no escribe ni pide el XML al PAC. Contra Postgres real y la base desechable.
import { spawnSync } from 'child_process'
import path from 'path'
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as admision from '@/services/fiscal/admisionIva'
import { sellarRenglones } from '@/services/fiscal/sellosIva'
import {
  MOTIVO_ORDEN_EN_OTRA_ORGANIZACION,
  MOTIVO_SELLO_DISTINTO,
  MOTIVO_XML_ILEGIBLE,
  MOTIVO_XML_SIN_TASA_UNICA,
} from '@/services/fiscal/sellosHeredados'
import * as sellosHeredados from '@/services/fiscal/sellosHeredados'
import { puestaAlDia } from '../../../scripts/iva/puesta-al-dia-6b'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

// Se simula la reparación del XML (la que habla con el PAC): el ensayo no debe llamarla; la corrida real sí. La referencia es perezosa
// porque `jest.mock` se eleva por encima de los `import` y `mockReparar` aún no existe cuando se arma la fábrica.
const mockReparar = jest.fn()
jest.mock('../../../src/services/fiscal/finalizadorCfdi', () => ({
  ...jest.requireActual('../../../src/services/fiscal/finalizadorCfdi'),
  repararArchivosDe: (...args: unknown[]) => mockReparar(...args),
}))

// Antes de registrar cualquier siembra o limpieza: nunca aceptar la base compartida.
const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const testDatabase = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !isDisposableH1Url(testDatabase) &&
  !(
    ['postgres:', 'postgresql:'].includes(testDatabase.protocol) &&
    ['localhost', '127.0.0.1'].includes(testDatabase.hostname) &&
    testDatabase.pathname === '/avoqado_cambio_r5_test_20261024'
  )
) {
  throw new Error('Esta suite exige una base H1 desechable validada (avoqado_h1a_test_<fecha>); nunca av-db-25.')
}
const NOMBRE_DE_LA_BASE = testDatabase.pathname.slice(1)

const traslado = (tasa: '0.160000' | '0.000000') => ({
  impuesto: '002',
  tipoFactor: 'Tasa',
  tasa,
  base: '100.00',
  importe: tasa === '0.000000' ? '0.00' : '16.00',
})
const xmlDe = (...tasas: Array<'0.160000' | '0.000000'>) => ({
  version: 1,
  subTotal: '100.00',
  descuento: '0.00',
  total: '116.00',
  totalImpuestosTrasladados: '16.00',
  conceptos: tasas.map(t => ({ noIdentificacion: null, objetoImp: '02', importe: '100.00', descuento: '0.00', traslados: [traslado(t)] })),
})
const XML_16 = xmlDe('0.160000')
const XML_0 = xmlDe('0.000000')

describe('puestaAlDia (integración): los negocios ya encendidos sellan sus facturas heredadas, sin bloquear nada', () => {
  const venues: string[] = []
  let sufijo = 0

  afterAll(async () => {
    // Dos pasadas: una venta movida de sede deja sus renglones en OTRO negocio, y los productos no se borran mientras tengan ventas.
    for (const venueId of venues) {
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.orderItemSelloIva.deleteMany({ where: { OR: [{ orderItem: { order: { venueId } } }, { cfdi: { venueId } }] } })
      await prisma.cfdi.deleteMany({ where: { venueId } })
      await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
      await prisma.order.deleteMany({ where: { venueId } })
    }
    for (const venueId of venues) {
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

  /** Un negocio con un «café» al precio del ticket; encendido (y con el café en IVA_0 si se pide) o apagado. */
  async function armarNegocio(o: { encendido: boolean; cafeIva0?: boolean }) {
    const id = `pd-${randomUUID().slice(0, 8)}-${sufijo++}`
    await prisma.organization.create({ data: { id, name: id, email: `${id}@example.test`, phone: '5500000000' } })
    const venueId = (await prisma.venue.create({ data: { id, organizationId: id, name: id, slug: id } })).id
    venues.push(venueId)
    const category = await prisma.menuCategory.create({ data: { venueId, name: id, slug: id } })
    const cafeId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: 'Café', sku: id, price: 116 } })).id
    const fiscalEmisorId = (
      await prisma.fiscalEmisor.create({
        data: { venueId, rfc: 'AAA010101AAA', legalName: id, regimenFiscal: '601', lugarExpedicion: '01000', csdStatus: 'ACTIVE' },
      })
    ).id
    if (o.encendido) await encenderIvaPorProducto(venueId)
    if (o.cafeIva0) await prisma.product.update({ where: { id: cafeId }, data: { ivaTratamiento: 'IVA_0' } })
    return { venueId, cafeId, fiscalEmisorId }
  }
  type Negocio = Awaited<ReturnType<typeof armarNegocio>>

  /** Una venta con 2 cafés, sin sellar. */
  async function nuevaOrden(n: Negocio) {
    const orden = await prisma.order.create({
      data: {
        venueId: n.venueId,
        orderNumber: `pd-${randomUUID().slice(0, 8)}`,
        subtotal: new Prisma.Decimal(200),
        taxAmount: new Prisma.Decimal(32),
        total: new Prisma.Decimal(232),
      } as Prisma.OrderUncheckedCreateInput,
    })
    for (let i = 0; i < 2; i++) {
      await prisma.orderItem.create({
        data: {
          orderId: orden.id,
          productId: n.cafeId,
          productName: `Café ${i + 1}`,
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

  /** Una factura HEREDADA (sin `protocoloIva`), individual, de ingreso y timbrada. */
  const nuevaHeredada = async (n: Negocio, orderId: string, extra: Partial<Prisma.CfdiUncheckedCreateInput> = {}) => {
    const serie = 'A'
    const folio = String(Math.floor(Math.random() * 1_000_000))
    const f = await prisma.cfdi.create({
      data: {
        venueId: n.venueId,
        fiscalEmisorId: n.fiscalEmisorId,
        type: 'INGRESO',
        status: 'STAMPED',
        flow: 'AUTOFACTURA_A',
        orderId,
        serie,
        folio,
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
        idempotencyKey: `pd-${randomUUID()}`,
        attempts: 3,
        updatedAt: new Date(),
        ...extra,
      } as Prisma.CfdiUncheckedCreateInput,
    })
    return { cfdiId: f.id, folio: `${f.serie}-${f.folio}` }
  }

  const tratamientos = async (orderId: string) =>
    (await prisma.orderItem.findMany({ where: { orderId }, select: { ivaTratamiento: true }, orderBy: { id: 'asc' } })).map(
      i => i.ivaTratamiento,
    )
  const sellosDelNegocio = (venueId: string) => prisma.orderItemSelloIva.count({ where: { cfdi: { venueId } } })
  const sellosPuestaAlDia = (venueId: string) =>
    prisma.activityLog.count({ where: { venueId, action: 'CFDI_HEREDADA_SELLADA', data: { path: ['origen'], equals: 'PUESTA_AL_DIA' } } })

  /** El arranque de verdad, en otro proceso (ts-node, como lo correrá el founder) y contra la base desechable. */
  function correrScript(args: string[]) {
    const raiz = path.resolve(__dirname, '../../..')
    const r = spawnSync(
      path.join(raiz, 'node_modules/.bin/ts-node'),
      ['-T', '-r', 'tsconfig-paths/register', 'scripts/iva/puesta-al-dia-6b.ts', ...args],
      { cwd: raiz, env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: 'utf8', timeout: 170_000 },
    )
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
  }
  const CLI_TIMEOUT = 180_000
  // El informe es el JSON que empieza en una línea que abre con «[» (antes salen el registro del arranque y la línea «Base: …»).
  const informeDe = (stdout: string) => JSON.parse(stdout.slice(stdout.search(/^\[/m)))

  // Los negocios y facturas del escenario (se arman una vez; las pruebas dependen del orden del archivo).
  let testarudo: Negocio
  let apagado: Negocio
  let a36: { cfdiId: string; folio: string }
  let b: { cfdiId: string; folio: string }
  let c: { cfdiId: string; folio: string }
  let ordenA: string
  let ordenB: string
  let ordenC: string
  let ordenApagado: string
  let cfdiApagado: string

  beforeAll(async () => {
    // «Testarudo de prueba»: encendido a mano, con el café ya en IVA_0.
    testarudo = await armarNegocio({ encendido: true, cafeIva0: true })
    // (a) La A-36: XML todo 0 %, su renglón YA sellado IVA_0 con su OrderItemSelloIva (como respaldos/2026-09-30-testarudo-iva-0/sello-a36.sql).
    const oa = await nuevaOrden(testarudo)
    ordenA = oa.orderId
    a36 = await nuevaHeredada(testarudo, ordenA, { serie: 'A', folio: '36', attempts: 9, xmlConceptos: XML_0 })
    await prisma.$transaction(tx =>
      sellarRenglones(tx, {
        cfdiId: a36.cfdiId,
        intento: 9,
        renglones: oa.itemIds.map(orderItemId => ({ orderItemId, tratamiento: 'IVA_0' as const })),
      }),
    )
    // (b) XML todo 16 % de una venta con el café (que HOY es 0 %) ⇒ debe quedar IVA_16.
    ordenB = (await nuevaOrden(testarudo)).orderId
    b = await nuevaHeredada(testarudo, ordenB, { xmlConceptos: XML_16 })
    // (c) XML mixto ⇒ se lista.
    ordenC = (await nuevaOrden(testarudo)).orderId
    c = await nuevaHeredada(testarudo, ordenC, { xmlConceptos: xmlDe('0.160000', '0.000000') })
    // (d) Otra, de un negocio APAGADO ⇒ no se toca.
    apagado = await armarNegocio({ encendido: false })
    ordenApagado = (await nuevaOrden(apagado)).orderId
    cfdiApagado = (await nuevaHeredada(apagado, ordenApagado, { xmlConceptos: XML_16 })).cfdiId
    mockReparar.mockReset()
  })

  it('ensayo: dice qué haría y no escribe nada', async () => {
    const antes = await sellosDelNegocio(testarudo.venueId)
    const logsAntes = await prisma.activityLog.count({ where: { venueId: testarudo.venueId } })
    const [r] = await puestaAlDia({ aplicar: false, venueId: testarudo.venueId })
    expect(r.venueId).toBe(testarudo.venueId)
    expect(r.porSellar).toEqual([`${b.folio} → IVA_16`])
    expect(r.sellados).toEqual([])
    expect(r.noSellables).toEqual([{ cfdiId: c.cfdiId, folio: c.folio, motivo: MOTIVO_XML_SIN_TASA_UNICA }])
    expect(await sellosDelNegocio(testarudo.venueId)).toBe(antes)
    expect(await prisma.activityLog.count({ where: { venueId: testarudo.venueId } })).toBe(logsAntes)
    expect(await tratamientos(ordenB)).toEqual([null, null])
    expect(mockReparar).not.toHaveBeenCalled()
  })

  it(
    'el arranque: una base distinta a la conectada aborta SIN escribir, y el ensayo imprime la base y el informe sin escribir',
    async () => {
      const mal = correrScript(['--confirmar-base', 'otra_base', '--venue', testarudo.venueId])
      expect(mal.error).toBeUndefined()
      expect(mal.status).toBe(1)
      expect(mal.stderr).toContain('No se escribió nada')
      expect(mal.stderr).toContain(`--confirmar-base ${NOMBRE_DE_LA_BASE}`)
      expect(await tratamientos(ordenB)).toEqual([null, null])

      const sinNada = correrScript(['--venue', testarudo.venueId])
      expect(sinNada.status).toBe(1) // ni --dry-run ni --confirmar-base: no escribe
      expect(await tratamientos(ordenB)).toEqual([null, null])

      const raro = correrScript(['--dry-run', `--venue=${testarudo.venueId}`])
      expect(raro.status).toBe(1) // un argumento mal escrito no puede ampliar el alcance
      expect(raro.stderr).toContain('Argumento desconocido')

      const ensayo = correrScript(['--dry-run', '--venue', testarudo.venueId])
      expect(ensayo.error).toBeUndefined()
      expect(ensayo.status).toBe(0)
      expect(ensayo.stdout).toContain(`Base: ${NOMBRE_DE_LA_BASE}`)
      expect(ensayo.stdout).not.toContain('postgresql://') // nunca la URL ni la clave
      const informe = informeDe(ensayo.stdout)
      expect(informe).toEqual([
        {
          venueId: testarudo.venueId,
          porSellar: [`${b.folio} → IVA_16`],
          sellados: [],
          noSellables: [{ cfdiId: c.cfdiId, folio: c.folio, motivo: MOTIVO_XML_SIN_TASA_UNICA }],
        },
      ])
      expect(await tratamientos(ordenB)).toEqual([null, null])
    },
    CLI_TIMEOUT,
  )

  it('§5.2b: sella desde el XML el renglón facturado al 16 % de un café que HOY es 0 %; la A-36 no se toca; nada se bloquea', async () => {
    const [r] = await puestaAlDia({ aplicar: true, venueId: testarudo.venueId })
    expect(r.sellados).toEqual([b.folio])
    expect(r.noSellables).toEqual([{ cfdiId: c.cfdiId, folio: c.folio, motivo: MOTIVO_XML_SIN_TASA_UNICA }])
    expect(await tratamientos(ordenB)).toEqual(['IVA_16', 'IVA_16'])
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: b.cfdiId } })).toBe(2)
    // La A-36 sigue con su sello a mano, sin otro, y su renglón no cambió.
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: a36.cfdiId } })).toBe(2)
    expect(await tratamientos(ordenA)).toEqual(['IVA_0', 'IVA_0'])
    expect(await sellosPuestaAlDia(testarudo.venueId)).toBe(1) // sólo la (b): la A-36 no se auditó otra vez
    // La mixta (c) se lista y no se toca.
    expect(await tratamientos(ordenC)).toEqual([null, null])
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: c.cfdiId } })).toBe(0)
    // No se re-enciende ni se apaga, y el café sigue en 0 % (el renglón sellado manda; el producto no se toca).
    expect(await prisma.venueIvaPorProducto.count({ where: { venueId: testarudo.venueId } })).toBe(1)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: testarudo.cafeId } })).ivaTratamiento).toBe('IVA_0')
    // El negocio apagado no se tocó.
    expect(await tratamientos(ordenApagado)).toEqual([null, null])
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: cfdiApagado } })).toBe(0)
    expect(await prisma.venueIvaPorProducto.count({ where: { venueId: apagado.venueId } })).toBe(0)
  })

  it('correrla dos veces no cambia nada', async () => {
    const sellos = await sellosDelNegocio(testarudo.venueId)
    const logs = await prisma.activityLog.count({ where: { venueId: testarudo.venueId, action: 'CFDI_HEREDADA_SELLADA' } })
    const [r] = await puestaAlDia({ aplicar: true, venueId: testarudo.venueId })
    expect(r.sellados).toEqual([])
    expect(r.porSellar).toEqual([])
    expect(r.noSellables).toEqual([{ cfdiId: c.cfdiId, folio: c.folio, motivo: MOTIVO_XML_SIN_TASA_UNICA }]) // la mixta sigue listada
    expect(await sellosDelNegocio(testarudo.venueId)).toBe(sellos)
    expect(await prisma.activityLog.count({ where: { venueId: testarudo.venueId, action: 'CFDI_HEREDADA_SELLADA' } })).toBe(logs)
    expect(await tratamientos(ordenB)).toEqual(['IVA_16', 'IVA_16'])
  })

  it(
    'el arranque con la base confirmada corre de verdad y, ya al día, no cambia nada',
    async () => {
      const sellos = await sellosDelNegocio(testarudo.venueId)
      const ok = correrScript(['--confirmar-base', NOMBRE_DE_LA_BASE, '--venue', testarudo.venueId])
      expect(ok.error).toBeUndefined()
      expect(ok.status).toBe(0)
      expect(ok.stdout).toContain(`Base: ${NOMBRE_DE_LA_BASE}`)
      const informe = informeDe(ok.stdout)
      expect(informe).toEqual([
        {
          venueId: testarudo.venueId,
          porSellar: [],
          sellados: [],
          noSellables: [{ cfdiId: c.cfdiId, folio: c.folio, motivo: MOTIVO_XML_SIN_TASA_UNICA }],
        },
      ])
      expect(await sellosDelNegocio(testarudo.venueId)).toBe(sellos)
    },
    CLI_TIMEOUT,
  )

  it('ensayo con una heredada SIN XML: no pide la reparación ni cambia sus campos (Codex r1 P2-6); la corrida real sí la pide', async () => {
    // Se siembra DENTRO de esta prueba: si no, el ensayo de la primera la listaría.
    const ordenE = (await nuevaOrden(testarudo)).orderId
    const e = await nuevaHeredada(testarudo, ordenE, {
      xmlConceptos: Prisma.DbNull,
      xmlUrl: null,
      pdfUrl: null,
      taxBreakdown: Prisma.DbNull,
    })
    const campos = { xmlConceptos: true, xmlUrl: true, pdfUrl: true, taxBreakdown: true, updatedAt: true } as const
    const antes = await prisma.cfdi.findUniqueOrThrow({ where: { id: e.cfdiId }, select: campos })

    mockReparar.mockReset()
    const [r] = await puestaAlDia({ aplicar: false, venueId: testarudo.venueId })
    expect(mockReparar).not.toHaveBeenCalled()
    expect(r.noSellables).toContainEqual({ cfdiId: e.cfdiId, folio: e.folio, motivo: MOTIVO_XML_ILEGIBLE })
    expect(MOTIVO_XML_ILEGIBLE).toBe('No se pudo leer su XML')
    expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: e.cfdiId }, select: campos })).toEqual(antes)
    expect(await tratamientos(ordenE)).toEqual([null, null])

    // La corrida autorizada sí la pide (una vez); si el PAC no la da, queda listada y nada se rompe.
    const [real] = await puestaAlDia({ aplicar: true, venueId: testarudo.venueId })
    expect(mockReparar).toHaveBeenCalledTimes(1)
    expect(mockReparar).toHaveBeenCalledWith(e.cfdiId)
    expect(real.sellados).toEqual([])
    expect(real.noSellables).toContainEqual({ cfdiId: e.cfdiId, folio: e.folio, motivo: MOTIVO_XML_ILEGIBLE })
    expect(await tratamientos(ordenE)).toEqual([null, null])
  })

  it('una factura que truena NO tumba la corrida: dos heredadas de la misma venta con tasas distintas ⇒ una se sella, la otra se lista y las demás siguen', async () => {
    mockReparar.mockReset()
    const n = await armarNegocio({ encendido: true })
    const o1 = await nuevaOrden(n)
    // Dos heredadas vivas de UNA venta, una al 16 % y otra al 0 %: el plan las ve sellables a las dos (aún nada está sellado) y la segunda
    // que se aplica diverge de la primera.
    const f1 = await nuevaHeredada(n, o1.orderId, { xmlConceptos: XML_16 })
    const f2 = await nuevaHeredada(n, o1.orderId, { xmlConceptos: XML_0 })
    const o2 = await nuevaOrden(n)
    const f3 = await nuevaHeredada(n, o2.orderId, { xmlConceptos: XML_16 })

    const [ensayo] = await puestaAlDia({ aplicar: false, venueId: n.venueId })
    expect(ensayo.porSellar).toHaveLength(3)
    expect(await sellosDelNegocio(n.venueId)).toBe(0)

    const [r] = await puestaAlDia({ aplicar: true, venueId: n.venueId })
    expect(r.sellados).toHaveLength(2)
    expect(r.sellados).toContain(f3.folio)
    const [sellada, rechazada] = r.sellados.includes(f1.folio) ? [f1, f2] : [f2, f1]
    expect(r.sellados).toContain(sellada.folio)
    expect(r.noSellables).toEqual([{ cfdiId: rechazada.cfdiId, folio: rechazada.folio, motivo: MOTIVO_SELLO_DISTINTO }])
    // La que truena revirtió ENTERA (ni un sello a medias); la otra y la tercera quedaron selladas.
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: rechazada.cfdiId } })).toBe(0)
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: sellada.cfdiId } })).toBe(2)
    expect(await tratamientos(o2.orderId)).toEqual(['IVA_16', 'IVA_16'])
    expect(await sellosPuestaAlDia(n.venueId)).toBe(2)
  })

  it('un error inesperado al sellar se lista SIN su mensaje (el informe no lleva datos) y no detiene a las demás', async () => {
    mockReparar.mockReset()
    const n = await armarNegocio({ encendido: true })
    const o1 = await nuevaOrden(n)
    const f1 = await nuevaHeredada(n, o1.orderId, { xmlConceptos: XML_16 })
    const o2 = await nuevaOrden(n)
    const f2 = await nuevaHeredada(n, o2.orderId, { xmlConceptos: XML_16 })
    const real = admision.bloquearOrdenesParaFacturar
    const espia = jest
      .spyOn(admision, 'bloquearOrdenesParaFacturar')
      .mockRejectedValueOnce(Object.assign(new Error('detalle con un teléfono 5512345678'), { code: 'P2034' }))
      .mockImplementation(real)
    try {
      const [r] = await puestaAlDia({ aplicar: true, venueId: n.venueId })
      const [primera, segunda] = [f1, f2].sort((x, y) => (x.cfdiId < y.cfdiId ? -1 : 1)) // el plan va por id
      expect(r.sellados).toEqual([segunda.folio])
      expect(r.noSellables).toEqual([
        { cfdiId: primera.cfdiId, folio: primera.folio, motivo: expect.stringContaining('Error inesperado al sellar (Error P2034)') },
      ])
      expect(JSON.stringify(r)).not.toContain('5512345678')
      expect(await sellosDelNegocio(n.venueId)).toBe(2) // sólo los de la que sí se selló
    } finally {
      espia.mockRestore()
    }
  })

  /** Una emisión en curso: sostiene el `FOR UPDATE` de la venta hasta que se llame a `soltar` (que espera a que termine). */
  async function retenerOrden(orderId: string) {
    let tomada!: () => void
    let liberar!: () => void
    const yaTomada = new Promise<void>(r => (tomada = r))
    const emision = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`
        tomada()
        await new Promise<void>(r => (liberar = r))
      },
      { timeout: 60_000 },
    )
    await yaTomada
    return {
      soltar: async () => {
        liberar()
        await emision
      },
    }
  }

  it.each([
    ['en su sede', false],
    ['aunque el job de PlayTelecom la movió a otra sede (se bloquea por id, sin venueId)', true],
  ])(
    'bloquea la venta ANTES de sellar, %s: si una emisión la tiene tomada, la puesta al día espera; al soltarla, sella',
    async (_caso, movida) => {
      mockReparar.mockReset()
      const n = await armarNegocio({ encendido: true })
      const o = await nuevaOrden(n)
      await nuevaHeredada(n, o.orderId, { xmlConceptos: XML_16 })
      // Otra sede de la MISMA organización: el job de PlayTelecom mueve ventas entre sedes de UNA organización (Ruling T6-a). Una venta en
      // OTRA organización ya no se sella aquí (Ruling CX-1, prueba de abajo). `armarNegocio` crea la organización con el id del negocio.
      const otraSede = movida ? `pd-${randomUUID().slice(0, 8)}-${sufijo++}` : null
      if (otraSede) {
        await prisma.venue.create({ data: { id: otraSede, organizationId: n.venueId, name: otraSede, slug: otraSede } })
        await prisma.order.update({ where: { id: o.orderId }, data: { venueId: otraSede } })
      }
      try {
        const emision = await retenerOrden(o.orderId)
        const corrida = puestaAlDia({ aplicar: true, venueId: n.venueId })
        let esperando = 0
        for (let i = 0; i < 40 && esperando === 0; i++) {
          await new Promise(r => setTimeout(r, 100))
          const [fila] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM "Order"%FOR UPDATE%'`
          esperando = fila.n
        }
        expect(esperando).toBeGreaterThan(0) // quedó esperando el candado de la venta
        expect(await tratamientos(o.orderId)).toEqual([null, null]) // y mientras tanto no selló nada
        await emision.soltar()
        const [r] = await corrida
        expect(r.sellados).toHaveLength(1)
        expect(await tratamientos(o.orderId)).toEqual(['IVA_16', 'IVA_16'])
      } finally {
        // La limpieza va por las sedes de `venues`: la venta vuelve a la suya y la sede extra se borra (su organización es la del negocio).
        if (otraSede) {
          await prisma.order.update({ where: { id: o.orderId }, data: { venueId: n.venueId } })
          await prisma.venue.delete({ where: { id: otraSede } })
        }
      }
    },
  )

  // Codex código r1 #1 (Ruling CX-1): sellarla exigiría la admisión de OTRA organización; la puesta al día nunca bloquea: la lista con su
  // motivo para revisarla a mano y no sella nada de esa venta.
  // Codex código r2 N3 (Ruling CX-13): el traslado llega ENTRE el plan (que la vio sellable) y los candados de su transacción. Bajo los
  // candados se comprueba otra vez que factura y venta siguen en la misma organización: se lista con el mismo motivo y no se sella.
  it('CX-13 · la venta se mueve a OTRA organización entre el plan y los candados: no se sella; se lista con su motivo', async () => {
    mockReparar.mockReset()
    const n = await armarNegocio({ encendido: true })
    const o = await nuevaOrden(n)
    const c = await nuevaHeredada(n, o.orderId, { xmlConceptos: XML_16 })
    const otra = await armarNegocio({ encendido: false })
    const planReal = sellosHeredados.planDeSelladoHeredado
    const plan = jest.spyOn(sellosHeredados, 'planDeSelladoHeredado').mockImplementation(async (...a) => {
      const p = await planReal(...a)
      expect(p.sellables.map(s => s.cfdiId)).toEqual([c.cfdiId]) // el plan la vio sellable
      await prisma.order.update({ where: { id: o.orderId }, data: { venueId: otra.venueId } })
      return p
    })
    try {
      const [r] = await puestaAlDia({ aplicar: true, venueId: n.venueId })
      expect(plan).toHaveBeenCalledTimes(1)
      expect(r.sellados).toEqual([])
      expect(r.noSellables).toEqual([{ cfdiId: c.cfdiId, folio: c.folio, motivo: MOTIVO_ORDEN_EN_OTRA_ORGANIZACION }])
      expect(await tratamientos(o.orderId)).toEqual([null, null])
    } finally {
      plan.mockRestore()
    }
  })

  it('CX-1 · la venta se movió a OTRA organización: no se sella; se lista con su motivo', async () => {
    mockReparar.mockReset()
    const n = await armarNegocio({ encendido: true })
    const o = await nuevaOrden(n)
    const c = await nuevaHeredada(n, o.orderId, { xmlConceptos: XML_16 })
    const otra = await armarNegocio({ encendido: false })
    await prisma.order.update({ where: { id: o.orderId }, data: { venueId: otra.venueId } })
    const [r] = await puestaAlDia({ aplicar: true, venueId: n.venueId })
    expect(r.sellados).toEqual([])
    expect(r.noSellables).toEqual([{ cfdiId: c.cfdiId, folio: c.folio, motivo: MOTIVO_ORDEN_EN_OTRA_ORGANIZACION }])
    expect(await tratamientos(o.orderId)).toEqual([null, null])
  })

  it('Ruling T10-a: la transacción de cada factura aguanta una espera de candado mayor a los 5 s por omisión de Prisma y aun así sella', async () => {
    mockReparar.mockReset()
    const n = await armarNegocio({ encendido: true })
    const o = await nuevaOrden(n)
    await nuevaHeredada(n, o.orderId, { xmlConceptos: XML_16 })
    const emision = await retenerOrden(o.orderId)
    const corrida = puestaAlDia({ aplicar: true, venueId: n.venueId })
    await new Promise(r => setTimeout(r, 6_500)) // más que el límite por omisión (5 s): con él, la factura saldría con P2028
    expect(await tratamientos(o.orderId)).toEqual([null, null]) // sigue esperando la venta
    await emision.soltar()
    const [r] = await corrida
    expect(r.noSellables).toEqual([])
    expect(r.sellados).toHaveLength(1)
    expect(await tratamientos(o.orderId)).toEqual(['IVA_16', 'IVA_16'])
  }, 60_000)

  it('sin venueId recorre sólo los negocios encendidos', async () => {
    mockReparar.mockReset()
    const informe = await puestaAlDia({ aplicar: false })
    const ids = informe.map(i => i.venueId)
    expect(ids).toContain(testarudo.venueId)
    expect(ids).not.toContain(apagado.venueId)
    expect(mockReparar).not.toHaveBeenCalled()
    // Un negocio apagado, pedido por su id, tampoco produce informe.
    expect(await puestaAlDia({ aplicar: false, venueId: apagado.venueId })).toEqual([])
  })
})
