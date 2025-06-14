//src/services/posSync/posSync.service.ts
import { processPosAreaEvent } from './posSyncArea.service'
import { processPosOrderEvent } from './posSyncOrder.service'
import { processPosShiftEvent } from './posSyncShift.service' // getOrCreatePosShift is not directly used here anymore
import { posSyncStaffService } from './posSyncStaff.service'

// Exportamos un objeto con todos los manejadores de eventos del POS
export const posSyncService = {
  processPosOrderEvent, // Imported from posSyncOrder.service.ts
  processPosStaffEvent: posSyncStaffService.processPosStaffEvent,
  processPosShiftEvent, // Imported from posSyncShift.service.ts
  processPosAreaEvent, // Imported from posSyncArea.service.ts
  // aquí irían: processPosPaymentEvent, etc.
}
