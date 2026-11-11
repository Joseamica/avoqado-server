/**
 * D5 (10-nov-2026): en una venta sin contrato (`DESCONOCIDO`), `taxAmount > 0` significa «el IVA se cobra APARTE»
 * (`impuestoQueSeCobraAparte`, regla del founder del 3-sep: así nacieron las de SoftRestaurant y las reservas viejas).
 * La siembra guardaba ahí el IVA YA INCLUIDO en el precio (subtotal − subtotal / 1.16) con `total = subtotal`, así que
 * cualquier recálculo (cortesía, anular, descuento, cobro) le sumaba el IVA encima: $120 − $20 de cortesía ⇒ $116.55.
 * Una venta sembrada nace como una nativa: contrato `IVA_INCLUIDO` y `taxAmount = 0` en la cuenta y en sus renglones.
 */
import fs from 'fs'
import path from 'path'

const lineas = fs.readFileSync(path.join(__dirname, '../../../prisma/seed.ts'), 'utf8').split('\n')

/** Texto de la llamada desde la línea i hasta que cierran sus paréntesis. */
function llamada(i: number): string {
  let prof = 0
  const out: string[] = []
  for (let j = i; j < lineas.length; j++) {
    out.push(lineas[j])
    for (const ch of lineas[j]) prof += ch === '(' ? 1 : ch === ')' ? -1 : 0
    if (prof <= 0) break
  }
  return out.join('\n')
}

describe('siembra: ninguna venta guarda el IVA incluido como si fuera aparte (D5)', () => {
  it('ningún taxAmount se calcula como la parte de IVA de un precio que ya lo trae (÷ 1.16) dentro de una venta', () => {
    const sitios = lineas
      .map((l, i) => ({ linea: i + 1, l }))
      .filter(({ l }) => /taxAmount\s*:[^,\n]*\/\s*1\.16/.test(l))
      .map(({ linea }) => linea)
    expect(sitios).toEqual([])
  })

  it('ningún prisma.order.update de la siembra reescribe taxAmount después de crear la venta', () => {
    const sitios = lineas
      .map((l, i) => ({ linea: i + 1, l }))
      .filter(({ l }) => /\.order\s*\.\s*update\s*\(/.test(l))
      .filter(({ linea }) => /\btaxAmount\b/.test(llamada(linea - 1)))
      .map(({ linea }) => linea)
    expect(sitios).toEqual([])
  })
})
