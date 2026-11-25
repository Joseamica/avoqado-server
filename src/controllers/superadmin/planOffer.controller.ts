/**
 * Planes editables B1 (Task 9): la oferta de los planes desde el SUPERADMIN, en /api/v1/superadmin/plan-offer. Hereda el token y el
 * rol SUPERADMIN del router padre (`superadmin.routes.ts`).
 *
 * Delgado a propósito: `zod` revisa sólo la FORMA de cada cuerpo (estricta, mensajes en español) y un error de forma responde 400
 * `PLAN_OFFER_INVALID` con `details.issues` ANTES de llamar al servicio. Las reglas (la oferta, el interruptor, los destinatarios) son
 * de los servicios, y sus errores pasan tal cual (`{ message, code, details }`) por el manejador global.
 *
 * Con el interruptor apagado (todo B1), lo que escribe responde 409 `PLAN_EDIT_DISABLED`, salvo descartar, el interruptor (que en B1
 * responde 409 `PLAN_EDIT_PREREQUISITE`) y los destinatarios.
 */
import { z } from 'zod'
import { asyncHandler } from '@/utils/asyncHandler'
import { BadRequestError } from '@/errors/AppError'
import { planOfferInput } from '@/services/billing/planOffer'
import {
  descartarPublicacion,
  estadoDeLaOferta,
  estadoDespuesDeConfirmar,
  publicarVersion,
  reintentarPublicacion,
  vistaPreviaDeLaOferta,
} from '@/services/billing/planOfferPublisher'
import { apagarPlanesEditables, estadoDelInterruptor, prenderPlanesEditables } from '@/services/billing/interruptorPlanesEditables'
import { setDestinatariosDelAlta } from '@/services/superadmin/platformSettings.service'

const errorMap: z.ZodErrorMap = () => ({ message: 'Falta este dato o no tiene el formato esperado.' })
const NO_ADMITIDO = 'Trae un campo que no se conoce.'

const cuerpoDeLaVistaPrevia = z.object({ entrada: planOfferInput }, { errorMap }).strict(NO_ADMITIDO)
const cuerpoDePublicar = z
  .object(
    {
      entrada: planOfferInput,
      // La revisión del puntero que vio quien confirmó (0 = todavía sin versiones).
      expectedRevision: z.number({ errorMap }).int('La revisión debe ser un número entero.').min(0, 'La revisión no puede ser negativa.'),
    },
    { errorMap },
  )
  .strict(NO_ADMITIDO)
const cuerpoVacio = z.object({}, { errorMap }).strict(NO_ADMITIDO)
const cuerpoDelInterruptor = z.object({ prendido: z.boolean({ errorMap }) }, { errorMap }).strict(NO_ADMITIDO)
// Sólo la forma: recortar, minúsculas, repetidos, el tope y que cada uno sea un correo los decide el servicio.
const cuerpoDeLosDestinatarios = z.object({ correos: z.array(z.string({ errorMap }), { errorMap }) }, { errorMap }).strict(NO_ADMITIDO)
const parametrosDeLaPendiente = z.object({ versionId: z.string({ errorMap }).cuid('Esa versión no existe.') }, { errorMap })

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    throw new BadRequestError(
      `Revisa lo que mandaste: ${issues.map(i => (i.path ? `${i.path}: ` : '') + i.message).join(' ')}`,
      'PLAN_OFFER_INVALID',
      { issues },
    )
  }
  return result.data
}

/** `GET /` — la vigente (con la entrada que llena el editor), la pendiente, el interruptor y los destinatarios. */
export const estado = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await estadoDeLaOferta() })
})

/** `POST /preview` — lo que publicar haría con esta `entrada`. No escribe. */
export const vistaPrevia = asyncHandler(async (req, res) => {
  const { entrada } = parse(cuerpoDeLaVistaPrevia, req.body)
  res.json({ success: true, data: await vistaPreviaDeLaOferta(entrada) })
})

/** `POST /publish` — publica exactamente esta `entrada` sobre `expectedRevision` (no hay borrador en el SERVIDOR). */
export const publicar = asyncHandler(async (req, res) => {
  const { entrada, expectedRevision } = parse(cuerpoDePublicar, req.body)
  const publicada = await publicarVersion(entrada, expectedRevision, req.authContext!.userId)
  // Ya publicada: si el estado no se puede leer, se responde el mínimo, nunca un error.
  res.json({ success: true, data: { publicada, estado: await estadoDespuesDeConfirmar('se publicó la versión', publicada.versionId) } })
})

/** `POST /pending/:versionId/retry` — retoma ESA versión pendiente; responde como publicar. */
export const reintentar = asyncHandler(async (req, res) => {
  const { versionId } = parse(parametrosDeLaPendiente, req.params)
  parse(cuerpoVacio, req.body ?? {})
  const publicada = await reintentarPublicacion(versionId, req.authContext!.userId)
  res.json({
    success: true,
    data: { publicada, estado: await estadoDespuesDeConfirmar('se reintentó la publicación', publicada.versionId) },
  })
})

/** `POST /pending/:versionId/discard` — descarta ESA versión pendiente (también con el interruptor apagado). */
export const descartar = asyncHandler(async (req, res) => {
  const { versionId } = parse(parametrosDeLaPendiente, req.params)
  parse(cuerpoVacio, req.body ?? {})
  // El estado completo o, si no se pudo leer después del descarte, el mínimo: tal cual.
  res.json({ success: true, data: await descartarPublicacion(versionId, req.authContext!.userId) })
})

/** `POST /interruptor` — prende (en B1: 409 `PLAN_EDIT_PREREQUISITE` con `faltan`) o apaga; responde el estado del interruptor. */
export const interruptor = asyncHandler(async (req, res) => {
  const { prendido } = parse(cuerpoDelInterruptor, req.body)
  if (prendido) await prenderPlanesEditables(req.authContext!.userId)
  else await apagarPlanesEditables(req.authContext!.userId)
  res.json({ success: true, data: await estadoDelInterruptor() })
})

/** `PUT /recipients` — reemplaza los destinatarios de los avisos internos; responde la lista guardada (normalizada). */
export const destinatarios = asyncHandler(async (req, res) => {
  const { correos } = parse(cuerpoDeLosDestinatarios, req.body)
  res.json({ success: true, data: { correos: await setDestinatariosDelAlta(correos, req.authContext!.userId) } })
})
