import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// El build de producción ya no revisa tipos (tsc pedía >7 GB y Render tiene 8 GiB, 20-nov-2026). Estas pruebas cuidan
// las dos cosas que lo hacen seguro: que emita lo mismo que tsc emitiría, y que el CI siga revisando los tipos antes.
const raizRepo = path.resolve(__dirname, '../../..')
const script = path.join(raizRepo, 'scripts/build-sin-tipos.cjs')

describe('build de producción sin revisión de tipos (scripts/build-sin-tipos.cjs)', () => {
  it('emite lo del include, lo importado por ruta relativa desde fuera y copia los .json importados', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sin-tipos-'))
    const escribir = (rel: string, texto: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), texto)
    }
    escribir(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          outDir: 'out',
          rootDir: '.',
          module: 'commonjs',
          target: 'es2020',
          resolveJsonModule: true,
          esModuleInterop: true,
        },
        include: ['src/**/*.ts'],
      }),
    )
    escribir(
      'src/a.ts',
      "import { b } from '../fuera/b'\nimport datos from './d.json'\nexport type T = { x: number }\nexport const a = b + datos.n\n",
    )
    escribir('fuera/b.ts', 'export const b: number = 1\n')
    escribir('src/d.json', '{ "n": 2 }')

    execFileSync('node', [script, path.join(dir, 'tsconfig.json')], { cwd: dir })

    expect(fs.existsSync(path.join(dir, 'out/src/a.js'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'out/fuera/b.js'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'out/src/d.json'), 'utf8'))).toEqual({ n: 2 })
    expect(require(path.join(dir, 'out/src/a.js')).a).toBe(3)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('un error de sintaxis detiene el build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sin-tipos-'))
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { outDir: 'out', rootDir: '.' }, include: ['src/**/*.ts'] }),
    )
    fs.writeFileSync(path.join(dir, 'src/roto.ts'), 'export const = ;\n')
    expect(() => execFileSync('node', [script, path.join(dir, 'tsconfig.json')], { cwd: dir, stdio: 'pipe' })).toThrow()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('--comparar: igual sale 0; un .js distinto, uno de más o uno faltante sale 1; un .json con otra sangría es igual', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sin-tipos-'))
    const poner = (rel: string, texto: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), texto)
    }
    const comparar = () => {
      try {
        execFileSync('node', [script, '--comparar', path.join(dir, 'tsc'), path.join(dir, 'nuevo')], { stdio: 'pipe' })
        return 0
      } catch (e) {
        return (e as { status: number }).status
      }
    }
    poner('tsc/a.js', 'exports.a = 1\n')
    poner('nuevo/a.js', 'exports.a = 1\n')
    poner('tsc/d.json', '{\n    "n": 2\n}')
    poner('nuevo/d.json', '{ "n": 2 }')
    expect(comparar()).toBe(0)
    poner('nuevo/a.js', 'exports.a = require("./enum").X\n') // const enum que tsc sí sustituía
    expect(comparar()).toBe(1)
    poner('nuevo/a.js', 'exports.a = 1\n')
    poner('tsc/fuera/b.js', 'exports.b = 1\n') // lo que tsc emitía por un alias y el script no
    expect(comparar()).toBe(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('🔴 el build de npm usa este script y el CI revisa los tipos y compara con tsc ANTES de desplegar', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(raizRepo, 'package.json'), 'utf8'))
    expect(pkg.scripts.build).toContain('node scripts/build-sin-tipos.cjs tsconfig.build.json')
    const ci = fs.readFileSync(path.join(raizRepo, '.github/workflows/ci-cd.yml'), 'utf8')
    const tipos = ci.indexOf('run: npm run typecheck')
    const build = ci.indexOf('run: npm run build')
    const comparar = ci.indexOf('node scripts/build-sin-tipos.cjs --comparar /tmp/dist-tsc /tmp/dist-sin-tipos')
    expect(tipos).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(tipos)
    expect(comparar).toBeGreaterThan(build)
    // El deploy espera al job que lleva esos pasos.
    expect(ci).toMatch(/needs: \[test-and-build, unit-tests\]/)
  })
})
