import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { parse } from 'yaml'

// El deploy a producción sube EXACTAMENTE el commit que el CI probó, y nunca hacia atrás (14-oct-2026).
//
// Antes, el paso de deploy le decía a Render «despliega» sin decir qué commit, y Render subía lo último de main. El
// 5-oct (19:24 Mx) la corrida de 6eddd89c3 pasó sus pruebas y Render subió dcc6ff788, que había llegado a main 20 min
// antes y cuyas pruebas ni habían empezado. Y un `workflow_dispatch` desde OTRA rama probaba esa rama y luego Render
// subía main sin revisarlo (3-oct). Estas pruebas fijan el cableado del workflow y el comportamiento del script contra
// un Render y un GitHub de mentira, sin tocar los reales.

const RAIZ = path.resolve(__dirname, '../../..')
const SCRIPT = path.join(RAIZ, '.github/scripts/render-deploy-commit-exacto.sh')
const WORKFLOWS = path.join(RAIZ, '.github/workflows')

const PROBADO = 'a'.repeat(40)
const OTRO = 'b'.repeat(40)
const VIVO = 'c'.repeat(40)
const LLAVE = 'rnd_llave_que_nunca_se_imprime'
const TOKEN = 'ghs_token_que_nunca_se_imprime'

describe('workflow: el deploy de producción', () => {
  const workflow = parse(fs.readFileSync(path.join(WORKFLOWS, 'ci-cd.yml'), 'utf8'))
  const deploy = workflow.jobs['deploy-production']
  const pasos: Array<Record<string, any>> = deploy.steps

  it('espera la revisión completa (integración y unitarias) y no la relaja con always()/failure()', () => {
    expect(deploy.needs).toEqual(expect.arrayContaining(['test-and-build', 'unit-tests']))
    expect(deploy.if).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)|success\(\)/)
    expect(deploy['timeout-minutes']).toBeGreaterThan(0)
  })

  // Evalúa el `if:` del job de verdad (no busca texto): sólo usa ==, &&, ||, paréntesis y literales entre comillas.
  const correriaElDeploy = (ctx: { ref: string; event: string; environment?: string }) => {
    const js = String(deploy.if)
      .replace(/github\.event\.inputs\.environment/g, 'ctx.environment')
      .replace(/github\.event_name/g, 'ctx.event')
      .replace(/github\.ref/g, 'ctx.ref')
      .replace(/==/g, '===')
    expect(js).toMatch(/^[\sa-zA-Z.'"/=&|()_*-]+$/)
    return Boolean(new Function('ctx', `return (${js})`)(ctx))
  }

  it.each([
    [true, { ref: 'refs/heads/main', event: 'push' }],
    [true, { ref: 'refs/heads/main', event: 'workflow_dispatch', environment: 'production' }],
    [false, { ref: 'refs/heads/develop', event: 'workflow_dispatch', environment: 'production' }],
    [false, { ref: 'refs/heads/ci/algo', event: 'workflow_dispatch', environment: 'production' }],
    [false, { ref: 'refs/heads/develop', event: 'push' }],
    [false, { ref: 'refs/heads/ci/algo', event: 'push' }],
    [false, { ref: 'refs/pull/7/merge', event: 'pull_request' }],
  ])('sólo despliega desde main (%s con %j): un dispatch desde otra rama ya no publica', (esperado, ctx) => {
    expect(correriaElDeploy(ctx)).toBe(esperado)
  })

  // Lo que haría que la revisión corra MENOS pruebas sin que nadie lo note.
  const RECORTES = /--onlyChanged|--changedSince|--findRelatedTests|--shard|--passWithNoTests|--bail/

  it('la integración sigue dentro de la revisión que el deploy espera, sin continue-on-error y con el filtro de siempre', () => {
    const revision = workflow.jobs['test-and-build']
    expect(revision['continue-on-error']).toBeUndefined()
    // Desde el 14-oct corre en 4 procesos con `npx jest` (una copia de la base por proceso), ya no con `npm run test:integration`.
    const integracion = revision.steps.find((p: Record<string, any>) => String(p.run ?? '').includes('--selectProjects=integration'))
    expect(integracion).toBeDefined()
    expect(integracion.if).toBeUndefined()
    expect(integracion['continue-on-error']).toBeUndefined()
    const run = String(integracion.run)
    expect(run).not.toMatch(RECORTES)
    // Las mismas exclusiones que `npm run test:integration`: ni una prueba menos.
    const filtro = (s: string) => s.match(/--testPathIgnorePatterns='([^']+)'/)?.[1]
    const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'))
    expect(filtro(pkg.scripts['test:integration'])).toBeDefined()
    expect(filtro(run)).toBe(filtro(pkg.scripts['test:integration']))
  })

  it('las unitarias corren completas, en un job que el deploy espera', () => {
    const unitarias = workflow.jobs['unit-tests']
    expect(deploy.needs).toEqual(expect.arrayContaining(['test-and-build', 'unit-tests']))
    expect(unitarias.if).toBeUndefined()
    expect(unitarias['continue-on-error']).toBeUndefined()
    expect(unitarias.strategy).toBeUndefined() // un solo job: sin partes que alguien pueda dejar fuera
    const paso = unitarias.steps.find((p: Record<string, any>) => /jest tests\/unit /.test(String(p.run ?? '')))
    expect(paso).toBeDefined()
    expect(paso.if).toBeUndefined()
    expect(paso['continue-on-error']).toBeUndefined()
    expect(String(paso.run)).not.toMatch(RECORTES)
  })

  // Las de cronómetro (miden el event loop contra 50 ms) corren aparte y solas (24-oct-2026): con 4 procesos compartiendo
  // CPU daban rojos falsos (59.7 ms en develop el 22-oct). Aparte, nunca fuera: la lista es EXACTAMENTE los archivos que
  // importan el arnés o utils/eventLoopBudget, salen de la corrida en paralelo con el mismo patrón y entran solas en el mismo paso.
  it('las de cronómetro corren solas en el mismo paso, y la lista es exactamente las que miden el event loop', () => {
    const paso = workflow.jobs['unit-tests'].steps.find((p: Record<string, any>) => /jest tests\/unit /.test(String(p.run ?? '')))
    const run = String(paso.run)
    const cronometro = run.match(/CRONOMETRO='([^']+)'/)?.[1]
    expect(cronometro).toBeDefined()
    expect(run).toMatch(/npx jest tests\/unit [^\n]*--testPathIgnorePatterns="\$CRONOMETRO"/)
    expect(run).toMatch(/npx jest "\$CRONOMETRO" [^\n]*--runInBand/)

    const archivos: string[] = []
    const recorrer = (dir: string) => {
      for (const e of fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) recorrer(rel)
        else if (rel.endsWith('.test.ts')) archivos.push(rel)
      }
    }
    recorrer('tests/unit')
    // Lo que SÍ garantiza: cada archivo corre una sola vez (la partición de abajo es la misma que hace Jest). Detectar
    // un cronómetro NUEVO es de buena fe (import, import(), require; con o sin .ts): si uno se escapa, corre en paralelo
    // como antes del 24-oct (un rojo falso a veces), nunca se pierde una prueba.
    const CARGA_CRONOMETRO = /(from\s+|import\(\s*|require\(\s*)['"`][^'"`\n]*(catalogImportEventLoopTestHarness|utils\/eventLoopBudget)(\.ts)?['"`]/
    const esta = path.relative(RAIZ, __filename).split(path.sep).join('/')
    const miden = archivos.filter(f => f !== esta && CARGA_CRONOMETRO.test(fs.readFileSync(path.join(RAIZ, f), 'utf8')))
    // Jest compara el patrón con la ruta ABSOLUTA y con «/»: aquí también, para que un `^tests/...` no pase aquí y falle allá.
    const aparte = archivos.filter(f => new RegExp(cronometro!).test(`${RAIZ.split(path.sep).join('/')}/${f}`))
    expect(miden.length).toBeGreaterThan(0)
    expect(aparte.sort()).toEqual(miden.sort())
  })

  it('despliega con el script del commit exacto, con el SHA probado y el secreto NUEVO del servicio (el viejo, de respaldo)', () => {
    const paso = pasos.find(p => String(p.run ?? '').includes('.github/scripts/render-deploy-commit-exacto.sh'))
    expect(paso).toBeDefined()
    expect(paso!.env.COMMIT_SHA).toBe('${{ github.sha }}')
    expect(paso!.env.GITHUB_TOKEN).toBe('${{ github.token }}')
    expect(paso!.env.RENDER_SERVICE_ID).toBe('${{ secrets.RENDER_DEPLOY_SERVICE_ID || secrets.RENDER_PRODUCTION_SERVICE_ID }}')
    expect(pasos.some(p => String(p.uses ?? '').includes('actions/checkout'))).toBe(true)
  })

  it('el secreto viejo del servicio sólo queda como respaldo del nuevo: al borrarlo, una corrida vieja re-ejecutada no puede desplegar', () => {
    const usos: string[] = []
    for (const archivo of fs.readdirSync(WORKFLOWS)) {
      for (const linea of fs.readFileSync(path.join(WORKFLOWS, archivo), 'utf8').split('\n')) {
        if (!linea.trim().startsWith('#') && linea.includes('secrets.RENDER_PRODUCTION_SERVICE_ID')) usos.push(linea.trim())
      }
    }
    expect(usos).toEqual(['RENDER_SERVICE_ID: ${{ secrets.RENDER_DEPLOY_SERVICE_ID || secrets.RENDER_PRODUCTION_SERVICE_ID }}'])
  })

  it('ningún workflow vuelve a usar la acción que desplegaba «lo último de main»', () => {
    // Se leen los `uses:` reales: el job de staging comentado todavía la menciona, y si alguien lo descomenta, falla aquí.
    const usos: string[] = []
    for (const archivo of fs.readdirSync(WORKFLOWS)) {
      const wf = parse(fs.readFileSync(path.join(WORKFLOWS, archivo), 'utf8'))
      for (const job of Object.values<Record<string, any>>(wf.jobs ?? {})) {
        for (const paso of job.steps ?? []) if (paso.uses) usos.push(String(paso.uses))
      }
    }
    expect(usos.length).toBeGreaterThan(0)
    expect(usos.filter(u => u.includes('render-deploy-action'))).toEqual([])
  })

  it('la revisión de salud falla si ninguno de sus intentos sale bien (antes anunciaba éxito igual)', () => {
    const salud = pasos.find(p => String(p.name ?? '').includes('health verification'))
    expect(salud!.if).toBe("steps.deploy.outputs.deployed == 'true'")
    expect(salud!.run).toContain('--max-time')
    expect(salud!.run).toMatch(/if \[ "\$OK" != true \]; then[\s\S]*exit 1/)
  })
})

// ── El script contra un Render y un GitHub de mentira ─────────────────────────────────────────────────────────────

type Deploy = { id: string; status: string; commit: { id: string } }
type Escenario = {
  // Lista de deploys ANTES de pedir el nuevo (de ahí sale qué está LIVE).
  previos?: Deploy[]
  // O una secuencia de listas antes de pedir (la última se repite): para deploys en curso que terminan después.
  previosSecuencia?: Deploy[][]
  // Qué contesta GitHub al preguntar si el commit sigue en main.
  enMain?: { code: number; status?: string }
  // Qué contesta GitHub al comparar lo LIVE con lo probado.
  comparar?: { code: number; status?: string }
  post?: { code: number; body?: unknown }
  // Lo que contesta GET /deploys/:id, una respuesta por consulta (la última se repite).
  porId?: Array<{ status: string; commit: string }>
  // Lo que contesta la lista DESPUÉS del POST (caso 202), una por consulta (la última se repite).
  listaTrasPost?: Deploy[][]
  // Render no contesta las consultas del deploy (red colgada).
  colgarConsultas?: boolean
}
type Peticion = { method: string; url: string; body: string; auth: string | undefined }

const vivoEn = (sha: string): Deploy[] => [
  { id: 'dep-anterior', status: 'live', commit: { id: sha } },
  { id: 'dep-viejo', status: 'deactivated', commit: { id: OTRO } },
]

async function mundoDeMentira(e: Escenario) {
  const peticiones: Peticion[] = []
  let iPorId = 0
  let iLista = 0
  let iPrevios = 0
  let yaPidio = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      peticiones.push({ method: req.method ?? '', url: req.url ?? '', body, auth: req.headers.authorization })
      const json = (code: number, data: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(data === undefined ? '' : JSON.stringify(data))
      }
      const url = req.url ?? ''
      if (url.startsWith(`/github/repos/Joseamica/avoqado-server/compare/${PROBADO}...main`)) {
        const c = e.enMain ?? { code: 200, status: 'identical' }
        return json(c.code, c.code === 200 ? { status: c.status } : { message: 'Not Found' })
      }
      if (url.startsWith('/github/repos/Joseamica/avoqado-server/compare/')) {
        const c = e.comparar ?? { code: 200, status: 'ahead' }
        return json(c.code, c.code === 200 ? { status: c.status } : { message: 'Not Found' })
      }
      if (req.method === 'POST' && url === '/v1/services/srv-prueba/deploys') {
        yaPidio = true
        const p = e.post ?? { code: 201, body: { id: 'dep-1', commit: { id: PROBADO } } }
        return json(p.code, p.body)
      }
      if (req.method === 'GET' && e.colgarConsultas && yaPidio) return
      if (req.method === 'GET' && url.startsWith('/v1/services/srv-prueba/deploys/')) {
        const lista = e.porId ?? []
        if (lista.length === 0) return json(404, { message: 'deploy desconocido' })
        const r = lista[Math.min(iPorId++, lista.length - 1)]
        return json(200, { id: url.split('/').pop(), status: r.status, commit: { id: r.commit } })
      }
      if (req.method === 'GET' && url.startsWith('/v1/services/srv-prueba/deploys?')) {
        let deploys = e.previos ?? vivoEn(VIVO)
        if (e.previosSecuencia && !yaPidio) deploys = e.previosSecuencia[Math.min(iPrevios++, e.previosSecuencia.length - 1)]
        if (yaPidio) {
          const listas = e.listaTrasPost ?? [deploys]
          deploys = listas[Math.min(iLista++, listas.length - 1)]
        }
        return json(
          200,
          deploys.map(deploy => ({ deploy, cursor: 'c' })),
        )
      }
      json(404, { message: 'ruta desconocida en el mundo de mentira' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const cerrar = () =>
    new Promise(resolve => {
      server.closeAllConnections()
      server.close(resolve)
    })
  return { base: `http://127.0.0.1:${port}`, peticiones, cerrar }
}

function correr(base: string, env: Record<string, string>) {
  return new Promise<{ code: number; salida: string }>(resolve => {
    execFile(
      'bash',
      [SCRIPT],
      {
        env: {
          PATH: process.env.PATH ?? '',
          RENDER_API_BASE: `${base}/v1`,
          GITHUB_API_URL: `${base}/github`,
          RENDER_API_KEY: LLAVE,
          RENDER_SERVICE_ID: 'srv-prueba',
          GITHUB_TOKEN: TOKEN,
          GITHUB_REPOSITORY: 'Joseamica/avoqado-server',
          COMMIT_SHA: PROBADO,
          POLL_SECONDS: '0',
          POLL_TRIES: '4',
          CURL_MAX_TIME: '1',
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, salida: `${stdout}${stderr}` }),
    )
  })
}

describe('script render-deploy-commit-exacto.sh', () => {
  let cerrar: (() => Promise<unknown>) | undefined
  afterEach(async () => {
    await cerrar?.()
    cerrar = undefined
  })

  async function escenario(e: Escenario, env: Record<string, string> = {}) {
    const mundo = await mundoDeMentira(e)
    cerrar = mundo.cerrar
    const resultado = await correr(mundo.base, env)
    expect(resultado.salida).not.toContain(LLAVE)
    expect(resultado.salida).not.toContain(TOKEN)
    const post = mundo.peticiones.find(p => p.method === 'POST')
    return { ...resultado, peticiones: mundo.peticiones, post }
  }

  it('pide a Render el commit EXACTO y termina en verde sólo cuando ESE deploy queda LIVE', async () => {
    const r = await escenario({
      porId: [
        { status: 'build_in_progress', commit: PROBADO },
        { status: 'update_in_progress', commit: PROBADO },
        { status: 'live', commit: PROBADO },
      ],
    })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.post!.body)).toEqual({ commitId: PROBADO })
    expect(r.post!.auth).toBe(`Bearer ${LLAVE}`)
    expect(r.peticiones.some(p => p.url.includes(`/compare/${PROBADO}...main`))).toBe(true)
    const comparacion = r.peticiones.find(p => p.url.includes(`/compare/${VIVO}...`))!
    expect(comparacion.url).toContain(`/compare/${VIVO}...${PROBADO}`)
    expect(comparacion.auth).toBe(`Bearer ${TOKEN}`)
    expect(r.peticiones.filter(p => p.url.endsWith('/deploys/dep-1'))).toHaveLength(3)
  })

  it('A y B seguidos con B rojo: A (probado y más nuevo que lo LIVE) sí sale aunque main ya tenga B', async () => {
    // El script no mira la punta de main: sólo que lo probado sea más nuevo que lo que está LIVE.
    const r = await escenario({ porId: [{ status: 'live', commit: PROBADO }] })
    expect(r.code).toBe(0)
    expect(r.post).toBeDefined()
  })

  it('nunca hacia atrás: si producción ya tiene un commit más nuevo, no despliega (re-correr una corrida vieja)', async () => {
    const r = await escenario({ comparar: { code: 200, status: 'behind' } })
    expect(r.code).toBe(0)
    expect(r.post).toBeUndefined()
    expect(r.salida).toContain('nunca se despliega hacia atrás')
  })

  it('si ese commit ya está LIVE no vuelve a desplegarlo', async () => {
    const r = await escenario({ previos: vivoEn(PROBADO) })
    expect(r.code).toBe(0)
    expect(r.post).toBeUndefined()
    expect(r.peticiones.some(p => p.url.includes(`/compare/${VIVO}...`))).toBe(false)
    expect(r.salida).toContain('ya está LIVE')
  })

  it.each([
    ['GitHub dice que las ramas divergieron', { comparar: { code: 200, status: 'diverged' } }],
    ['GitHub no puede comparar', { comparar: { code: 404 } }],
    ['no hay ningún deploy LIVE', { previos: [{ id: 'dep-x', status: 'deactivated', commit: { id: OTRO } }] }],
  ])('falla cerrado si %s: no le pide nada a Render', async (_caso, e) => {
    const r = await escenario(e as Escenario)
    expect(r.code).not.toBe(0)
    expect(r.salida).toContain('❌')
    expect(r.post).toBeUndefined()
  })

  it.each([
    ['main ya no lo contiene (force-push)', { enMain: { code: 200, status: 'diverged' } }],
    ['main es más viejo que el commit', { enMain: { code: 200, status: 'behind' } }],
    ['GitHub no contesta si está en main', { enMain: { code: 500 } }],
  ])('falla cerrado si %s: no le pide nada a Render', async (_caso, e) => {
    const r = await escenario(e as Escenario)
    expect(r.code).not.toBe(0)
    expect(r.salida).toContain('no está en main')
    expect(r.post).toBeUndefined()
  })

  it('si hay un deploy en curso, espera a que termine y compara contra lo que quedó LIVE', async () => {
    const enCurso: Deploy = { id: 'dep-en-curso', status: 'build_in_progress', commit: { id: OTRO } }
    const r = await escenario({
      previosSecuencia: [
        [enCurso, ...vivoEn(VIVO)],
        [{ ...enCurso, status: 'live' }, ...vivoEn(VIVO).slice(1)],
      ],
      porId: [{ status: 'live', commit: PROBADO }],
    })
    expect(r.code).toBe(0)
    expect(r.salida).toContain('hay deploys en curso')
    // Compara contra OTRO (lo que quedó LIVE al terminar), no contra el VIVO de antes.
    expect(r.peticiones.some(p => p.url.includes(`/compare/${OTRO}...${PROBADO}`))).toBe(true)
  })

  it('regresión de Codex: la corrida de A se cayó tras pedir su deploy y re-corren C (más viejo); C no queda encima de A', async () => {
    // LIVE = L (VIVO); Render sigue construyendo A (OTRO). C (PROBADO) es más viejo que A.
    const a: Deploy = { id: 'dep-a', status: 'update_in_progress', commit: { id: OTRO } }
    const r = await escenario({
      previosSecuencia: [[a, ...vivoEn(VIVO)], [{ ...a, status: 'live' }]],
      comparar: { code: 200, status: 'behind' },
    })
    expect(r.code).toBe(0)
    expect(r.post).toBeUndefined()
    expect(r.peticiones.some(p => p.url.includes(`/compare/${OTRO}...${PROBADO}`))).toBe(true)
    expect(r.salida).toContain('nunca se despliega hacia atrás')
  })

  it('si el deploy en curso nunca termina, no pide otro encima', async () => {
    const r = await escenario({
      previos: [{ id: 'dep-eterno', status: 'pre_deploy_in_progress', commit: { id: OTRO } }, ...vivoEn(VIVO)],
    })
    expect(r.code).not.toBe(0)
    expect(r.salida).toContain('No pido otro encima')
    expect(r.post).toBeUndefined()
  })

  it('un estado desconocido de Render cuenta como «en curso», no como terminado', async () => {
    const r = await escenario({
      previos: [{ id: 'dep-raro', status: 'estado_nuevo_de_render', commit: { id: OTRO } }, ...vivoEn(VIVO)],
    })
    expect(r.code).not.toBe(0)
    expect(r.post).toBeUndefined()
  })

  it('falla cerrado con un SHA corto: no consulta nada', async () => {
    const r = await escenario({}, { COMMIT_SHA: 'abc1234' })
    expect(r.code).not.toBe(0)
    expect(r.peticiones).toHaveLength(0)
  })

  it('falla si Render rechaza la petición (antes se ignoraba el código de respuesta)', async () => {
    const r = await escenario({ post: { code: 401, body: { message: 'Unauthorized' } } })
    expect(r.code).not.toBe(0)
    expect(r.salida).toContain('HTTP 401')
    expect(r.salida).toContain('Unauthorized')
    expect(r.peticiones.filter(p => p.url.includes('/deploys/'))).toHaveLength(0)
  })

  it('falla si Render responde 201 sin id: no puede seguir el deploy', async () => {
    const r = await escenario({ post: { code: 201, body: { status: 'created' } } })
    expect(r.code).not.toBe(0)
    expect(r.salida).toContain('sin id')
  })

  it('falla si Render acepta el deploy pero con OTRO commit', async () => {
    const r = await escenario({ post: { code: 201, body: { id: 'dep-1', commit: { id: OTRO } } } })
    expect(r.code).not.toBe(0)
    expect(r.salida).toContain('OTRO commit')
  })

  it.each(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'])(
    'falla si el deploy termina en %s',
    async estado => {
      const r = await escenario({ porId: [{ status: estado, commit: PROBADO }] })
      expect(r.code).not.toBe(0)
      expect(r.salida).toContain(`terminó en: ${estado}`)
    },
  )

  it('falla si el deploy queda LIVE con otro commit', async () => {
    const r = await escenario({ porId: [{ status: 'live', commit: OTRO }] })
    expect(r.code).not.toBe(0)
    expect(r.salida).toContain('OTRO commit')
  })

  it('si Render deja de contestar, cada consulta se corta y el deploy falla en vez de colgarse', async () => {
    const r = await escenario({ colgarConsultas: true }, { POLL_TRIES: '2' })
    expect(r.code).not.toBe(0)
    expect(r.salida).toContain('status=http_000')
  })

  it('falla al agotar las consultas sin quedar LIVE', async () => {
    const r = await escenario({ porId: [{ status: 'build_in_progress', commit: PROBADO }] })
    expect(r.code).not.toBe(0)
    expect(r.peticiones.filter(p => p.url.endsWith('/deploys/dep-1'))).toHaveLength(4)
  })

  describe('Render lo deja en fila (202, sin id)', () => {
    const viejoDelMismoCommit: Deploy = { id: 'dep-mismo-viejo', status: 'live', commit: { id: PROBADO } }

    it('lo encuentra entre los deploys NUEVOS de ese commit y confirma LIVE leyéndolo por su id', async () => {
      const previos = [...vivoEn(VIVO), { ...viejoDelMismoCommit, status: 'deactivated' }]
      const r = await escenario({
        previos,
        post: { code: 202 },
        listaTrasPost: [previos, [{ id: 'dep-2', status: 'queued', commit: { id: PROBADO } }, ...previos]],
        porId: [{ status: 'live', commit: PROBADO }],
      })
      expect(r.code).toBe(0)
      expect(r.peticiones.some(p => p.url.endsWith('/deploys/dep-2'))).toBe(true)
      expect(r.peticiones.some(p => p.url.endsWith('/deploys/dep-mismo-viejo'))).toBe(false)
    })

    it('un deploy que ya existía del mismo commit (aunque esté LIVE en la lista) no cuenta como el nuevo', async () => {
      const previos = [...vivoEn(VIVO), { ...viejoDelMismoCommit, status: 'deactivated' }]
      const r = await escenario({
        previos,
        post: { code: 202 },
        listaTrasPost: [[viejoDelMismoCommit, ...vivoEn(VIVO)]],
      })
      expect(r.code).not.toBe(0)
      expect(r.salida).not.toContain('✅')
    })

    it('si aparecen DOS deploys nuevos del mismo commit, falla en vez de adivinar', async () => {
      const r = await escenario({
        post: { code: 202 },
        listaTrasPost: [
          [
            { id: 'dep-2', status: 'queued', commit: { id: PROBADO } },
            { id: 'dep-3', status: 'queued', commit: { id: PROBADO } },
            ...vivoEn(VIVO),
          ],
        ],
      })
      expect(r.code).not.toBe(0)
      expect(r.salida).toContain('no sé cuál es el mío')
    })
  })
})
