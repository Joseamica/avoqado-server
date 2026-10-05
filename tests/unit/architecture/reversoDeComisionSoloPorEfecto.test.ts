// tests/unit/architecture/reversoDeComisionSoloPorEfecto.test.ts
/**
 * Fase 3 de pago por servicio (A2; spec §9-2, §9-3; Codex r1-2, r1-3): el reverso de la comisión de una devolución nace
 * SÓLO como efecto durable, en la transacción de la devolución. Un enganche directo después del commit se pierde si el
 * proceso muere y, corriendo aparte del efecto, puede revivir una comisión anulada.
 */
import fs from 'fs'
import path from 'path'

const leer = (archivo: string) => fs.readFileSync(path.join(__dirname, '../../../src', archivo), 'utf8')
const CANALES = ['services/tpv/refund.tpv.service.ts', 'services/dashboard/refund.dashboard.service.ts']

describe('el reverso de comisión de una devolución es sólo un efecto durable', () => {
  it.each(CANALES)('%s no crea el reverso directo', archivo => {
    expect(leer(archivo)).not.toMatch(/\bcreateRefundCommission\s*\(/)
  })

  it.each(CANALES)('%s lo encola dentro de su transacción', archivo => {
    expect(leer(archivo)).toMatch(/await enqueueRefundPaymentEffectsInTx\(tx,/)
  })
})
