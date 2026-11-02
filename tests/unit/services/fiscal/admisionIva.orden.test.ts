/**
 * IVA por producto, plan 6b (spec §2 D10, §5.3): UN solo orden de candados para todos — admisión `iva-emision` primero, después las
 * órdenes por createdAt DESC/id DESC (R5) y al final los productos por id. Con el orden viejo (orden → productos → admisión) el encendido toma la admisión
 * EXCLUSIVA primero, se trababa con cualquier emisión.
 */
import { Prisma } from '@prisma/client'
import { bloquearOrdenParaFacturar, bloquearOrdenesParaFacturar, tomarAdmisionExclusiva } from '@/services/fiscal/admisionIva'

function txQueGraba(respuestas: Array<{ si: RegExp; filas: unknown[] }>) {
  const sql: string[] = []
  /** Los valores de cada sentencia, alineados con `sql` (plantilla etiquetada: `(strings, ...valores)`). */
  const valores: unknown[][] = []
  const correr = async (q: unknown, v: unknown[]) => {
    const texto = ((q as { strings: string[] }).strings ?? (q as TemplateStringsArray)).join('?').replace(/\s+/g, ' ').trim()
    sql.push(texto)
    valores.push(v)
    return respuestas.find(r => r.si.test(texto))?.filas ?? []
  }
  const tx = {
    $queryRaw: jest.fn((q: unknown, ...v: unknown[]) => correr(q, v)),
    $executeRaw: jest.fn((q: unknown, ...v: unknown[]) => correr(q, v)),
  } as unknown as Prisma.TransactionClient
  return { tx, sql, valores }
}
/** Las organizaciones de las admisiones compartidas, en el orden en que se pidieron, y la posición de la última. */
const admisionesDe = (sql: string[], valores: unknown[][]) => {
  const pos = sql.map((s, i) => (/pg_advisory_xact_lock_shared/.test(s) ? i : -1)).filter(i => i >= 0)
  return { orgs: pos.map(i => valores[i][0]), ultima: Math.max(-1, ...pos) }
}
const indice = (sql: string[], re: RegExp) => sql.findIndex(s => re.test(s))

describe('bloquearOrdenParaFacturar — D10', () => {
  it('toma la admisión compartida ANTES de bloquear la orden y sus productos', async () => {
    const { tx, sql } = txQueGraba([
      { si: /FOR UPDATE OF o/, filas: [{ venueId: 'v1', organizationId: 'org1' }] },
      { si: /"organizationId" FROM "Order"/, filas: [{ organizationId: 'org1' }] },
    ])
    await expect(bloquearOrdenParaFacturar(tx, 'o1')).resolves.toEqual({ venueId: 'v1', organizationId: 'org1' })
    const admision = indice(sql, /pg_advisory_xact_lock_shared/)
    expect(admision).toBeGreaterThanOrEqual(0)
    expect(admision).toBeLessThan(indice(sql, /FOR UPDATE OF o/))
    expect(indice(sql, /FOR UPDATE OF o/)).toBeLessThan(indice(sql, /FOR SHARE OF p/))
  })

  it('la orden que no existe no toma nada', async () => {
    const { tx, sql } = txQueGraba([])
    await expect(bloquearOrdenParaFacturar(tx, 'nada')).resolves.toBeNull()
    expect(indice(sql, /pg_advisory/)).toBe(-1)
  })

  it('si el negocio cambió de organización entre la lectura y el candado, responde 409 con su código', async () => {
    const { tx } = txQueGraba([
      { si: /FOR UPDATE OF o/, filas: [{ venueId: 'v1', organizationId: 'org2' }] },
      { si: /"organizationId" FROM "Order"/, filas: [{ organizationId: 'org1' }] },
    ])
    await expect(bloquearOrdenParaFacturar(tx, 'o1')).rejects.toMatchObject({ code: 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION' })
  })
})

describe('bloquearOrdenesParaFacturar — D10', () => {
  it('locks a manifest larger than 100 in one global date order and returns only a database count', async () => {
    const { tx, sql, valores } = txQueGraba([{ si: /FROM "Venue" WHERE id/, filas: [{ organizationId: 'org1' }] }])
    const ids = Array.from({ length: 201 }, (_, i) => `order-${i}`)
    await bloquearOrdenesParaFacturar(tx, ids, 'v1')
    const claims = sql.map((s, i) => (/FROM "Order" WHERE[\s\S]*FOR UPDATE/.test(s) ? i : -1)).filter(i => i >= 0)
    expect(claims).toHaveLength(1)
    expect(sql[claims[0]]).toContain('SELECT COUNT(*) FROM')
    expect(sql[claims[0]]).toContain('ORDER BY "createdAt" DESC, id DESC FOR UPDATE')
    expect(valores[claims[0]][0]).toMatchObject({ values: ['v1', ids] })
  })

  it('con negocio: la admisión de su organización antes de la primera orden', async () => {
    const { tx, sql } = txQueGraba([{ si: /FROM "Venue" WHERE id/, filas: [{ organizationId: 'org1' }] }])
    await bloquearOrdenesParaFacturar(tx, ['o1', 'o2'], 'v1')
    const admision = indice(sql, /pg_advisory_xact_lock_shared/)
    expect(admision).toBeGreaterThanOrEqual(0) // sin esto pasaría en vacío con el orden viejo (índice -1 < cualquiera)
    expect(admision).toBeLessThan(indice(sql, /FROM "Order" WHERE[\s\S]*FOR UPDATE/))
  })

  it('sin negocio (cancelación): una admisión por organización, en orden, antes de la primera orden', async () => {
    const { tx, sql } = txQueGraba([
      { si: /DISTINCT v."organizationId"/, filas: [{ organizationId: 'org-a' }, { organizationId: 'org-b' }] },
    ])
    await bloquearOrdenesParaFacturar(tx, ['o1'])
    const admisiones = sql.map((s, i) => (/pg_advisory_xact_lock_shared/.test(s) ? i : -1)).filter(i => i >= 0)
    expect(admisiones).toHaveLength(2)
    expect(Math.max(...admisiones)).toBeLessThan(indice(sql, /FROM "Order" WHERE[\s\S]*FOR UPDATE/))
  })

  it('productosExtra entra en la MISMA pasada ascendente de productos y paraEscribir toma FOR NO KEY UPDATE', async () => {
    const { tx, sql } = txQueGraba([{ si: /FROM "Venue" WHERE id/, filas: [{ organizationId: 'org1' }] }])
    await bloquearOrdenesParaFacturar(tx, ['o1'], 'v1', { productosExtra: ['p9'], paraEscribir: true })
    const productos = sql.filter(s => /FROM "Product"/.test(s))
    expect(productos).toHaveLength(1)
    expect(productos[0]).toMatch(/UNION SELECT unnest\(\?::text\[\]\)\) ORDER BY id ASC FOR NO KEY UPDATE/) // un solo IN (… UNION …): busca por llave
  })
})

// Codex código r1 #1 (Ruling CX-1): las organizaciones de la FACTURA (cancelación, anulación) entran con `organizacionesExtra` y TODAS
// las admisiones se piden en orden ascendente ANTES de la primera fila; `soloOrganizacion` (el encendido) nunca pide la de otra organización.
describe('bloquearOrdenesParaFacturar — organizacionesExtra y soloOrganizacion (CX-1)', () => {
  it('organizacionesExtra: la de la factura (org-c) y las de las órdenes (org-b, org-d), ascendentes y todas antes de la primera fila', async () => {
    const { tx, sql, valores } = txQueGraba([
      { si: /DISTINCT v."organizationId"/, filas: [{ organizationId: 'org-b' }, { organizationId: 'org-d' }] },
    ])
    await bloquearOrdenesParaFacturar(tx, ['o1', 'o2'], undefined, { organizacionesExtra: ['org-c'] })
    const { orgs, ultima } = admisionesDe(sql, valores)
    expect(orgs).toEqual(['org-b', 'org-c', 'org-d'])
    expect(ultima).toBeLessThan(indice(sql, /FROM "Order" WHERE[\s\S]*FOR UPDATE/))
    expect(ultima).toBeLessThan(indice(sql, /FROM "Product"/))
  })

  it('organizacionesExtra repetida con la de las órdenes: UNA sola admisión', async () => {
    const { tx, sql, valores } = txQueGraba([{ si: /DISTINCT v."organizationId"/, filas: [{ organizationId: 'org-a' }] }])
    await bloquearOrdenesParaFacturar(tx, ['o1'], undefined, { organizacionesExtra: ['org-a'] })
    expect(admisionesDe(sql, valores).orgs).toEqual(['org-a'])
  })

  it('manifiesto vacío + organizacionesExtra: toma la de la factura (sin órdenes no hay filas detrás)', async () => {
    const { tx, sql, valores } = txQueGraba([])
    await bloquearOrdenesParaFacturar(tx, [], undefined, { organizacionesExtra: ['org-a'] })
    expect(admisionesDe(sql, valores).orgs).toEqual(['org-a'])
  })

  it('soloOrganizacion: una orden en OTRA organización ⇒ 409 IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION sin tomar NINGUNA admisión ni fila', async () => {
    const { tx, sql } = txQueGraba([
      { si: /DISTINCT v."organizationId"/, filas: [{ organizationId: 'org-a' }, { organizationId: 'org-b' }] },
    ])
    await expect(bloquearOrdenesParaFacturar(tx, ['o1', 'o2'], undefined, { soloOrganizacion: 'org-a' })).rejects.toMatchObject({
      code: 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION',
    })
    expect(sql.length).toBeGreaterThan(0) // sí leyó las organizaciones: la ausencia de abajo no es vacua
    expect(indice(sql, /pg_advisory/)).toBe(-1)
    expect(indice(sql, /FOR UPDATE|FOR SHARE|FOR NO KEY UPDATE/)).toBe(-1)
  })

  it('soloOrganizacion: todas en la suya ⇒ sigue como siempre (admisión de su organización y luego filas)', async () => {
    const { tx, sql, valores } = txQueGraba([{ si: /DISTINCT v."organizationId"/, filas: [{ organizationId: 'org-a' }] }])
    await bloquearOrdenesParaFacturar(tx, ['o1'], undefined, { soloOrganizacion: 'org-a' })
    const { orgs, ultima } = admisionesDe(sql, valores)
    expect(orgs).toEqual(['org-a'])
    expect(ultima).toBeLessThan(indice(sql, /FROM "Order" WHERE[\s\S]*FOR UPDATE/))
  })
})

describe('tomarAdmisionExclusiva', () => {
  it('es la MISMA llave que la compartida, en exclusiva', async () => {
    const { tx, sql } = txQueGraba([])
    await tomarAdmisionExclusiva(tx, 'org1')
    expect(sql[0]).toMatch(/pg_advisory_xact_lock\(hashtextextended\('iva-emision:' \|\| \?, 0\)\)/)
  })
})
