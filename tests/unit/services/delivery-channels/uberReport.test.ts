/**
 * El lector del reporte financiero de Uber — la ÚNICA vía por la que nos enteramos de un
 * reembolso ("Refunds/chargebacks appear only in Reporting—not Orders API", guía de Uber).
 *
 * 🔴 Se prueba contra el CSV REAL descargado de Uber el 2026-08-21, no contra uno inventado.
 * La documentación pública no publica este contrato, y el archivo real trae dos trampas que
 * un fixture escrito a mano no habría tenido.
 */
import fs from 'fs'
import path from 'path'

import { esReembolso, parseUberReportCsv } from '@/services/delivery-channels/providers/uber-eats/uber.report'

const REAL = fs.readFileSync(path.join(__dirname, '../../../fixtures/delivery/uber/reporte-real-payment-details.csv'), 'utf8')

describe('reporte financiero de Uber', () => {
  it('🔴 salta las DOS filas de encabezado del archivo real', () => {
    // La primera fila son descripciones de párrafo, la SEGUNDA los nombres cortos. Un
    // lector ingenuo toma la primera como llaves y mete la segunda como si fuera un pedido:
    // aparecería una venta cuyo folio es literalmente "Order ID".
    const filas = parseUberReportCsv(REAL)
    expect(filas.every(f => f.orderId !== 'Order ID')).toBe(true)
  })

  it('🔴 respeta las comas DENTRO de comillas', () => {
    // Los encabezados de Uber traen comas dentro de comillas ("Either: Completed, Cancelled,
    // Refund…"). Un `split(',')` desalinea TODAS las columnas — y un reporte desalineado no
    // falla: lee el importe equivocado del pedido equivocado.
    const csv = [
      'desc1,desc2,desc3,desc4',
      'Order ID,Order Status,"Chargeback Amount (incl. VAT)",Total payout',
      'abc-123,"Refund, por el cliente",45.50,-45.50',
    ].join('\n')

    const [fila] = parseUberReportCsv(csv)
    expect(fila.orderId).toBe('abc-123')
    expect(fila.status).toBe('Refund, por el cliente')
    expect(fila.chargebackInclVat).toBe('45.50')
  })

  it('un reporte sin movimientos devuelve vacío, no un error', () => {
    // Es el caso NORMAL en un negocio que aún no vende, y también los primeros 72 h
    // mientras Uber asienta los datos. Tratarlo como error llenaría el log de falsas alarmas.
    expect(parseUberReportCsv(REAL)).toEqual([])
  })

  it('🔴 detecta el reembolso por MONTO o por ESTADO', () => {
    // Los dos importan y no siempre coinciden: un pedido marcado "Refund" con importe 0 no
    // le costó dinero al comercio, y un cargo > 0 sin ese estado sigue siendo dinero que sale.
    const base = { orderId: 'x', salesInclVat: '100', totalPayout: '', payoutDate: '', payoutRef: '' }
    expect(esReembolso({ ...base, status: 'Completed', chargebackInclVat: '45.50' })).toBe(true)
    expect(esReembolso({ ...base, status: 'Refund', chargebackInclVat: '0' })).toBe(true)
    expect(esReembolso({ ...base, status: 'Completed', chargebackInclVat: '0' })).toBe(false)
    expect(esReembolso({ ...base, status: 'Completed', chargebackInclVat: '' })).toBe(false)
  })

  it('🔴 si Uber renombra las columnas, truena RUIDOSO en vez de adivinar por posición', () => {
    // Adivinar por posición aplicaría importes al pedido equivocado — un error silencioso
    // que mueve dinero.
    const csv = ['a,b', 'Columna Rara,Otra Cosa', '1,2'].join('\n')
    expect(() => parseUberReportCsv(csv)).toThrow(/no trae las columnas esperadas/i)
  })
})
