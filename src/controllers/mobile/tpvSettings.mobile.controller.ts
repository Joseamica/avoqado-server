/**
 * Mobile TPV Settings Controller
 *
 * Combined endpoint that returns venue terminals + merged settings
 * for the first active terminal in a single request.
 *
 * Replaces two dashboard calls:
 *   GET /dashboard/venues/:venueId/tpvs
 *   GET /dashboard/tpv/:tpvId/settings
 */

import { TerminalStatus, TerminalType } from '@prisma/client'
import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import { type DeviceReceiptPayload, getDeviceReceiptPayloadWithStatus } from '../../services/dashboard/receiptLayout/devicePayload.service'
import AppError, { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { VenuePlanInfo, getVenuePlanInfo } from '../../services/access/basePlan.service'
import { TpvSettings, getTpvSettings, updateTpvSettings } from '../../services/dashboard/tpv.dashboard.service'
import { assertSettingsConfigurable, resolveConfigurableSettings } from '../../services/device-capabilities.service'
import { logAction } from '../../services/dashboard/activity-log.service'
import type { UpdateDisplayModeInput, UpdateTerminalSettingsInput } from '../../schemas/mobile/tpvSettings.mobile.schema'
import {
  DisplayModeRequestError,
  acknowledgeDisplayModeRequest,
  parseDisplayModeRequest,
  updateLocalDisplayMode,
} from '../../services/display-mode-request.service'
import {
  ESTADOS_DE_FUENTE_PROPIA,
  ORDEN_DEL_RESPALDO,
  POLL_TERMINAL_SELECT,
  capabilityReportRequested,
  collectPollFingerprints,
  type PollFingerprints,
} from '../../services/customer-display/posPollFingerprints'
import { customerDisplayBlockFor, readSettingsFingerprint } from '../../services/customer-display/settingsEnvelope.service'
import { CUSTOMER_DISPLAY_DESIGN_CAPABILITY } from '../../services/customer-display/customerDisplayDesign.validation'
import { requestDeviceUid } from '../../utils/requestDeviceUid'

function requireRequestDeviceUid(req: Request): string {
  const deviceUid = requestDeviceUid(req)
  if (!deviceUid) throw new BadRequestError('X-Device-ID es requerido', 'DEVICE_ID_REQUIRED')
  return deviceUid
}

function mapDisplayModeRequestError(error: unknown): unknown {
  if (!(error instanceof DisplayModeRequestError)) return error
  return new AppError(error.message, error.statusCode, true, error.code)
}

/**
 * Get venue terminals and merged settings for the requesting device's terminal
 * (with the first active terminal retained as a legacy fallback),
 * plus the venue's plan-tier info (optional `plan` field) so POS apps can
 * gate UI by plan.
 * @route GET /api/v1/mobile/venues/:venueId/settings
 */
export const getVenueTpvSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const deviceUid = requestDeviceUid(req)

    // 0. 🔴 ORDEN DE LECTURA (spec §5.7.4, hallazgo D5): la huella PRIMERO, el cuerpo DESPUÉS — por eso NO va en el
    //    `Promise.all` de abajo. Si alguien escribe en medio, el cuerpo sale más nuevo que la huella (un refresco de más,
    //    inofensivo); al revés se confirmaría una versión que nunca se entregó. Nunca lanza (Codex r1 #8).
    const huella = await readSettingsFingerprint(venueId, deviceUid)

    // 1. Fetch all terminals (lightweight fields + config for merge), in parallel with the
    //    venue's plan-tier info (additive `plan` field — POS apps gate UI by plan).
    //    RESILIENT: a plan-lookup failure must NEVER break venue-select on the POS — log it
    //    and return the settings WITHOUT the plan field (apps fail open).
    const [terminals, plan, venueSettingsLeido, recibo, pantalla] = await Promise.all([
      prisma.terminal.findMany({
        where: { venueId },
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          serialNumber: true,
          brand: true,
          model: true,
          lastHeartbeat: true,
          config: true,
          configOverrides: true,
          assignedMerchantIds: true,
          preferredProcessor: true,
          activatedAt: true,
          deviceUid: true,
          fulfillmentAreaId: true,
          canIssueAreaTickets: true,
          canCheckoutAreaTickets: true,
          canDeliverAreaTickets: true,
          defaultWorkspace: true,
          customerDisplayInverted: true,
        },
        // `id` desempata (R11): «la primera activa» del cuerpo es la MISMA fila que lee la huella aunque dos terminales
        // se llamen igual — el orden de LA regla de la Task 7, no una copia.
        orderBy: ORDEN_DEL_RESPALDO,
      }),
      getVenuePlanInfo(venueId).catch((error): VenuePlanInfo | undefined => {
        logger.error('Failed to resolve plan info for mobile venue settings — returning settings without plan', { venueId, error })
        return undefined
      }),
      // Dónde pinta el POS el panel de promociones. Es preferencia de LAYOUT del
      // venue (VenueSettings), no configuración de terminal — por eso va en su
      // propio bloque y no dentro de `settings`, que es TpvSettings por terminal.
      // «No hay fila» (los defaults son la verdad: `ok`) NO es lo mismo que «la lectura falló» (`failed`).
      prisma.venueSettings
        .findUnique({
          where: { venueId },
          select: { promotionsPanelCashier: true, promotionsPanelCustomer: true, managerPinOverrideEnabled: true },
        })
        .then(
          fila => ({ ok: true as const, fila }),
          error => {
            logger.error('Failed to resolve venue-level POS settings — returning defaults', { venueId, error })
            return { ok: false as const, fila: null }
          },
        ),
      // Encabezado Y DISEÑO del ticket impreso (spec § 7.3). Un solo constructor compartido
      // con el servicio de la PAX: si cada uno armara lo suyo, las tablets y la terminal
      // imprimirían distinto y los casos dorados NO lo cazarían. Falla en blando: si algo no
      // se resuelve, el campo se omite y los settings salen igual — un POS sin settings no cobra.
      getDeviceReceiptPayloadWithStatus(venueId).catch(error => {
        logger.error('Failed to resolve receipt payload for mobile venue settings — returning settings without it', { venueId, error })
        return { payload: {} as DeviceReceiptPayload, status: 'failed' as const }
      }),
      // Con `bindingStatus`: «no pude saberlo» sale `failed`, no `not_applicable` (Codex r1 #8). Nunca lanza.
      customerDisplayBlockFor(venueId, huella),
    ])
    const venueSettings = venueSettingsLeido.fila

    // 2. Prefer the terminal that made this request. A venue can have an area
    //    station, a checkout and a café terminal at the same time; choosing the
    //    first active row would leak one device's workspace/settings into another.
    //    Headerless legacy clients keep the previous first-active fallback.
    // POS Android devices can be marked INACTIVE by terminal-health liveness even
    // while authenticated mobile requests keep updating their lastHeartbeat.
    // Status is not the identity or permission boundary here: the exact deviceUid,
    // staff permissions and the downstream feature endpoints are. Still exclude
    // terminals that have not been activated, are in maintenance or were retired.
    // LA regla de la Task 7 (`ESTADOS_DE_FUENTE_PROPIA`), no una copia: la huella y el cuerpo eligen la MISMA fuente.
    const deviceTerminal = deviceUid
      ? (terminals.find(t => ESTADOS_DE_FUENTE_PROPIA.includes(t.status) && t.deviceUid === deviceUid) ?? null)
      : null
    const activeTerminal = deviceTerminal ?? terminals.find(t => t.status === TerminalStatus.ACTIVE) ?? null

    // 3. If there is an active terminal, get its merged settings
    let settings: TpvSettings | null = null
    if (activeTerminal) {
      // Acotado al venue de la ruta: la terminal salió de la lista de ESTE venue, pero una
      // reasignación entre las dos lecturas no puede entregar ajustes de otro negocio.
      settings = await getTpvSettings(activeTerminal.id, { venueId })
    }

    // 4. Strip private/internal fields from the terminal list. Per-device area
    //    capabilities are returned separately below so Android never has to infer
    //    its identity from a venue-wide list.
    const terminalList = terminals.map(
      ({
        config,
        configOverrides,
        deviceUid: _deviceUid,
        fulfillmentAreaId: _fulfillmentAreaId,
        canIssueAreaTickets: _canIssueAreaTickets,
        canCheckoutAreaTickets: _canCheckoutAreaTickets,
        canDeliverAreaTickets: _canDeliverAreaTickets,
        defaultWorkspace: _defaultWorkspace,
        customerDisplayInverted: _customerDisplayInverted,
        ...rest
      }) => rest,
    )

    // 5. `plan` is ADDITIVE and OPTIONAL (omitted when the lookup failed) — existing fields
    //    must never be removed/renamed (old app versions depend on them).
    return res.json({
      success: true,
      data: {
        terminals: terminalList,
        settings,
        activeTerminalId: activeTerminal?.id ?? null,
        deviceTerminal: deviceTerminal
          ? {
              id: deviceTerminal.id,
              defaultWorkspace: deviceTerminal.defaultWorkspace,
              canIssueAreaTickets: deviceTerminal.canIssueAreaTickets,
              canCheckoutAreaTickets: deviceTerminal.canCheckoutAreaTickets,
              canDeliverAreaTickets: deviceTerminal.canDeliverAreaTickets,
              fulfillmentAreaId: deviceTerminal.fulfillmentAreaId,
              customerDisplayInverted: deviceTerminal.customerDisplayInverted,
              // Qué ajustes puede cambiar ESTE aparato desde su propia pantalla de Configuración.
              // Viaja aquí para que las apps NO lleven la lista codificada: el día que un tipo de
              // aparato gane o pierda un ajuste, no hay que recompilar ni publicar un APK.
              // Aditivo y opcional (mismo contrato que `plan`): un POS viejo lo ignora.
              configurableSettings: resolveConfigurableSettings(deviceTerminal.type),
            }
          : null,
        ...(plan ? { plan } : {}),
        // Aditivo y opcional (mismo contrato que `plan`): un POS viejo lo
        // ignora, uno nuevo sin este campo cae a estos mismos defaults.
        promotions: {
          panelCashier: venueSettings?.promotionsPanelCashier ?? 'TAB',
          panelCustomer: venueSettings?.promotionsPanelCustomer ?? 'SIDE_PANEL',
        },
        // PIN de autorización de gerente. Aditivo y opcional (mismo contrato que
        // `plan`): un POS viejo lo ignora; uno nuevo sin el campo cae a false, que
        // es el comportamiento de hoy. Es de VENUE, no de terminal — por eso vive
        // aquí y no dentro de `settings`.
        managerPinOverrideEnabled: venueSettings?.managerPinOverrideEnabled ?? false,
        // Encabezado y diseño del ticket (aditivo y opcional, mismo contrato que `plan`):
        // un POS viejo los ignora. `receiptInfo` conserva EXACTAMENTE sus campos de siempre
        // y suma los emisores por venta; `receiptLayout` es nuevo (spec § 7.3).
        ...recibo.payload,
        // — Pantalla del cliente (spec §5.7.2, §5.7.4): aditivo y opcional; lo de arriba sale idéntico. —
        ...(huella.fingerprint ? { fingerprints: { settings: huella.fingerprint } } : {}),
        // `failed` = «conserva lo que tenías»; `not_applicable` = «no esperes este bloque». Ausente ≠ null.
        componentsStatus: {
          receipt: recibo.status,
          plan: plan ? 'ok' : 'failed',
          promotionsPanel: venueSettingsLeido.ok ? 'ok' : 'failed', // cubre también managerPinOverrideEnabled (misma fila)
          customerDisplay: pantalla.status,
        },
        ...(pantalla.block ? { customerDisplay: pantalla.block } : {}),
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Entrega ligera de la intención vigente al POS Android que hizo la solicitud, y el SOBRE de la pantalla del cliente
 * (spec §5.7.2). No expira ni resuelve nada durante la lectura.
 * @route GET /api/v1/mobile/venues/:venueId/display-mode-request
 */
export const getDisplayModeRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const deviceUid = requireRequestDeviceUid(req)
    // 🔴 La BASE primero (spec §5.7.1; pendiente de F0-A): el binding exacto decide qué aparato es y de qué negocio.
    // Ninguna caché se consulta antes, y después sólo con el id que devolvió esta lectura.
    const terminal = await prisma.terminal.findFirst({
      where: { venueId, deviceUid, type: TerminalType.POS_ANDROID },
      select: POLL_TERMINAL_SELECT,
    })
    if (!terminal) throw new NotFoundError('Dispositivo POS Android no encontrado.', 'DEVICE_NOT_FOUND')

    const stored = parseDisplayModeRequest(terminal.customerDisplayRequest)
    const now = Date.now()
    const deliverable = stored?.status === 'PENDING' && new Date(stored.expiresAt).getTime() > now ? stored : null

    // Cada huella se aísla por dentro; esto es el cinturón: un fallo inesperado nunca retrasa ni tumba la entrega.
    let fingerprints: PollFingerprints = {}
    try {
      fingerprints = await collectPollFingerprints({ venueId, terminal, hasRequest: deliverable !== null })
    } catch (error) {
      logger.warn('[pantalla-del-cliente] las huellas del poll fallaron; se entrega el sobre sin ellas', {
        venueId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    res.status(200).json({
      data: {
        terminalId: terminal.id,
        request: deliverable
          ? {
              requestId: deliverable.requestId,
              desiredInverted: deliverable.desiredInverted,
              requestedAt: deliverable.requestedAt,
              expiresAt: deliverable.expiresAt,
            }
          : null,
        // — lo nuevo, aditivo y opcional (Android decodifica con ignoreUnknownKeys; iOS y la TPV no llaman esta ruta) —
        fingerprints,
        capabilities: { customerDisplayDesign: CUSTOMER_DISPLAY_DESIGN_CAPABILITY },
        capabilityReport: { requested: capabilityReportRequested(terminal) },
      },
    })
  } catch (error) {
    next(mapDisplayModeRequestError(error))
  }
}

/**
 * Set (or clear) whether THIS terminal has an inverted customer display —
 * the customer sees the big screen and the cashier works the small one.
 * Per-DEVICE (how that counter is physically wired), not per-venue. The POS
 * applies its local value and syncs it here; the dashboard can change it
 * remotely.
 * @route PATCH /api/v1/mobile/venues/:venueId/terminals/:terminalId/display-mode
 */
export const updateDisplayMode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, terminalId } = req.params
    const deviceUid = requireRequestDeviceUid(req)
    const body = req.body as UpdateDisplayModeInput
    const binding = { deviceUid, type: TerminalType.POS_ANDROID } as const

    if ('requestId' in body) {
      const result = await acknowledgeDisplayModeRequest({
        venueId,
        terminalId,
        requestId: body.requestId,
        outcome: body.outcome,
        ...('resultCode' in body ? { resultCode: body.resultCode } : {}),
        confirmedInverted: body.customerDisplayInverted,
        binding,
      })

      return res.json({
        success: true,
        data: { id: terminalId, customerDisplayInverted: result.customerDisplayInverted },
      })
    }

    const result = await updateLocalDisplayMode({
      venueId,
      terminalId,
      confirmedInverted: body.customerDisplayInverted,
      binding,
    })

    // Compatibilidad del body legacy: conserva la bitácora del actor autenticado.
    // Las transiciones con requestId ya quedan auditadas atómicamente en Task 4.
    void logAction({
      staffId: req.authContext?.userId ?? null,
      venueId,
      action: 'TERMINAL_DISPLAY_MODE_UPDATED',
      entity: 'Terminal',
      entityId: terminalId,
      data: {
        from: result.previousCustomerDisplayInverted,
        to: result.customerDisplayInverted,
      },
    })

    return res.json({
      success: true,
      data: { id: terminalId, customerDisplayInverted: result.customerDisplayInverted },
    })
  } catch (error) {
    logger.error('Error updating terminal display mode', { error })
    next(mapDisplayModeRequestError(error))
  }
}

/**
 * El POS cambia un ajuste de SU PROPIA ficha (hoy: las pantallas del cobro).
 *
 * 🔴 Tres candados, y ninguno sustituye a los otros:
 *   1. `checkPermission('tpv-settings:update')` en la ruta — QUIÉN (por defecto: dueño, administrador y gerente;
 *      el administrador desde el 15-oct-2026, decisión del founder).
 *   2. El binding `id + venueId + deviceUid` de abajo — SOBRE QUÉ: sólo la ficha de este aparato.
 *      Sin el `deviceUid`, un dueño podría reconfigurar la PAX (o la tablet del otro mostrador)
 *      desde su propia tablet, que es justo lo que la pestaña del dashboard evita mostrando sólo
 *      las terminales de cobro.
 *   3. `assertSettingsConfigurable` — QUÉ: un POS no obedece los ajustes de la PAX, así que
 *      dejárselos escribir sería guardar un interruptor que no hace nada (peor que no tenerlo).
 *
 * @route PATCH /api/v1/mobile/venues/:venueId/terminals/:terminalId/settings
 */
export const updateTerminalSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, terminalId } = req.params
    const deviceUid = requireRequestDeviceUid(req)
    const changes = req.body as UpdateTerminalSettingsInput

    const terminal = await prisma.terminal.findFirst({
      where: { id: terminalId, venueId, deviceUid },
      select: {
        id: true,
        type: true,
        customerDisplayPresent: true,
        customerDisplayInvertible: true,
        displayModeProtocolVersion: true,
        capabilitiesObservedAt: true,
      },
    })
    if (!terminal) throw new NotFoundError('Este dispositivo no está registrado en este establecimiento.', 'DEVICE_NOT_FOUND')

    assertSettingsConfigurable(terminal, Object.keys(changes))

    // 🔴 El `staffId` va en el scope, no en un `logAction` aparte: `updateTpvSettings` YA audita, y
    // escribir aquí otro renglón dejaba DOS filas por un toque —la suya anónima, la mía con el
    // detalle—. Medido en el QA del 18-sep sobre una Sunmi OrderPAD 3 real.
    const settings = await updateTpvSettings(terminalId, changes, {
      venueId,
      staffId: (req as any).authContext?.userId,
      source: 'pos',
      deviceUid,
    })

    return res.json({ success: true, data: { terminalId, settings } })
  } catch (error) {
    next(error)
  }
}
