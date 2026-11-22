/**
 * D662 v5 · el script del interruptor escribe en la base que el operador confirmó, y en ninguna otra.
 *
 * Rediseño tras Codex p2v5-r6 (cuatro rondas de la MISMA familia: el destino que se deducía de la URL no era el que abría Prisma; rutas
 * con `/`, `%61`, `search_path`, `DATABASE_CONNECTION_LIMIT`, un túnel a localhost). Ya no se deduce nada de la URL: la confirmación es
 * lo que la BASE dice que es (clúster, base y esquema), preguntado en la MISMA transacción que escribe, antes de escribir.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { elegirBase, exigirIdentidad, leerIdentidad, main, textoDeIdentidad } from '../../../scripts/pausa-sola-interruptor'

const LOCAL = 'postgresql://yo@localhost:5432/av-db-25-pruebas'
const RENDER = 'postgresql://yo@dpg-d4abc123-a.oregon-postgres.render.com/avoqado_prod'
const IDENTIDAD = { cluster: '7142610626013088922', servidor: '127.0.0.1:5432', base: 'av-db-25-pruebas', esquema: 'public' }
const TEXTO = 'cluster:7142610626013088922/servidor:127.0.0.1:5432/base:av-db-25-pruebas/esquema:public'
const SUYA = 'cluster:7142610626013088922/servidor:127.0.0.1:5432/base:av-db-25-pruebas/esquema:yo'

const raw = () => prismaMock.$queryRaw as unknown as jest.Mock
const textoSql = (llamada: unknown[]) => (llamada[0] as string[]).join('?')
/** La base contesta su identidad a la consulta de identidad, y `filasDelInsert` al INSERT del interruptor. */
const baseQueDice = (
  identidad: Record<string, unknown> | null,
  filasDelInsert: unknown[] = [{ desde: new Date('2026-11-21T19:00:00Z') }],
) =>
  raw().mockImplementation((partes: string[]) =>
    Promise.resolve(partes.join('?').includes('pg_control_system') ? (identidad ? [identidad] : []) : filasDelInsert),
  )
const llamadasDe = (fragmento: string) => raw().mock.calls.filter(c => textoSql(c).includes(fragmento))
/** Las escrituras del interruptor: el INSERT de «Prender» ($queryRaw) y el de «Apagar» ($executeRaw). */
const escrituras = () =>
  [...raw().mock.calls, ...(prismaMock.$executeRaw as unknown as jest.Mock).mock.calls].filter(c => textoSql(c).includes('INSERT INTO'))
const ordenDe = (fragmento: string) => raw().mock.invocationCallOrder[raw().mock.calls.findIndex(c => textoSql(c).includes(fragmento))]

describe('identidad de la base', () => {
  it('se pregunta a Postgres (clúster, servidor, base y esquema) y se escribe como una sola cadena sin espacios', async () => {
    baseQueDice(IDENTIDAD)
    const identidad = await leerIdentidad(prismaMock as any)
    expect(identidad).toEqual(IDENTIDAD)
    expect(textoDeIdentidad(identidad)).toBe(TEXTO)
    const sql = textoSql(raw().mock.calls[0])
    expect(sql).toContain('system_identifier')
    // Codex p2v5-r7 #2: una copia física conserva el clúster; la dirección y el puerto que atienden ESTA conexión la distinguen.
    expect(sql).toContain("coalesce(host(inet_server_addr()), 'socket')")
    expect(sql).toContain('inet_server_port()')
    expect(sql).toContain('current_database()')
    expect(sql).toContain('current_schema()')
  })

  it('si la base no dice quién es (p. ej. sin permiso para el clúster), no se sigue', async () => {
    baseQueDice(null)
    await expect(leerIdentidad(prismaMock as any)).rejects.toThrow(/no dijo quién es/)
  })

  it('🔴 exigirIdentidad compara contra lo que contestó la base, y se niega fuera del esquema que lee la tienda', async () => {
    baseQueDice(IDENTIDAD)
    await expect(exigirIdentidad(TEXTO, 'public')(prismaMock as any)).resolves.toBeUndefined()
    await expect(exigirIdentidad(undefined, 'public')(prismaMock as any)).rejects.toThrow(TEXTO)
    await expect(exigirIdentidad(TEXTO.replace('pruebas', 'otra'), 'public')(prismaMock as any)).rejects.toThrow(/--confirm-db/)
    baseQueDice({ ...IDENTIDAD, esquema: 'yo' })
    await expect(exigirIdentidad(SUYA, 'public')(prismaMock as any)).rejects.toThrow(/esquema «yo»/)
    // 🔴 Codex p2v5-r7 #2: la misma base y el mismo clúster en OTRO servidor (una copia física) ya no coincide.
    baseQueDice({ ...IDENTIDAD, servidor: '10.0.0.7:5433' })
    await expect(exigirIdentidad(TEXTO, 'public')(prismaMock as any)).rejects.toThrow(/servidor:10\.0\.0\.7:5433/)
  })
})

describe('elegirBase: sólo elige la variable (y local pide un host de esta máquina como primera barrera)', () => {
  it('local usa DATABASE_URL; render usa RENDER_DATABASE_URL sin analizar la URL', () => {
    expect(elegirBase([], { DATABASE_URL: LOCAL })).toBe(LOCAL)
    expect(elegirBase(['--base', 'render'], { DATABASE_URL: LOCAL, RENDER_DATABASE_URL: RENDER })).toBe(RENDER)
    expect(() => elegirBase(['--base', 'render'], { DATABASE_URL: RENDER })).toThrow(/falta RENDER_DATABASE_URL/)
    expect(() => elegirBase(['--base', 'prod'], { DATABASE_URL: LOCAL })).toThrow(/sólo acepta/)
  })

  it('--base local con una URL que no es de esta máquina se niega sin imprimirla', () => {
    // 🔴 Codex p2v5-r7 #3: `?host=` o `?hostaddr=` mandan a Prisma a otro lado aunque la dirección diga localhost.
    for (const url of [
      RENDER,
      'no-es-una-url',
      'postgresql://yo@localhost:5432/av-db-25?host=dpg-x.oregon-postgres.render.com',
      'postgresql://yo@localhost:5432/av-db-25?hostaddr=10.0.0.7',
    ]) {
      let mensaje = ''
      try {
        elegirBase(['--base', 'local'], { DATABASE_URL: url })
      } catch (e) {
        mensaje = (e as Error).message
      }
      expect(mensaje).toMatch(/--base local/)
      expect(mensaje).not.toContain(url)
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
  const impreso = () => log.mock.calls.map(c => String(c[0])).join('\n')

  it('--ver imprime la identidad que dice la base y no escribe', async () => {
    baseQueDice(IDENTIDAD)
    await main(['--ver'], { DATABASE_URL: LOCAL })
    expect(impreso()).toContain(`Base: ${TEXTO}`)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(llamadasDe('INSERT INTO')).toHaveLength(0)
  })

  it('sin --apply sólo dice qué haría y cómo confirmarlo con la identidad', async () => {
    baseQueDice(IDENTIDAD)
    await main(['--prender', '--por', 'founder'], { DATABASE_URL: LOCAL })
    expect(impreso()).toContain(`--apply --confirm-db ${TEXTO}`)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 --prender --apply con la identidad correcta: la confirma DENTRO de la transacción que escribe, después del candado y antes del INSERT', async () => {
    baseQueDice(IDENTIDAD)
    await main(['--prender', '--por', 'founder', '--apply', '--confirm-db', TEXTO], { DATABASE_URL: LOCAL })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    // Dos lecturas de identidad: la de mostrar y la de confirmar (ésta, dentro de la transacción).
    const identidades = llamadasDe('pg_control_system')
    expect(identidades).toHaveLength(2)
    const ultimaIdentidad = raw().mock.invocationCallOrder[raw().mock.calls.lastIndexOf(identidades[1])]
    expect(ultimaIdentidad).toBeLessThan(ordenDe('INSERT INTO'))
    expect((prismaMock.$executeRaw as unknown as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(ultimaIdentidad)
    expect(impreso()).toContain('PRENDIDA')
  })

  it('🔴 con una identidad equivocada NO escribe (ni prender ni apagar)', async () => {
    baseQueDice(IDENTIDAD)
    const otra = TEXTO.replace('7142610626013088922', '1111111111111111111')
    await expect(main(['--prender', '--por', 'founder', '--apply', '--confirm-db', otra], { DATABASE_URL: LOCAL })).rejects.toThrow(
      /--confirm-db/,
    )
    await expect(main(['--apagar', '--por', 'founder', '--apply', '--confirm-db', otra], { DATABASE_URL: LOCAL })).rejects.toThrow(
      /--confirm-db/,
    )
    expect(escrituras()).toHaveLength(0)
  })

  it('🔴 fuera del esquema que lee la tienda no escribe, aunque la confirmación coincida con lo que dice la base', async () => {
    baseQueDice({ ...IDENTIDAD, esquema: 'yo' })
    await expect(main(['--apagar', '--por', 'founder', '--apply', '--confirm-db', SUYA], { DATABASE_URL: LOCAL })).rejects.toThrow(
      /esquema «yo»/,
    )
    expect(escrituras()).toHaveLength(0)
  })

  it('con la identidad correcta, apaga', async () => {
    baseQueDice(IDENTIDAD)
    const env: NodeJS.ProcessEnv = { DATABASE_URL: LOCAL }
    await main(['--apagar', '--por', 'founder', '--apply', '--confirm-db', TEXTO], env)
    const [apagado] = escrituras()
    expect(textoSql(apagado)).toContain('INSERT INTO "public"."InterruptorDePlataforma"')
    expect(apagado).toContain('founder')
    expect(env.DATABASE_URL).toBe(LOCAL)
  })
})
