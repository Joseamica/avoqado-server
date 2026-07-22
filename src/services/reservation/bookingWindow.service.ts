import { ValidationError } from '@/errors/AppError'

export interface BookingWindowSettings {
  maxAdvanceDays?: number | null
  minNoticeMin?: number | null
}

/** Enforces booking lead/advance policy against a caller-supplied authority clock. */
export function enforceBookingWindow(startsAt: Date, scheduling?: BookingWindowSettings, checkedAt: Date = new Date(Date.now())): void {
  if (!scheduling) return

  const startMs = startsAt.getTime()
  const checkedAtMs = checkedAt.getTime()
  const maxAdvanceDays = scheduling.maxAdvanceDays
  if (maxAdvanceDays !== null && maxAdvanceDays !== undefined && maxAdvanceDays > 0) {
    const latestAllowed = checkedAtMs + maxAdvanceDays * 24 * 60 * 60 * 1000
    if (startMs > latestAllowed) {
      throw new ValidationError(`No puedes reservar con tanta anticipación. Máximo ${maxAdvanceDays} días.`)
    }
  }

  const minNoticeMin = scheduling.minNoticeMin
  if (minNoticeMin !== null && minNoticeMin !== undefined && minNoticeMin > 0) {
    const earliestAllowed = checkedAtMs + minNoticeMin * 60 * 1000
    if (startMs < earliestAllowed) {
      throw new ValidationError(`Esta reservación requiere al menos ${minNoticeMin} minutos de anticipación.`)
    }
  }
}
