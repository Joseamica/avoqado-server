/**
 * D662 v5 · el script del interruptor tiene que escribir en la base que el operador confirmó, y en ninguna otra.
 * - Codex p2v5-r3 #4: confirmaba sólo el host, y `--base local` heredaba una DATABASE_URL de Render.
 * - Codex p2v5-r4 #3: también pasaban otro PUERTO del mismo host, otro ESQUEMA (`?schema=`) y, con `--base render`, cualquier host
 *   remoto. Ahora se confirma el destino completo, `host:puerto/base/esquema`; `local` es la regla de `_solo-base-local.ts` y `render`
 *   sólo acepta un host de Postgres de Render.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { elegirBase, main, revisarConfirmacion } from '../../../scripts/pausa-sola-interruptor'

const LOCAL = 'postgresql://yo@localhost:5432/av-db-25'
const RENDER = 'postgresql://yo@dpg-d4abc123-a.oregon-postgres.render.com/avoqado_prod'
const DESTINO_RENDER = 'dpg-d4abc123-a.oregon-postgres.render.com:5432/avoqado_prod/public'

describe('elegirBase', () => {
  it('sin --base es local: usa DATABASE_URL y dice el destino completo (host:puerto/base/esquema)', () => {
    expect(elegirBase([], { DATABASE_URL: LOCAL })).toEqual({ url: LOCAL, destino: 'localhost:5432/av-db-25/public' })
    expect(elegirBase(['--base', 'local'], { DATABASE_URL: 'postgres://yo@127.0.0.1/av-db-25?schema=otro' }).destino).toBe(
      '127.0.0.1:5432/av-db-25/otro',
    )
  })

  it('🔴 --base local se NIEGA fuera de esta máquina, en otro puerto (túnel) o con una base que no es de desarrollo', () => {
    expect(() => elegirBase([], { DATABASE_URL: RENDER })).toThrow(/--base local/)
    expect(() => elegirBase(['--base', 'local'], { DATABASE_URL: 'postgresql://yo@localhost:5433/av-db-25' })).toThrow(/puerto/)
    expect(() => elegirBase(['--base', 'local'], { DATABASE_URL: 'postgresql://yo@localhost:5432/avoqado_prod' })).toThrow(/desarrollo/)
  })

  it('🔴 --base render usa RENDER_DATABASE_URL y sólo acepta un host de Postgres de Render', () => {
    expect(elegirBase(['--base', 'render'], { DATABASE_URL: LOCAL, RENDER_DATABASE_URL: RENDER })).toEqual({
      url: RENDER,
      destino: DESTINO_RENDER,
    })
    for (const url of [
      LOCAL,
      'postgresql://yo@db.example.com:5432/avoqado_prod',
      'postgresql://yo@dpg-abc.oregon-postgres.render.com.example.com/avoqado_prod',
    ]) {
      expect(() => elegirBase(['--base', 'render'], { RENDER_DATABASE_URL: url })).toThrow(/no es un Postgres de Render/)
    }
    expect(() => elegirBase(['--base', 'render'], { DATABASE_URL: RENDER })).toThrow(/falta RENDER_DATABASE_URL/)
  })

  it('🔴 sólo URLs de Postgres, y sin `?host=` (que manda la conexión a otro lado)', () => {
    expect(() => elegirBase([], { DATABASE_URL: 'mysql://yo@localhost:5432/av-db-25' })).toThrow(/postgres/)
    expect(() => elegirBase(['--base', 'render'], { RENDER_DATABASE_URL: `${RENDER}?host=/tmp` })).toThrow(/host=/)
  })

  it('otro --base, una URL sin base o inválida: error sin imprimir la URL', () => {
    expect(() => elegirBase(['--base', 'prod'], { DATABASE_URL: LOCAL })).toThrow(/sólo acepta/)
    for (const url of ['postgresql://yo@localhost:5432/', 'no-es-una-url']) {
      let mensaje = ''
      try {
        elegirBase([], { DATABASE_URL: url })
      } catch (e) {
        mensaje = (e as Error).message
      }
      expect(mensaje).not.toBe('')
      expect(mensaje).not.toContain(url)
    }
  })
})

describe('revisarConfirmacion', () => {
  const destino = elegirBase(['--base', 'render'], { RENDER_DATABASE_URL: RENDER })

  it('pide el destino completo exacto en --confirm-db', () => {
    expect(() => revisarConfirmacion(['--confirm-db', DESTINO_RENDER], destino)).not.toThrow()
    expect(() => revisarConfirmacion([], destino)).toThrow(/--confirm-db/)
    expect(() => revisarConfirmacion(['--confirm-db', 'avoqado_prod'], destino)).toThrow(DESTINO_RENDER)
  })

  it('🔴 mismo host y base pero otro PUERTO u otro ESQUEMA: la confirmación de producción NO pasa', () => {
    for (const otra of [
      'postgresql://yo@dpg-d4abc123-a.oregon-postgres.render.com:5433/avoqado_prod',
      `${RENDER}?schema=staging`,
      'postgresql://yo@dpg-d4abc123-a.oregon-postgres.render.com/avoqado_staging',
    ]) {
      const copia = elegirBase(['--base', 'render'], { RENDER_DATABASE_URL: otra })
      expect(() => revisarConfirmacion(['--confirm-db', DESTINO_RENDER], copia)).toThrow(/--confirm-db/)
    }
  })
})

describe('main', () => {
  let log: jest.SpyInstance
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    prismaMock.interruptorDePlataforma.findUnique.mockResolvedValue(null)
  })
  afterEach(() => log.mockRestore())

  it('imprime el destino ANTES de conectar, y con la URL de otra base NO escribe', async () => {
    const argv = ['--prender', '--por', 'founder', '--apply', '--confirm-db', 'localhost:5432/av-db-25/public']
    await expect(main(argv, { DATABASE_URL: 'postgresql://yo@localhost:5432/av-db-25-test' })).rejects.toThrow(/--confirm-db/)
    expect(log.mock.calls[0][0]).toBe('Base: localhost:5432/av-db-25-test/public')
    expect(log.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.interruptorDePlataforma.findUnique.mock.invocationCallOrder[0])
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.interruptorDePlataforma.upsert).not.toHaveBeenCalled()
  })

  it('--base local con DATABASE_URL de Render no conecta ni escribe', async () => {
    const argv = ['--apagar', '--por', 'founder', '--apply', '--confirm-db', DESTINO_RENDER]
    await expect(main(argv, { DATABASE_URL: RENDER })).rejects.toThrow(/--base local/)
    expect(prismaMock.interruptorDePlataforma.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.interruptorDePlataforma.upsert).not.toHaveBeenCalled()
  })

  it('con el destino confirmado, apaga', async () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: LOCAL }
    await main(['--apagar', '--por', 'founder', '--apply', '--confirm-db', 'localhost:5432/av-db-25/public'], env)
    expect(prismaMock.interruptorDePlataforma.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { desde: null, actualizadoPor: 'founder' } }),
    )
    expect(env.DATABASE_URL).toBe(LOCAL)
  })
})
