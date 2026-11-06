/**
 * La guardia de la marca (S5b, r6 #2, R74; Rulings 22 y 29): `scripts/guardias/txConReintento.ts` usa el verificador de tipos para que
 * `TxConReintento` sólo viaje como parámetro. Aquí corre sobre programas de JUGUETE con el mismo `unique symbol`; su corrida sobre
 * `src/` se exige desde el paso 8 (`npm run guard:tx-con-reintento`).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { revisarPrograma } from '../../../scripts/guardias/txConReintento'
import revisado from './ordenDeCandadosParte2.reviewed.json'

const BASE: Record<string, string> = {
  'src/utils/serializableRetry.ts': `
export type Cliente = {
  discount: { delete(a: unknown): Promise<unknown> }
  $transaction<T>(fn: (tx: Cliente) => Promise<T>): Promise<T>
}
declare const conReintento: unique symbol
export type TxConReintento = Cliente & { readonly [conReintento]: true }
declare const prisma: Cliente
export async function withDeadlockRetry<T>(fn: (tx: TxConReintento) => Promise<T>, _o: { etiqueta: string }): Promise<T> {
  const cuerpo = (tx: Cliente) => fn(tx as TxConReintento)
  return prisma.$transaction(cuerpo)
}
export async function withSerializableRetry<T>(fn: (tx: TxConReintento) => Promise<T>, _o: { reintentarInterbloqueo: true }): Promise<T> {
  return prisma.$transaction(tx => fn(tx as TxConReintento))
}
`,
  'src/utils/prismaClient.ts': `import type { Cliente } from './serializableRetry'\nconst prisma = {} as Cliente\nexport default prisma\n`,
  'src/escritor.ts': `
import type { TxConReintento } from './utils/serializableRetry'
export async function escribir(tx: TxConReintento): Promise<void> {
  await tx.discount.delete({})
}
export const servicio = {
  async escribir(tx: TxConReintento): Promise<void> {
    await tx.discount.delete({})
  },
}
export default async function porDefecto(tx: TxConReintento): Promise<void> {
  await tx.discount.delete({})
}
`,
  'src/services/mobile/http-operation.mobile.service.ts': `
import { withDeadlockRetry, TxConReintento } from '../../utils/serializableRetry'
export async function executeHttpOperation(_input: unknown, mutate: (tx: TxConReintento) => Promise<void>): Promise<void> {
  await withDeadlockRetry(tx => mutate(tx), { etiqueta: 'executeHttpOperation' })
}
`,
  'src/services/tpv/payment.tpv.service.ts': `
import prisma from '../../utils/prismaClient'
import type { TxConReintento } from '../../utils/serializableRetry'
import { escribir } from '../../escritor'
export async function recordOrderPayment(): Promise<void> {
  await prisma.$transaction(tx => cuerpo(tx as TxConReintento))
}
async function cuerpo(tx: TxConReintento): Promise<void> {
  await escribir(tx)
}
`,
}
const ENCABEZADO = `import prisma from './utils/prismaClient'
import { withDeadlockRetry, withSerializableRetry, TxConReintento, Cliente } from './utils/serializableRetry'
import { escribir, servicio } from './escritor'
import { executeHttpOperation } from './services/mobile/http-operation.mobile.service'
export type { TxConReintento, Cliente }
`

/** Lo que pasa: todas las formas en que la marca viaja como parámetro. */
const PASA = `${ENCABEZADO}
export async function enCuerpo() {
  await withDeadlockRetry(async tx => escribir(tx), { etiqueta: 'enCuerpo' })
  await withDeadlockRetry(escribir, { etiqueta: 'porNombre' })
  await withSerializableRetry(escribir, { reintentarInterbloqueo: true })
  await executeHttpOperation({}, async tx => {
    await escribir(tx)
  })
}
export async function otra(tx: TxConReintento) {
  await escribir(tx)
  await servicio.escribir(tx)
  const { escribir: w } = await import('./escritor')
  await w(tx)
  await (await import('./escritor')).escribir(tx)
}
export async function desestructurado({ tx }: { tx: TxConReintento }) {
  await escribir(tx)
}
export async function opcional(tx?: TxConReintento) {
  if (tx) await escribir(tx)
}
const conTipo: { escribir(tx: TxConReintento): Promise<void> } = {
  async escribir(tx: TxConReintento) {
    await escribir(tx)
  },
}
export async function metodoConTipo(tx: TxConReintento) {
  await conTipo.escribir(tx)
}
type Manejador = { escribir(tx: TxConReintento): Promise<void>; 'con-guion'(tx: TxConReintento): Promise<void> }
const conUnion: Manejador | undefined = {
  async escribir(tx: TxConReintento) {
    await escribir(tx)
  },
  async 'con-guion'(tx: TxConReintento) {
    await escribir(tx)
  },
}
export async function metodoConUnion(tx: TxConReintento) {
  await conUnion?.escribir(tx)
}
export { escribir }
`

/** Lo que falla, uno por archivo: [archivo, regla, código]. */
const FALLAN: Array<[string, string, string]> = [
  ['variableAny', '(9)', `export async function f() { const db: any = prisma; await escribir(db) }`],
  ['alias', '(10)', `type Alias = TxConReintento\nexport async function f() { await escribir(prisma as unknown as Alias) }`],
  ['parametroAny', '(9)', `export async function f(db: any) { await escribir(db) }`],
  ['variableMarcada', '(9)', `export async function f(tx: TxConReintento) { const t: TxConReintento = tx; await escribir(t) }`],
  [
    'generica',
    '(9)',
    `declare function forjar<T>(x: unknown): T\nexport async function f() { await escribir(forjar<TxConReintento>(prisma)) }`,
  ],
  ['objetoAny', '(9)', `declare function usar(o: { tx: TxConReintento }): void\nexport function f() { usar({ tx: prisma as any }) }`],
  ['propiedad', '(9)', `export async function f(p: { tx: TxConReintento }) { await escribir(p.tx) }`],
  ['reflect', '(11)', `export function f() { return Reflect.apply(escribir, undefined, [prisma]) }`],
  ['funcion', '(11)', `export function f() { const ejecutar: Function = escribir; return ejecutar(prisma) }`],
  ['call', '(11)', `export function f() { return escribir.call(null, prisma as any) }`],
  ['bind', '(11)', `export function f() { return escribir.bind(null) }`],
  ['tabla', '(11)', `export const tabla = { handler: escribir }`],
  ['tablaEnLinea', '(11)', `export const tabla = { handler: async (tx: TxConReintento) => escribir(tx) }`],
  [
    'importDinamico',
    '(11)',
    `export async function f() { const { escribir: w } = await import('./escritor'); const otra = w; return otra }`,
  ],
  ['importEnLinea', '(11)', `export async function f() { return (await import('./escritor')).escribir }`],
  ['metodoComoValor', '(11)', `export function f() { return [servicio.escribir] }`],
  [
    'sobrecarga',
    '(12)',
    `export function escribir2(tx: any): Promise<void>\nexport function escribir2(tx: TxConReintento): Promise<void>\nexport async function escribir2(tx: TxConReintento) { await escribir(tx) }`,
  ],
  ['union', '(12)', `export async function mezcla(tx: TxConReintento | Cliente) { await escribir(tx as TxConReintento) }`],
  ['segundoCast', '(10)', `export async function recordOrderPayment() { await prisma.$transaction(tx => escribir(tx as TxConReintento)) }`],
  ['crudo', '(9)', `export async function f() { await prisma.$transaction(async tx => escribir(tx)) }`],
  // Fix round 1 de la revisión (Important 2, m1, m2, m6 y la sonda del revisor).
  [
    'metodoEnMapa',
    '(11)',
    `const h: Record<string, Function> = { async a(tx: TxConReintento) { await escribir(tx) } }\nexport function g() { return h.a(prisma) }`,
  ],
  [
    'metodoEnAny',
    '(11)',
    `const h: any = { async a(tx: TxConReintento) { await escribir(tx) } }\nexport function g() { return h.a(prisma) }`,
  ],
  [
    'metodoEntreComillas',
    '(11)',
    `const h: Record<string, Function> = { async 'a'(tx: TxConReintento) { await escribir(tx) } }\nexport function g() { return h.a(prisma) }`,
  ],
  [
    'metodoEnUnionConMapa',
    '(11)',
    `const h: Record<string, Function> | undefined = { async a(tx: TxConReintento) { await escribir(tx) } }\nexport function g() { return h?.a(prisma) }`,
  ],
  ['variableInferida', '(9)', `export async function f(tx: TxConReintento) { const t = tx }`],
  ['apply', '(11)', `export function f() { return escribir.apply(null, [prisma as any]) }`],
  ['receptorAny', '(11)', `export async function f() { await (servicio as any).escribir(prisma) }`],
  ['servicioEnAny', '(11)', `export async function f() { const s: any = servicio; await s.escribir(prisma) }`],
  [
    'genericoAcotado',
    '(9)',
    `export async function escribirG<T extends TxConReintento>(tx: T) { await tx.discount.delete({}) }\nexport async function f() { await escribirG(prisma as any) }`,
  ],
  ['porIndice', '(11)', `export function f() { return Reflect.apply(servicio['escribir'], undefined, [prisma]) }`],
  [
    'importPorDefecto',
    '(11)',
    `import otroNombre from './escritor'\nexport function f() { return Reflect.apply(otroNombre, undefined, [prisma]) }`,
  ],
  ['spread', '(9)', `export async function f() { const args = [prisma] as unknown as [any]; await escribir(...args) }`],
]

function programa(archivos: Record<string, string>): { programa: ts.Program; raiz: string } {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'guardia-tx-'))
  for (const [nombre, texto] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(raiz, nombre)), { recursive: true })
    fs.writeFileSync(path.join(raiz, nombre), texto)
  }
  const opciones: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  }
  return {
    programa: ts.createProgram(
      Object.keys(archivos).map(n => path.join(raiz, n)),
      opciones,
    ),
    raiz,
  }
}
const OPCIONES = { castsPermitidos: revisado.castsPermitidos, openersGenericos: revisado.openersGenericos }
const juguete = (renombrar = (s: string) => s) => ({
  ...BASE,
  'src/pasa.ts': PASA,
  ...Object.fromEntries(FALLAN.map(([archivo, , codigo]) => [`src/${renombrar(archivo)}.ts`, `${ENCABEZADO}${codigo}\n`])),
})
const ejecutar = (archivos: Record<string, string>) => {
  const { programa: p, raiz } = programa(archivos)
  try {
    return revisarPrograma(p, { raiz, ...OPCIONES })
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true })
  }
}

describe('guardia de la marca TxConReintento (verificador de tipos)', () => {
  let resultado: ReturnType<typeof revisarPrograma>
  beforeAll(() => {
    resultado = ejecutar(juguete())
  }, 60_000)

  it('encuentra la marca por el unique symbol de serializableRetry.ts', () => {
    expect(resultado.marca).toBe(true)
  })

  it('pasa: escribir(tx) en un cuerpo de withDeadlockRetry o en una función que lo pide, servicio.escribir(tx), el cuerpo por nombre, el opener genérico, import/export y el `await import` en posición de llamada', () => {
    expect(resultado.hallazgos.filter(h => h.includes('src/pasa.ts'))).toEqual([])
  })

  it('pasan las llamadas internas de withDeadlockRetry y withSerializableRetry, el opener genérico y el cast listado de recordOrderPayment', () => {
    for (const archivo of [
      'src/utils/serializableRetry.ts',
      'src/services/tpv/payment.tpv.service.ts',
      'src/services/mobile/http-operation.mobile.service.ts',
      'src/escritor.ts',
    ])
      expect(resultado.hallazgos.filter(h => h.includes(archivo))).toEqual([])
  })

  it.each(FALLAN.map(([archivo, regla]) => [archivo, regla]))('falla %s con la regla %s', (archivo, regla) => {
    const suyos = resultado.hallazgos.filter(h => h.includes(`src/${archivo}.ts:`))
    expect(suyos.some(h => h.startsWith(regla))).toBe(true)
  })

  it('dentro de la función listada en castsPermitidos sólo pasa la aserción A LA MARCA: `escribir(tx as any)` y `escribir(prisma as any)` fallan (Important 1)', () => {
    const pago = BASE['src/services/tpv/payment.tpv.service.ts'].replace(
      '  await prisma.$transaction(tx => cuerpo(tx as TxConReintento))\n',
      '  await prisma.$transaction(tx => cuerpo(tx as TxConReintento))\n  await prisma.$transaction(async tx => { await escribir(tx as any) })\n  await escribir(prisma as any)\n',
    )
    const r = ejecutar({ ...juguete(), 'src/services/tpv/payment.tpv.service.ts': pago })
    const suyos = r.hallazgos.filter(h => h.includes('src/services/tpv/payment.tpv.service.ts:'))
    expect(suyos.filter(h => h.startsWith('(9)') && h.includes('tx as any'))).toHaveLength(1)
    expect(suyos.filter(h => h.startsWith('(9)') && h.includes('prisma as any'))).toHaveLength(1)
    expect(suyos.filter(h => h.includes('tx as TxConReintento'))).toEqual([])
  }, 60_000)

  it('renombrar el alias o el archivo no cambia el resultado (identidad del símbolo)', () => {
    const renombrados: Record<string, string> = {}
    for (const [archivo, texto] of Object.entries(juguete(a => `${a}Renombrado`)))
      renombrados[archivo] = texto.replace(/\bTxConReintento\b/g, 'SelloDeLaRed')
    const otro = ejecutar(renombrados)
    const reglas = (h: string[]) =>
      h
        .map(x =>
          x
            .replace(/Renombrado/g, '')
            .replace(/SelloDeLaRed/g, 'TxConReintento')
            .replace(/:\d+/, ''),
        )
        .sort()
    expect(otro.marca).toBe(true)
    expect(reglas(otro.hallazgos)).toEqual(reglas(resultado.hallazgos))
  }, 60_000)

  it('sin la marca (alias pelón, pasos 1–7) no hay nada que revisar y lo dice', () => {
    const sinMarca = {
      ...juguete(),
      'src/utils/serializableRetry.ts': BASE['src/utils/serializableRetry.ts'].replace(
        'Cliente & { readonly [conReintento]: true }',
        'Cliente',
      ),
    }
    const r = ejecutar(sinMarca)
    expect(r.marca).toBe(false)
    expect(r.hallazgos).toEqual([])
  }, 60_000)
})
