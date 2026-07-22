export interface StaffAwareReservationSettings {
  scheduling: { capacityMode: string }
  publicBooking: { showStaffPicker: boolean }
}

export function isStaffAware(settings: StaffAwareReservationSettings): boolean {
  return settings.scheduling.capacityMode === 'per_staff' || settings.publicBooking.showStaffPicker === true
}
