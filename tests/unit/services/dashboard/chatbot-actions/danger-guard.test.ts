import { DangerGuardService, DangerCheckResult } from '@/services/dashboard/chatbot-actions/danger-guard.service'

// ---------------------------------------------------------------------------
// Tests: DangerGuardService
// ---------------------------------------------------------------------------

describe('DangerGuardService', () => {
  let service: DangerGuardService

  beforeEach(() => {
    service = new DangerGuardService()
  })

  // -------------------------------------------------------------------------
  // low
  // -------------------------------------------------------------------------

  describe('low danger level', () => {
    it('should require single confirmation only', () => {
      const result = service.checkDanger('low')

      expect(result.requiresConfirmation).toBe(true)
      expect(result.requiresDoubleConfirm).toBe(false)
      expect(result.showChangeSummary).toBe(false)
      expect(result.blocked).toBe(false)
    })

    it('should not set a blockMessage for low', () => {
      const result = service.checkDanger('low')
      expect(result.blockMessage).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // medium
  // -------------------------------------------------------------------------

  describe('medium danger level', () => {
    it('should require confirmation and show change summary', () => {
      const result = service.checkDanger('medium')

      expect(result.requiresConfirmation).toBe(true)
      expect(result.requiresDoubleConfirm).toBe(false)
      expect(result.showChangeSummary).toBe(true)
      expect(result.blocked).toBe(false)
    })

    it('should not set a blockMessage for medium', () => {
      const result = service.checkDanger('medium')
      expect(result.blockMessage).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // high
  // -------------------------------------------------------------------------

  describe('high danger level', () => {
    it('should require double confirmation and show change summary', () => {
      const result = service.checkDanger('high')

      expect(result.requiresConfirmation).toBe(true)
      expect(result.requiresDoubleConfirm).toBe(true)
      expect(result.showChangeSummary).toBe(true)
      expect(result.blocked).toBe(false)
    })

    it('should not set a blockMessage for high', () => {
      const result = service.checkDanger('high')
      expect(result.blockMessage).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // blocked
  // -------------------------------------------------------------------------

  describe('blocked danger level', () => {
    it('should be blocked with no confirmation gates', () => {
      const result = service.checkDanger('blocked')

      expect(result.blocked).toBe(true)
      expect(result.requiresConfirmation).toBe(false)
      expect(result.requiresDoubleConfirm).toBe(false)
      expect(result.showChangeSummary).toBe(false)
    })

    it('should include the Spanish block message', () => {
      const result = service.checkDanger('blocked')
      expect(result.blockMessage).toBe('Esta operación no está disponible via chatbot. Usa el dashboard.')
    })
  })

  // -------------------------------------------------------------------------
  // Regression: result shape is complete for all levels
  // -------------------------------------------------------------------------

  describe('regression: result shape completeness', () => {
    const levels = ['low', 'medium', 'high', 'blocked'] as const

    it.each(levels)('result for "%s" should always have all required fields', level => {
      const result: DangerCheckResult = service.checkDanger(level)

      expect(typeof result.requiresConfirmation).toBe('boolean')
      expect(typeof result.requiresDoubleConfirm).toBe('boolean')
      expect(typeof result.showChangeSummary).toBe('boolean')
      expect(typeof result.blocked).toBe('boolean')
    })

    it('non-blocked levels should never have blocked=true', () => {
      for (const level of ['low', 'medium', 'high'] as const) {
        expect(service.checkDanger(level).blocked).toBe(false)
      }
    })
  })
})
