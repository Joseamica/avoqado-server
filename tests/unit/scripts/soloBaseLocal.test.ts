/**
 * El cortafuegos de los scripts de prueba (hallazgo #9 de Codex).
 *
 * 🔴 El coste de equivocarse es asimétrico: rechazar una base local rara cuesta un minuto;
 * dejar pasar producción cuesta autorizaciones de nómina y cuadrantes de empleados. Por eso
 * todas las pruebas de abajo empujan hacia el MISMO lado: ante la duda, corta.
 */
import { esBaseLocal, esClusterAutorizado } from '../../../scripts/_solo-base-local'

describe('esBaseLocal', () => {
  describe('deja pasar lo local', () => {
    it.each([
      'postgresql://postgres:x@localhost:5432/av-db-25',
      'postgresql://postgres:x@127.0.0.1:5432/av-db-25',
      'postgresql://postgres:x@localhost:5432/av-db-25-test',
      'postgres://u:p@localhost:5432/av-db-25?schema=public',
    ])('%s', url => {
      expect(esBaseLocal(url).ok).toBe(true)
    })
  })

  /**
   * 🔴 Un host local NO prueba que la base sea local: `ssh -L 5433:prod:5432` deja producción
   * escuchando en `localhost` (2ª auditoría de Codex, 30-ago-2026, P1 #6). Por eso además del
   * host se comprueban el PUERTO y el NOMBRE.
   *
   * ⚠️ El precio, declarado: una base local con nombre no listado deja de pasar. Es
   * deliberado y coherente con la asimetría que este módulo declara en su cabecera — quien
   * usa otro nombre pierde un minuto añadiéndolo a `BASES_LOCALES`; dejar pasar producción
   * pierde datos de nómina.
   */
  describe('🔴 un host local NO basta: túnel SSH', () => {
    it('corta un puerto que no es el de Postgres', () => {
      const r = esBaseLocal('postgresql://u:p@localhost:5433/avoqado_prod')
      expect(r.ok).toBe(false)
      expect(r.motivo).toMatch(/túnel|puerto/i)
    })

    it('corta un nombre de base desconocido aunque el puerto sea el bueno', () => {
      const r = esBaseLocal('postgresql://u:p@localhost:5432/avoqado_prod')
      expect(r.ok).toBe(false)
      expect(r.motivo).toMatch(/no está en la lista|desarrollo/i)
    })

    it('el motivo dice QUÉ base rechazó, para poder añadirla si es legítima', () => {
      expect(esBaseLocal('postgresql://u:p@localhost:5432/mi_base').motivo).toContain('mi_base')
    })
  })

  describe('🔴 corta cualquier otra cosa', () => {
    it.each([
      ['un host remoto cualquiera', 'postgresql://u:p@db.example.com:5432/prod'],
      ['Render', 'postgresql://u:p@dpg-abc123.oregon-postgres.render.com/avoqado'],
      ['Fly', 'postgresql://u:p@avoqado-db.fly.dev:5432/postgres'],
      ['Neon', 'postgresql://u:p@ep-cool.us-east-2.aws.neon.tech/main'],
      ['Supabase', 'postgresql://u:p@db.abcdef.supabase.co:5432/postgres'],
      ['RDS', 'postgresql://u:p@x.abc.us-east-1.rds.amazonaws.com:5432/prod'],
      ['una IP de red local que NO es loopback', 'postgresql://u:p@192.168.1.50:5432/av-db-25'],
    ])('%s', (_, url) => {
      expect(esBaseLocal(url).ok).toBe(false)
    })
  })

  it('🔴 sin DATABASE_URL corta — no asume nada', () => {
    expect(esBaseLocal(undefined).ok).toBe(false)
    expect(esBaseLocal('').ok).toBe(false)
  })

  it('🔴 una URL ilegible corta: no poder leerla no es lo mismo que ser local', () => {
    expect(esBaseLocal('esto no es una url').ok).toBe(false)
  })

  it('🔴 un proveedor remoto corta AUNQUE el host parezca local (túnel o proxy)', () => {
    // Alguien que tuneliza producción a localhost sigue escribiendo en producción.
    expect(esBaseLocal('postgresql://u:p@localhost:5432/db?host=x.render.com').ok).toBe(false)
  })

  it('el motivo dice QUÉ pasó, no un código', () => {
    expect(esBaseLocal('postgresql://u:p@db.example.com/prod').motivo).toMatch(/no es local/i)
    expect(esBaseLocal(undefined).motivo).toMatch(/DATABASE_URL/i)
  })

  it('devuelve host y base para poder enseñarlos al abortar', () => {
    const r = esBaseLocal('postgresql://u:p@db.example.com:5432/produccion')
    expect(r.host).toBe('db.example.com')
    expect(r.base).toBe('produccion')
  })
})

describe('🔴 los scripts que escriben lo USAN — prueba estática', () => {
  // Estática a propósito: lo que importa es que la llamada no desaparezca de ninguno.
  const fs = require('fs')
  const path = require('path')
  const DIR = path.join(__dirname, '../../../scripts')

  it.each([
    'probar-horas-extra.ts',
    'probar-autorizar-extra.ts',
    'sembrar-extra-para-qa.ts',
  ])('%s llama a exigirBaseLocal', archivo => {
    const fuente = fs.readFileSync(path.join(DIR, archivo), 'utf8')
    expect(fuente).toContain('exigirBaseLocal')
  })
})

/**
 * 🔴 La URL no prueba dónde termina el socket (3ª auditoría de Codex, 31-ago-2026, P1 #4).
 * `ssh -L 5432:produccion:5432` deja producción respondiendo en `localhost:5432`, y si la base
 * se llama como una de desarrollo la URL pasa entera. Por eso se le pregunta al SERVIDOR.
 */
describe('esClusterAutorizado · lo único que un túnel no puede falsificar', () => {
  const conId = (id: string) => ({
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id, base: 'av-db-25' }]),
  })
  const original = process.env.AVQ_LOCAL_DB_ID
  afterEach(() => {
    if (original === undefined) delete process.env.AVQ_LOCAL_DB_ID
    else process.env.AVQ_LOCAL_DB_ID = original
  })

  /**
   * 🔴 Mi primer intento miraba `inet_server_addr()` y NO servía: con
   * `ssh -L 5432:localhost:5432 produccion`, OpenSSH abre la conexión desde la máquina remota,
   * así que el Postgres de producción la acepta sobre SU PROPIO loopback y contesta
   * `127.0.0.1`. La prueba de entonces modelaba el túnel como si reportara `10.x` — un caso que
   * casi nunca ocurre — y por eso pasaba (4ª auditoría de Codex, 31-ago-2026, P1 #3).
   */
  it('🔴 el clúster de producción alcanzado por túnel NO está autorizado', () => {
    process.env.AVQ_LOCAL_DB_ID = '7142610626013088922'
    return expect(esClusterAutorizado(conId('9988776655443322110') as any)).resolves.toMatchObject({ ok: false })
  })

  it('el clúster autorizado pasa', async () => {
    process.env.AVQ_LOCAL_DB_ID = '7142610626013088922'
    expect((await esClusterAutorizado(conId('7142610626013088922') as any)).ok).toBe(true)
  })

  it('🔴 sin autorizar NADA corta, y dice el identificador para poder autorizarlo a mano', async () => {
    delete process.env.AVQ_LOCAL_DB_ID
    const r = await esClusterAutorizado(conId('7142610626013088922') as any)
    expect(r.ok).toBe(false)
    expect(r.motivo).toContain('7142610626013088922')
  })

  it('acepta varios separados por coma, para quien tiene más de una base local', async () => {
    process.env.AVQ_LOCAL_DB_ID = '111, 7142610626013088922 ,222'
    expect((await esClusterAutorizado(conId('7142610626013088922') as any)).ok).toBe(true)
  })

  it('si no se puede preguntar, CORTA', async () => {
    process.env.AVQ_LOCAL_DB_ID = '111'
    const roto = { $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('sin conexión')) }
    expect((await esClusterAutorizado(roto as any)).ok).toBe(false)
  })
})
