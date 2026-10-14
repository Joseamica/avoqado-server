/*
  tests/api-tests/dashboard/customer-display.api.test.ts

  La CAPA HTTP de la pantalla del cliente, de punta a punta: arranca el Express real y le pega a las rutas con supertest.

  🔴 Existe porque una prueba ESTÁTICA de permisos demuestra que alguien escribió el nombre correcto en el archivo de
  rutas, NO que un cajero reciba un 403. Esto ejercita authenticateToken → checkPermission → validateRequest →
  controlador, y en la subida la cadena del spec §5.4:

    autenticar → pertenecer al negocio → amarrar la terminal (404/422) → permiso (403) → forma (400)
      → plan, sólo slides (403) → multer (el ÚNICO paso que lee el archivo) → controlador

  Los servicios se simulan: aquí se prueba la capa HTTP. El aislamiento por negocio del servicio (una terminal ajena es
  un 404 idéntico al de una inexistente) se prueba contra la base en las pruebas de la Task 5.
*/
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../../src/config/session', () => {
  const noop = (_req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))

// 🔴 Un ESPÍA sobre el lector de archivos: «el servicio no se llamó» no demuestra que multer no leyó el archivo.
const lecturasDeArchivo = jest.fn()
jest.mock('multer', () => {
  const real = jest.requireActual('multer')
  const envuelto = (opciones: unknown) => {
    const instancia = real(opciones)
    const single = instancia.single.bind(instancia)
    instancia.single = (campo: string) => {
      const mw = single(campo)
      return (req: any, res: any, next: any) => {
        lecturasDeArchivo()
        return mw(req, res, next)
      }
    }
    return instancia
  }
  return Object.assign(envuelto, real)
})

jest.mock('../../../src/services/customer-display/customerDisplayDesign.service', () => ({
  __esModule: true,
  getCustomerDisplayForDashboard: jest.fn(),
  previewCustomerDisplay: jest.fn(),
  saveCustomerDisplayDesign: jest.fn(),
  resetCustomerDisplayDesign: jest.fn(),
  copyCustomerDisplayDesign: jest.fn(),
  listCustomerDisplayDevices: jest.fn(),
}))
jest.mock('../../../src/services/customer-display/customerDisplayAsset.service', () => ({
  __esModule: true,
  authorizeAssetTerminal: jest.fn(),
  authorizeAssetPlan: jest.fn(),
  uploadCustomerDisplayAsset: jest.fn(),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue, type MirrorTokenRoleOptions } from '@tests/__helpers__/venueRoleMock'
import { ForbiddenError, NotFoundError } from '@/errors/AppError'
import { MAX_ASSET_BYTES } from '@/services/customer-display/customerDisplayDesign.validation'
import logger from '@/config/logger'

const app = require('../../../src/app').default
const servicio = require('../../../src/services/customer-display/customerDisplayDesign.service')
const activos = require('../../../src/services/customer-display/customerDisplayAsset.service')

const DASH = '/api/v1/dashboard'
const VENUE = 'clvenuecdisplay00000001'
const OTRO_VENUE = 'clvenuecdisplay00000002'
const TERMINAL = 'clterminalcdisplay00001'
const RUTA = `${DASH}/venues/${VENUE}/terminals/${TERMINAL}/customer-display`
const LISTA = `${DASH}/venues/${VENUE}/customer-display/devices`
const PNG = require('fs').readFileSync(require('path').join(__dirname, '../../fixtures/customer-display/imagen-1280x720.png'))

function token(role: string, venueDelToken: string = VENUE, opciones?: MirrorTokenRoleOptions) {
  mirrorTokenRoleOnStaffVenue(role, venueDelToken, opciones)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: venueDelToken, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}
const como = (role: string, venueDelToken?: string, opciones?: MirrorTokenRoleOptions) => ({
  get: (url: string) =>
    request(app)
      .get(url)
      .set('Authorization', `Bearer ${token(role, venueDelToken, opciones)}`),
  put: (url: string) =>
    request(app)
      .put(url)
      .set('Authorization', `Bearer ${token(role, venueDelToken, opciones)}`),
  post: (url: string) =>
    request(app)
      .post(url)
      .set('Authorization', `Bearer ${token(role, venueDelToken, opciones)}`),
})

beforeEach(() => {
  jest.clearAllMocks()
  // `mockReset` y no sólo `clearAllMocks`: un `…Once` que una prueba dejó sin consumir sobrevive a `clearAllMocks` y
  // contesta en la prueba siguiente.
  for (const simulado of [...Object.values(servicio), ...Object.values(activos)]) if (jest.isMockFunction(simulado)) simulado.mockReset()
  // checkPermission determinista: sin bypass de SUPERADMIN ni overrides personalizados.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  servicio.getCustomerDisplayForDashboard.mockResolvedValue({ editToken: 'factory' })
  servicio.saveCustomerDisplayDesign.mockResolvedValue({ editToken: 'd1:1' })
  servicio.resetCustomerDisplayDesign.mockResolvedValue({ editToken: 'd1:2' })
  servicio.copyCustomerDisplayDesign.mockResolvedValue({ copied: [], promosOmitted: false })
  servicio.listCustomerDisplayDevices.mockResolvedValue({ devices: [], total: 0, nextCursor: null })
  activos.authorizeAssetTerminal.mockResolvedValue(undefined)
  activos.authorizeAssetPlan.mockResolvedValue(undefined)
  activos.uploadCustomerDisplayAsset.mockResolvedValue({ assetId: 'a1', url: 'u', sha256: 's', width: 1280, height: 720 })
})

describe('permisos de verdad', () => {
  it('sin token, 401 — y no 404, que filtraría si el id existe', async () => {
    expect((await request(app).get(RUTA)).status).toBe(401)
  })

  it.each([['CASHIER'], ['WAITER']])('%s recibe 403 en la LECTURA y no llega al servicio', async rol => {
    expect((await como(rol).get(RUTA)).status).toBe(403)
    expect(servicio.getCustomerDisplayForDashboard).not.toHaveBeenCalled()
  })

  it.each([['MANAGER'], ['ADMIN'], ['OWNER']])('%s lee (200) — decisión del founder: el local personaliza su pantalla', async rol => {
    expect((await como(rol).get(RUTA)).status).toBe(200)
    expect(servicio.getCustomerDisplayForDashboard).toHaveBeenCalledWith(VENUE, TERMINAL)
  })

  it('MANAGER también GUARDA (200): personalizar la pantalla es trabajo del local, no administración fiscal', async () => {
    const res = await como('MANAGER')
      .put(RUTA)
      .send({ expectedEditToken: 'factory', design: { welcomeText: 'Hola' } })
    expect(res.status).toBe(200)
    expect(servicio.saveCustomerDisplayDesign).toHaveBeenCalledTimes(1)
  })

  // Con una LISTA PROPIA (PermissionSet), que REEMPLAZA los permisos del rol: un gerente al que sólo se le dejó leer. (Un
  // `VenueRolePermission` no serviría aquí: SUMA a los del rol, y MANAGER ya trae `customer-display:*`.)
  it('leer NO alcanza para escribir: una lista propia con sólo `customer-display:read` lee (200) y recibe 403 en el PUT', async () => {
    const soloLeer = { permissionSet: { id: 'ps-solo-leer', permissions: ['customer-display:read'] } }
    expect((await como('MANAGER', VENUE, soloLeer).get(RUTA)).status).toBe(200)
    const res = await como('MANAGER', VENUE, soloLeer).put(RUTA).send({ expectedEditToken: 'factory', design: {} })
    expect(res.status).toBe(403)
    expect(servicio.saveCustomerDisplayDesign).not.toHaveBeenCalled()
  })

  // C7: el servicio está simulado, así que esto sólo demuestra que el 404 del servicio llega como 404 al navegador. Que
  // una terminal ajena sea indistinguible de una inexistente se prueba contra la base en las pruebas de la Task 5.
  it('un 404 del servicio sale tal cual como 404 (el mapeo de errores, no el aislamiento)', async () => {
    servicio.getCustomerDisplayForDashboard.mockRejectedValueOnce(new NotFoundError('Dispositivo no encontrado'))
    expect((await como('OWNER').get(RUTA)).status).toBe(404)
  })
})

describe('la forma del cuerpo', () => {
  it('el PUT exige `expectedEditToken`: sin él, 400 y nada llega al servicio', async () => {
    expect(
      (
        await como('OWNER')
          .put(RUTA)
          .send({ design: { welcomeText: 'Hola' } })
      ).status,
    ).toBe(400)
    expect(servicio.saveCustomerDisplayDesign).not.toHaveBeenCalled()
  })

  it('el venue sale SIEMPRE de la URL: un `venueId` en el cuerpo se descarta', async () => {
    await como('OWNER')
      .put(RUTA)
      .send({ expectedEditToken: 'factory', design: { welcomeText: 'Hola' }, venueId: 'otro' })
    const [args] = servicio.saveCustomerDisplayDesign.mock.calls[0]
    expect(args.venueId).toBe(VENUE)
    expect(args.terminalId).toBe(TERMINAL)
    expect(args.staffId).toBe('user_test')
    expect(args.draft).toEqual({ welcomeText: 'Hola' })
  })

  // El `.strict()` vive DENTRO del borrador: la llave desconocida tiene que ir ahí para probarlo (P2-10).
  it('una llave desconocida DENTRO del borrador es 400 (no se ignora en silencio)', async () => {
    const res = await como('OWNER')
      .put(RUTA)
      .send({ expectedEditToken: 'factory', design: { welcomeText: 'Hola', venueId: 'otro' } })
    expect(res.status).toBe(400)
    expect(servicio.saveCustomerDisplayDesign).not.toHaveBeenCalled()
  })

  it('la vista previa exige su número de petición y lo pasa tal cual', async () => {
    servicio.previewCustomerDisplay.mockResolvedValue({ ficha: {}, assetRejected: [], previewSeq: 4 })
    expect((await como('OWNER').post(`${RUTA}/preview`).send({ design: {} })).status).toBe(400)
    await como('OWNER').post(`${RUTA}/preview`).send({ design: {}, previewSeq: 4 })
    expect(servicio.previewCustomerDisplay).toHaveBeenCalledWith(VENUE, TERMINAL, {}, 4)
  })

  it('restablecer exige el token de edición y lo pasa con el venue de la URL', async () => {
    expect((await como('OWNER').post(`${RUTA}/reset`).send({})).status).toBe(400)
    const res = await como('OWNER').post(`${RUTA}/reset`).send({ expectedEditToken: 'd1:1' })
    expect(res.status).toBe(200)
    expect(servicio.resetCustomerDisplayDesign).toHaveBeenCalledWith({
      venueId: VENUE,
      terminalId: TERMINAL,
      expectedEditToken: 'd1:1',
      staffId: 'user_test',
    })
  })

  it('copiar exige entre 1 y 20 destinos', async () => {
    const targets = Array.from({ length: 21 }, (_, i) => ({ terminalId: `t${i}`, editToken: 'factory' }))
    expect(
      (
        await como('OWNER')
          .post(`${RUTA}/copy`)
          .send({ source: { terminalId: TERMINAL, editToken: 'factory' }, targets })
      ).status,
    ).toBe(400)
    expect(servicio.copyCustomerDisplayDesign).not.toHaveBeenCalled()
  })

  it('copiar desde un origen que NO es el dispositivo de la ruta: 400 SOURCE_MISMATCH y nada llega al servicio', async () => {
    const res = await como('OWNER')
      .post(`${RUTA}/copy`)
      .send({ source: { terminalId: 'otra-terminal', editToken: 'factory' }, targets: [{ terminalId: 't1', editToken: 'factory' }] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('SOURCE_MISMATCH')
    expect(servicio.copyCustomerDisplayDesign).not.toHaveBeenCalled()
  })
})

describe('🔴 la subida: TODO se decide antes de leer el archivo (spec §5.4, P1-1)', () => {
  const subir = (rol: string, kind: string, venueDelToken?: string) =>
    como(rol, venueDelToken).post(`${RUTA}/assets?kind=${kind}`).attach('file', PNG, 'x.png')

  it('alguien que NO trabaja en el negocio recibe 403 sin que se consulte la terminal: ajena e inexistente dan lo mismo', async () => {
    // Si la terminal se amarrara antes de saber si pertenece al negocio, un extraño distinguiría «no existe» (404) de
    // «existe en ese negocio» (403): el oráculo que la regla del 404 idéntico prohíbe.
    const existe = await subir('OWNER', 'logo', OTRO_VENUE)
    activos.authorizeAssetTerminal.mockRejectedValue(new NotFoundError('Dispositivo no encontrado'))
    const noExiste = await subir('OWNER', 'logo', OTRO_VENUE)

    expect(existe.status).toBe(403)
    expect(noExiste.status).toBe(403)
    expect(noExiste.body).toEqual(existe.body)
    expect(activos.authorizeAssetTerminal).not.toHaveBeenCalled()
    expect(lecturasDeArchivo).not.toHaveBeenCalled()
  })

  // R6: la terminal se amarra ANTES del permiso. Un cajero del negocio recibe 404 por una terminal ajena o inexistente…
  it('un CASHIER con una terminal ajena o inexistente recibe 404 — la terminal va antes del permiso — y el archivo NO se lee', async () => {
    activos.authorizeAssetTerminal.mockRejectedValueOnce(new NotFoundError('Dispositivo no encontrado'))
    const res = await subir('CASHIER', 'slide')
    expect(res.status).toBe(404)
    expect(activos.authorizeAssetTerminal).toHaveBeenCalledWith({ venueId: VENUE, terminalId: TERMINAL })
    expect(activos.authorizeAssetPlan).not.toHaveBeenCalled()
    expect(lecturasDeArchivo).not.toHaveBeenCalled()
  })

  // …y 403 por una terminal propia: el permiso corre después de amarrarla, y el plan ni se consulta.
  it('un CASHIER con una terminal PROPIA recibe 403 y el archivo NO se lee', async () => {
    const res = await subir('CASHIER', 'slide')
    expect(res.status).toBe(403)
    expect(activos.authorizeAssetTerminal).toHaveBeenCalledWith({ venueId: VENUE, terminalId: TERMINAL })
    expect(activos.authorizeAssetPlan).not.toHaveBeenCalled()
    expect(lecturasDeArchivo).not.toHaveBeenCalled()
  })

  it('sin plan PRO, una slide recibe 403 FEATURE_REQUIRES_PRO y el archivo NO se lee', async () => {
    activos.authorizeAssetPlan.mockRejectedValueOnce(
      new ForbiddenError('Las promociones en reposo son del plan PRO.', 'FEATURE_REQUIRES_PRO'),
    )
    const res = await subir('OWNER', 'slide')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FEATURE_REQUIRES_PRO')
    expect(activos.authorizeAssetTerminal).toHaveBeenCalledWith({ venueId: VENUE, terminalId: TERMINAL })
    expect(activos.authorizeAssetPlan).toHaveBeenCalledWith({ venueId: VENUE, kind: 'SLIDE' })
    expect(lecturasDeArchivo).not.toHaveBeenCalled()
  })

  it('una terminal ajena recibe 404 y el archivo NO se lee', async () => {
    activos.authorizeAssetTerminal.mockRejectedValueOnce(new NotFoundError('Dispositivo no encontrado'))
    expect((await subir('OWNER', 'logo')).status).toBe(404)
    expect(lecturasDeArchivo).not.toHaveBeenCalled()
  })

  it('autorizado: el archivo se lee UNA vez y llega al servicio con la terminal de la URL', async () => {
    const res = await subir('OWNER', 'logo')
    expect(res.status).toBe(201)
    expect(lecturasDeArchivo).toHaveBeenCalledTimes(1)
    expect(activos.uploadCustomerDisplayAsset).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: VENUE, terminalId: TERMINAL, kind: 'LOGO', staffId: 'user_test', buffer: expect.any(Buffer) }),
    )
  })

  // C9: UNA sola traducción del `kind` de la consulta; el candado del plan y el servicio no pueden recibir tipos distintos.
  it('el candado del plan y el servicio reciben el MISMO tipo', async () => {
    expect((await subir('OWNER', 'slide')).status).toBe(201)
    expect(activos.authorizeAssetPlan).toHaveBeenCalledWith({ venueId: VENUE, kind: 'SLIDE' })
    expect(activos.uploadCustomerDisplayAsset).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SLIDE' }))
  })

  it('`kind` sólo puede ser slide o logo: 400, sin consultar el plan ni leer el archivo', async () => {
    expect((await subir('OWNER', 'otra')).status).toBe(400)
    expect(activos.authorizeAssetPlan).not.toHaveBeenCalled()
    expect(lecturasDeArchivo).not.toHaveBeenCalled()
  })

  it('sin archivo: 400 ASSET_MISSING y nada llega al servicio', async () => {
    const res = await como('OWNER').post(`${RUTA}/assets?kind=logo`).send()
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('ASSET_MISSING')
    expect(activos.uploadCustomerDisplayAsset).not.toHaveBeenCalled()
  })

  it('un archivo de más de 5 MB lo corta multer: 422 CUSTOMER_DISPLAY_UPLOAD_INVALID y nada llega al servicio', async () => {
    const gordo = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])
    const res = await como('OWNER').post(`${RUTA}/assets?kind=logo`).attach('file', gordo, 'x.png')
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('CUSTOMER_DISPLAY_UPLOAD_INVALID')
    expect(activos.uploadCustomerDisplayAsset).not.toHaveBeenCalled()
  })

  // Hallazgo menor 3: el tope de la ruta y el del servicio son el MISMO número (un solo módulo puro). Se fija por los dos
  // lados: un archivo de EXACTAMENTE el tope pasa la ruta y llega al servicio; uno de un byte más lo corta multer.
  it('el tope de la ruta es MAX_ASSET_BYTES: exactamente el tope llega al servicio; un byte más, 422', async () => {
    const justo = Buffer.alloc(MAX_ASSET_BYTES, 1)
    expect((await como('OWNER').post(`${RUTA}/assets?kind=logo`).attach('file', justo, 'x.png')).status).toBe(201)
    expect(activos.uploadCustomerDisplayAsset).toHaveBeenCalledWith(expect.objectContaining({ buffer: expect.any(Buffer) }))
    expect(activos.uploadCustomerDisplayAsset.mock.calls[0][0].buffer.length).toBe(MAX_ASSET_BYTES)

    activos.uploadCustomerDisplayAsset.mockClear()
    const uno = await como('OWNER')
      .post(`${RUTA}/assets?kind=logo`)
      .attach('file', Buffer.alloc(MAX_ASSET_BYTES + 1, 1), 'x.png')
    expect(uno.status).toBe(422)
    expect(uno.body.code).toBe('CUSTOMER_DISPLAY_UPLOAD_INVALID')
    expect(activos.uploadCustomerDisplayAsset).not.toHaveBeenCalled()
  })

  // Codex 14-oct (P2): `limits` topaba el archivo pero dejaba ilimitada la CANTIDAD de campos de texto, que multer acumula
  // en memoria (`req.body`); la ruta no usa ninguno (`kind` va en la query). Una subida válida que además trae campos de
  // texto es 422 y el servicio de subida no se llama.
  it('🔴 una subida válida que además trae campos de texto es 422 LIMIT_FIELD_COUNT: los campos no se acumulan en memoria', async () => {
    const res = await como('OWNER')
      .post(`${RUTA}/assets?kind=logo`)
      .attach('file', PNG, 'x.png')
      .field('relleno1', 'a'.repeat(512 * 1024))
      .field('relleno2', 'a'.repeat(512 * 1024))
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('CUSTOMER_DISPLAY_UPLOAD_INVALID')
    expect(res.body.details).toEqual({ multerCode: 'LIMIT_FIELD_COUNT' })
    expect(activos.uploadCustomerDisplayAsset).not.toHaveBeenCalled()
  })

  // Hallazgo menor 5: un multipart ROTO no es un MulterError sino un error de busboy; antes caía al manejador global como
  // 500. Es una entrada mal formada del cliente, igual que un archivo de más: 422 con el mismo código.
  it.each([
    ['sin límite (boundary) en el encabezado', 'multipart/form-data', 'cualquier cosa'],
    [
      'el formulario se corta a la mitad',
      'multipart/form-data; boundary=avq',
      '--avq\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\nabc',
    ],
  ])('un multipart roto (%s) es 422 CUSTOMER_DISPLAY_UPLOAD_INVALID, nunca 500', async (_caso, tipo, cuerpo) => {
    const res = await como('OWNER').post(`${RUTA}/assets?kind=logo`).set('Content-Type', tipo).send(cuerpo)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('CUSTOMER_DISPLAY_UPLOAD_INVALID')
    expect(activos.uploadCustomerDisplayAsset).not.toHaveBeenCalled()
  })

  // M4: el error original de un multipart roto se perdía por completo (no era un MulterError, así que no llevaba
  // `multerCode`). Ahora se registra ANTES de responder — la respuesta 422 al cliente no cambia en absoluto.
  it('M4: un multipart roto (sin boundary) se registra con logger.warn y el 422 no expone el error original', async () => {
    const res = await como('OWNER').post(`${RUTA}/assets?kind=logo`).set('Content-Type', 'multipart/form-data').send('cualquier cosa')

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('CUSTOMER_DISPLAY_UPLOAD_INVALID')
    expect(res.body).not.toHaveProperty('details')
    expect(res.body).not.toHaveProperty('multerCode')

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('CUSTOMER_DISPLAY_UPLOAD_INVALID'),
      expect.objectContaining({ errorMessage: expect.any(String) }),
    )
  })
})

describe('la lista de dispositivos', () => {
  it('pedir 500 llega al servicio TOPADO en 50 (política única: se topa, no se rechaza)', async () => {
    expect((await como('OWNER').get(`${LISTA}?take=500`)).status).toBe(200)
    expect(servicio.listCustomerDisplayDevices).toHaveBeenCalledWith(expect.objectContaining({ venueId: VENUE, take: 50 }))
  })

  it('sin `take` pide 25, y el cursor llega tal cual', async () => {
    expect((await como('MANAGER').get(`${LISTA}?cursor=clterminalcdisplay00009`)).status).toBe(200)
    expect(servicio.listCustomerDisplayDevices).toHaveBeenCalledWith({ venueId: VENUE, cursor: 'clterminalcdisplay00009', take: 25 })
  })

  it('un CASHIER no ve la lista', async () => {
    expect((await como('CASHIER').get(LISTA)).status).toBe(403)
    expect(servicio.listCustomerDisplayDevices).not.toHaveBeenCalled()
  })
})
