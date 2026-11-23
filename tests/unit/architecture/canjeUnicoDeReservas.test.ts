/**
 * D679 · un solo canje de reservas. Bajar el saldo de un paquete de créditos (`remainingQuantity: { decrement`) sólo lo hacen:
 *   · `creditRedemption.service.ts` — el canje de una reserva (clase del widget, cita del widget y clase de la app de clientes);
 *   · `creditPack.dashboard.service.ts` — el canje a mano del DASHBOARD;
 *   · `undoNoShow.service.ts` — «Sí llegó», que vuelve a cobrar lo que devolvió el «No asistió».
 *
 * Antes había tres copias del canje de una reserva y cada regla nueva (el Ilimitado es personal, un lugar, sólo clases vigentes)
 * había que ponerla tres veces. Un canje nuevo pasa por `redeemCreditsForReservation`, o se agrega aquí A PROPÓSITO, con su razón.
 */
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../../src')
const PERMITIDOS = new Set([
  'services/reservation/creditRedemption.service.ts',
  'services/dashboard/creditPack.dashboard.service.ts',
  'services/reservation/undoNoShow.service.ts',
])

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? archivos(p) : p.endsWith('.ts') ? [p] : []
  })
}

const DESCUENTA = /remainingQuantity:\s*\{\s*decrement\b/

describe('D679 · sólo tres lugares bajan el saldo de un paquete', () => {
  it('el detector ve el descuento escrito de las dos formas', () => {
    expect(DESCUENTA.test('data: { remainingQuantity: { decrement: 1 } }')).toBe(true)
    expect(DESCUENTA.test('remainingQuantity: {\n  decrement: n,\n}')).toBe(true)
    expect(DESCUENTA.test('remainingQuantity: { increment: 1 }')).toBe(false)
  })

  it('ningún otro archivo de src/ descuenta saldo', () => {
    const fuera = archivos(SRC)
      .filter(f => DESCUENTA.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f).split(path.sep).join('/'))
      .filter(f => !PERMITIDOS.has(f))
    expect(fuera).toEqual([])
  })

  it('la lista es real: los tres permitidos existen y descuentan', () => {
    for (const f of PERMITIDOS) {
      expect(DESCUENTA.test(fs.readFileSync(path.join(SRC, f), 'utf8'))).toBe(true)
    }
  })
})
