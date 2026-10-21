import { readFileSync } from 'fs'
import { join } from 'path'
import { desgloseDesdeXml, finalizarTimbre } from '../../../../src/services/fiscal/finalizadorCfdi'
const xml = (name: string) => readFileSync(join(__dirname, '../../../fixtures/cfdi', `${name}.xml`), 'utf8')
const iva = { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '100.00', importe: '16.00' }
describe('finalizador CFDI', () => {
  it('lee sólo traslados del comprobante, conservando precisión textual', () => expect(desgloseDesdeXml(xml('iva16'))).toEqual([iva]))
  it('distingue tasa cero', () =>
    expect(desgloseDesdeXml(xml('iva16-cero'))).toEqual([
      iva,
      { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.000000', base: '50.00', importe: '0.00' },
    ]))
  it('distingue Exento sin tasa ni importe', () =>
    expect(desgloseDesdeXml(xml('iva16-exento'))).toEqual([
      iva,
      { impuesto: '002', tipoFactor: 'Exento', tasa: null, base: '50.00', importe: null },
    ]))
  it('un CFDI sin impuestos produce desglose vacío', () =>
    expect(desgloseDesdeXml('<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4"/>')).toEqual([]))
  it.each(['', '<xml/>', '<Comprobante><Impuestos>'])('rechaza XML inválido %s', value => expect(() => desgloseDesdeXml(value)).toThrow())
  it('no acepta pending aunque tenga UUID', async () => {
    const transaction = jest.fn()
    await expect(
      finalizarTimbre(
        {
          cfdiId: 'c',
          idempotencyKey: 'k',
          version: 1,
          identidad: { status: 'pending', facturapiId: 'p', uuid: 'u', serie: null, folio: null, stampedAt: new Date() },
        },
        { runInTransaction: transaction },
      ),
    ).rejects.toThrow()
    expect(transaction).not.toHaveBeenCalled()
  })
})

// ─── C2 · Tarea 5 (Codex C2-13, C2-14): el XML timbrado queda como evidencia (`Cfdi.xmlConceptos`) ───────────────────────────────
import { Prisma } from '@prisma/client'
import { XMLValidator } from 'fast-xml-parser'
import logger from '../../../../src/config/logger'
import prisma from '../../../../src/utils/prismaClient'
import {
  completarArchivos,
  conLimiteDeTiempo,
  dondeFaltanArchivos,
  ENFRIAMIENTO_TRAS_FALLO_MS,
  esMarcaDeXmlIlegible,
  LIMITE_REPARACION_MS,
  MARGEN_PARA_GUARDAR_ARCHIVOS_MS,
  marcaDeXmlIlegible,
  MEMORIA_DE_LO_PERMANENTE_MS,
  olvidarReparaciones,
  repararArchivosCompartido,
  repararArchivosDe,
  SELECCION_DE_REPARACION,
  VERSION_DEL_LECTOR_XML,
  type FilaDeReparacion,
} from '../../../../src/services/fiscal/finalizadorCfdi'
import { ProviderHttpError, TIEMPO_LIMITE_CONSULTA_MS } from '../../../../src/services/fiscal/providers/facturapi.provider'
import { leerXmlConceptos } from '../../../../src/services/fiscal/saldoFiscal'
import { TOPE_XML_TIMBRADO_PROPIO_BYTES } from '../../../../src/services/fiscal/cfdiReceived.parser'

const XML_C2 = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" SubTotal="250.01" Descuento="0.00" Total="258.01">
  <cfdi:Conceptos><cfdi:Concepto NoIdentificacion="F-1" ObjetoImp="02" Importe="250.000000" Descuento="0.000000"><cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="50.000000" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="8.000000"/><cfdi:Traslado Base="200.000000" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto><cfdi:Concepto ObjetoImp="01" Importe="0.010000"/></cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="8.00"><cfdi:Traslados><cfdi:Traslado Base="50.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="8.00"/><cfdi:Traslado Base="200.00" Impuesto="002" TipoFactor="Exento"/></cfdi:Traslados></cfdi:Impuestos>
</cfdi:Comprobante>`
const DESGLOSE_C2 = [
  { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '50.00', importe: '8.00' },
  { impuesto: '002', tipoFactor: 'Exento', tasa: null, base: '200.00', importe: null },
]
const CONCEPTOS_C2 = {
  version: 1,
  subTotal: '250.01',
  descuento: '0.00',
  total: '258.01',
  totalImpuestosTrasladados: '8.00',
  conceptos: [
    {
      noIdentificacion: 'F-1',
      objetoImp: '02',
      importe: '250.000000',
      descuento: '0.000000',
      traslados: [
        { impuesto: '002', tipoFactor: 'Tasa', tasa: '0.160000', base: '50.000000', importe: '8.000000' },
        { impuesto: '002', tipoFactor: 'Exento', tasa: null, base: '200.000000', importe: null },
      ],
    },
    { noIdentificacion: null, objetoImp: '01', importe: '0.010000', descuento: '0', traslados: [] },
  ],
}

describe('C2 · T5 · completarArchivos guarda también los conceptos del XML', () => {
  const proveedor = (xml: string) => ({
    downloadXml: jest.fn(async () => Buffer.from(xml)),
    downloadPdf: jest.fn(async () => Buffer.from('%PDF')),
  })
  const params = (xml = XML_C2) => ({
    cfdiId: 'c1',
    idempotencyKey: 'k1',
    version: 3,
    providerInvoiceId: 'pac-1',
    venueSlug: 'demo',
    uuid: 'U-1',
    provider: proveedor(xml),
  })
  const storeArtifact = jest.fn(async (_b: Buffer, path: string) => `https://example.test/${path}`)
  beforeEach(() => {
    storeArtifact.mockClear()
    ;(prisma.cfdi.updateMany as jest.Mock).mockReset().mockResolvedValue({ count: 1 })
  })

  it('🔴 `persistArtifacts` recibe `xmlConceptos` junto a `taxBreakdown`, sacados del MISMO XML', async () => {
    const persistArtifacts = jest.fn(async () => true)
    const p = params()
    expect(await completarArchivos(p, { storeArtifact, persistArtifacts })).toBe('OK')
    expect(persistArtifacts).toHaveBeenCalledWith(p, {
      xmlUrl: expect.stringContaining('U-1.xml'),
      pdfUrl: expect.stringContaining('U-1.pdf'),
      taxBreakdown: DESGLOSE_C2,
      xmlConceptos: CONCEPTOS_C2,
    })
  })

  it('🔴 la escritura de siempre (CAS por identidad, estado y versión) lleva `xmlConceptos` en la MISMA actualización', async () => {
    expect(await completarArchivos(params(), { storeArtifact })).toBe('OK')
    expect(prisma.cfdi.updateMany).toHaveBeenCalledTimes(1)
    expect(prisma.cfdi.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', idempotencyKey: 'k1', facturapiId: 'pac-1', uuid: 'U-1', status: 'STAMPED', attempts: 3 },
      data: {
        xmlUrl: expect.stringContaining('U-1.xml'),
        pdfUrl: expect.stringContaining('U-1.pdf'),
        taxBreakdown: DESGLOSE_C2,
        xmlConceptos: CONCEPTOS_C2,
      },
    })
  })

  // Ronda 1 (M3), cambio A PROPÓSITO de la prueba de la entrega: unos conceptos ilegibles ya no tumban los archivos de siempre. Se
  // guardan como antes de la T5 (las URLs y el desglose, que no dependen de los conceptos) y NUNCA `xmlConceptos`: el resultado es FALLO,
  // la fila sigue en el barrido y la nota sigue esperando.
  // C2 T7 (N1 de la re-revisión de la T5), cambio A PROPÓSITO: un XML que SÍ se bajó y no se lee es permanente ⇒ `XML_ILEGIBLE` (antes,
  // `FALLO`, igual que un PAC caído, y la nota esperaba para siempre). Lo que se guarda no cambia.
  // C2 T7 ronda 1 (I2), cambio A PROPÓSITO: el veredicto ilegible se PERSISTE como marca en `xmlConceptos` (nunca unos conceptos
  // inventados: la marca no es un `XmlConceptos` y `leerXmlConceptos` la rechaza).
  it('🔴 M3: un concepto con un traslado de IVA incompleto ⇒ XML_ILEGIBLE: se guardan los archivos, el desglose y la MARCA de ilegible (no unos conceptos)', async () => {
    const roto = XML_C2.replace(
      '<cfdi:Traslado Base="50.000000" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="8.000000"/>',
      '<cfdi:Traslado Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="8.000000"/>',
    )
    const persistArtifacts = jest.fn(async () => true)
    const p = params(roto)
    expect(await completarArchivos(p, { storeArtifact, persistArtifacts })).toBe('XML_ILEGIBLE')
    expect(persistArtifacts).toHaveBeenCalledWith(p, {
      xmlUrl: expect.stringContaining('U-1.xml'),
      pdfUrl: expect.stringContaining('U-1.pdf'),
      taxBreakdown: DESGLOSE_C2,
      // OF-1 (T7 N1), cambio A PROPÓSITO: la marca lleva la versión del lector.
      xmlConceptos: {
        version: 1,
        ilegible: true,
        motivo: expect.stringContaining('traslado de IVA incompleto'),
        at: expect.any(String),
        lector: VERSION_DEL_LECTOR_XML,
      },
    })
  })

  it('🔴 M3: un atributo obligatorio ausente (Importe) ⇒ XML_ILEGIBLE con su motivo en el log, y `xmlConceptos` sólo lleva la marca (nunca un "0" inventado)', async () => {
    const sinImporte = XML_C2.replace(' Importe="250.000000"', '')
    const persistArtifacts = jest.fn(async () => true)
    const p = params(sinImporte)
    ;(logger.error as jest.Mock).mockClear()
    expect(await completarArchivos(p, { storeArtifact, persistArtifacts })).toBe('XML_ILEGIBLE')
    expect(persistArtifacts).toHaveBeenCalledTimes(1)
    const escrito = (persistArtifacts.mock.calls[0] as any[])[1].xmlConceptos
    expect(esMarcaDeXmlIlegible(escrito)).toBe(true)
    expect(leerXmlConceptos(escrito)).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('xmlConceptos'),
      expect.objectContaining({ cfdiId: 'c1', motivo: expect.stringMatching(/«Importe» válido en el concepto 1/) }),
    )
  })

  it('🔴 M2: el XML se valida y se lee UNA sola vez (de esa lectura salen el desglose y los conceptos)', async () => {
    const validar = jest.spyOn(XMLValidator, 'validate')
    try {
      expect(await completarArchivos(params(), { storeArtifact, persistArtifacts: async () => true })).toBe('OK')
      expect(validar).toHaveBeenCalledTimes(1)
    } finally {
      validar.mockRestore()
    }
  })

  it('🔴 C2 T7 (N1): un XML que se bajó pero no es un CFDI ⇒ XML_ILEGIBLE (permanente), aunque el PDF sí suba', async () => {
    const persistArtifacts = jest.fn(async () => true)
    const p = params('<Comprobante/>')
    expect(await completarArchivos(p, { storeArtifact, persistArtifacts })).toBe('XML_ILEGIBLE')
    expect(await completarArchivos(params('esto no es xml'), { storeArtifact, persistArtifacts })).toBe('XML_ILEGIBLE')
  })
  it('🔴 C2 T7 ronda 1 (I2): un XML que ni siquiera es un CFDI también deja la marca (sólo eso y el PDF)', async () => {
    const persistArtifacts = jest.fn(async () => true)
    expect(await completarArchivos(params('<Comprobante/>'), { storeArtifact, persistArtifacts })).toBe('XML_ILEGIBLE')
    expect(esMarcaDeXmlIlegible((persistArtifacts.mock.calls[0] as any[])[1].xmlConceptos)).toBe(true)
  })
  it.each([404, 401, 403])(
    '🔴 C2 T7 ronda 1 (M1): el PAC contesta %i al bajar el XML ⇒ XML_NO_DISPONIBLE (permanente; no se persiste: un permiso se arregla)',
    async status => {
      const persistArtifacts = jest.fn(async () => true)
      const p = {
        ...params(),
        provider: {
          downloadXml: jest.fn(async () => Promise.reject(new ProviderHttpError(status, null, 'no'))),
          downloadPdf: jest.fn(async () => Buffer.from('%PDF')),
        },
      }
      expect(await completarArchivos(p, { storeArtifact, persistArtifacts })).toBe('XML_NO_DISPONIBLE')
      expect((persistArtifacts.mock.calls[0] as any[])?.[1] ?? {}).not.toHaveProperty('xmlConceptos')
    },
  )
  it.each([500, 429])('control — C2 T7 ronda 1 (M1): un %i del PAC sigue siendo FALLO (transitorio)', async status => {
    const p = {
      ...params(),
      provider: {
        downloadXml: jest.fn(async () => Promise.reject(new ProviderHttpError(status, null, 'no'))),
        downloadPdf: jest.fn(async () => Buffer.from('%PDF')),
      },
    }
    expect(await completarArchivos(p, { storeArtifact, persistArtifacts: async () => true })).toBe('FALLO')
  })
  it('control — C2 T7 (N1): el XML no baja (el PAC no responde) sigue siendo FALLO (transitorio), no ILEGIBLE', async () => {
    const p = {
      ...params(),
      provider: {
        downloadXml: jest.fn(async () => Promise.reject(new Error('PAC caído'))),
        downloadPdf: jest.fn(async () => Buffer.from('%PDF')),
      },
    }
    expect(await completarArchivos(p, { storeArtifact, persistArtifacts: async () => true })).toBe('FALLO')
  })
  it('control — C2 T7 (N1): el XML se lee pero no se puede subir (almacenamiento caído) sigue siendo FALLO', async () => {
    const subirSinXml = jest.fn(async (_b: Buffer, path: string) => {
      if (path.endsWith('.xml')) throw new Error('almacenamiento caído')
      return `https://example.test/${path}`
    })
    expect(await completarArchivos(params(), { storeArtifact: subirSinXml, persistArtifacts: async () => true })).toBe('FALLO')
  })

  describe('🔴 M6: la evidencia del XML no depende del PDF (ni al revés); lo que salió bien va en UNA escritura con el CAS', () => {
    const conPdf = (pdf: jest.Mock, xml: jest.Mock = jest.fn(async () => Buffer.from(XML_C2))) => ({
      ...params(),
      provider: { downloadXml: xml, downloadPdf: pdf },
    })
    const XML = { xmlUrl: expect.stringContaining('U-1.xml'), taxBreakdown: DESGLOSE_C2, xmlConceptos: CONCEPTOS_C2 }

    it('el PDF no baja ⇒ se escriben el XML, el desglose y los conceptos; FALLO (falta el PDF)', async () => {
      const persistArtifacts = jest.fn(async () => true)
      const p = conPdf(jest.fn(async () => Promise.reject(new Error('el PAC no rinde el PDF'))))
      expect(await completarArchivos(p, { storeArtifact, persistArtifacts })).toBe('FALLO')
      expect(persistArtifacts).toHaveBeenCalledWith(p, XML)
    })

    it('el PDF no se sube ⇒ igual: la evidencia del XML se escribe', async () => {
      const persistArtifacts = jest.fn(async () => true)
      const subirSinPdf = jest.fn(async (_b: Buffer, path: string) => {
        if (path.endsWith('.pdf')) throw new Error('almacenamiento caído')
        return `https://example.test/${path}`
      })
      const p = params()
      expect(await completarArchivos(p, { storeArtifact: subirSinPdf, persistArtifacts })).toBe('FALLO')
      expect(persistArtifacts).toHaveBeenCalledWith(p, XML)
    })

    it('el XML no baja ⇒ sólo el PDF; FALLO', async () => {
      const persistArtifacts = jest.fn(async () => true)
      const p = conPdf(
        jest.fn(async () => Buffer.from('%PDF')),
        jest.fn(async () => Promise.reject(new Error('timeout'))),
      )
      expect(await completarArchivos(p, { storeArtifact, persistArtifacts })).toBe('FALLO')
      expect(persistArtifacts).toHaveBeenCalledWith(p, { pdfUrl: expect.stringContaining('U-1.pdf') })
    })

    it('control — no baja nada ⇒ no se escribe nada; FALLO', async () => {
      const persistArtifacts = jest.fn(async () => true)
      const falla = () => jest.fn(async () => Promise.reject(new Error('PAC caído')))
      expect(await completarArchivos(conPdf(falla(), falla()), { storeArtifact, persistArtifacts })).toBe('FALLO')
      expect(persistArtifacts).not.toHaveBeenCalled()
    })
  })
})

describe('C2 · T5 · repararArchivosDe (la usan el reconciliador y la espera de una nota)', () => {
  const fila = (extra: Partial<FilaDeReparacion> = {}): FilaDeReparacion => ({
    id: 'c1',
    status: 'STAMPED',
    stampedAt: new Date('2026-10-01T12:00:00Z'),
    idempotencyKey: 'k1',
    attempts: 3,
    facturapiId: 'pac-1',
    uuid: 'U-1',
    venue: { slug: 'demo' },
    fiscalEmisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: 'cifrada' } as FilaDeReparacion['fiscalEmisor'],
    ...extra,
  })
  const proveedor = { downloadXml: jest.fn(), downloadPdf: jest.fn() }
  let resolverProveedor: jest.Mock
  let completar: jest.Mock
  beforeEach(() => {
    resolverProveedor = jest.fn(() => proveedor)
    completar = jest.fn(async () => 'OK' as const)
    ;(prisma.cfdi.findUnique as jest.Mock).mockReset()
  })

  it.each([
    ['en timbrado', { status: 'STAMPING' as const }],
    ['cancelada', { status: 'CANCELLED' as const }],
    ['sin facturapiId', { facturapiId: null }],
    ['sin uuid', { uuid: null }],
  ])('🔴 una fila %s ⇒ NO_APLICA sin llamar al proveedor', async (_caso, extra) => {
    const leerFila = jest.fn(async () => fila(extra))
    expect(await repararArchivosDe('c1', { sandbox: true }, { leerFila, resolverProveedor, completar })).toBe('NO_APLICA')
    expect(leerFila).toHaveBeenCalledWith('c1')
    expect(resolverProveedor).not.toHaveBeenCalled()
    expect(completar).not.toHaveBeenCalled()
  })

  it('🔴 una fila que no existe ⇒ NO_APLICA', async () => {
    expect(await repararArchivosDe('nada', {}, { leerFila: async () => null, resolverProveedor, completar })).toBe('NO_APLICA')
    expect(completar).not.toHaveBeenCalled()
  })

  it('🔴 una STAMPED ⇒ lee su fila con el select del barrido y llama `completarArchivos` con los MISMOS parámetros que armaba el reconciliador', async () => {
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValue(fila())
    expect(await repararArchivosDe('c1', { sandbox: true }, { resolverProveedor, completar })).toBe('OK')
    expect(prisma.cfdi.findUnique).toHaveBeenCalledWith({ where: { id: 'c1' }, select: SELECCION_DE_REPARACION })
    // Lo que el select de `repairArtifacts` leía hoy (más `status`, para decidir NO_APLICA con la fila fresca).
    expect(SELECCION_DE_REPARACION).toEqual({
      id: true,
      status: true,
      stampedAt: true,
      idempotencyKey: true,
      attempts: true,
      facturapiId: true,
      uuid: true,
      venue: { select: { slug: true } },
      fiscalEmisor: { select: { id: true, provider: true, providerKeyEnc: true } },
    })
    expect(resolverProveedor).toHaveBeenCalledWith(fila().fiscalEmisor, { sandbox: true })
    expect(completar).toHaveBeenCalledWith({
      cfdiId: 'c1',
      idempotencyKey: 'k1',
      version: 3,
      providerInvoiceId: 'pac-1',
      uuid: 'U-1',
      venueSlug: 'demo',
      provider: proveedor,
    })
    completar.mockResolvedValueOnce('FALLO')
    expect(await repararArchivosDe('c1', { sandbox: false }, { resolverProveedor, completar })).toBe('FALLO')
    expect(resolverProveedor).toHaveBeenLastCalledWith(fila().fiscalEmisor, { sandbox: false })
  })

  it('🔴 C2 T7 (N1): con `completarArchivos` de verdad, un XML que se bajó y no se lee ⇒ XML_ILEGIBLE (la nota se detiene, nunca espera para siempre)', async () => {
    const ilegible = {
      downloadXml: jest.fn(async () => Buffer.from('<Comprobante/>')),
      downloadPdf: jest.fn(async () => Buffer.from('%PDF')),
    }
    const storeArtifact = jest.fn(async (_b: Buffer, path: string) => path)
    expect(
      await repararArchivosDe(
        'c1',
        { sandbox: true },
        {
          leerFila: async () => fila(),
          resolverProveedor: () => ilegible,
          completar: p => completarArchivos(p, { storeArtifact, persistArtifacts: async () => true }),
        },
      ),
    ).toBe('XML_ILEGIBLE')
  })

  it('🔴 sin `sandbox` explícito usa el del entorno, como el reconciliador (en pruebas NODE_ENV ≠ production ⇒ sandbox)', async () => {
    expect(await repararArchivosDe('c1', {}, { leerFila: async () => fila(), resolverProveedor, completar })).toBe('OK')
    expect(resolverProveedor).toHaveBeenCalledWith(fila().fiscalEmisor, { sandbox: true })
  })

  describe('🔴 I1: tiene límite de tiempo (una reparación colgada no detiene al barrido ni a la nota)', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())
    const enCurso = <T>(p: Promise<T>) => {
      const estado: { listo: boolean; valor?: T } = { listo: false }
      void p.then(v => Object.assign(estado, { listo: true, valor: v }))
      return estado
    }

    it('una reparación que nunca contesta ⇒ FALLO justo al vencer `LIMITE_REPARACION_MS`, ni antes ni después', async () => {
      const nunca = jest.fn(() => new Promise<'OK' | 'FALLO'>(() => {}))
      const r = enCurso(repararArchivosDe('c1', { sandbox: true }, { leerFila: async () => fila(), resolverProveedor, completar: nunca }))
      await jest.advanceTimersByTimeAsync(LIMITE_REPARACION_MS - 1)
      expect(r.listo).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      expect(r).toEqual({ listo: true, valor: 'FALLO' })
    })

    it('una bajada del PAC que nunca contesta (con `completarArchivos` de verdad) ⇒ FALLO al límite pedido, sin escribir nada', async () => {
      const persistArtifacts = jest.fn(async () => true)
      const colgado = { downloadXml: jest.fn(() => new Promise<Buffer>(() => {})), downloadPdf: jest.fn(async () => Buffer.from('%PDF')) }
      const storeArtifact = jest.fn(async (_b: Buffer, path: string) => path)
      const r = enCurso(
        repararArchivosDe(
          'c1',
          { sandbox: true, limiteMs: 5_000 },
          {
            leerFila: async () => fila(),
            resolverProveedor: () => colgado,
            completar: p => completarArchivos(p, { storeArtifact, persistArtifacts }),
          },
        ),
      )
      await jest.advanceTimersByTimeAsync(4_999)
      expect(r.listo).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      expect(r).toEqual({ listo: true, valor: 'FALLO' })
      expect(persistArtifacts).not.toHaveBeenCalled()
    })

    it('control — si el trabajo gana, devuelve lo suyo y no deja el reloj corriendo', async () => {
      expect(await conLimiteDeTiempo(Promise.resolve('OK'), 1_000, () => 'FALLO')).toBe('OK')
      expect(jest.getTimerCount()).toBe(0)
    })
  })

  // Ronda 1 (M4): la prueba de arriba no distinguía `?? NODE_ENV !== 'production'` de `?? true` (en pruebas NODE_ENV no es production).
  it('control — M4: en PRODUCCIÓN, sin `sandbox` explícito ⇒ { sandbox: false } (nunca manda las reparaciones a sandbox)', async () => {
    let reparar!: typeof repararArchivosDe
    jest.isolateModules(() => {
      jest.doMock('../../../../src/config/env', () => ({ ...jest.requireActual('../../../../src/config/env'), NODE_ENV: 'production' }))
      reparar = require('../../../../src/services/fiscal/finalizadorCfdi').repararArchivosDe
    })
    expect(await reparar('c1', {}, { leerFila: async () => fila(), resolverProveedor, completar })).toBe('OK')
    expect(resolverProveedor).toHaveBeenCalledWith(fila().fiscalEmisor, { sandbox: false })
  })

  it('control — nunca lanza: si la lectura o el proveedor fallan ⇒ FALLO (la nota sigue esperando; el barrido sigue con la siguiente fila)', async () => {
    const leerRota = jest.fn(async () => {
      throw new Error('P1001 sin base')
    })
    await expect(repararArchivosDe('c1', {}, { leerFila: leerRota, resolverProveedor, completar })).resolves.toBe('FALLO')
    const sinLlave = jest.fn(() => {
      throw new Error('No facturapi key available for emisor')
    })
    await expect(repararArchivosDe('c1', {}, { leerFila: async () => fila(), resolverProveedor: sinLlave, completar })).resolves.toBe(
      'FALLO',
    )
    expect(completar).not.toHaveBeenCalled()
  })
})

describe('C2 · T5 · dondeFaltanArchivos (la selección del reconciliador)', () => {
  const cutoff = new Date('2026-10-08T12:00:00Z')
  it('🔴 una fila STAMPED con desglose y XML pero SIN `xmlConceptos` entra a la reparación (antes no entraba); y una SIN PDF también (M6)', () => {
    // `toStrictEqual`: distingue `Prisma.DbNull` (columna nula) de `Prisma.JsonNull` (el JSON `null`), que `toEqual` confunde.
    // Ronda 1 (M6): como el XML y el PDF ya se escriben por separado, una fila puede quedar sin PDF: el barrido también la repara.
    // OF-1 (M4), cambio A PROPÓSITO: sin `xmlConceptos` ya cubre a las de sin desglose o sin URL del XML (los conceptos legibles se escriben
    // siempre con los dos); una con la marca de ilegible ya no vuelve cada 5 min por su XML, sólo por su PDF.
    expect(dondeFaltanArchivos(cutoff, null)).toStrictEqual({
      status: 'STAMPED',
      stampedAt: { lt: cutoff },
      OR: [{ xmlConceptos: { equals: Prisma.DbNull } }, { pdfUrl: null }],
    })
  })
  it('control — con cursor avanza por (stampedAt, id), como el barrido de hoy', () => {
    const c = { stampedAt: new Date('2026-10-01T00:00:00Z'), id: 'c9' }
    expect(dondeFaltanArchivos(cutoff, c).AND).toEqual([
      { OR: [{ stampedAt: { gt: c.stampedAt } }, { stampedAt: c.stampedAt, id: { gt: 'c9' } }] },
    ])
  })
})

describe('C2 · T7 ronda 1 (I2) · repararArchivosCompartido: una en vuelo por factura, lo permanente se recuerda y el FALLO se enfría', () => {
  const fila = (): FilaDeReparacion =>
    ({
      id: 'c1',
      status: 'STAMPED',
      stampedAt: new Date('2026-10-01T12:00:00Z'),
      idempotencyKey: 'k1',
      attempts: 3,
      facturapiId: 'pac-1',
      uuid: 'U-1',
      venue: { slug: 'demo' },
      fiscalEmisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: 'cifrada' },
    }) as FilaDeReparacion
  const diferido = () => {
    let resolver!: (r: any) => void
    const promesa = new Promise<any>(r => (resolver = r))
    return { promesa, resolver }
  }
  const deps = (completar: jest.Mock) => ({ leerFila: async () => fila(), resolverProveedor: () => ({}) as any, completar })
  beforeEach(() => {
    olvidarReparaciones()
    jest.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z') })
  })
  afterEach(() => {
    olvidarReparaciones()
    jest.useRealTimers()
  })

  it('🔴 dos vistas y el POST a la vez ⇒ UNA sola reparación; todos reciben su resultado', async () => {
    const d = diferido()
    const completar = jest.fn(() => d.promesa)
    const pedidos = [
      repararArchivosCompartido('c1', { esperaMs: 10_000 }, deps(completar)),
      repararArchivosCompartido('c1', { esperaMs: 10_000 }, deps(completar)),
      repararArchivosCompartido('c1', { esperaMs: 10_000, insistir: true }, deps(completar)),
    ]
    await jest.advanceTimersByTimeAsync(10)
    d.resolver('OK')
    expect(await Promise.all(pedidos)).toEqual(['OK', 'OK', 'OK'])
    expect(completar).toHaveBeenCalledTimes(1)
  })
  it('🔴 quien espera poco recibe EN_CURSO y la reparación sigue; el siguiente se une a la MISMA y lee su resultado', async () => {
    const d = diferido()
    const completar = jest.fn(() => d.promesa)
    const vista = repararArchivosCompartido('c1', { esperaMs: 2_000 }, deps(completar))
    await jest.advanceTimersByTimeAsync(2_000)
    expect(await vista).toBe('EN_CURSO')
    const otra = repararArchivosCompartido('c1', { esperaMs: 2_000 }, deps(completar))
    d.resolver('XML_ILEGIBLE')
    expect(await otra).toBe('XML_ILEGIBLE')
    expect(completar).toHaveBeenCalledTimes(1)
  })
  it('🔴 tras un FALLO, la vista no vuelve a pedirlo al PAC durante el enfriamiento; el POST (insistir) sí; pasado el enfriamiento, otra vez', async () => {
    const completar = jest.fn(async () => 'FALLO' as const)
    expect(await repararArchivosCompartido('c1', { esperaMs: 2_000 }, deps(completar))).toBe('FALLO')
    expect(await repararArchivosCompartido('c1', { esperaMs: 2_000 }, deps(completar))).toBe('FALLO')
    expect(completar).toHaveBeenCalledTimes(1)
    expect(await repararArchivosCompartido('c1', { esperaMs: 2_000, insistir: true }, deps(completar))).toBe('FALLO')
    expect(completar).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(ENFRIAMIENTO_TRAS_FALLO_MS + 1)
    await repararArchivosCompartido('c1', { esperaMs: 2_000 }, deps(completar))
    expect(completar).toHaveBeenCalledTimes(3)
  })
  it.each(['XML_ILEGIBLE', 'XML_NO_DISPONIBLE'] as const)(
    '🔴 %s se recuerda (ni el POST lo vuelve a bajar) hasta que pasa la memoria de lo permanente',
    async r => {
      const completar = jest.fn(async () => r)
      expect(await repararArchivosCompartido('c1', { esperaMs: 2_000 }, deps(completar))).toBe(r)
      expect(await repararArchivosCompartido('c1', { esperaMs: 2_000, insistir: true }, deps(completar))).toBe(r)
      expect(completar).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(MEMORIA_DE_LO_PERMANENTE_MS + 1)
      await repararArchivosCompartido('c1', { esperaMs: 2_000 }, deps(completar))
      expect(completar).toHaveBeenCalledTimes(2)
    },
  )
  it('🔴 NO_APLICA también se recuerda; un OK no (la fila ya tiene su XML: nadie lo vuelve a pedir)', async () => {
    const leerFila = jest.fn(async () => null)
    expect(
      await repararArchivosCompartido('c2', { esperaMs: 2_000 }, { leerFila, resolverProveedor: () => ({}) as any, completar: jest.fn() }),
    ).toBe('NO_APLICA')
    expect(
      await repararArchivosCompartido('c2', { esperaMs: 2_000 }, { leerFila, resolverProveedor: () => ({}) as any, completar: jest.fn() }),
    ).toBe('NO_APLICA')
    expect(leerFila).toHaveBeenCalledTimes(1)
    const completar = jest.fn(async () => 'OK' as const)
    await repararArchivosCompartido('c1', { esperaMs: 2_000 }, deps(completar))
    await repararArchivosCompartido('c1', { esperaMs: 2_000 }, deps(completar))
    expect(completar).toHaveBeenCalledTimes(2)
  })
  it('control — facturas distintas no se esperan entre sí', async () => {
    const d = diferido()
    const lenta = jest.fn(() => d.promesa)
    const rapida = jest.fn(async () => 'OK' as const)
    const a = repararArchivosCompartido('c1', { esperaMs: 10_000 }, deps(lenta))
    expect(await repararArchivosCompartido('c9', { esperaMs: 10_000 }, deps(rapida))).toBe('OK')
    d.resolver('OK')
    expect(await a).toBe('OK')
  })
  it('🔴 la marca: es una marca, no son conceptos', () => {
    const m = marcaDeXmlIlegible('x', new Date('2026-10-09T00:00:00Z'))
    // OF-1 (T7 N1), cambio A PROPÓSITO: la marca lleva la versión del lector que dio el veredicto.
    expect(m).toEqual({ version: 1, ilegible: true, motivo: 'x', at: '2026-10-09T00:00:00.000Z', lector: VERSION_DEL_LECTOR_XML })
    expect(esMarcaDeXmlIlegible(m)).toBe(true)
    expect(leerXmlConceptos(m)).toBeNull()
    for (const otro of [null, undefined, {}, { version: 1 }, CONCEPTOS_C2, { ...m, ilegible: 'sí' }])
      expect(esMarcaDeXmlIlegible(otro)).toBe(false)
  })
})

// ─── OF-1 · T7 N1 + M4: la marca «ilegible» nunca pisa conceptos buenos, y una fila que sólo necesita el PDF no vuelve a bajar el XML ────
describe('OF-1 · T7 N1 + M4 · la marca y el barrido de PDFs', () => {
  const XML_BUENO = XML_C2
  const fila = (): FilaDeReparacion => ({
    id: 'c1',
    status: 'STAMPED',
    stampedAt: new Date('2026-10-01T12:00:00Z'),
    idempotencyKey: 'k1',
    attempts: 3,
    facturapiId: 'pac-1',
    uuid: 'U-1',
    venue: { slug: 'demo' },
    fiscalEmisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: 'cifrada' } as FilaDeReparacion['fiscalEmisor'],
  })
  const storeArtifact = jest.fn(async (_b: Buffer, path: string) => `https://example.test/${path}`)
  const cas = { id: 'c1', idempotencyKey: 'k1', facturapiId: 'pac-1', uuid: 'U-1', status: 'STAMPED', attempts: 3 }
  const params = (xml: string, extra = {}) => ({
    cfdiId: 'c1',
    idempotencyKey: 'k1',
    version: 3,
    providerInvoiceId: 'pac-1',
    venueSlug: 'demo',
    uuid: 'U-1',
    provider: { downloadXml: jest.fn(async () => Buffer.from(xml)), downloadPdf: jest.fn(async () => Buffer.from('%PDF')) },
    ...extra,
  })
  beforeEach(() => {
    storeArtifact.mockClear()
    ;(prisma.cfdi.updateMany as jest.Mock).mockReset().mockResolvedValue({ count: 1 })
    ;(prisma.cfdi.findUnique as jest.Mock).mockReset()
    ;(prisma.cfdi.count as jest.Mock).mockReset()
  })

  it.each([
    ['no es XML (página de mantenimiento)', 'esto no es xml', {}],
    // Se lee el resumen pero no los conceptos: su URL y su desglose salen del MISMO XML ilegible y van con la marca.
    ['XML sin conceptos legibles', '<Comprobante/>', { xmlUrl: expect.stringContaining('U-1.xml'), taxBreakdown: [] }],
  ])(
    '🔴 un 200 del PAC que %s: lo del XML (con la marca) se escribe APARTE y sólo donde `xmlConceptos` está vacío; el PDF, con el CAS de siempre',
    async (_caso, xml, delXml) => {
      expect(await completarArchivos(params(xml), { storeArtifact })).toBe('XML_ILEGIBLE')
      const llamadas = (prisma.cfdi.updateMany as jest.Mock).mock.calls.map(c => c[0])
      expect(llamadas).toHaveLength(2)
      // `toStrictEqual`: distingue `Prisma.DbNull` (columna nula) de `Prisma.JsonNull`.
      expect(llamadas.find(c => 'xmlConceptos' in c.data)).toStrictEqual({
        where: { ...cas, xmlConceptos: { equals: Prisma.DbNull } },
        data: { ...delXml, xmlConceptos: expect.objectContaining({ ilegible: true, lector: VERSION_DEL_LECTOR_XML }) },
      })
      expect(llamadas.find(c => !('xmlConceptos' in c.data))).toStrictEqual({
        where: cas,
        data: { pdfUrl: expect.stringContaining('U-1.pdf') },
      })
    },
  )

  it('control — unos conceptos LEGIBLES se escriben como siempre: una sola escritura con el CAS, sin condición sobre `xmlConceptos`', async () => {
    expect(await completarArchivos(params(XML_BUENO), { storeArtifact })).toBe('OK')
    expect(prisma.cfdi.updateMany).toHaveBeenCalledTimes(1)
    expect((prisma.cfdi.updateMany as jest.Mock).mock.calls[0][0].where).toStrictEqual(cas)
  })

  it('🔴 `soloPdf`: no baja el XML (un 200 basura no puede ni llegar) y escribe sólo el PDF ⇒ OK', async () => {
    const persistArtifacts = jest.fn(async () => true)
    const p = params('<Comprobante/>', { soloPdf: true })
    expect(await completarArchivos(p, { storeArtifact, persistArtifacts })).toBe('OK')
    expect(p.provider.downloadXml).not.toHaveBeenCalled()
    expect(persistArtifacts).toHaveBeenCalledWith(p, { pdfUrl: expect.stringContaining('U-1.pdf') })
  })

  it('control — `soloPdf` con el PDF caído ⇒ FALLO y no escribe nada', async () => {
    const persistArtifacts = jest.fn(async () => true)
    const p = params(XML_BUENO, { soloPdf: true })
    p.provider.downloadPdf.mockRejectedValueOnce(new Error('el PAC no rinde el PDF'))
    expect(await completarArchivos(p, { storeArtifact, persistArtifacts })).toBe('FALLO')
    expect(persistArtifacts).not.toHaveBeenCalled()
  })

  it('🔴 la lectura de la fila pregunta (sin cargarlo) si `xmlConceptos` está vacío: con conceptos ⇒ `soloPdf`; sin ellos ⇒ todo', async () => {
    const completar = jest.fn(async (_p: unknown) => 'OK' as const)
    const resolverProveedor = jest.fn(() => ({}) as any)
    ;(prisma.cfdi.findUnique as jest.Mock).mockResolvedValue(fila())
    ;(prisma.cfdi.count as jest.Mock).mockResolvedValueOnce(0) // ya tiene `xmlConceptos`
    expect(await repararArchivosDe('c1', { sandbox: true }, { resolverProveedor, completar })).toBe('OK')
    expect(prisma.cfdi.count).toHaveBeenCalledWith({ where: { id: 'c1', xmlConceptos: { equals: Prisma.DbNull } } })
    expect((prisma.cfdi.count as jest.Mock).mock.calls[0][0].where.xmlConceptos.equals).toBe(Prisma.DbNull)
    expect(completar).toHaveBeenLastCalledWith(expect.objectContaining({ cfdiId: 'c1', soloPdf: true }))
    ;(prisma.cfdi.count as jest.Mock).mockResolvedValueOnce(1) // le falta
    expect(await repararArchivosDe('c1', { sandbox: true }, { resolverProveedor, completar })).toBe('OK')
    expect(completar.mock.calls[1][0]).not.toHaveProperty('soloPdf')
  })
})

// C2 · OF-2 (T8 M4, `task-8-review.md`): un XML propio MÁS GRANDE que el tope del lector (una global enorme) no se lee, pero ES el XML del
// PAC: se guarda el archivo (la global conserva su XML descargable) con la marca de ilegible. Lo que no es un CFDI (página de mantenimiento)
// sigue sin guardarse como XML.
describe('C2 · OF-2 · T8 M4 — el XML propio por encima del tope se guarda aunque no se lea', () => {
  const params = (xml: string) => ({
    cfdiId: 'c1',
    idempotencyKey: 'k1',
    version: 3,
    providerInvoiceId: 'pac-1',
    venueSlug: 'demo',
    uuid: 'U-1',
    provider: { downloadXml: jest.fn(async () => Buffer.from(xml)), downloadPdf: jest.fn(async () => Buffer.from('%PDF')) },
  })
  const storeArtifact = jest.fn(async (_b: Buffer, path: string) => `https://example.test/${path}`)
  beforeEach(() => storeArtifact.mockClear())
  const grande = XML_C2.replace('</cfdi:Comprobante>', `<!--${'x'.repeat(TOPE_XML_TIMBRADO_PROPIO_BYTES)}--></cfdi:Comprobante>`)

  it('🔴 más grande que el tope ⇒ XML_ILEGIBLE, y se guardan el archivo (`xmlUrl`) y la marca; nunca un desglose ni conceptos', async () => {
    const persistArtifacts = jest.fn(async () => true)
    expect(Buffer.byteLength(grande)).toBeGreaterThan(TOPE_XML_TIMBRADO_PROPIO_BYTES)
    expect(await completarArchivos(params(grande), { storeArtifact, persistArtifacts })).toBe('XML_ILEGIBLE')
    expect(storeArtifact).toHaveBeenCalledWith(expect.any(Buffer), expect.stringContaining('U-1.xml'), 'application/xml')
    const archivos = (persistArtifacts.mock.calls[0] as any[])[1]
    expect(archivos).toEqual({
      xmlUrl: expect.stringContaining('U-1.xml'),
      pdfUrl: expect.stringContaining('U-1.pdf'),
      xmlConceptos: expect.anything(),
    })
    expect(esMarcaDeXmlIlegible(archivos.xmlConceptos)).toBe(true)
  })
  it('control — lo que no es un CFDI (página de mantenimiento) no se guarda como XML: sólo la marca y el PDF', async () => {
    const persistArtifacts = jest.fn(async () => true)
    expect(await completarArchivos(params('esto no es xml'), { storeArtifact, persistArtifacts })).toBe('XML_ILEGIBLE')
    expect(storeArtifact).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('.xml'), expect.anything())
    expect(Object.keys((persistArtifacts.mock.calls[0] as any[])[1]).sort()).toEqual(['pdfUrl', 'xmlConceptos'])
  })
})

// C2 · OF-2 (T5 N4, `task-5-rereview-1.md`): el límite de una reparación ya no es un literal suelto: sale del tiempo límite de la bajada del
// PAC más el margen para guardar. Si alguien sube el tiempo de la bajada, el límite sube con él (nunca queda por debajo de la bajada).
describe('C2 · OF-2 · T5 N4 — los tiempos de la reparación, con nombre y derivados', () => {
  it('control — LIMITE_REPARACION_MS = TIEMPO_LIMITE_CONSULTA_MS + MARGEN_PARA_GUARDAR_ARCHIVOS_MS (45 s hoy)', () => {
    expect(LIMITE_REPARACION_MS).toBe(TIEMPO_LIMITE_CONSULTA_MS + MARGEN_PARA_GUARDAR_ARCHIVOS_MS)
    expect(LIMITE_REPARACION_MS).toBe(45_000)
    expect(LIMITE_REPARACION_MS).toBeGreaterThan(TIEMPO_LIMITE_CONSULTA_MS)
  })
})

// Ronda de la ola (review-OF m3): si el que falla es el GUARDADO del XML (almacenamiento caído un momento), eso es transitorio: NO se escribe
// la marca «ilegible» (con ella la fila ya no volvía al barrido y nunca tendría su `xmlUrl`). La siguiente pasada lo guarda. Un XML que de
// verdad no se lee (no es un CFDI) sigue dejando la marca como hoy.
describe('ronda de la ola (m3) — una falla al GUARDAR el XML no deja la marca', () => {
  const params = (xml: string) => ({
    cfdiId: 'c1',
    idempotencyKey: 'k1',
    version: 3,
    providerInvoiceId: 'pac-1',
    venueSlug: 'demo',
    uuid: 'U-1',
    provider: { downloadXml: jest.fn(async () => Buffer.from(xml)), downloadPdf: jest.fn(async () => Buffer.from('%PDF')) },
  })
  /** El almacenamiento rechaza el XML la primera vez y luego responde; el PDF siempre sube. */
  const almacenamientoQueFallaUnaVez = () => {
    let fallo = false
    return jest.fn(async (_b: Buffer, path: string) => {
      if (path.endsWith('.xml') && !fallo) {
        fallo = true
        throw new Error('almacenamiento caído')
      }
      return `https://example.test/${path}`
    })
  }
  const grande = XML_C2.replace('</cfdi:Comprobante>', `<!--${'x'.repeat(TOPE_XML_TIMBRADO_PROPIO_BYTES)}--></cfdi:Comprobante>`)
  const conceptosRotos = XML_C2.replace(
    '<cfdi:Traslado Base="50.000000" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="8.000000"/>',
    '<cfdi:Traslado Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="8.000000"/>',
  )

  it.each([
    ['el XML más grande que el tope (T8 M4)', grande, { xmlUrl: expect.stringContaining('U-1.xml'), xmlConceptos: expect.anything() }],
    [
      'el de resumen legible y conceptos no',
      conceptosRotos,
      { xmlUrl: expect.stringContaining('U-1.xml'), taxBreakdown: DESGLOSE_C2, xmlConceptos: expect.anything() },
    ],
  ])('🔴 %s: la subida falla una vez ⇒ FALLO sin la marca; la siguiente pasada lo guarda con su marca', async (_n, xml, despues) => {
    const storeArtifact = almacenamientoQueFallaUnaVez()
    const persistArtifacts = jest.fn(async () => true)
    expect(await completarArchivos(params(xml), { storeArtifact, persistArtifacts })).toBe('FALLO')
    expect((persistArtifacts.mock.calls[0] as any[])[1]).toEqual({ pdfUrl: expect.stringContaining('U-1.pdf') })
    expect(await completarArchivos(params(xml), { storeArtifact, persistArtifacts })).toBe('XML_ILEGIBLE')
    const archivos = (persistArtifacts.mock.calls[1] as any[])[1]
    expect(archivos).toEqual({ ...despues, pdfUrl: expect.stringContaining('U-1.pdf') })
    expect(esMarcaDeXmlIlegible(archivos.xmlConceptos)).toBe(true)
  })
  it('control — un XML que no es un CFDI deja la marca aunque el almacenamiento esté caído (no se sube nada como XML)', async () => {
    const storeArtifact = almacenamientoQueFallaUnaVez()
    const persistArtifacts = jest.fn(async () => true)
    expect(await completarArchivos(params('esto no es xml'), { storeArtifact, persistArtifacts })).toBe('XML_ILEGIBLE')
    expect(esMarcaDeXmlIlegible((persistArtifacts.mock.calls[0] as any[])[1].xmlConceptos)).toBe(true)
  })
})
