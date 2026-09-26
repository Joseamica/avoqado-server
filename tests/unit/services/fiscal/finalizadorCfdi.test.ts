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
