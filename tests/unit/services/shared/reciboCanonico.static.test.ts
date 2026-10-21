/** r4 R4-A1: ninguna reutilización por paymentId elige el recibo por su cuenta. Estática a propósito (son ~20 sitios de replay). */
import { readFileSync } from 'fs'
import { join } from 'path'

const sitios = [
  'src/services/tpv/digitalReceipt.tpv.service.ts',
  'src/services/dashboard/receipt.dashboard.service.ts',
  'src/controllers/mobile/receipt.mobile.controller.ts',
  'src/services/tpv/payment.tpv.service.ts',
  'src/services/tpv/refund.tpv.service.ts',
  'src/services/tpv/registroRepetido.ts',
  'src/services/mobile/order.mobile.service.ts',
  'src/services/dashboard/testing.dashboard.service.ts',
  'src/services/shared/ticketTotals.ts',
  'src/services/dashboard/order.dashboard.service.ts',
]

/** Cada `receipts: { … }` (un include/select de recibos) con su bloque completo, llaves balanceadas. */
const bloquesDeRecibos = (fuente: string) =>
  [...fuente.matchAll(/receipts:\s*\{/g)].map(m => {
    let i = m.index! + m[0].length
    for (let nivel = 1; nivel > 0 && i < fuente.length; i++) nivel += fuente[i] === '{' ? 1 : fuente[i] === '}' ? -1 : 0
    return fuente.slice(m.index!, i)
  })

it.each(sitios)('%s no elige recibo sin el selector canónico', ruta => {
  const fuente = readFileSync(join(__dirname, '../../../..', ruta), 'utf8')
  expect(fuente).not.toMatch(/include:\s*\{\s*receipts:\s*true/)
  // También dentro de un include de varias llaves (`include: { order: true, receipts: true }`, refund.tpv).
  expect(fuente).not.toMatch(/receipts:\s*true/)
  expect(fuente).not.toMatch(/digitalReceipt\.findFirst\(\{\s*where:\s*\{\s*paymentId/)
  expect(fuente).not.toMatch(/receipts:\s*\{[^}]*createdAt:\s*'desc'/)
  // Revisión T3b m1/m2: un `receipts: { take: 1 }` o un `select` sin orden deja que Postgres elija cuál sale primero.
  expect(bloquesDeRecibos(fuente).filter(bloque => !/orderBy:\s*ORDEN_RECIBO_CANONICO/.test(bloque))).toEqual([])
})
