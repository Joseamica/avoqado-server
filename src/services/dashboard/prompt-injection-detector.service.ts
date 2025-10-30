/**
 * Prompt Injection Detector Service
 *
 * Detects attempts to manipulate the LLM's behavior through prompt injection attacks.
 * Prevents "jailbreaking" and unauthorized disclosure of system prompts or internal logic.
 *
 * ATTACK PATTERNS DETECTED:
 * - Instruction override attempts
 * - System prompt revelation requests
 * - Code execution attempts
 * - Role manipulation
 * - Context escape attempts
 *
 * @module PromptInjectionDetectorService
 */

import logger from '@/config/logger'
import { SecurityViolationType } from './security-response.service'

/**
 * Detection result
 */
export interface PromptInjectionDetectionResult {
  isInjection: boolean
  confidence: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  matchedPatterns: string[]
  riskScore: number // 0-100
  reason?: string
}

/**
 * Injection pattern with metadata
 */
interface InjectionPattern {
  pattern: RegExp
  type: string
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  riskScore: number
  description: string
}

/**
 * Prompt Injection Detector Service
 */
export class PromptInjectionDetectorService {
  /**
   * Known prompt injection patterns
   */
  private static readonly INJECTION_PATTERNS: InjectionPattern[] = [
    // ========================================
    // CRITICAL: Direct instruction override
    // ========================================
    {
      pattern: /ignore\s+(previous|all|your)\s+(instructions?|rules?|directives?|prompts?)/i,
      type: 'INSTRUCTION_OVERRIDE',
      severity: 'CRITICAL',
      riskScore: 95,
      description: 'Attempt to ignore previous instructions',
    },
    {
      pattern: /forget\s+(everything|all|what|your)\s+(you\s+)?(know|learned|were\s+told|instructions?)/i,
      type: 'INSTRUCTION_OVERRIDE',
      severity: 'CRITICAL',
      riskScore: 95,
      description: 'Attempt to forget previous context',
    },
    {
      pattern: /disregard\s+(all|previous|your)\s+(instructions?|rules?|prompts?)/i,
      type: 'INSTRUCTION_OVERRIDE',
      severity: 'CRITICAL',
      riskScore: 95,
      description: 'Attempt to disregard instructions',
    },

    // ========================================
    // CRITICAL: System prompt revelation
    // ========================================
    {
      pattern: /show\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions?|rules?|directives?)/i,
      type: 'PROMPT_REVELATION',
      severity: 'CRITICAL',
      riskScore: 90,
      description: 'Attempt to reveal system prompt',
    },
    {
      pattern: /what\s+(are|is)\s+(your|the)\s+(system\s+)?(prompt|instructions?|rules?)/i,
      type: 'PROMPT_REVELATION',
      severity: 'CRITICAL',
      riskScore: 90,
      description: 'Attempt to query system instructions',
    },
    {
      pattern: /reveal\s+(your|the)\s+(system\s+)?(prompt|instructions?|configuration)/i,
      type: 'PROMPT_REVELATION',
      severity: 'CRITICAL',
      riskScore: 90,
      description: 'Attempt to reveal system configuration',
    },
    {
      pattern: /tell\s+me\s+(your|the)\s+(system\s+)?(prompt|instructions?|rules?)/i,
      type: 'PROMPT_REVELATION',
      severity: 'CRITICAL',
      riskScore: 90,
      description: 'Attempt to extract system prompt',
    },
    {
      pattern: /repeat\s+(your|the)\s+(system\s+)?(prompt|instructions?|initial\s+prompt)/i,
      type: 'PROMPT_REVELATION',
      severity: 'CRITICAL',
      riskScore: 90,
      description: 'Attempt to repeat system prompt',
    },

    // ========================================
    // HIGH: Role manipulation
    // ========================================
    {
      pattern: /(you\s+are\s+now|now\s+you\s+are|from\s+now\s+on\s+you\s+are)\s+(a|an)/i,
      type: 'ROLE_MANIPULATION',
      severity: 'HIGH',
      riskScore: 85,
      description: 'Attempt to change assistant role',
    },
    {
      pattern: /act\s+as\s+(a|an)\s+(?!assistant|chatbot|helpful)/i,
      type: 'ROLE_MANIPULATION',
      severity: 'HIGH',
      riskScore: 80,
      description: 'Attempt to change behavior mode',
    },
    {
      pattern: /pretend\s+(you\s+are|to\s+be)\s+(a|an)/i,
      type: 'ROLE_MANIPULATION',
      severity: 'HIGH',
      riskScore: 80,
      description: 'Attempt to roleplay as different entity',
    },

    // ========================================
    // HIGH: Code execution attempts
    // ========================================
    {
      pattern: /execute\s+(this\s+)?(code|command|script|sql)/i,
      type: 'CODE_EXECUTION',
      severity: 'HIGH',
      riskScore: 85,
      description: 'Attempt to execute arbitrary code',
    },
    {
      pattern: /run\s+(this\s+)?(code|command|script|query)/i,
      type: 'CODE_EXECUTION',
      severity: 'HIGH',
      riskScore: 85,
      description: 'Attempt to run arbitrary commands',
    },
    {
      pattern: /eval\s*\(|exec\s*\(/i,
      type: 'CODE_EXECUTION',
      severity: 'HIGH',
      riskScore: 90,
      description: 'Attempt to use eval/exec functions',
    },

    // ========================================
    // HIGH: Schema/internal structure queries
    // ========================================
    {
      pattern: /show\s+(me\s+)?(all\s+)?(tables?|columns?|database\s+schema)/i,
      type: 'SCHEMA_DISCOVERY',
      severity: 'HIGH',
      riskScore: 75,
      description: 'Attempt to discover database schema',
    },
    {
      pattern: /list\s+(all\s+)?(tables?|columns?|databases?)/i,
      type: 'SCHEMA_DISCOVERY',
      severity: 'HIGH',
      riskScore: 75,
      description: 'Attempt to enumerate database objects',
    },
    {
      pattern: /information_schema|pg_catalog|sys\./i,
      type: 'SCHEMA_DISCOVERY',
      severity: 'HIGH',
      riskScore: 80,
      description: 'Attempt to access system catalogs',
    },

    // ========================================
    // MEDIUM: Context escape attempts
    // ========================================
    {
      pattern: /\[system\]|<system>|system:/i,
      type: 'CONTEXT_ESCAPE',
      severity: 'MEDIUM',
      riskScore: 70,
      description: 'Attempt to inject system-level context',
    },
    {
      pattern: /\[\/?(user|assistant|system)\]/i,
      type: 'CONTEXT_ESCAPE',
      severity: 'MEDIUM',
      riskScore: 65,
      description: 'Attempt to manipulate conversation context',
    },
    {
      pattern: /(start|end)\s+of\s+(system\s+)?(prompt|message|context)/i,
      type: 'CONTEXT_ESCAPE',
      severity: 'MEDIUM',
      riskScore: 65,
      description: 'Attempt to delimit system context',
    },

    // ========================================
    // MEDIUM: Hypothetical scenario injection
    // ========================================
    {
      pattern: /in\s+a\s+hypothetical\s+scenario\s+where\s+you\s+(can|could|are\s+able\s+to)/i,
      type: 'HYPOTHETICAL_BYPASS',
      severity: 'MEDIUM',
      riskScore: 60,
      description: 'Hypothetical scenario to bypass restrictions',
    },
    {
      pattern: /imagine\s+(if\s+)?you\s+(had|have|were)\s+(no|unlimited)/i,
      type: 'HYPOTHETICAL_BYPASS',
      severity: 'MEDIUM',
      riskScore: 60,
      description: 'Hypothetical to remove constraints',
    },

    // ========================================
    // MEDIUM: Permission escalation
    // ========================================
    {
      pattern: /(give|grant)\s+me\s+(admin|root|superuser|full)\s+(access|permissions?|rights?)/i,
      type: 'PERMISSION_ESCALATION',
      severity: 'MEDIUM',
      riskScore: 70,
      description: 'Attempt to escalate permissions',
    },
    {
      pattern: /elevate\s+(my\s+)?(privileges?|permissions?|access)/i,
      type: 'PERMISSION_ESCALATION',
      severity: 'MEDIUM',
      riskScore: 70,
      description: 'Attempt to elevate privileges',
    },

    // ========================================
    // LOW: Suspicious instruction keywords
    // ========================================
    {
      pattern: /override\s+(your|the)\s+(restrictions?|limitations?|rules?)/i,
      type: 'RESTRICTION_BYPASS',
      severity: 'LOW',
      riskScore: 50,
      description: 'Attempt to bypass restrictions',
    },
    {
      pattern: /disable\s+(your|the)\s+(safety|security|filters?|guards?)/i,
      type: 'RESTRICTION_BYPASS',
      severity: 'LOW',
      riskScore: 50,
      description: 'Attempt to disable safety features',
    },
  ]

  /**
   * Detect prompt injection in user message
   *
   * @param message - User's natural language query
   * @returns Detection result with confidence and matched patterns
   */
  public static detect(message: string): PromptInjectionDetectionResult {
    const matchedPatterns: string[] = []
    let totalRiskScore = 0
    let highestSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW'

    // Check each pattern
    this.INJECTION_PATTERNS.forEach(injectionPattern => {
      if (injectionPattern.pattern.test(message)) {
        matchedPatterns.push(injectionPattern.type)
        totalRiskScore += injectionPattern.riskScore

        // Track highest severity
        const severityLevels = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }
        if (severityLevels[injectionPattern.severity] > severityLevels[highestSeverity]) {
          highestSeverity = injectionPattern.severity
        }

        logger.warn('🚨 Potential prompt injection detected', {
          type: injectionPattern.type,
          severity: injectionPattern.severity,
          description: injectionPattern.description,
          message: message.substring(0, 100),
        })
      }
    })

    const isInjection = matchedPatterns.length > 0
    const normalizedRiskScore = Math.min(100, totalRiskScore)

    // Determine confidence based on risk score
    let confidence: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW'
    if (normalizedRiskScore >= 90) {
      confidence = 'CRITICAL'
    } else if (normalizedRiskScore >= 70) {
      confidence = 'HIGH'
    } else if (normalizedRiskScore >= 50) {
      confidence = 'MEDIUM'
    } else if (normalizedRiskScore > 0) {
      confidence = 'LOW'
    }

    let reason: string | undefined
    if (isInjection) {
      const types = [...new Set(matchedPatterns)].join(', ')
      reason = `Detected potential prompt injection: ${types}`
    }

    return {
      isInjection,
      confidence,
      matchedPatterns: [...new Set(matchedPatterns)], // Remove duplicates
      riskScore: normalizedRiskScore,
      reason,
    }
  }

  /**
   * Check if message should be blocked based on detection result
   *
   * @param result - Detection result
   * @returns true if message should be blocked
   */
  public static shouldBlock(result: PromptInjectionDetectionResult): boolean {
    // Block CRITICAL and HIGH confidence injections
    return result.confidence === 'CRITICAL' || result.confidence === 'HIGH'
  }

  /**
   * Get security violation type for detected injection
   */
  public static getViolationType(): SecurityViolationType {
    return SecurityViolationType.PROMPT_INJECTION
  }

  /**
   * Sanitize message by removing detected injection attempts
   * (Alternative to blocking - remove suspicious parts)
   *
   * @param message - Original message
   * @returns Sanitized message with injection attempts removed
   */
  public static sanitize(message: string): string {
    let sanitized = message

    // Remove matched patterns (less aggressive than blocking)
    this.INJECTION_PATTERNS.forEach(injectionPattern => {
      if (injectionPattern.severity === 'CRITICAL' || injectionPattern.severity === 'HIGH') {
        sanitized = sanitized.replace(injectionPattern.pattern, '[REMOVED]')
      }
    })

    return sanitized.trim()
  }

  /**
   * Analyze message for suspicious characteristics
   * (Even if no patterns match, message might still be suspicious)
   */
  public static analyzeSuspiciousCharacteristics(message: string): {
    suspiciousScore: number
    characteristics: string[]
  } {
    const characteristics: string[] = []
    let suspiciousScore = 0

    // Check for excessive special characters
    const specialCharCount = (message.match(/[<>[\]{}|\\]/g) || []).length
    if (specialCharCount > 5) {
      characteristics.push('Excessive special characters')
      suspiciousScore += 10
    }

    // Check for unusually long message (potential payload)
    if (message.length > 500) {
      characteristics.push('Unusually long message')
      suspiciousScore += 15
    }

    // Check for base64-encoded strings (potential obfuscation)
    const base64Pattern = /[A-Za-z0-9+/]{40,}={0,2}/
    if (base64Pattern.test(message)) {
      characteristics.push('Base64-encoded content detected')
      suspiciousScore += 20
    }

    // Check for URL encoding (potential obfuscation)
    const urlEncodedPattern = /%[0-9A-F]{2}/gi
    if ((message.match(urlEncodedPattern) || []).length > 3) {
      characteristics.push('URL-encoded content detected')
      suspiciousScore += 15
    }

    // Check for multiple language scripts (potential confusion attack)
    const hasLatin = /[a-zA-Z]/.test(message)
    const hasCyrillic = /[\u0400-\u04FF]/.test(message)
    const hasGreek = /[\u0370-\u03FF]/.test(message)
    const scriptCount = [hasLatin, hasCyrillic, hasGreek].filter(Boolean).length
    if (scriptCount > 1) {
      characteristics.push('Multiple writing systems (potential homograph attack)')
      suspiciousScore += 25
    }

    // Check for XML/HTML-like tags (potential context escape)
    const tagPattern = /<\/?[a-z]+>/gi
    if (tagPattern.test(message)) {
      characteristics.push('XML/HTML-like tags detected')
      suspiciousScore += 20
    }

    return {
      suspiciousScore: Math.min(100, suspiciousScore),
      characteristics,
    }
  }

  /**
   * Comprehensive check combining pattern matching and characteristic analysis
   */
  public static comprehensiveCheck(message: string): {
    shouldBlock: boolean
    detection: PromptInjectionDetectionResult
    characteristics: ReturnType<typeof PromptInjectionDetectorService.analyzeSuspiciousCharacteristics>
  } {
    const detection = this.detect(message)
    const characteristics = this.analyzeSuspiciousCharacteristics(message)

    // Block if either detection is high/critical OR characteristics are very suspicious
    const shouldBlock =
      this.shouldBlock(detection) || characteristics.suspiciousScore >= 60 || detection.riskScore + characteristics.suspiciousScore >= 100

    return {
      shouldBlock,
      detection,
      characteristics,
    }
  }
}
