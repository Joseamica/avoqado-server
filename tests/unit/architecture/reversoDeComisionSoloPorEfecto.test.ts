// tests/unit/architecture/reversoDeComisionSoloPorEfecto.test.ts
/**
 * Fase 3 de pago por servicio (A2; spec §9-2, §9-3; Codex r1-2, r1-3): el reverso de la comisión de una devolución nace
 * SÓLO como efecto durable, en la transacción de la devolución. Un enganche directo después del commit se pierde si el
 * proceso muere y, corriendo aparte del efecto, puede revivir una comisión anulada.
 *
 * Ronda 1: la guarda recorre TODO `src`, no sólo los dos canales de hoy — un tercer canal (o un script de reparación)
 * que llame `createRefundCommission(` directo reabriría el mismo hueco.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')
const leer = (archivo: string) => fs.readFileSync(path.join(SRC, archivo), 'utf8')
const CANALES = ['services/tpv/refund.tpv.service.ts', 'services/dashboard/refund.dashboard.service.ts']
/** Quien la define (y se llama a sí misma con su transacción) y el único que la encola como efecto. */
const PERMITIDOS = new Set(['services/dashboard/commission/commission-calculation.service.ts', 'services/tpv/paymentEffects.service.ts'])

function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const ruta = path.join(dir, e.name)
    if (e.isDirectory()) return archivosTs(ruta)
    return e.name.endsWith('.ts') ? [path.relative(SRC, ruta).split(path.sep).join('/')] : []
  })
}

describe('el reverso de comisión de una devolución es sólo un efecto durable', () => {
  it('nadie en src llama createRefundCommission( fuera de quien la define y del encolado', () => {
    const archivos = archivosTs(SRC)
    expect(archivos.length).toBeGreaterThan(100) // la guarda de verdad recorrió src
    const infractores = archivos.filter(a => !PERMITIDOS.has(a) && /\bcreateRefundCommission\s*\(/.test(leer(a)))
    expect(infractores).toEqual([])
  })

  it.each(CANALES)('%s lo encola dentro de su transacción', archivo => {
    expect(leer(archivo)).toMatch(/await enqueueRefundPaymentEffectsInTx\(tx,/)
  })
})
