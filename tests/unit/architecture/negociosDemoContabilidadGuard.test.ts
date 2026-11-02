/**
 * El reinicio de los negocios demo borra el negocio entero, pero la contabilidad vive por (organización, RFC) y no cae con
 * él (Codex r1, hallazgo 10). `MODELOS_POR_RFC_DEL_DEMO` dice qué se borra; si aparece un modelo nuevo con
 * `organizationId` + `rfc`, esta prueba truena hasta que alguien decida si el reinicio lo borra o por qué no.
 */
import fs from 'fs'
import path from 'path'

const RAIZ = path.join(__dirname, '../../..')
const schema = fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8')
const servicio = fs.readFileSync(path.join(RAIZ, 'src/services/demo/negociosDemo.service.ts'), 'utf8')

/** Modelos por (organización, RFC) que el reinicio NO borra, con su razón. */
const NO_SE_BORRAN: Record<string, string> = {
  Venue: 'el negocio mismo: lo borra deleteVenueDataTx',
  BillingTaxProfile: 'datos fiscales para que Avoqado facture SU plan; el demo no puede contratar (capa 1)',
}

it('todo modelo con organizationId + rfc se borra en el reinicio o declara por qué no', () => {
  const porRfc = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
    .filter(([, , cuerpo]) => /^\s+organizationId\s+String/m.test(cuerpo) && /^\s+rfc\s+String/m.test(cuerpo))
    .map(([, nombre]) => nombre)
  const lista = servicio.match(/MODELOS_POR_RFC_DEL_DEMO = \[([\s\S]*?)\] as const/)?.[1] ?? ''
  const seBorran = [...lista.matchAll(/'(\w+)'/g)].map(m => m[1])
  expect(seBorran.length).toBeGreaterThan(5)
  expect(porRfc.filter(m => !seBorran.includes(m) && !(m in NO_SE_BORRAN))).toEqual([])
})

it('cada modelo de la lista se borra de verdad en borrarContabilidadDemo', () => {
  const lista = servicio.match(/MODELOS_POR_RFC_DEL_DEMO = \[([\s\S]*?)\] as const/)?.[1] ?? ''
  for (const [, m] of lista.matchAll(/'(\w+)'/g)) {
    const delegado = m[0].toLowerCase() + m.slice(1)
    // Con el filtro de la organización y el RFC del demo; un `deleteMany({})` pasaba la versión anterior (Codex r2, 9).
    expect(servicio).toMatch(new RegExp(`tx\\.${delegado}\\.deleteMany\\(\\{ where: (?:donde|\\{ fixedAsset: donde \\}) \\}\\)`))
  }
})
