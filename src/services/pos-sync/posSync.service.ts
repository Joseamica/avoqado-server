// src/services/pos-sync/posSync.service.ts

import { processPosOrderEvent } from './posSyncOrder.service'
import { processPosOrderItemEvent } from './posSyncOrderItem.service'
import { processPosShiftEvent } from './posSyncShift.service'

import { posSyncStaffService } from './posSyncStaff.service'
import { processPosAreaEvent } from './posSyncArea.service'
import { processPosHeartbeat } from './posSyncHeartbeat.service'

// Exportamos un objeto con todos los manejadores de eventos del POS
export const posSyncService = {
  // Manejadores de datos del POS
  processPosOrderEvent,
  processPosOrderItemEvent,
  processPosShiftEvent,
  processPosAreaEvent,
  processPosStaffEvent: posSyncStaffService.processPosStaffEvent.bind(posSyncStaffService),

  // Manejador del sistema de monitoreo
  processPosHeartbeat,
}
