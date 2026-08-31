import { randomUUID } from 'crypto'
import { Prisma, TerminalStatus, TerminalType } from '@prisma/client'
import { z } from 'zod'
import { ForbiddenError, NotFoundError } from '@/errors/AppError'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import prisma from '@/utils/prismaClient'

export const DISPLAY_MODE_REQUEST_TTL_MS = 15 * 60 * 1000

export type DisplayModeRequestStatus = 'PENDING' | 'APPLIED' | 'REJECTED' | 'SUPERSEDED' | 'CANCELLED' | 'EXPIRED'

export type DisplayModeResultCode =
  | 'DISPLAY_NOT_PRESENT'
  | 'DISPLAY_NOT_INVERTIBLE'
  | 'APPLY_FAILED'
  | 'LOCAL_OVERRIDE'
  | 'CANCEL_TOO_LATE'
  | 'ACK_AFTER_EXPIRY'
  | 'DEVICE_RETIRED'

export interface DisplayModeRequestRecord {
  requestId: string
  desiredInverted: boolean
  status: DisplayModeRequestStatus
  requestedAt: string
  requestedBy: string
  expiresAt: string
  resolvedAt?: string
  resultCode?: DisplayModeResultCode
}

export type DisplayModeRequestErrorCode =
  | 'DISPLAY_MODE_CONFLICT'
  | 'DEVICE_REQUEST_SUPERSEDED'
  | 'DEVICE_RETIRED'
  | 'DISPLAY_MODE_INVALID_INPUT'
  | 'DISPLAY_MODE_INVALID_TRANSITION'

export class DisplayModeRequestError extends Error {
  constructor(
    public readonly code: DisplayModeRequestErrorCode,
    message: string,
    public readonly statusCode: 409 | 422 = 409,
  ) {
    super(message)
    this.name = 'DisplayModeRequestError'
  }
}

const isoDateString = z.string().datetime({ offset: true })
const displayModeRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    desiredInverted: z.boolean(),
    status: z.enum(['PENDING', 'APPLIED', 'REJECTED', 'SUPERSEDED', 'CANCELLED', 'EXPIRED']),
    requestedAt: isoDateString,
    requestedBy: z.string().trim().min(1).max(128),
    expiresAt: isoDateString,
    resolvedAt: isoDateString.optional(),
    resultCode: z
      .enum([
        'DISPLAY_NOT_PRESENT',
        'DISPLAY_NOT_INVERTIBLE',
        'APPLY_FAILED',
        'LOCAL_OVERRIDE',
        'CANCEL_TOO_LATE',
        'ACK_AFTER_EXPIRY',
        'DEVICE_RETIRED',
      ])
      .optional(),
  })
  .strict()

export function parseDisplayModeRequest(value: unknown): DisplayModeRequestRecord | null {
  const parsed = displayModeRequestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

interface TransitionAudit {
  action: 'DISPLAY_MODE_REQUESTED' | 'DISPLAY_MODE_RESOLVED' | 'DISPLAY_MODE_EXPIRED'
  data: Prisma.InputJsonObject
}

export interface DisplayModeWriteTransition {
  kind: 'WRITE'
  nextRequest: DisplayModeRequestRecord | null
  nextExpiresAt: Date | null
  confirmedPhysicalValue?: boolean
  audit: TransitionAudit
  postCommitErrorCode?: 'DEVICE_REQUEST_SUPERSEDED'
  physicalOnly?: boolean
}

export interface DisplayModeNoopTransition {
  kind: 'NOOP'
  request: DisplayModeRequestRecord | null
  disposition: 'IDEMPOTENT' | 'TOO_LATE' | 'NOT_DUE' | 'NOT_PENDING'
  resultCode?: DisplayModeResultCode
}

export type DisplayModeTransition = DisplayModeWriteTransition | DisplayModeNoopTransition

function resolvedAuditData(record: DisplayModeRequestRecord, now: Date): Prisma.InputJsonObject {
  return {
    requestId: record.requestId,
    status: record.status,
    requestedAt: record.requestedAt,
    resolvedAt: record.resolvedAt ?? now.toISOString(),
    latencyMs: Math.max(0, now.getTime() - new Date(record.requestedAt).getTime()),
    ...(record.resultCode ? { resultCode: record.resultCode } : {}),
  }
}

export function decideCreateDisplayModeRequest(input: {
  current: DisplayModeRequestRecord | null
  terminalStatus: TerminalStatus
  currentPhysicalValue: boolean
  desiredInverted: boolean
  requestedBy: string
  requestId: string
  now: Date
}): DisplayModeWriteTransition {
  if (input.terminalStatus === TerminalStatus.RETIRED) {
    throw new DisplayModeRequestError('DEVICE_RETIRED', 'Este dispositivo está retirado y no acepta solicitudes nuevas.')
  }

  const requestedAt = input.now.toISOString()
  const nextRequest: DisplayModeRequestRecord = {
    requestId: input.requestId,
    desiredInverted: input.desiredInverted,
    status: 'PENDING',
    requestedAt,
    requestedBy: input.requestedBy,
    expiresAt: new Date(input.now.getTime() + DISPLAY_MODE_REQUEST_TTL_MS).toISOString(),
  }
  const auditData: Prisma.InputJsonObject = {
    requestId: nextRequest.requestId,
    status: nextRequest.status,
    requestedAt,
    ...(input.current?.status === 'PENDING'
      ? {
          supersededRequestId: input.current.requestId,
          supersededStatus: 'SUPERSEDED',
        }
      : {}),
  }

  return {
    kind: 'WRITE',
    nextRequest,
    nextExpiresAt: new Date(nextRequest.expiresAt),
    audit: { action: 'DISPLAY_MODE_REQUESTED', data: auditData },
  }
}

export function decideCancelDisplayModeRequest(input: {
  current: DisplayModeRequestRecord | null
  requestId: string
  now: Date
}): DisplayModeTransition {
  if (!input.current || input.current.requestId !== input.requestId) {
    throw new DisplayModeRequestError('DEVICE_REQUEST_SUPERSEDED', 'La solicitud ya no es la vigente para este dispositivo.')
  }

  if (input.current.status !== 'PENDING') {
    return {
      kind: 'NOOP',
      request: input.current,
      disposition: 'TOO_LATE',
      ...(input.current.status === 'APPLIED' ? { resultCode: 'CANCEL_TOO_LATE' as const } : {}),
    }
  }

  const nextRequest: DisplayModeRequestRecord = {
    ...input.current,
    status: 'CANCELLED',
    resolvedAt: input.now.toISOString(),
  }
  return {
    kind: 'WRITE',
    nextRequest,
    nextExpiresAt: null,
    audit: { action: 'DISPLAY_MODE_RESOLVED', data: resolvedAuditData(nextRequest, input.now) },
  }
}

export type DisplayModeAckOutcome = 'APPLIED' | 'REJECTED'
export type DisplayModeAckResultCode =
  | 'DISPLAY_NOT_PRESENT'
  | 'DISPLAY_NOT_INVERTIBLE'
  | 'APPLY_FAILED'
  | 'LOCAL_OVERRIDE'
  | 'DEVICE_RETIRED'

const DISPLAY_MODE_ACK_RESULT_CODES = new Set<DisplayModeAckResultCode>([
  'DISPLAY_NOT_PRESENT',
  'DISPLAY_NOT_INVERTIBLE',
  'APPLY_FAILED',
  'LOCAL_OVERRIDE',
  'DEVICE_RETIRED',
])

export function decideAcknowledgeDisplayModeRequest(input: {
  current: DisplayModeRequestRecord | null
  requestId: string
  outcome: DisplayModeAckOutcome
  resultCode?: DisplayModeAckResultCode
  confirmedInverted?: boolean
  now: Date
}): DisplayModeTransition {
  if (!input.current || input.current.requestId !== input.requestId) {
    const updatesPhysicalState = input.outcome === 'APPLIED' || (input.outcome === 'REJECTED' && input.resultCode === 'LOCAL_OVERRIDE')
    if (!updatesPhysicalState) {
      throw new DisplayModeRequestError('DEVICE_REQUEST_SUPERSEDED', 'La solicitud ya fue reemplazada por otra más reciente.')
    }

    return {
      kind: 'WRITE',
      nextRequest: input.current,
      nextExpiresAt: input.current?.status === 'PENDING' ? new Date(input.current.expiresAt) : null,
      confirmedPhysicalValue: input.confirmedInverted,
      audit: {
        action: 'DISPLAY_MODE_RESOLVED',
        data: {
          requestId: input.requestId,
          status: 'SUPERSEDED',
          resolvedAt: input.now.toISOString(),
        },
      },
      postCommitErrorCode: 'DEVICE_REQUEST_SUPERSEDED',
      physicalOnly: true,
    }
  }

  if (
    (input.current.status === 'APPLIED' && input.outcome === 'APPLIED') ||
    (input.current.status === 'REJECTED' && input.outcome === 'REJECTED' && input.current.resultCode === input.resultCode)
  ) {
    return { kind: 'NOOP', request: input.current, disposition: 'IDEMPOTENT' }
  }

  let status: 'APPLIED' | 'REJECTED'
  let resultCode: DisplayModeResultCode | undefined
  let confirmedPhysicalValue: boolean | undefined

  if (input.current.status === 'PENDING') {
    status = input.outcome
    const expiredBeforeAck = new Date(input.current.expiresAt).getTime() <= input.now.getTime()
    resultCode = input.outcome === 'REJECTED' ? input.resultCode : expiredBeforeAck ? 'ACK_AFTER_EXPIRY' : undefined
    confirmedPhysicalValue = input.outcome === 'APPLIED' || input.resultCode === 'LOCAL_OVERRIDE' ? input.confirmedInverted : undefined
  } else if (input.current.status === 'EXPIRED' && input.outcome === 'APPLIED') {
    status = 'APPLIED'
    resultCode = 'ACK_AFTER_EXPIRY'
    confirmedPhysicalValue = input.confirmedInverted
  } else if (input.current.status === 'CANCELLED' && input.outcome === 'APPLIED') {
    status = 'APPLIED'
    resultCode = 'CANCEL_TOO_LATE'
    confirmedPhysicalValue = input.confirmedInverted
  } else {
    throw new DisplayModeRequestError(
      'DISPLAY_MODE_INVALID_TRANSITION',
      `No se puede acusar ${input.outcome} desde ${input.current.status}.`,
    )
  }

  const nextRequest: DisplayModeRequestRecord = {
    requestId: input.current.requestId,
    desiredInverted: input.current.desiredInverted,
    status,
    requestedAt: input.current.requestedAt,
    requestedBy: input.current.requestedBy,
    expiresAt: input.current.expiresAt,
    resolvedAt: input.now.toISOString(),
    ...(resultCode ? { resultCode } : {}),
  }
  return {
    kind: 'WRITE',
    nextRequest,
    nextExpiresAt: null,
    ...(confirmedPhysicalValue === undefined ? {} : { confirmedPhysicalValue }),
    audit: { action: 'DISPLAY_MODE_RESOLVED', data: resolvedAuditData(nextRequest, input.now) },
  }
}

export function decideExpireDisplayModeRequest(input: { current: DisplayModeRequestRecord | null; now: Date }): DisplayModeTransition {
  if (!input.current || input.current.status !== 'PENDING') {
    return { kind: 'NOOP', request: input.current, disposition: 'NOT_PENDING' }
  }
  if (new Date(input.current.expiresAt).getTime() > input.now.getTime()) {
    return { kind: 'NOOP', request: input.current, disposition: 'NOT_DUE' }
  }

  const nextRequest: DisplayModeRequestRecord = {
    ...input.current,
    status: 'EXPIRED',
    resolvedAt: input.now.toISOString(),
  }
  return {
    kind: 'WRITE',
    nextRequest,
    nextExpiresAt: null,
    audit: { action: 'DISPLAY_MODE_EXPIRED', data: resolvedAuditData(nextRequest, input.now) },
  }
}

const DISPLAY_MODE_TERMINAL_SELECT = {
  id: true,
  venueId: true,
  status: true,
  customerDisplayRequest: true,
  customerDisplayRequestVersion: true,
  customerDisplayRequestExpiresAt: true,
  customerDisplayInverted: true,
} satisfies Prisma.TerminalSelect

type DisplayModeTerminalSnapshot = Prisma.TerminalGetPayload<{ select: typeof DISPLAY_MODE_TERMINAL_SELECT }>

export interface DisplayModeMutationResult {
  mutated: boolean
  version: number
  request: DisplayModeRequestRecord | null
  customerDisplayInverted: boolean
  previousCustomerDisplayInverted?: boolean
  disposition?: DisplayModeNoopTransition['disposition']
  resultCode?: DisplayModeResultCode
}

export interface DisplayModeDeviceBinding {
  deviceUid: string
  type: typeof TerminalType.POS_ANDROID
}

class DisplayModeCasLostError extends Error {
  constructor() {
    super('display-mode CAS lost')
    this.name = 'DisplayModeCasLostError'
  }
}

function validateNow(value: Date | undefined): Date {
  const now = value ?? new Date()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DisplayModeRequestError('DISPLAY_MODE_INVALID_INPUT', 'La fecha de la operación no es válida.', 422)
  }
  return now
}

function requireBoundedId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 128) {
    throw new DisplayModeRequestError('DISPLAY_MODE_INVALID_INPUT', `${field} no es válido.`, 422)
  }
  return value.trim()
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DisplayModeRequestError('DISPLAY_MODE_INVALID_INPUT', `${field} debe ser booleano.`, 422)
  }
  return value
}

function validateDeviceBinding(binding: DisplayModeDeviceBinding | undefined): DisplayModeDeviceBinding | undefined {
  if (!binding) return undefined
  const deviceUid = requireBoundedId(binding.deviceUid, 'deviceUid')
  if (deviceUid.length > 64 || binding.type !== TerminalType.POS_ANDROID) {
    throw new DisplayModeRequestError('DISPLAY_MODE_INVALID_INPUT', 'El vínculo técnico del dispositivo no es válido.', 422)
  }
  return { deviceUid, type: TerminalType.POS_ANDROID }
}

function validateAckInput(input: {
  outcome: DisplayModeAckOutcome
  resultCode?: DisplayModeAckResultCode
  confirmedInverted?: boolean
}): void {
  if (input.outcome !== 'APPLIED' && input.outcome !== 'REJECTED') {
    throw new DisplayModeRequestError('DISPLAY_MODE_INVALID_INPUT', 'outcome no es válido.', 422)
  }
  if (input.outcome === 'APPLIED') {
    requireBoolean(input.confirmedInverted, 'confirmedInverted')
    if (input.resultCode !== undefined) {
      throw new DisplayModeRequestError('DISPLAY_MODE_INVALID_INPUT', 'APPLIED no acepta resultCode del cliente.', 422)
    }
    return
  }
  if (!input.resultCode) {
    throw new DisplayModeRequestError('DISPLAY_MODE_INVALID_INPUT', 'REJECTED requiere resultCode.', 422)
  }
  if (!DISPLAY_MODE_ACK_RESULT_CODES.has(input.resultCode)) {
    throw new DisplayModeRequestError('DISPLAY_MODE_INVALID_INPUT', 'resultCode no es válido.', 422)
  }
  if (input.confirmedInverted !== undefined) requireBoolean(input.confirmedInverted, 'confirmedInverted')
  if (input.resultCode === 'LOCAL_OVERRIDE') requireBoolean(input.confirmedInverted, 'confirmedInverted')
}

function toStoredRequest(record: DisplayModeRequestRecord): Prisma.InputJsonObject {
  return {
    requestId: record.requestId,
    desiredInverted: record.desiredInverted,
    status: record.status,
    requestedAt: record.requestedAt,
    requestedBy: record.requestedBy,
    expiresAt: record.expiresAt,
    ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
    ...(record.resultCode ? { resultCode: record.resultCode } : {}),
  }
}

async function readTerminalSnapshot(
  venueId: string,
  terminalId: string,
  binding?: DisplayModeDeviceBinding,
): Promise<DisplayModeTerminalSnapshot> {
  const terminal = await prisma.terminal.findFirst({
    where: { id: terminalId, venueId, ...(binding ?? {}) },
    select: DISPLAY_MODE_TERMINAL_SELECT,
  })
  if (!terminal && binding) {
    throw new ForbiddenError('El dispositivo no corresponde a esta terminal.', 'DEVICE_BINDING_MISMATCH')
  }
  if (!terminal) throw new NotFoundError('Dispositivo no encontrado.', 'DEVICE_NOT_FOUND')
  return terminal
}

async function runAuditedCasTransition(input: {
  venueId: string
  terminalId: string
  binding?: DisplayModeDeviceBinding
  auditStaffId?: string
  rejectRetiredAtWrite?: boolean
  decide: (snapshot: DisplayModeTerminalSnapshot, current: DisplayModeRequestRecord | null) => DisplayModeTransition
}): Promise<DisplayModeMutationResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await readTerminalSnapshot(input.venueId, input.terminalId, input.binding)
    const current = parseDisplayModeRequest(snapshot.customerDisplayRequest)
    const transition = input.decide(snapshot, current)

    if (transition.kind === 'NOOP') {
      return {
        mutated: false,
        version: snapshot.customerDisplayRequestVersion,
        request: transition.request,
        customerDisplayInverted: snapshot.customerDisplayInverted,
        disposition: transition.disposition,
        ...(transition.resultCode ? { resultCode: transition.resultCode } : {}),
      }
    }

    try {
      await prisma.$transaction(async tx => {
        const data: Prisma.TerminalUpdateManyMutationInput = transition.physicalOnly
          ? { customerDisplayInverted: transition.confirmedPhysicalValue }
          : {
              customerDisplayRequestVersion: { increment: 1 },
              ...(transition.confirmedPhysicalValue === undefined ? {} : { customerDisplayInverted: transition.confirmedPhysicalValue }),
            }
        if (!transition.physicalOnly) {
          data.customerDisplayRequest = transition.nextRequest ? toStoredRequest(transition.nextRequest) : Prisma.DbNull
          data.customerDisplayRequestExpiresAt = transition.nextExpiresAt
        }

        const update = await tx.terminal.updateMany({
          where: {
            id: input.terminalId,
            venueId: input.venueId,
            ...(input.binding ?? {}),
            customerDisplayRequestVersion: snapshot.customerDisplayRequestVersion,
            ...(input.rejectRetiredAtWrite ? { status: { not: TerminalStatus.RETIRED } } : {}),
          },
          data,
        })
        if (update.count !== 1) throw new DisplayModeCasLostError()

        await writeLegacyActivityAuditTx(tx, {
          staffId: input.auditStaffId ?? null,
          venueId: input.venueId,
          action: transition.audit.action,
          entity: 'Terminal',
          entityId: input.terminalId,
          data: transition.audit.data,
        })
      })
    } catch (error) {
      if (!(error instanceof DisplayModeCasLostError)) throw error
      if (attempt === 0) continue
      throw new DisplayModeRequestError(
        'DISPLAY_MODE_CONFLICT',
        'Otro cambio ganó la carrera. Consulta el estado vigente e intenta de nuevo.',
      )
    }

    const nextPhysical = transition.confirmedPhysicalValue ?? snapshot.customerDisplayInverted
    if (transition.postCommitErrorCode === 'DEVICE_REQUEST_SUPERSEDED') {
      throw new DisplayModeRequestError(
        'DEVICE_REQUEST_SUPERSEDED',
        'La solicitud ya fue reemplazada; el estado físico se registró sin tocar la solicitud vigente.',
      )
    }
    return {
      mutated: true,
      version: snapshot.customerDisplayRequestVersion + (transition.physicalOnly ? 0 : 1),
      request: transition.nextRequest,
      customerDisplayInverted: nextPhysical,
    }
  }

  throw new DisplayModeRequestError('DISPLAY_MODE_CONFLICT', 'No fue posible actualizar la solicitud vigente.')
}

export async function createDisplayModeRequest(input: {
  venueId: string
  terminalId: string
  desiredInverted: boolean
  requestedBy: string
  now?: Date
}): Promise<DisplayModeMutationResult> {
  const venueId = requireBoundedId(input.venueId, 'venueId')
  const terminalId = requireBoundedId(input.terminalId, 'terminalId')
  const requestedBy = requireBoundedId(input.requestedBy, 'requestedBy')
  const desiredInverted = requireBoolean(input.desiredInverted, 'desiredInverted')
  const now = validateNow(input.now)
  const requestId = randomUUID()

  return runAuditedCasTransition({
    venueId,
    terminalId,
    auditStaffId: requestedBy,
    rejectRetiredAtWrite: true,
    decide: (snapshot, current) =>
      decideCreateDisplayModeRequest({
        current,
        terminalStatus: snapshot.status,
        currentPhysicalValue: snapshot.customerDisplayInverted,
        desiredInverted,
        requestedBy,
        requestId,
        now,
      }),
  })
}

export async function cancelDisplayModeRequest(input: {
  venueId: string
  terminalId: string
  requestId: string
  cancelledBy: string
  now?: Date
}): Promise<DisplayModeMutationResult> {
  const venueId = requireBoundedId(input.venueId, 'venueId')
  const terminalId = requireBoundedId(input.terminalId, 'terminalId')
  const requestId = requireBoundedId(input.requestId, 'requestId')
  const cancelledBy = requireBoundedId(input.cancelledBy, 'cancelledBy')
  const now = validateNow(input.now)

  return runAuditedCasTransition({
    venueId,
    terminalId,
    auditStaffId: cancelledBy,
    decide: (_snapshot, current) => decideCancelDisplayModeRequest({ current, requestId, now }),
  })
}

export async function acknowledgeDisplayModeRequest(input: {
  venueId: string
  terminalId: string
  requestId: string
  outcome: DisplayModeAckOutcome
  resultCode?: DisplayModeAckResultCode
  confirmedInverted?: boolean
  binding?: DisplayModeDeviceBinding
  now?: Date
}): Promise<DisplayModeMutationResult> {
  const venueId = requireBoundedId(input.venueId, 'venueId')
  const terminalId = requireBoundedId(input.terminalId, 'terminalId')
  const requestId = requireBoundedId(input.requestId, 'requestId')
  const binding = validateDeviceBinding(input.binding)
  validateAckInput(input)
  const now = validateNow(input.now)

  return runAuditedCasTransition({
    venueId,
    terminalId,
    binding,
    decide: (_snapshot, current) =>
      decideAcknowledgeDisplayModeRequest({
        current,
        requestId,
        outcome: input.outcome,
        resultCode: input.resultCode,
        confirmedInverted: input.confirmedInverted,
        now,
      }),
  })
}

export async function expireDisplayModeRequest(input: {
  venueId: string
  terminalId: string
  now?: Date
}): Promise<DisplayModeMutationResult> {
  const venueId = requireBoundedId(input.venueId, 'venueId')
  const terminalId = requireBoundedId(input.terminalId, 'terminalId')
  const now = validateNow(input.now)

  return runAuditedCasTransition({
    venueId,
    terminalId,
    decide: (_snapshot, current) => decideExpireDisplayModeRequest({ current, now }),
  })
}

export async function updateLocalDisplayMode(input: {
  venueId: string
  terminalId: string
  confirmedInverted: boolean
  binding?: DisplayModeDeviceBinding
}): Promise<DisplayModeMutationResult> {
  const venueId = requireBoundedId(input.venueId, 'venueId')
  const terminalId = requireBoundedId(input.terminalId, 'terminalId')
  const confirmedInverted = requireBoolean(input.confirmedInverted, 'confirmedInverted')
  const binding = validateDeviceBinding(input.binding)

  const snapshot = await readTerminalSnapshot(venueId, terminalId, binding)

  const update = await prisma.terminal.updateMany({
    where: { id: terminalId, venueId, ...(binding ?? {}) },
    data: { customerDisplayInverted: confirmedInverted },
  })
  if (update.count !== 1 && binding) {
    throw new ForbiddenError('El dispositivo no corresponde a esta terminal.', 'DEVICE_BINDING_MISMATCH')
  }
  if (update.count !== 1) throw new NotFoundError('Dispositivo no encontrado.', 'DEVICE_NOT_FOUND')

  return {
    mutated: true,
    version: snapshot.customerDisplayRequestVersion,
    request: parseDisplayModeRequest(snapshot.customerDisplayRequest),
    customerDisplayInverted: confirmedInverted,
    previousCustomerDisplayInverted: snapshot.customerDisplayInverted,
  }
}
