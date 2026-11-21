/**
 * D662 v5 · Codex p2v5-r3 #4: el script del interruptor confirmaba sólo el host. Dos bases pueden compartirlo, y `--base local` heredaba
 * una DATABASE_URL de Render. Ahora `local` exige una URL de esta máquina, `render` una que no lo sea, y escribir pide host Y base.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { elegirBase, main, revisarConfirmacion } from '../../../scripts/pausa-sola-interruptor'

const LOCAL = 'postgresql://yo@localhost:5432/av-db-25'
const COPIA_LOCAL = 'postgresql://yo@localhost:5432/av-db-25-pruebas'
const RENDER = 'postgresql://yo@dpg-abc.oregon-postgres.render.com/avoqado_prod'
const COPIA_RENDER = 'postgresql://yo@dpg-abc.oregon-postgres.render.com/avoqado_staging'

describe('elegirBase', () => {
  it('sin --base es local: usa DATABASE_URL de esta máquina y dice host y base', () => {
    expect(elegirBase([], { DATABASE_URL: LOCAL })).toEqual({ url: LOCAL, host: 'localhost', baseDeDatos: 'av-db-25' })
    expect(elegirBase(['--base', 'local'], { DATABASE_URL: 'postgresql://yo@127.0.0.1/otra' }).host).toBe('127.0.0.1')
  })

  it('🔴 --base local (o sin --base) se NIEGA si DATABASE_URL no es de esta máquina (p. ej. la heredada de Render)', () => {
    expect(() => elegirBase([], { DATABASE_URL: RENDER })).toThrow(/no es de esta máquina/)
    expect(() => elegirBase(['--base', 'local'], { DATABASE_URL: RENDER })).toThrow(/no es de esta máquina/)
  })

  it('🔴 --base render usa RENDER_DATABASE_URL y se NIEGA si es de esta máquina', () => {
    expect(elegirBase(['--base', 'render'], { DATABASE_URL: LOCAL, RENDER_DATABASE_URL: RENDER })).toEqual({
      url: RENDER,
      host: 'dpg-abc.oregon-postgres.render.com',
      baseDeDatos: 'avoqado_prod',
    })
    expect(() => elegirBase(['--base', 'render'], { RENDER_DATABASE_URL: LOCAL })).toThrow(/es de esta máquina/)
    expect(() => elegirBase(['--base', 'render'], { DATABASE_URL: RENDER })).toThrow(/falta RENDER_DATABASE_URL/)
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
      expect(mensaje).toMatch(/host y nombre de base/)
      expect(mensaje).not.toContain(url)
    }
  })
})

describe('revisarConfirmacion', () => {
  const destino = elegirBase(['--base', 'render'], { RENDER_DATABASE_URL: RENDER })

  it('pide el host Y el nombre de la base exactos', () => {
    expect(() => revisarConfirmacion(['--confirm-host', destino.host, '--confirm-db', 'avoqado_prod'], destino)).not.toThrow()
    expect(() => revisarConfirmacion(['--confirm-host', destino.host], destino)).toThrow(/--confirm-db/)
    expect(() => revisarConfirmacion(['--confirm-db', 'avoqado_prod'], destino)).toThrow(/--confirm-host/)
  })

  it('🔴 dos bases con el MISMO host: confirmar la de producción con la URL de la copia NO pasa', () => {
    const copia = elegirBase(['--base', 'render'], { RENDER_DATABASE_URL: COPIA_RENDER })
    expect(copia.host).toBe(destino.host)
    expect(() => revisarConfirmacion(['--confirm-host', copia.host, '--confirm-db', 'avoqado_prod'], copia)).toThrow(/avoqado_staging/)
  })
})

describe('main', () => {
  let log: jest.SpyInstance
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    prismaMock.interruptorDePlataforma.findUnique.mockResolvedValue(null)
  })
  afterEach(() => log.mockRestore())

  it('imprime host y base ANTES de conectar, y con la URL de otra base del mismo host NO escribe', async () => {
    const argv = ['--prender', '--por', 'founder', '--apply', '--confirm-host', 'localhost', '--confirm-db', 'av-db-25']
    await expect(main(argv, { DATABASE_URL: COPIA_LOCAL })).rejects.toThrow(/--confirm-db.*av-db-25-pruebas/)
    expect(log.mock.calls[0][0]).toBe('Base: localhost / av-db-25-pruebas')
    expect(log.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.interruptorDePlataforma.findUnique.mock.invocationCallOrder[0])
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.interruptorDePlataforma.upsert).not.toHaveBeenCalled()
  })

  it('--base local con DATABASE_URL de Render no conecta ni escribe', async () => {
    const argv = ['--apagar', '--por', 'founder', '--apply', '--confirm-host', 'dpg-abc.oregon-postgres.render.com', '--confirm-db', 'avoqado_prod']
    await expect(main(argv, { DATABASE_URL: RENDER })).rejects.toThrow(/no es de esta máquina/)
    expect(prismaMock.interruptorDePlataforma.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.interruptorDePlataforma.upsert).not.toHaveBeenCalled()
  })

  it('con host y base confirmados, apaga', async () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: LOCAL }
    await main(['--apagar', '--por', 'founder', '--apply', '--confirm-host', 'localhost', '--confirm-db', 'av-db-25'], env)
    expect(prismaMock.interruptorDePlataforma.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { desde: null, actualizadoPor: 'founder' } }))
    expect(env.DATABASE_URL).toBe(LOCAL)
  })
})
