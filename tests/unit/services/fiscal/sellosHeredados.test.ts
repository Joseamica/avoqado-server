/** Plan 6b (D11, §5.2b): una factura heredada se sella con la tasa ÚNICA de su XML; si no hay una sola, no se adivina. */
import { tratamientoUnicoDelXml } from '@/services/fiscal/sellosHeredados'
import { marcaDeXmlIlegible } from '@/services/fiscal/finalizadorCfdi'

const traslado = (tipoFactor: 'Tasa' | 'Exento', tasa: string | null) => ({
  impuesto: '002',
  tipoFactor,
  tasa,
  base: '100.00',
  importe: tipoFactor === 'Exento' ? null : tasa === '0.000000' ? '0.00' : '16.00',
})
const xml = (...conceptos: Array<{ objetoImp?: string; traslados: unknown[] }>) => ({
  version: 1,
  subTotal: '100.00',
  descuento: '0.00',
  total: '116.00',
  totalImpuestosTrasladados: '16.00',
  conceptos: conceptos.map(c => ({
    noIdentificacion: null,
    objetoImp: c.objetoImp ?? '02',
    importe: '100.00',
    descuento: '0.00',
    traslados: c.traslados,
  })),
})

describe('tratamientoUnicoDelXml', () => {
  it.each([
    ['todo 16 %', xml({ traslados: [traslado('Tasa', '0.160000')] }, { traslados: [traslado('Tasa', '0.160000')] }), 'IVA_16'],
    ['todo 0 % (la A-36)', xml({ traslados: [traslado('Tasa', '0.000000')] }), 'IVA_0'],
    ['todo exento', xml({ traslados: [traslado('Exento', null)] }), 'EXENTO'],
  ])('%s', (_n, x, esperado) => expect(tratamientoUnicoDelXml(x)).toEqual({ tratamiento: esperado }))

  it.each([
    ['mixto 16 + 0', xml({ traslados: [traslado('Tasa', '0.160000')] }, { traslados: [traslado('Tasa', '0.000000')] })],
    ['8 %', xml({ traslados: [traslado('Tasa', '0.080000')] })],
    ['no objeto', xml({ objetoImp: '01', traslados: [] })],
    ['sin XML', null],
    ['marca de ilegible', marcaDeXmlIlegible('no se pudo leer')],
    ['basura', { version: 2 }],
  ])('%s ⇒ no sellable, con motivo', (_n, x) => expect(tratamientoUnicoDelXml(x)).toEqual({ motivo: expect.any(String) }))
})
