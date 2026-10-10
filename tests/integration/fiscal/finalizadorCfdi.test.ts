import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  finalizarTimbre,
  completarArchivos,
  escalarIntentoIncierto,
  dondeFaltanArchivos,
  repararArchivosDe,
} from '@/services/fiscal/finalizadorCfdi'
import { reconcileStuckCfdi } from '@/services/fiscal/cfdiReconcile.service'
import { getCfdiStatus } from '@/services/fiscal/cfdi.service'
import { sellarRenglones } from '@/services/fiscal/sellosIva'
import { TOPE_XML_TIMBRADO_PROPIO_BYTES } from '@/services/fiscal/cfdiReceived.parser'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// La base fiscal de esta Mac o la desechable de CI (ci-cd.yml adopta ese nombre en vez de relajar la guarda): nunca otra.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !['/av_db_25_iva_test', '/avoqado_h1a_test_20260808'].includes(database.pathname)
)
  throw new Error('Exige av_db_25_iva_test o la desechable de CI (avoqado_h1a_test_20260808), locales.')
const xml = readFileSync(join(__dirname, '../../fixtures/cfdi/iva16-exento.xml'))

describe('finalizador y conciliación reales', () => {
  const fixture = `finalizador-${randomUUID()}`
  let venueId: string, fiscalEmisorId: string, productId: string
  const stamped = {
    status: 'valid' as const,
    providerInvoiceId: 'pac',
    uuid: 'uuid',
    serie: 'F',
    folio: '9',
    stampedAt: new Date(),
    totalCents: 11600,
  }
  const provider = {
    getInvoice: jest.fn(),
    findByExternalId: jest.fn(),
    searchInvoices: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }
  const storeArtifact = jest.fn(async (_buffer: Buffer, path: string) => `https://example.test/${path}`)
  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { organizationId: fixture, name: fixture, slug: fixture } })).id
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    productId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: fixture, sku: fixture, price: 116 } })).id
    fiscalEmisorId = (
      await prisma.fiscalEmisor.create({
        data: { venueId, rfc: 'AAA010101AAA', legalName: fixture, regimenFiscal: '601', lugarExpedicion: '01000' },
      })
    ).id
  })
  beforeEach(() => {
    stamped.uuid = randomUUID()
    provider.getInvoice.mockReset().mockResolvedValue(stamped)
    provider.findByExternalId.mockReset().mockResolvedValue(null)
    provider.searchInvoices.mockReset().mockResolvedValue({ invoices: [stamped], truncated: false })
    provider.downloadXml.mockReset().mockResolvedValue(xml)
    provider.downloadPdf.mockReset().mockResolvedValue(Buffer.from('%PDF'))
    storeArtifact.mockClear()
  })
  afterAll(async () => {
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
  })
  async function reservation(extra = {}) {
    const order = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 100,
        taxAmount: 16,
        total: 116,
        items: { create: { productId, quantity: 1, unitPrice: 100, taxAmount: 16, total: 116 } },
      },
      include: { items: true },
    })
    const cfdi = await prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId,
        orderId: order.id,
        flow: 'STAFF_B',
        status: 'STAMPING',
        attempts: 1,
        protocoloIva: 1,
        enviadoAt: new Date(),
        idempotencyKey: randomUUID(),
        receptorRfc: 'XAXX010101000',
        receptorNombre: 'PUBLICO',
        receptorRegimen: '616',
        receptorCp: '01000',
        usoCfdi: 'S01',
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        ...extra,
      },
    })
    await prisma.$transaction(tx =>
      sellarRenglones(tx, { cfdiId: cfdi.id, intento: 1, renglones: [{ orderItemId: order.items[0].id, tratamiento: 'IVA_16' }] }),
    )
    return cfdi
  }
  const current = (id: string) => prisma.cfdi.findUniqueOrThrow({ where: { id } })
  const seals = (id: string) => prisma.orderItemSelloIva.findMany({ where: { cfdiId: id } })
  const finish = (row: any, extra = {}) =>
    finalizarTimbre({
      cfdiId: row.id,
      idempotencyKey: row.idempotencyKey,
      version: row.attempts,
      identidad: { ...stamped, facturapiId: stamped.providerInvoiceId },
      ...extra,
    })
  const reconcile = (row: any) =>
    reconcileStuckCfdi({ cfdi: row, now: new Date(), sandbox: true }, { resolveProvider: () => provider as any, storeArtifact })
  const artifacts = (row: any) =>
    completarArchivos(
      {
        cfdiId: row.id,
        idempotencyKey: row.idempotencyKey,
        providerInvoiceId: 'pac',
        venueSlug: fixture,
        uuid: stamped.uuid,
        provider: provider as any,
      },
      { storeArtifact },
    )
  it('RESET conserva sellos y versión; el timbre tardío finaliza sin resellar', async () => {
    const row = await reservation(),
      before = await seals(row.id)
    expect((await reconcile(row)).outcome).toBe('RESET')
    expect(await current(row.id)).toMatchObject({ status: 'STAMP_FAILED', attempts: 1, falloDefinitivo: false })
    expect(await seals(row.id)).toEqual(before)
    expect(await finish(row)).toBe('FINALIZADO')
    expect(await current(row.id)).toMatchObject({ status: 'STAMPED', uuid: stamped.uuid })
    expect(await seals(row.id)).toEqual(before)
  })
  it('recupera pending por id y conserva UUID, serie y folio', async () => {
    const row = await reservation({ facturapiId: 'pac' })
    expect((await reconcile(row)).outcome).toBe('COMPLETED')
    expect(provider.getInvoice).toHaveBeenCalledWith('pac')
    expect(await current(row.id)).toMatchObject({ status: 'STAMPED', uuid: stamped.uuid, serie: 'F', folio: '9', attempts: 1 })
  })
  it('pausa controlada: RESET tardío no degrada un timbre concurrente', async () => {
    const row = await reservation()
    let release!: () => void, searched!: () => void
    const found = new Promise<void>(resolve => {
      searched = resolve
    })
    const resume = new Promise<void>(resolve => {
      release = resolve
    })
    provider.findByExternalId.mockImplementationOnce(async () => {
      searched()
      await resume
      return null
    })
    const pending = reconcile(row)
    await found
    await finish(row)
    release()
    expect((await pending).outcome).toBe('SKIPPED')
    expect(await current(row.id)).toMatchObject({ status: 'STAMPED', uuid: stamped.uuid, attempts: 1 })
  })
  it.each([{ attempts: 2 }, { status: 'CANCELLED' as const }])('detecta respuesta vieja/cancelada %p', async extra => {
    const row = await reservation(extra),
      before = await current(row.id),
      originalSeals = await seals(row.id)
    expect(await finish(row, { version: 1 })).toBe('DUPLICADO')
    expect(await current(row.id)).toEqual(before)
    expect(await seals(row.id)).toEqual(originalSeals)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: row.id, action: 'CFDI_TIMBRE_DUPLICADO' } })).toBe(1)
  })
  it('idempotente sólo si coincide versión, identidad y estado STAMPED', async () => {
    const row = await reservation()
    expect(await finish(row)).toBe('FINALIZADO')
    expect(await finish(row)).toBe('YA_FINALIZADO')
    await prisma.cfdi.update({ where: { id: row.id }, data: { status: 'CANCELLED' } })
    expect(await finish(row)).toBe('DUPLICADO')
  })
  it('otra identidad o versión sobre STAMPED no cuenta como idempotencia', async () => {
    const row = await reservation()
    await finish(row)
    const before = await current(row.id)
    expect(await finish(row, { identidad: { ...stamped, facturapiId: 'otro-pac' } })).toBe('DUPLICADO')
    expect(await finish(row, { version: 0 })).toBe('DUPLICADO')
    expect(await current(row.id)).toEqual(before)
  })
  it('protocolo 1 jamás recupera por RFC+total; incierto sigue consultable por versión', async () => {
    const row = await reservation()
    await reconcile(row)
    expect(provider.searchInvoices).not.toHaveBeenCalled()
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${row.idempotencyKey}#1`)
    expect((await current(row.id)).facturapiId).toBeNull()
    provider.findByExternalId.mockResolvedValueOnce(stamped)
    expect((await reconcile(await current(row.id))).outcome).toBe('COMPLETED')
  })
  it.each([
    { status: 'pending', uuid: null },
    { status: 'valid', uuid: null },
  ])('no finaliza PAC incompleto %p', async response => {
    const row = await reservation({ facturapiId: 'pac' })
    provider.getInvoice.mockResolvedValueOnce({ ...stamped, ...response })
    expect((await reconcile(row)).outcome).toBe('INCONCLUSIVE')
    expect((await current(row.id)).status).toBe('STAMPING')
  })
  it('fallar storage no oculta un timbre válido', async () => {
    const row = await reservation({ facturapiId: 'pac' })
    provider.downloadXml.mockRejectedValueOnce(new Error('storage offline'))
    expect((await reconcile(row)).outcome).toBe('COMPLETED')
    expect(await current(row.id)).toMatchObject({ status: 'STAMPED', uuid: stamped.uuid, xmlUrl: null })
  })
  it.each([false, true])('escala una sola vez tras 61 minutos, PAC falla=%s y consulta concurrente', async failure => {
    const row = await reservation({ status: 'STAMP_FAILED', enviadoAt: new Date(Date.now() - 61 * 60_000) }),
      before = await current(row.id),
      originalSeals = await seals(row.id)
    if (failure) provider.findByExternalId.mockRejectedValue(new Error('PAC offline'))
    await Promise.all([reconcile(row), escalarIntentoIncierto(row)])
    await reconcile(row)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: row.id, action: 'CFDI_INTENTO_INCIERTO_ESCALADO' } })).toBe(1)
    expect(await current(row.id)).toEqual(before)
    expect(await seals(row.id)).toEqual(originalSeals)
  })
  it('archivos y desglose del XML; una cancelación durante descarga impide escribirlos', async () => {
    const row = await reservation()
    await finish(row)
    // C2 · T5 ronda 1 (M3): este fixture no es un comprobante completo (sin SubTotal/Total ni Importe/ObjetoImp en su concepto). Se guardan
    // los archivos y el desglose como siempre, pero NO `xmlConceptos` (nunca se inventa un "0").
    // C2 T7 (N1), cambio A PROPÓSITO: el resultado ya no es FALLO sino XML_ILEGIBLE (el XML se bajó y no se lee: permanente).
    expect(await artifacts(row)).toBe('XML_ILEGIBLE')
    expect(await current(row.id)).toMatchObject({
      xmlUrl: expect.stringContaining('.xml'),
      pdfUrl: expect.stringContaining('.pdf'),
      taxBreakdown: [
        { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '100.00', importe: '16.00' },
        { impuesto: '002', tipoFactor: 'Exento', tasa: null, base: '50.00', importe: null },
      ],
      // C2 T7 ronda 1 (I2), cambio A PROPÓSITO: el veredicto ilegible queda PERSISTIDO como marca (nunca unos conceptos inventados).
      xmlConceptos: { version: 1, ilegible: true, motivo: expect.any(String), at: expect.any(String) },
    })
    const cancelled = await reservation()
    stamped.uuid = randomUUID()
    await finish(cancelled)
    provider.downloadXml.mockImplementationOnce(async () => {
      await prisma.cfdi.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } })
      return xml
    })
    expect(await artifacts(cancelled)).toBe('XML_ILEGIBLE') // C2 T7 (N1): el MISMO fixture incompleto; lo que importa es que no escribe
    expect(await current(cancelled.id)).toMatchObject({
      status: 'CANCELLED',
      xmlUrl: null,
      pdfUrl: null,
      taxBreakdown: null,
      xmlConceptos: null,
    })
  })

  // C2 · Tarea 5 (Codex C2-13): las filas timbradas ANTES de la T5 tienen archivos y desglose pero no `xmlConceptos`. El barrido las
  // encuentra (en la base real: `DbNull` sobre JSON) y `repararArchivosDe` —la misma que usa la espera de una nota— las completa con el
  // CAS de hoy; después ya no las encuentra.
  const XML_C2 =
    '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" SubTotal="100.01" Total="116.01"><cfdi:Conceptos>' +
    '<cfdi:Concepto NoIdentificacion="T-1" ObjetoImp="02" Importe="100.000000"><cfdi:Impuestos><cfdi:Traslados>' +
    '<cfdi:Traslado Base="100.000000" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16.000000"/></cfdi:Traslados>' +
    '</cfdi:Impuestos></cfdi:Concepto><cfdi:Concepto ObjetoImp="01" Importe="0.010000"/></cfdi:Conceptos>' +
    '<cfdi:Impuestos TotalImpuestosTrasladados="16.00"><cfdi:Traslados><cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" ' +
    'TasaOCuota="0.160000" Importe="16.00"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Comprobante>'
  it('🔴 C2-T5 · una fila timbrada con archivos y SIN xmlConceptos entra al barrido; repararArchivosDe la completa y sale', async () => {
    const row = await reservation()
    await finish(row)
    const desglose = [{ impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '100.00', importe: '16.00' }]
    await prisma.cfdi.update({
      where: { id: row.id },
      data: { xmlUrl: 'https://example.test/viejo.xml', pdfUrl: 'https://example.test/viejo.pdf', taxBreakdown: desglose },
    })
    const corte = new Date(Date.now() + 60_000)
    const faltan = () => prisma.cfdi.findMany({ where: { AND: [dondeFaltanArchivos(corte, null), { id: row.id }] }, select: { id: true } })
    expect(await faltan()).toEqual([{ id: row.id }])
    provider.downloadXml.mockResolvedValue(Buffer.from(XML_C2))
    const deps = { resolverProveedor: () => provider as any, completar: (p: any) => completarArchivos(p, { storeArtifact }) }
    expect(await repararArchivosDe(row.id, { sandbox: true }, deps)).toBe('OK')
    expect(provider.downloadXml).toHaveBeenCalledWith('pac')
    expect(await current(row.id)).toMatchObject({
      status: 'STAMPED',
      xmlUrl: expect.stringContaining(`${stamped.uuid}.xml`),
      taxBreakdown: desglose,
      xmlConceptos: {
        version: 1,
        subTotal: '100.01',
        descuento: '0.00',
        total: '116.01',
        totalImpuestosTrasladados: '16.00',
        conceptos: [
          {
            noIdentificacion: 'T-1',
            objetoImp: '02',
            importe: '100.000000',
            descuento: '0',
            traslados: [{ impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '100.000000', importe: '16.000000' }],
          },
          { noIdentificacion: null, objetoImp: '01', importe: '0.010000', descuento: '0', traslados: [] },
        ],
      },
    })
    expect(await faltan()).toEqual([])
    // Ronda 1 (M1): `GET /cfdi/:id` (la fila de `getCfdiStatus`) no trae `xmlConceptos`; todo lo demás, sí.
    const vista = await getCfdiStatus({ cfdiId: row.id, expectedVenueId: venueId })
    expect(vista).not.toHaveProperty('xmlConceptos')
    expect(vista).toMatchObject({
      id: row.id,
      status: 'STAMPED',
      taxBreakdown: desglose,
      xmlUrl: expect.stringContaining('.xml'),
      replacedBy: [],
    })
    // Ronda 1 (M6): con la fila completa de nuevo sin `xmlConceptos` y el PDF del PAC caído, la evidencia del XML se escribe igual y el PDF
    // de antes se queda (la escritura sólo lleva lo que salió bien).
    await prisma.cfdi.update({ where: { id: row.id }, data: { xmlConceptos: Prisma.DbNull, pdfUrl: 'https://example.test/viejo.pdf' } })
    provider.downloadPdf.mockRejectedValueOnce(new Error('el PAC no rinde el PDF'))
    expect(await repararArchivosDe(row.id, { sandbox: true }, deps)).toBe('FALLO')
    expect(await current(row.id)).toMatchObject({
      pdfUrl: 'https://example.test/viejo.pdf',
      xmlConceptos: expect.objectContaining({ version: 1, total: '116.01' }),
    })
    expect(await faltan()).toEqual([])
    // Una fila que todavía no está timbrada: NO_APLICA, sin tocar al proveedor.
    const enCurso = await reservation()
    provider.downloadXml.mockClear()
    expect(await repararArchivosDe(enCurso.id, { sandbox: true }, deps)).toBe('NO_APLICA')
    expect(provider.downloadXml).not.toHaveBeenCalled()
  })
  // OF-1 · T7 N1 + M4: una factura con conceptos legibles a la que sólo le falta el PDF vuelve al barrido cada 5 min. Si el PAC contesta un
  // 200 que no es un CFDI (mantenimiento), la marca «ilegible» NO puede pisar esos conceptos (si no, toda nota se detiene para siempre).
  it('🔴 OF-1 · conceptos buenos y sin PDF + un 200 basura del PAC ⇒ el barrido no baja el XML y `xmlConceptos` queda intacto; sin conceptos ⇒ la marca', async () => {
    const row = await reservation()
    await finish(row)
    provider.downloadXml.mockResolvedValue(Buffer.from(XML_C2))
    expect(await artifacts(row)).toBe('OK')
    await prisma.cfdi.update({ where: { id: row.id }, data: { pdfUrl: null } })
    const antes = await current(row.id)
    expect(antes.xmlConceptos).toMatchObject({ version: 1, total: '116.01' })
    const corte = new Date(Date.now() + 60_000)
    const faltan = () => prisma.cfdi.findMany({ where: { AND: [dondeFaltanArchivos(corte, null), { id: row.id }] }, select: { id: true } })
    expect(await faltan()).toEqual([{ id: row.id }]) // vuelve por su PDF

    // (M4) El barrido: sólo el PDF; el XML ni se pide.
    provider.downloadXml.mockClear().mockResolvedValue(Buffer.from('esto no es xml'))
    const deps = { resolverProveedor: () => provider as any, completar: (p: any) => completarArchivos(p, { storeArtifact }) }
    expect(await repararArchivosDe(row.id, { sandbox: true }, deps)).toBe('OK')
    expect(provider.downloadXml).not.toHaveBeenCalled()
    expect(await current(row.id)).toMatchObject({
      xmlConceptos: antes.xmlConceptos,
      taxBreakdown: antes.taxBreakdown,
      xmlUrl: antes.xmlUrl,
      pdfUrl: expect.stringContaining('.pdf'),
    })
    expect(await faltan()).toEqual([])

    // (N1) Aunque el XML se baje (otra reparación a la vez que leyó la fila antes de los conceptos), la marca y lo que sale de un XML
    // ilegible no pisan lo que ya había: ni sin resumen ('esto no es xml') ni con un resumen vacío ('<Comprobante/>').
    for (const basura of ['esto no es xml', '<Comprobante/>']) {
      provider.downloadXml.mockResolvedValue(Buffer.from(basura))
      expect(await artifacts(row)).toBe('XML_ILEGIBLE')
      expect(await current(row.id)).toMatchObject({
        xmlConceptos: antes.xmlConceptos,
        taxBreakdown: antes.taxBreakdown,
        xmlUrl: antes.xmlUrl,
      })
    }

    // Una fila SIN conceptos y un XML ilegible ⇒ la marca, como hoy (con la versión del lector); y ya no vuelve al barrido por su XML.
    await prisma.cfdi.update({ where: { id: row.id }, data: { xmlConceptos: Prisma.DbNull } })
    provider.downloadXml.mockResolvedValue(Buffer.from('esto no es xml'))
    expect(await artifacts(row)).toBe('XML_ILEGIBLE')
    expect((await current(row.id)).xmlConceptos).toMatchObject({ version: 1, ilegible: true, motivo: expect.any(String), lector: 1 })
    expect(await faltan()).toEqual([])
  })

  // Ronda de la ola (review-OF m3): el XML de más de 4 MiB (T8 M4) con el almacenamiento caído UNA vez. Antes quedaba la marca sin `xmlUrl` y la
  // fila ya no volvía al barrido: nunca tendría su XML descargable. Ahora es un FALLO transitorio: sin marca, sigue en el barrido, y la
  // siguiente reparación guarda el archivo con la marca.
  it('🔴 m3 · XML > tope y la subida falla una vez ⇒ sin marca y en el barrido; la siguiente reparación lo guarda con la marca', async () => {
    const row = await reservation()
    await finish(row)
    await prisma.cfdi.update({ where: { id: row.id }, data: { xmlUrl: null, pdfUrl: null, taxBreakdown: Prisma.DbNull } })
    const grande = XML_C2.replace('</cfdi:Comprobante>', `<!--${'x'.repeat(TOPE_XML_TIMBRADO_PROPIO_BYTES)}--></cfdi:Comprobante>`)
    provider.downloadXml.mockResolvedValue(Buffer.from(grande))
    let fallo = false
    const almacen = jest.fn(async (_b: Buffer, path: string) => {
      if (path.endsWith('.xml') && !fallo) {
        fallo = true
        throw new Error('almacenamiento caído')
      }
      return `https://example.test/${path}`
    })
    const deps = { resolverProveedor: () => provider as any, completar: (p: any) => completarArchivos(p, { storeArtifact: almacen }) }
    const corte = new Date(Date.now() + 60_000)
    const faltan = () => prisma.cfdi.findMany({ where: { AND: [dondeFaltanArchivos(corte, null), { id: row.id }] }, select: { id: true } })

    expect(await repararArchivosDe(row.id, { sandbox: true }, deps)).toBe('FALLO')
    expect(await current(row.id)).toMatchObject({ xmlConceptos: null, xmlUrl: null, pdfUrl: expect.stringContaining('.pdf') })
    expect(await faltan()).toEqual([{ id: row.id }])

    expect(await repararArchivosDe(row.id, { sandbox: true }, deps)).toBe('XML_ILEGIBLE')
    const despues = await current(row.id)
    expect(despues.xmlUrl).toEqual(expect.stringContaining('.xml'))
    expect(despues.xmlConceptos).toMatchObject({ version: 1, ilegible: true, lector: 1 })
    expect(await faltan()).toEqual([])
  })
})
