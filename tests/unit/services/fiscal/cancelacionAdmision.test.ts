/**
 * IVA por producto, plan 6b (spec §5.3, ruling T1-b): TODA cancelación pasa por la admisión `iva-emision`. La toma el helper de las órdenes
 * del manifiesto; si el manifiesto sale vacío el helper no toma ninguna (no hay organización que leer en las órdenes), así que la intención de
 * cancelar la toma sola, con la organización del negocio de la factura.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: { $transaction: jest.fn() } }))
jest.mock('../../../../src/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))

import prisma from '../../../../src/utils/prismaClient'
import { anotarIntencionDeCancelar, aplicarCancelacion } from '../../../../src/services/fiscal/cfdi.service'

function correrConManifiesto(orderIds: string[], orgs: { ordenes?: string; factura?: string } = {}) {
  const admisiones: unknown[][] = []
  /** Cada candado en el orden en que se pidió: `admision:<org>` o `orden` (la primera fila de `Order`). */
  const pasos: string[] = []
  const tx = {
    // El manifiesto (UNION de Cfdi + CfdiGlobalOrden), la organización de las órdenes (helper) y el resto de candados.
    $queryRaw: jest.fn(async (q: unknown) => {
      const texto = ((q as { strings: string[] }).strings ?? (q as TemplateStringsArray)).join('?')
      if (/UNION SELECT "orderId"/.test(texto)) return orderIds.map(orderId => ({ orderId }))
      if (/DISTINCT v\."organizationId"/.test(texto)) return orderIds.length ? [{ organizationId: orgs.ordenes ?? 'org-1' }] : []
      if (/FROM "Order" WHERE[\s\S]*FOR UPDATE/.test(texto)) pasos.push('orden')
      return []
    }),
    // Plantilla etiquetada: (strings, ...valores).
    $executeRaw: jest.fn(async (q: TemplateStringsArray, ...valores: unknown[]) => {
      if (/pg_advisory_xact_lock_shared/.test(q.join('?'))) {
        admisiones.push(valores)
        pasos.push(`admision:${valores[0]}`)
      }
      return 0
    }),
    // Una factura que ya no está vigente: sale con PERDIDA justo después de los candados (lo que importa aquí es qué candados tomó).
    cfdi: {
      findUnique: jest.fn(async () => ({ status: 'CANCELLED', attempts: 1, venue: { organizationId: orgs.factura ?? 'org-1' } })),
    },
  }
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (work: (t: unknown) => unknown) => work(tx))
  return { admisiones, pasos }
}

describe('anotarIntencionDeCancelar — toda cancelación pasa por la admisión (§5.3)', () => {
  const p: Parameters<typeof anotarIntencionDeCancelar>[2] = { motivo: '02' }

  it('manifiesto vacío: toma la admisión compartida de la organización del negocio de la factura', async () => {
    const { admisiones } = correrConManifiesto([])
    await expect(anotarIntencionDeCancelar('cfdi-1', 1, p)).resolves.toEqual({ estado: 'PERDIDA' })
    expect(admisiones).toEqual([['org-1']])
  })

  it('control — manifiesto con órdenes: la admisión de la organización la toma el helper, UNA sola vez', async () => {
    const { admisiones } = correrConManifiesto(['o1', 'o2'])
    await expect(anotarIntencionDeCancelar('cfdi-1', 1, p)).resolves.toEqual({ estado: 'PERDIDA' })
    expect(admisiones).toEqual([['org-1']])
  })

  // Codex código r1 #1 (Ruling CX-1): la factura es de A y su orden hoy vive en B. Antes se tomaba sólo la de B (la de la orden) y se omitía
  // la de A: el encendido de A no veía esta intención de cancelar. Ahora las dos, ascendentes, antes de la primera fila.
  it('CX-1 · factura de org-a con su orden en org-b: toma org-a y org-b, en orden, ANTES de la primera fila', async () => {
    const { pasos } = correrConManifiesto(['o1'], { ordenes: 'org-b', factura: 'org-a' })
    await expect(anotarIntencionDeCancelar('cfdi-1', 1, p)).resolves.toEqual({ estado: 'PERDIDA' })
    expect(pasos).toEqual(['admision:org-a', 'admision:org-b', 'orden'])
  })
})

// Codex código r1 #1 (Ruling CX-1): el desenlace de la cancelación (`aplicarCancelacion`) toma los mismos candados que la intención.
describe('aplicarCancelacion — la admisión de la factura y la de sus órdenes, antes de la primera fila (CX-1)', () => {
  it('factura de org-a con su orden en org-b: org-a y org-b, en orden, ANTES de la primera fila', async () => {
    const pasos: string[] = []
    const tx = {
      $queryRaw: jest.fn(async (q: unknown) => {
        const texto = ((q as { strings: string[] }).strings ?? (q as TemplateStringsArray)).join('?')
        if (/UNION SELECT "orderId"/.test(texto)) return [{ orderId: 'o1' }]
        if (/DISTINCT v\."organizationId"/.test(texto)) return [{ organizationId: 'org-b' }]
        if (/FROM "Cfdi" c JOIN "Venue" v/.test(texto)) return [{ organizationId: 'org-a' }]
        if (/FROM "Order" WHERE[\s\S]*FOR UPDATE/.test(texto)) pasos.push('orden')
        return []
      }),
      $executeRaw: jest.fn(async (q: TemplateStringsArray, ...valores: unknown[]) => {
        if (/pg_advisory_xact_lock_shared/.test(q.join('?'))) pasos.push(`admision:${valores[0]}`)
        return 0
      }),
      cfdi: { updateMany: jest.fn(async () => ({ count: 0 })) }, // perdió el CAS: lo que importa aquí es qué candados tomó
    }
    await expect(aplicarCancelacion('cfdi-1', { cancelStatus: 'CANCELLED' }, 1, 'DIRECTA', {}, tx as never)).resolves.toBeNull()
    expect(pasos).toEqual(['admision:org-a', 'admision:org-b', 'orden'])
  })
})

// Codex código r2 N2 (Ruling CX-12): el desenlace también puede METER una cancelación en trámite (la respuesta tardía del PAC o la
// sincronización externa, REJECTED → REQUESTED). Si el negocio de la factura cambió de organización entre la lectura sin candado y los
// candados, tendría sólo la admisión de la organización vieja: 409 de reintento y NO escribe.
describe('aplicarCancelacion — la organización de la factura se revalida bajo los candados (CX-12)', () => {
  it('regreso tardío REJECTED → REQUESTED con la factura trasladada de org-a a org-b en medio ⇒ IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION, sin escribir', async () => {
    const lecturasDeLaFactura = ['org-a', 'org-b'] // antes del helper: org-a; ya con los candados: org-b
    const tx = {
      $queryRaw: jest.fn(async (q: unknown) => {
        const texto = ((q as { strings: string[] }).strings ?? (q as TemplateStringsArray)).join('?')
        if (/UNION SELECT "orderId"/.test(texto)) return [{ orderId: 'o1' }]
        if (/DISTINCT v\."organizationId"/.test(texto)) return [{ organizationId: 'org-a' }] // la venta se quedó en org-a
        if (/FROM "Cfdi" c JOIN "Venue" v/.test(texto)) return [{ organizationId: lecturasDeLaFactura.shift() ?? 'org-b' }]
        return []
      }),
      $executeRaw: jest.fn(async () => 0),
      cfdi: { updateMany: jest.fn(async () => ({ count: 1 })), findUnique: jest.fn(async () => ({ id: 'cfdi-1' })) },
    }
    await expect(aplicarCancelacion('cfdi-1', { cancelStatus: 'REQUESTED' }, 1, 'EXTERNA', {}, tx as never)).rejects.toMatchObject({
      code: 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION',
    })
    expect(tx.cfdi.updateMany).not.toHaveBeenCalled()
  })
})
