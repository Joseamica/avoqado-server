// ---------------------------------------------------------------------------
// DangerGuardService
//
// Determines the UX safety gates that must be shown before executing a
// chatbot CRUD action, based on the action's declared danger level.
// ---------------------------------------------------------------------------

export interface DangerCheckResult {
  requiresConfirmation: boolean
  requiresDoubleConfirm: boolean
  showChangeSummary: boolean
  blocked: boolean
  blockMessage?: string
}

export class DangerGuardService {
  /**
   * Returns the set of safety gates that apply for the given danger level.
   *
   * - low     → single confirmation only
   * - medium  → single confirmation + show change summary
   * - high    → double confirmation + show change summary
   * - blocked → action not available via chatbot; show block message
   */
  checkDanger(dangerLevel: 'low' | 'medium' | 'high' | 'blocked'): DangerCheckResult {
    switch (dangerLevel) {
      case 'low':
        return {
          requiresConfirmation: true,
          requiresDoubleConfirm: false,
          showChangeSummary: false,
          blocked: false,
        }

      case 'medium':
        return {
          requiresConfirmation: true,
          requiresDoubleConfirm: false,
          showChangeSummary: true,
          blocked: false,
        }

      case 'high':
        return {
          requiresConfirmation: true,
          requiresDoubleConfirm: true,
          showChangeSummary: true,
          blocked: false,
        }

      case 'blocked':
        return {
          requiresConfirmation: false,
          requiresDoubleConfirm: false,
          showChangeSummary: false,
          blocked: true,
          blockMessage: 'Esta operación no está disponible via chatbot. Usa el dashboard.',
        }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const dangerGuard = new DangerGuardService()
