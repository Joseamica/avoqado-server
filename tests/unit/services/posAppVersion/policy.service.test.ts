/**
 * Actualizador del POS — servicio de la política (tarea 4).
 *
 * El doble de Prisma (`tests/__helpers__/setup.ts`) llama al callback de `$transaction` con el mismo doble. Encima, aquí se
 * arma una tabla falsa en memoria (una fila por plataforma) para que `findUnique` / `findFirst` / `create` / `updateMany` /
 * `update` se comporten como Postgres: así las pruebas leen lo que el servicio escribió, no lo que la prueba le dictó.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { POLICY_CHANGED, clearPolicy, getPolicies, getPublicPolicy, setPolicy } from '@/services/posAppVersion/policy.service'

// Ids con forma de cuid v1 (25 caracteres, empiezan con «c»), como los de `@default(cuid())`.
const ACTOR = 'cmhk2actor0001staff00000a'
const POLICY_ID = 'cmhk2pol00001android0000a'
const IOS_POLICY_ID = 'cmhk2pol00002ios000000000'
const ANN_REC = 'cmhk2ann00001recomend000a'
const ANN_REQ = 'cmhk2ann00002required00a0'
const NUEVOS = ['cmhk2ann00003nuevo00000a0', 'cmhk2ann00004nuevo00000a0', 'cmhk2ann00005nuevo00000a0']

const PLAY = 'https://play.google.com/store/apps/details?id=com.avoqado.pos'
const APPLE = 'https://apps.apple.com/app/id6758351745'

type Row = Record<string, any>

let tabla: Record<string, Row>
let siguienteAnuncio: number

/** La fila de ANDROID en la revisión 3: «Bloquear» 100 y «Avisar» 102 como ventana, cada nivel con su anuncio vivo. */
function filaAndroid(over: Row = {}): Row {
  return {
    id: POLICY_ID,
    platform: 'ANDROID',
    requiredMinVersionCode: 100,
    requiredMinVersionName: '2.27.0',
    recommendedMinVersionCode: 102,
    recommendedMinVersionName: '2.27.2',
    recommendedNoticeStyle: 'MODAL',
    message: null,
    recommendedAnnouncementId: ANN_REC,
    requiredAnnouncementId: ANN_REQ,
    version: 3,
    updatedById: ACTOR,
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    ...over,
  }
}

const reqAndroid = { versionCode: 100, versionName: '2.27.0' }
const recAndroid = { versionCode: 102, versionName: '2.27.2', noticeStyle: 'MODAL' as const }

/** Aplica `data` de Prisma sobre una fila, incluido `{ increment: n }`. */
function aplicar(fila: Row, data: Row): Row {
  const nueva = { ...fila }
  for (const [k, v] of Object.entries(data)) {
    nueva[k] = v && typeof v === 'object' && 'increment' in v ? (fila[k] as number) + (v as any).increment : v
  }
  nueva.updatedAt = new Date()
  return nueva
}

function armarTablaFalsa() {
  const pol = prismaMock.posAppVersionPolicy
  for (const fn of Object.values(pol) as jest.Mock[]) fn.mockReset()
  for (const fn of Object.values(prismaMock.platformAnnouncement) as jest.Mock[]) fn.mockReset()
  prismaMock.activityLog.create.mockReset()
  prismaMock.staff.findUnique.mockReset()
  prismaMock.staff.findMany.mockReset()

  pol.findUnique.mockImplementation(async ({ where }: any) => (tabla[where.platform] ? { ...tabla[where.platform] } : null))
  pol.findFirst.mockImplementation(async ({ where }: any) => {
    const fila = tabla[where.platform]
    return fila && fila.version === where.version ? { ...fila } : null
  })
  pol.create.mockImplementation(async ({ data }: any) => {
    const fila = {
      id: data.platform === 'IOS' ? IOS_POLICY_ID : POLICY_ID,
      recommendedAnnouncementId: null,
      requiredAnnouncementId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }
    tabla[data.platform] = fila
    return { ...fila }
  })
  pol.updateMany.mockImplementation(async ({ where, data }: any) => {
    const fila = tabla[where.platform]
    if (!fila || fila.version !== where.version) return { count: 0 }
    tabla[where.platform] = aplicar(fila, data)
    return { count: 1 }
  })
  pol.update.mockImplementation(async ({ where, data }: any) => {
    tabla[where.platform] = aplicar(tabla[where.platform], data)
    return { ...tabla[where.platform] }
  })

  prismaMock.platformAnnouncement.create.mockImplementation(async () => ({ id: NUEVOS[siguienteAnuncio++] }))
  prismaMock.platformAnnouncement.update.mockImplementation(async ({ where }: any) => ({ id: where.id }))
  prismaMock.activityLog.create.mockResolvedValue({})
  prismaMock.staff.findUnique.mockResolvedValue({ firstName: 'José', lastName: 'Amieva' })
}

const prismaError = (code: string) => new Prisma.PrismaClientKnownRequestError(`Fallo ${code}`, { code, clientVersion: 'test' })

const anunciosCreados = () => prismaMock.platformAnnouncement.create.mock.calls.map((c: any[]) => c[0].data)
const archivados = () =>
  prismaMock.platformAnnouncement.update.mock.calls.filter((c: any[]) => c[0].data?.status === 'ARCHIVED').map((c: any[]) => c[0].where.id)
const asiento = () => prismaMock.activityLog.create.mock.calls[0][0].data
const conflicto = { statusCode: 409, code: 'POS_APP_VERSION_POLICY_CHANGED' }

beforeEach(() => {
  tabla = {}
  siguienteAnuncio = 0
  armarTablaFalsa()
})

afterEach(() => {
  // Un aviso de actualizar no tiene acuses, ni buzón, ni push (spec §4.7): nunca, en ninguna prueba.
  expect(prismaMock.platformAnnouncementDelivery.createMany).not.toHaveBeenCalled()
  expect(prismaMock.platformAnnouncementDelivery.create).not.toHaveBeenCalled()
  expect(prismaMock.notification.create).not.toHaveBeenCalled()
  expect(prismaMock.notification.createMany).not.toHaveBeenCalled()
})

describe('POLICY_CHANGED', () => {
  it('es el código del 409', () => {
    expect(POLICY_CHANGED).toBe('POS_APP_VERSION_POLICY_CHANGED')
  })
})

describe('setPolicy — crear (expectedVersion null)', () => {
  it('sin fila: crea con version 1 y deja el asiento SET con before null', async () => {
    const vista = await setPolicy({
      platform: 'ANDROID',
      required: reqAndroid,
      recommended: recAndroid,
      message: null,
      expectedVersion: null,
      actorId: ACTOR,
    })

    expect(prismaMock.posAppVersionPolicy.create).toHaveBeenCalledTimes(1)
    const data = prismaMock.posAppVersionPolicy.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      platform: 'ANDROID',
      version: 1,
      requiredMinVersionCode: 100,
      requiredMinVersionName: '2.27.0',
      recommendedMinVersionCode: 102,
      recommendedMinVersionName: '2.27.2',
      recommendedNoticeStyle: 'MODAL',
      message: null,
      updatedById: ACTOR,
    })
    expect(prismaMock.posAppVersionPolicy.updateMany).not.toHaveBeenCalled()

    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(asiento()).toMatchObject({
      staffId: ACTOR,
      venueId: null,
      action: 'POS_APP_VERSION_POLICY_SET',
      entity: 'PosAppVersionPolicy',
      entityId: 'ANDROID',
    })
    expect(asiento().data.before).toBeNull()
    expect(asiento().data.platform).toBe('ANDROID')
    expect(asiento().data.after).toMatchObject({ version: 1, requiredMinVersionCode: 100, recommendedMinVersionCode: 102 })

    expect(vista).toEqual({
      exists: true,
      version: 1,
      required: { versionCode: 100, versionName: '2.27.0' },
      recommended: { versionCode: 102, versionName: '2.27.2', noticeStyle: 'MODAL' },
      message: null,
      updatedAt: expect.any(String),
      updatedBy: { id: ACTOR, name: 'José Amieva' },
    })
    expect($transactionCalls()).toBe(1)
  })

  it('con fila existente: 409 y no crea ni deja asiento', async () => {
    tabla.ANDROID = filaAndroid()
    await expect(
      setPolicy({ platform: 'ANDROID', required: reqAndroid, recommended: null, message: null, expectedVersion: null, actorId: ACTOR }),
    ).rejects.toMatchObject(conflicto)
    expect(prismaMock.posAppVersionPolicy.create).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(prismaMock.platformAnnouncement.create).not.toHaveBeenCalled()
  })

  it('create rechaza con P2002 (otro la creó al mismo tiempo): 409, sin reintento', async () => {
    prismaMock.posAppVersionPolicy.create.mockRejectedValueOnce(prismaError('P2002'))
    await expect(
      setPolicy({ platform: 'ANDROID', required: reqAndroid, recommended: null, message: null, expectedVersion: null, actorId: ACTOR }),
    ).rejects.toMatchObject(conflicto)
    expect($transactionCalls()).toBe(1)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})

describe('setPolicy — cambiar (CAS por version)', () => {
  it('expectedVersion 3 con la fila 3: updateMany condicional, sube 1, y el asiento lleva el before de la fila 3', async () => {
    tabla.ANDROID = filaAndroid()
    const vista = await setPolicy({
      platform: 'ANDROID',
      required: { versionCode: 101, versionName: '2.27.1' },
      recommended: recAndroid,
      message: null,
      expectedVersion: 3,
      actorId: ACTOR,
    })

    expect(prismaMock.posAppVersionPolicy.findFirst).toHaveBeenCalledWith({ where: { platform: 'ANDROID', version: 3 } })
    expect(prismaMock.posAppVersionPolicy.updateMany).toHaveBeenCalledTimes(1)
    const arg = prismaMock.posAppVersionPolicy.updateMany.mock.calls[0][0]
    expect(arg.where).toEqual({ platform: 'ANDROID', version: 3 })
    expect(arg.data.version).toEqual({ increment: 1 })
    expect(arg.data).toMatchObject({ requiredMinVersionCode: 101, requiredMinVersionName: '2.27.1', updatedById: ACTOR })

    expect(asiento().action).toBe('POS_APP_VERSION_POLICY_SET')
    expect(asiento().data.before).toEqual({
      requiredMinVersionCode: 100,
      requiredMinVersionName: '2.27.0',
      recommendedMinVersionCode: 102,
      recommendedMinVersionName: '2.27.2',
      recommendedNoticeStyle: 'MODAL',
      message: null,
      version: 3,
    })
    expect(asiento().data.after).toMatchObject({ requiredMinVersionCode: 101, version: 4 })

    expect(vista.version).toBe(4)
    expect(vista.required).toEqual({ versionCode: 101, versionName: '2.27.1' })
  })

  it('el update de los ids de anuncio NO vuelve a subir version', async () => {
    tabla.ANDROID = filaAndroid()
    await setPolicy({
      platform: 'ANDROID',
      required: { versionCode: 101, versionName: '2.27.1' },
      recommended: recAndroid,
      message: null,
      expectedVersion: 3,
      actorId: ACTOR,
    })
    expect(prismaMock.posAppVersionPolicy.update).toHaveBeenCalledTimes(1)
    const data = prismaMock.posAppVersionPolicy.update.mock.calls[0][0].data
    expect(Object.keys(data).sort()).toEqual(['recommendedAnnouncementId', 'requiredAnnouncementId'])
    expect(tabla.ANDROID.version).toBe(4)
  })

  it('token adelantado (findFirst sin fila): 409, sin updateMany ni asiento', async () => {
    tabla.ANDROID = filaAndroid()
    await expect(
      setPolicy({ platform: 'ANDROID', required: reqAndroid, recommended: null, message: null, expectedVersion: 4, actorId: ACTOR }),
    ).rejects.toMatchObject(conflicto)
    expect(prismaMock.posAppVersionPolicy.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(prismaMock.platformAnnouncement.create).not.toHaveBeenCalled()
  })

  it('carrera perdida (findFirst con fila, updateMany count 0): 409 y sin asiento', async () => {
    tabla.ANDROID = filaAndroid()
    prismaMock.posAppVersionPolicy.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(
      setPolicy({ platform: 'ANDROID', required: reqAndroid, recommended: null, message: null, expectedVersion: 3, actorId: ACTOR }),
    ).rejects.toMatchObject(conflicto)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(prismaMock.platformAnnouncement.create).not.toHaveBeenCalled()
  })

  it('updateMany rechaza con P2034: 409 y $transaction se llamó UNA vez (nunca se reintenta)', async () => {
    tabla.ANDROID = filaAndroid()
    prismaMock.posAppVersionPolicy.updateMany.mockRejectedValueOnce(prismaError('P2034'))
    await expect(
      setPolicy({ platform: 'ANDROID', required: reqAndroid, recommended: null, message: null, expectedVersion: 3, actorId: ACTOR }),
    ).rejects.toMatchObject(conflicto)
    expect($transactionCalls()).toBe(1)
  })

  it('otro error de Prisma (P2025) sube tal cual, no es 409', async () => {
    tabla.ANDROID = filaAndroid()
    const err = prismaError('P2025')
    prismaMock.posAppVersionPolicy.updateMany.mockRejectedValueOnce(err)
    await expect(
      setPolicy({ platform: 'ANDROID', required: reqAndroid, recommended: null, message: null, expectedVersion: 3, actorId: ACTOR }),
    ).rejects.toBe(err)
  })

  it('activityLog.create rechaza: setPolicy rechaza con ese error (no hay cambio sin bitácora)', async () => {
    tabla.ANDROID = filaAndroid()
    const err = new Error('db')
    prismaMock.activityLog.create.mockRejectedValueOnce(err)
    await expect(
      setPolicy({ platform: 'ANDROID', required: reqAndroid, recommended: recAndroid, message: null, expectedVersion: 3, actorId: ACTOR }),
    ).rejects.toBe(err)
  })

  it('sin recomendada, sobre una fila que tenía MODAL: guarda recommendedNoticeStyle null', async () => {
    tabla.ANDROID = filaAndroid()
    const vista = await setPolicy({
      platform: 'ANDROID',
      required: reqAndroid,
      recommended: null,
      message: null,
      expectedVersion: 3,
      actorId: ACTOR,
    })
    const data = prismaMock.posAppVersionPolicy.updateMany.mock.calls[0][0].data
    expect(data).toMatchObject({ recommendedMinVersionCode: null, recommendedMinVersionName: null, recommendedNoticeStyle: null })
    expect(vista.recommended).toBeNull()
  })
})

describe('clearPolicy', () => {
  it('deja los cuatro niveles, el mensaje y la forma en null, sube version y asienta CLEARED', async () => {
    tabla.ANDROID = filaAndroid({ message: 'Hay mejoras de caja' })
    const vista = await clearPolicy({ platform: 'ANDROID', expectedVersion: 3, actorId: ACTOR })

    const arg = prismaMock.posAppVersionPolicy.updateMany.mock.calls[0][0]
    expect(arg.where).toEqual({ platform: 'ANDROID', version: 3 })
    expect(arg.data).toMatchObject({
      requiredMinVersionCode: null,
      requiredMinVersionName: null,
      recommendedMinVersionCode: null,
      recommendedMinVersionName: null,
      recommendedNoticeStyle: null,
      message: null,
      updatedById: ACTOR,
      version: { increment: 1 },
    })
    expect(prismaMock.posAppVersionPolicy.delete).not.toHaveBeenCalled()
    expect(prismaMock.posAppVersionPolicy.deleteMany).not.toHaveBeenCalled()

    expect(asiento()).toMatchObject({ action: 'POS_APP_VERSION_POLICY_CLEARED', entityId: 'ANDROID', venueId: null })
    expect(asiento().data.after).toMatchObject({ requiredMinVersionCode: null, recommendedMinVersionCode: null, version: 4 })
    expect(vista).toMatchObject({ exists: true, version: 4, required: null, recommended: null, message: null })
  })

  it('token viejo: 409, sin asiento', async () => {
    tabla.ANDROID = filaAndroid({ version: 5 })
    await expect(clearPolicy({ platform: 'ANDROID', expectedVersion: 3, actorId: ACTOR })).rejects.toMatchObject(conflicto)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})

describe('anuncios de actualizar (r7, §4.7)', () => {
  it('crear con «Avisar» MODAL y «Bloquear»: dos anuncios publicados, sin acuses, con el texto y la forma fijos', async () => {
    await setPolicy({
      platform: 'ANDROID',
      required: reqAndroid,
      recommended: recAndroid,
      message: null,
      expectedVersion: null,
      actorId: ACTOR,
    })

    const creados = anunciosCreados()
    expect(creados).toHaveLength(2)
    const rec = creados.find((d: Row) => d.posAppNoticeKind === 'RECOMMENDED')
    const req = creados.find((d: Row) => d.posAppNoticeKind === 'REQUIRED')

    const comunes = {
      posAppPlatform: 'ANDROID',
      status: 'PUBLISHED',
      publishedAt: expect.any(Date),
      deliveredAt: expect.any(Date),
      deliveredCount: 0,
      audienceRoles: [],
      actionLabel: 'Actualizar',
      actionUrl: PLAY,
      createdBy: ACTOR,
      createdByName: 'José Amieva · Versiones del POS',
      posAppBelowVersionName: null,
    }
    expect(rec).toMatchObject({
      ...comunes,
      title: 'Hay una versión nueva de Avoqado',
      body: 'Actualiza la app para tener lo más reciente.',
      priority: 'HIGH',
      showAsBanner: true,
      showAsModal: true,
      posAppBelowVersionCode: 102,
    })
    expect(req).toMatchObject({
      ...comunes,
      title: 'Actualiza Avoqado cuanto antes',
      body: 'Esta versión ya no debe usarse. Actualizar toma un minuto.',
      priority: 'URGENT',
      showAsBanner: true,
      showAsModal: true,
      posAppBelowVersionCode: 100,
    })
    expect(rec.createdByName.endsWith(' · Versiones del POS')).toBe(true)

    // Los ids nuevos quedan en la fila, y la bitácora dice qué se creó.
    const idRec = NUEVOS[creados.indexOf(rec)]
    const idReq = NUEVOS[creados.indexOf(req)]
    expect(prismaMock.posAppVersionPolicy.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platform: 'ANDROID' },
        data: { recommendedAnnouncementId: idRec, requiredAnnouncementId: idReq },
      }),
    )
    expect(tabla.ANDROID).toMatchObject({ recommendedAnnouncementId: idRec, requiredAnnouncementId: idReq, version: 1 })
    expect(asiento().data.announcements).toEqual({ archived: [], created: expect.arrayContaining([idRec, idReq]) })
    expect(asiento().data.announcements.created).toHaveLength(2)
    expect(archivados()).toEqual([])
  })

  it('«Avisar» como BANNER: banner sí, ventana no', async () => {
    await setPolicy({
      platform: 'ANDROID',
      required: null,
      recommended: { ...recAndroid, noticeStyle: 'BANNER' },
      message: null,
      expectedVersion: null,
      actorId: ACTOR,
    })
    const creados = anunciosCreados()
    expect(creados).toHaveLength(1)
    expect(creados[0]).toMatchObject({ posAppNoticeKind: 'RECOMMENDED', showAsBanner: true, showAsModal: false, priority: 'HIGH' })
    expect(tabla.ANDROID.requiredAnnouncementId).toBeNull()
  })

  it('el mensaje, si viene, reemplaza el cuerpo de los dos', async () => {
    await setPolicy({
      platform: 'ANDROID',
      required: reqAndroid,
      recommended: recAndroid,
      message: 'Trae el cobro dividido',
      expectedVersion: null,
      actorId: ACTOR,
    })
    for (const d of anunciosCreados()) expect(d.body).toBe('Trae el cobro dividido')
  })

  it('iOS: liga de la App Store y el umbral por nombre (sin número)', async () => {
    await setPolicy({
      platform: 'IOS',
      required: { versionCode: null, versionName: '1.16.0' },
      recommended: { versionCode: null, versionName: '1.16.2', noticeStyle: 'BANNER' },
      message: null,
      expectedVersion: null,
      actorId: ACTOR,
    })
    const creados = anunciosCreados()
    const req = creados.find((d: Row) => d.posAppNoticeKind === 'REQUIRED')
    const rec = creados.find((d: Row) => d.posAppNoticeKind === 'RECOMMENDED')
    expect(req).toMatchObject({ posAppPlatform: 'IOS', actionUrl: APPLE, posAppBelowVersionName: '1.16.0', posAppBelowVersionCode: null })
    expect(rec).toMatchObject({ posAppPlatform: 'IOS', actionUrl: APPLE, posAppBelowVersionName: '1.16.2', posAppBelowVersionCode: null })
    // «Bloquear» es ventana y banner aunque «Avisar» sea sólo banner: su forma no depende de la recomendada.
    expect(req).toMatchObject({ showAsBanner: true, showAsModal: true, priority: 'URGENT' })
    expect(rec).toMatchObject({ showAsBanner: true, showAsModal: false, priority: 'HIGH' })
    expect(asiento().entityId).toBe('IOS')
  })

  it('cambiar sólo la forma de «Avisar»: archiva su anuncio y crea otro; el de «Bloquear» queda intacto', async () => {
    tabla.ANDROID = filaAndroid()
    await setPolicy({
      platform: 'ANDROID',
      required: reqAndroid,
      recommended: { ...recAndroid, noticeStyle: 'BANNER' },
      message: null,
      expectedVersion: 3,
      actorId: ACTOR,
    })

    expect(prismaMock.platformAnnouncement.update).toHaveBeenCalledWith({ where: { id: ANN_REC }, data: { status: 'ARCHIVED' } })
    expect(archivados()).toEqual([ANN_REC])
    const creados = anunciosCreados()
    expect(creados).toHaveLength(1)
    expect(creados[0]).toMatchObject({ posAppNoticeKind: 'RECOMMENDED', showAsModal: false })
    expect(tabla.ANDROID).toMatchObject({ recommendedAnnouncementId: NUEVOS[0], requiredAnnouncementId: ANN_REQ })
    expect(asiento().data.announcements).toEqual({ archived: [ANN_REC], created: [NUEVOS[0]] })
  })

  it('cambiar sólo la obligatoria: reemplaza su anuncio y conserva el de «Avisar»', async () => {
    tabla.ANDROID = filaAndroid()
    await setPolicy({
      platform: 'ANDROID',
      required: { versionCode: 101, versionName: '2.27.0' },
      recommended: recAndroid,
      message: null,
      expectedVersion: 3,
      actorId: ACTOR,
    })
    expect(archivados()).toEqual([ANN_REQ])
    expect(anunciosCreados()).toEqual([expect.objectContaining({ posAppNoticeKind: 'REQUIRED', posAppBelowVersionCode: 101 })])
    expect(tabla.ANDROID).toMatchObject({ recommendedAnnouncementId: ANN_REC, requiredAnnouncementId: NUEVOS[0] })
  })

  it('cambiar sólo el nombre que se muestra también cuenta como cambio del nivel', async () => {
    tabla.ANDROID = filaAndroid()
    await setPolicy({
      platform: 'ANDROID',
      required: { versionCode: 100, versionName: '2.27.0-b' },
      recommended: recAndroid,
      message: null,
      expectedVersion: 3,
      actorId: ACTOR,
    })
    expect(archivados()).toEqual([ANN_REQ])
    expect(anunciosCreados()).toHaveLength(1)
  })

  it('cambiar el mensaje reemplaza los dos', async () => {
    tabla.ANDROID = filaAndroid()
    await setPolicy({
      platform: 'ANDROID',
      required: reqAndroid,
      recommended: recAndroid,
      message: 'Nueva caja',
      expectedVersion: 3,
      actorId: ACTOR,
    })
    expect(archivados().sort()).toEqual([ANN_REC, ANN_REQ].sort())
    expect(anunciosCreados()).toHaveLength(2)
  })

  it('sin cambios en ningún nivel: no archiva ni crea, y conserva los dos ids', async () => {
    tabla.ANDROID = filaAndroid()
    await setPolicy({
      platform: 'ANDROID',
      required: reqAndroid,
      recommended: recAndroid,
      message: null,
      expectedVersion: 3,
      actorId: ACTOR,
    })
    expect(prismaMock.platformAnnouncement.create).not.toHaveBeenCalled()
    expect(prismaMock.platformAnnouncement.update).not.toHaveBeenCalled()
    expect(tabla.ANDROID).toMatchObject({ recommendedAnnouncementId: ANN_REC, requiredAnnouncementId: ANN_REQ, version: 4 })
    expect(asiento().data.announcements).toEqual({ archived: [], created: [] })
  })

  it('quitar la recomendada sólo archiva su anuncio (no crea nada para ella)', async () => {
    tabla.ANDROID = filaAndroid()
    await setPolicy({ platform: 'ANDROID', required: reqAndroid, recommended: null, message: null, expectedVersion: 3, actorId: ACTOR })
    expect(archivados()).toEqual([ANN_REC])
    expect(prismaMock.platformAnnouncement.create).not.toHaveBeenCalled()
    expect(tabla.ANDROID).toMatchObject({ recommendedAnnouncementId: null, requiredAnnouncementId: ANN_REQ })
  })

  it('clearPolicy archiva los dos y deja los ids en null', async () => {
    tabla.ANDROID = filaAndroid()
    await clearPolicy({ platform: 'ANDROID', expectedVersion: 3, actorId: ACTOR })
    expect(archivados().sort()).toEqual([ANN_REC, ANN_REQ].sort())
    expect(prismaMock.platformAnnouncement.create).not.toHaveBeenCalled()
    expect(tabla.ANDROID).toMatchObject({ recommendedAnnouncementId: null, requiredAnnouncementId: null, version: 4 })
    expect(asiento().data.announcements).toEqual({ archived: expect.arrayContaining([ANN_REC, ANN_REQ]), created: [] })
  })

  it('volver a poner una mínima sobre la fila vacía crea sus anuncios', async () => {
    tabla.ANDROID = filaAndroid({
      version: 5,
      requiredMinVersionCode: null,
      requiredMinVersionName: null,
      recommendedMinVersionCode: null,
      recommendedMinVersionName: null,
      recommendedNoticeStyle: null,
      recommendedAnnouncementId: null,
      requiredAnnouncementId: null,
    })
    await setPolicy({ platform: 'ANDROID', required: reqAndroid, recommended: null, message: null, expectedVersion: 5, actorId: ACTOR })
    expect(anunciosCreados()).toEqual([
      expect.objectContaining({ posAppNoticeKind: 'REQUIRED', posAppBelowVersionCode: 100, showAsBanner: true, showAsModal: true }),
    ])
    expect(archivados()).toEqual([])
    expect(tabla.ANDROID).toMatchObject({ requiredAnnouncementId: NUEVOS[0], recommendedAnnouncementId: null, version: 6 })
  })

  it('el Master Admin (sin fila de Staff): el asiento no lleva la llave foránea y el anuncio dice quién fue', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(null)
    await setPolicy({
      platform: 'ANDROID',
      required: reqAndroid,
      recommended: null,
      message: null,
      expectedVersion: null,
      actorId: 'MASTER_ADMIN',
    })
    expect(asiento().staffId).toBeNull()
    expect(asiento().data.unknownStaffId).toBe('MASTER_ADMIN')
    expect(anunciosCreados()[0]).toMatchObject({ createdBy: 'MASTER_ADMIN', createdByName: 'Master Admin · Versiones del POS' })
  })
})

describe('getPolicies', () => {
  const vacia = {
    exists: false,
    version: null,
    required: null,
    recommended: null,
    message: null,
    updatedAt: null,
    updatedBy: null,
  }

  it('sin filas: ANDROID e iOS salen como «nunca hubo»', async () => {
    prismaMock.posAppVersionPolicy.findMany.mockResolvedValue([])
    prismaMock.staff.findMany.mockResolvedValue([])
    await expect(getPolicies()).resolves.toEqual({ ANDROID: vacia, IOS: vacia })
    expect(prismaMock.posAppVersionPolicy.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }))
  })

  it('una política vaciada (se quitó) sale con exists true y su version; la otra con sus niveles y quién la cambió', async () => {
    prismaMock.posAppVersionPolicy.findMany.mockResolvedValue([
      filaAndroid({ message: 'Hay mejoras' }),
      {
        id: IOS_POLICY_ID,
        platform: 'IOS',
        requiredMinVersionCode: null,
        requiredMinVersionName: null,
        recommendedMinVersionCode: null,
        recommendedMinVersionName: null,
        recommendedNoticeStyle: null,
        message: null,
        recommendedAnnouncementId: null,
        requiredAnnouncementId: null,
        version: 5,
        updatedById: null,
        createdAt: new Date('2026-11-01T10:00:00.000Z'),
        updatedAt: new Date('2026-11-03T10:00:00.000Z'),
      },
    ])
    prismaMock.staff.findMany.mockResolvedValue([{ id: ACTOR, firstName: 'José', lastName: 'Amieva' }])

    const r = await getPolicies()
    expect(r.IOS).toEqual({
      exists: true,
      version: 5,
      required: null,
      recommended: null,
      message: null,
      updatedAt: '2026-11-03T10:00:00.000Z',
      updatedBy: null,
    })
    expect(r.ANDROID).toEqual({
      exists: true,
      version: 3,
      required: { versionCode: 100, versionName: '2.27.0' },
      recommended: { versionCode: 102, versionName: '2.27.2', noticeStyle: 'MODAL' },
      message: 'Hay mejoras',
      updatedAt: '2026-11-02T10:00:00.000Z',
      updatedBy: { id: ACTOR, name: 'José Amieva' },
    })

    const staffArg = prismaMock.staff.findMany.mock.calls[0][0]
    expect(staffArg.where).toEqual({ id: { in: [ACTOR] } })
    expect(staffArg.select).toEqual({ id: true, firstName: true, lastName: true })
    expect(staffArg.take).toBeLessThanOrEqual(2)
  })
})

describe('getPublicPolicy', () => {
  it('sin fila: null', async () => {
    await expect(getPublicPolicy('ANDROID')).resolves.toBeNull()
  })

  it('con fila: los niveles y el mensaje en la misma lectura', async () => {
    tabla.ANDROID = filaAndroid({ message: 'Trae mejoras' })
    await expect(getPublicPolicy('ANDROID')).resolves.toEqual({
      levels: {
        required: { versionCode: 100, versionName: '2.27.0' },
        recommended: { versionCode: 102, versionName: '2.27.2' },
      },
      message: 'Trae mejoras',
    })
    expect(prismaMock.posAppVersionPolicy.findUnique).toHaveBeenCalledTimes(1)
  })

  it('política vaciada: los dos niveles en null (la app abre normal)', async () => {
    tabla.IOS = filaAndroid({
      id: IOS_POLICY_ID,
      platform: 'IOS',
      version: 5,
      requiredMinVersionCode: null,
      requiredMinVersionName: null,
      recommendedMinVersionCode: null,
      recommendedMinVersionName: null,
      recommendedNoticeStyle: null,
    })
    await expect(getPublicPolicy('IOS')).resolves.toEqual({ levels: { required: null, recommended: null }, message: null })
  })
})

function $transactionCalls(): number {
  return (prismaMock.$transaction as jest.Mock).mock.calls.length
}
