/**
 * La recompra automática y las órdenes RECHAZADAS.
 *
 * `REJECTED` no estaba en la lista de estados "abiertos", así que el cron nocturno
 * volvía a pedir esa misma noche lo que un gerente acababa de rechazar: a la mañana
 * siguiente había otra orden idéntica esperando. El gerente frena, el sistema insiste.
 *
 * Pero frenarla para siempre sería peor: una orden rechazada y olvidada dejaría ese
 * insumo sin reponer indefinidamente, y el desabasto silencioso duele más que una
 * orden duplicada. De ahí la caducidad de 14 días.
 */

import { PurchaseOrderStatus } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'

const ARCHIVO = path.join(__dirname, '../../../../src/services/dashboard/autoReorder.service.ts')

describe('recompra automática: no vuelve a pedir lo que alguien rechazó', () => {
  const fuente = fs.readFileSync(ARCHIVO, 'utf8')

  it('consulta las órdenes RECHAZADAS además de las abiertas', () => {
    // Si alguien quita esta rama, el cron vuelve a duplicar en silencio: nadie se
    // entera hasta que llegan dos veces los mismos insumos.
    expect(fuente).toMatch(/status:\s*PurchaseOrderStatus\.REJECTED/)
  })

  it('la rechazada frena por tiempo limitado, no para siempre', () => {
    expect(fuente).toContain('DIAS_QUE_UNA_RECHAZADA_FRENA_LA_RECOMPRA')
    expect(fuente).toMatch(/rejectedAt:\s*\{\s*gte:/)
  })

  it('el corte son 14 días', () => {
    expect(fuente).toMatch(/DIAS_QUE_UNA_RECHAZADA_FRENA_LA_RECOMPRA\s*=\s*14/)
  })

  it('cuenta aparte lo frenado por rechazo de lo frenado por orden abierta', () => {
    // Son dos situaciones que se atienden distinto: una es "ya lo pedí", la otra es
    // "alguien decidió que no". Mezclarlas en un solo contador esconde la segunda.
    expect(fuente).toContain('skippedRejectedPo')
    expect(fuente).toMatch(/skippedRejectedPo:\s*number/)
  })

  it('REJECTED NO se agregó a la lista de estados abiertos', () => {
    // Meterlo ahí lo trataría como una orden en curso en todo el archivo, que no lo
    // es: una orden rechazada no va a llegar nunca. La distinción tiene que vivir en
    // la consulta, no en la constante.
    const lista = fuente.slice(fuente.indexOf('const OPEN_PO_STATUSES'), fuente.indexOf('DIAS_QUE_UNA_RECHAZADA'))
    expect(lista).not.toContain('REJECTED')
    // …y los estados que sí son "en curso" siguen ahí.
    for (const estado of [
      PurchaseOrderStatus.DRAFT,
      PurchaseOrderStatus.PENDING_APPROVAL,
      PurchaseOrderStatus.APPROVED,
      PurchaseOrderStatus.SENT,
      PurchaseOrderStatus.CONFIRMED,
      PurchaseOrderStatus.SHIPPED,
      PurchaseOrderStatus.PARTIAL,
    ]) {
      expect(lista).toContain(estado)
    }
  })
})
