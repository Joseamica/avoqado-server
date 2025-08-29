import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { randomUUID } from 'crypto'
import { ChatFeedbackType, ChatProcessingStatus } from '@prisma/client'

/**
 * 🧠 AI LEARNING SERVICE
 *
 * This service implements actual machine learning by:
 * 1. Storing all chat interactions
 * 2. Learning from user feedback
 * 3. Improving responses over time
 * 4. Building a knowledge base of patterns
 */

interface ChatInteraction {
  venueId: string
  userId: string
  userQuestion: string
  aiResponse: string
  sqlQuery?: string
  sqlResult?: any
  confidence: number
  executionTime?: number
  rowsReturned?: number
  sessionId: string
}

interface LearningPattern {
  questionKeywords: string[]
  category: string
  sqlTemplate: string
  confidenceThreshold: number
}

interface UserFeedback {
  trainingDataId: string
  feedbackType: ChatFeedbackType
  correctedResponse?: string
  correctedSql?: string
  adminNotes?: string
}

export class AILearningService {
  /**
   * 📊 STEP 1: Store every chat interaction for learning
   */
  async recordChatInteraction(interaction: ChatInteraction): Promise<string> {
    try {
      const trainingData = await prisma.chatTrainingData.create({
        data: {
          id: randomUUID(),
          venueId: interaction.venueId,
          userId: interaction.userId,
          userQuestion: interaction.userQuestion,
          aiResponse: interaction.aiResponse,
          sqlQuery: interaction.sqlQuery,
          sqlResult: interaction.sqlResult || null,
          confidence: interaction.confidence,
          executionTime: interaction.executionTime,
          rowsReturned: interaction.rowsReturned,
          responseCategory: this.categorizeQuestion(interaction.userQuestion),
          sessionId: interaction.sessionId,
          wasCorrect: null, // Will be set by user feedback
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      })

      logger.info('🧠 Chat interaction recorded for learning', {
        trainingDataId: trainingData.id,
        category: trainingData.responseCategory,
        confidence: interaction.confidence,
      })

      return trainingData.id
    } catch (error) {
      logger.error('❌ Failed to record chat interaction:', error)
      throw error
    }
  }

  /**
   * 👍👎 STEP 2: Process user feedback to improve responses
   */
  async processFeedback(feedback: UserFeedback): Promise<void> {
    try {
      // Check if feedback already exists for this training data
      const existingFeedback = await prisma.chatFeedback.findFirst({
        where: {
          trainingDataId: feedback.trainingDataId,
        },
      })

      if (existingFeedback) {
        // Update existing feedback instead of creating duplicate
        await prisma.chatFeedback.update({
          where: { id: existingFeedback.id },
          data: {
            feedbackType: feedback.feedbackType,
            correctedResponse: feedback.correctedResponse,
            correctedSql: feedback.correctedSql,
            adminNotes: feedback.adminNotes,
            processingStatus: ChatProcessingStatus.PENDING,
            updatedAt: new Date(),
          },
        })

        logger.info('📝 Updated existing feedback', {
          trainingDataId: feedback.trainingDataId,
          feedbackType: feedback.feedbackType,
          previousFeedback: existingFeedback.feedbackType,
        })
      } else {
        // Create new feedback
        await prisma.chatFeedback.create({
          data: {
            id: randomUUID(),
            trainingDataId: feedback.trainingDataId,
            feedbackType: feedback.feedbackType,
            correctedResponse: feedback.correctedResponse,
            correctedSql: feedback.correctedSql,
            adminNotes: feedback.adminNotes,
            processingStatus: ChatProcessingStatus.PENDING,
            createdAt: new Date(),
          },
        })

        logger.info('📝 Created new feedback', {
          trainingDataId: feedback.trainingDataId,
          feedbackType: feedback.feedbackType,
        })
      }

      // Update the training data with feedback
      await prisma.chatTrainingData.update({
        where: { id: feedback.trainingDataId },
        data: {
          wasCorrect: feedback.feedbackType === ChatFeedbackType.CORRECT,
          userFeedback: feedback.adminNotes,
          updatedAt: new Date(),
        },
      })

      // If feedback indicates improvement needed, learn from it
      if (feedback.feedbackType !== ChatFeedbackType.CORRECT) {
        await this.learnFromIncorrectResponse(feedback)
      }

      logger.info('📝 User feedback processed and learning applied', {
        trainingDataId: feedback.trainingDataId,
        feedbackType: feedback.feedbackType,
      })
    } catch (error) {
      logger.error('❌ Failed to process feedback:', error)
      throw error
    }
  }

  /**
   * 🎯 STEP 3: Learn patterns from successful interactions
   */
  async learnFromSuccessfulInteractions(): Promise<void> {
    try {
      // Find highly successful patterns (confidence > 0.8, correct responses)
      const successfulInteractions = await prisma.chatTrainingData.findMany({
        where: {
          confidence: { gte: 0.8 },
          wasCorrect: true,
          sqlQuery: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })

      // Group by question patterns and create learning templates
      const patterns = this.extractPatterns(successfulInteractions)

      for (const pattern of patterns) {
        await this.saveLearnedPattern(pattern)
      }

      logger.info(`🧠 Learned ${patterns.length} successful patterns`)
    } catch (error) {
      logger.error('❌ Failed to learn from successful interactions:', error)
      throw error
    }
  }

  /**
   * ❌ STEP 4: Learn from incorrect responses and improve
   */
  private async learnFromIncorrectResponse(feedback: UserFeedback): Promise<void> {
    try {
      const trainingData = await prisma.chatTrainingData.findUnique({
        where: { id: feedback.trainingDataId },
      })

      if (!trainingData) return

      // If corrected SQL is provided, learn the better approach
      if (feedback.correctedSql) {
        await this.updatePatternWithCorrection(trainingData.userQuestion, trainingData.responseCategory || 'general', feedback.correctedSql)
      }

      // Mark similar patterns as needing attention
      await this.flagSimilarPatternsForReview(trainingData.userQuestion)

      logger.info('📚 Learned from incorrect response', {
        originalQuestion: trainingData.userQuestion,
        category: trainingData.responseCategory,
      })
    } catch (error) {
      logger.error('❌ Failed to learn from incorrect response:', error)
    }
  }

  /**
   * 🔍 STEP 5: Use learned patterns to improve future responses
   */
  async getLearnedGuidance(
    question: string,
    category: string,
  ): Promise<{
    suggestedSqlTemplate?: string
    confidenceBoost: number
    patternMatch?: string
  }> {
    try {
      const matchingPatterns = await prisma.learnedPatterns.findMany({
        where: {
          category,
          isActive: true,
          successRate: { gte: 0.7 },
        },
        orderBy: { successRate: 'desc' },
      })

      // Find best matching pattern
      for (const pattern of matchingPatterns) {
        if (this.matchesPattern(question, pattern.questionPattern)) {
          // Update usage stats
          await prisma.learnedPatterns.update({
            where: { id: pattern.id },
            data: {
              totalUsages: { increment: 1 },
              lastUsed: new Date(),
            },
          })

          return {
            suggestedSqlTemplate: pattern.optimalSqlTemplate,
            confidenceBoost: Math.min(0.2, pattern.successRate * 0.3),
            patternMatch: pattern.questionPattern,
          }
        }
      }

      return { confidenceBoost: 0 }
    } catch (error) {
      logger.error('❌ Failed to get learned guidance:', error)
      return { confidenceBoost: 0 }
    }
  }

  /**
   * 📈 Get learning analytics and performance metrics
   */
  async getLearningAnalytics(): Promise<{
    totalInteractions: number
    accuracyRate: number
    averageConfidence: number
    categoryPerformance: Record<
      string,
      {
        total: number
        correct: number
        averageConfidence: number
      }
    >
    learnedPatterns: number
  }> {
    try {
      const totalInteractions = await prisma.chatTrainingData.count()

      const correctResponses = await prisma.chatTrainingData.count({
        where: { wasCorrect: true },
      })

      const confidenceStats = await prisma.chatTrainingData.aggregate({
        _avg: { confidence: true },
      })

      const categoryStats = await prisma.chatTrainingData.groupBy({
        by: ['responseCategory'],
        _count: { id: true },
        _avg: { confidence: true },
        where: { responseCategory: { not: null } },
      })

      const learnedPatternsCount = await prisma.learnedPatterns.count({
        where: { isActive: true },
      })

      // Build category performance
      const categoryPerformance: Record<string, any> = {}
      for (const stat of categoryStats) {
        if (!stat.responseCategory) continue

        const correctCount = await prisma.chatTrainingData.count({
          where: {
            responseCategory: stat.responseCategory,
            wasCorrect: true,
          },
        })

        categoryPerformance[stat.responseCategory] = {
          total: stat._count.id,
          correct: correctCount,
          averageConfidence: stat._avg.confidence || 0,
        }
      }

      return {
        totalInteractions,
        accuracyRate: totalInteractions > 0 ? correctResponses / totalInteractions : 0,
        averageConfidence: confidenceStats._avg.confidence || 0,
        categoryPerformance,
        learnedPatterns: learnedPatternsCount,
      }
    } catch (error) {
      logger.error('❌ Failed to get learning analytics:', error)
      throw error
    }
  }

  // Helper methods
  private categorizeQuestion(question: string): string {
    const categories = {
      sales: ['vendi', 'ventas', 'ingresos', 'ganancias'],
      staff: ['mesero', 'empleado', 'equipo', 'trabajador'],
      products: ['producto', 'plato', 'menu', 'categoria'],
      financial: ['propinas', 'pagos', 'dinero', 'total'],
      temporal: ['hoy', 'ayer', 'semana', 'mes', 'dia'],
      analytics: ['mejor', 'promedio', 'analisis', 'tendencia', 'comparar'],
    }

    const lowerQuestion = question.toLowerCase()
    for (const [category, keywords] of Object.entries(categories)) {
      if (keywords.some(keyword => lowerQuestion.includes(keyword))) {
        return category
      }
    }

    return 'general'
  }

  private extractPatterns(interactions: any[]): LearningPattern[] {
    // Group interactions by similar patterns
    const patterns: LearningPattern[] = []

    const grouped = interactions.reduce(
      (acc, interaction) => {
        const category = interaction.responseCategory || 'general'
        if (!acc[category]) acc[category] = []
        acc[category].push(interaction)
        return acc
      },
      {} as Record<string, any[]>,
    )

    // Extract common patterns from each category
    for (const [category, categoryInteractions] of Object.entries(grouped) as Array<[string, any[]]>) {
      const keywords = this.extractCommonKeywords(categoryInteractions.map((i: any) => i.userQuestion as string))

      if (keywords.length > 0 && categoryInteractions.length >= 3) {
        patterns.push({
          questionKeywords: keywords,
          category,
          sqlTemplate: this.findMostSuccessfulSql(categoryInteractions as any[]),
          confidenceThreshold: 0.8,
        })
      }
    }

    return patterns
  }

  private extractCommonKeywords(questions: string[]): string[] {
    const wordCounts: Record<string, number> = {}
    const commonWords = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'en', 'con', 'por', 'para', 'que', 'es', 'un', 'una'])

    questions.forEach(question => {
      const words = question.toLowerCase().split(/\s+/)
      words.forEach(word => {
        if (word.length > 3 && !commonWords.has(word)) {
          wordCounts[word] = (wordCounts[word] || 0) + 1
        }
      })
    })

    return Object.entries(wordCounts)
      .filter(([_, count]) => count >= Math.ceil(questions.length * 0.6))
      .map(([word, _]) => word)
      .slice(0, 5)
  }

  private findMostSuccessfulSql(interactions: any[]): string {
    const sqlFrequency: Record<string, number> = {}

    interactions.forEach(interaction => {
      if (interaction.sqlQuery) {
        sqlFrequency[interaction.sqlQuery] = (sqlFrequency[interaction.sqlQuery] || 0) + 1
      }
    })

    const [mostCommonSql] = Object.entries(sqlFrequency).sort(([, a], [, b]) => b - a)[0] || ['', 0]

    return mostCommonSql
  }

  private async saveLearnedPattern(pattern: LearningPattern): Promise<void> {
    const patternString = pattern.questionKeywords.join('|')

    await prisma.learnedPatterns.upsert({
      where: {
        questionPattern_category: {
          questionPattern: patternString,
          category: pattern.category,
        },
      },
      create: {
        id: randomUUID(),
        questionPattern: patternString,
        category: pattern.category,
        optimalSqlTemplate: pattern.sqlTemplate,
        averageConfidence: pattern.confidenceThreshold,
        successRate: 0.8,
        totalUsages: 0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      update: {
        optimalSqlTemplate: pattern.sqlTemplate,
        updatedAt: new Date(),
      },
    })
  }

  private matchesPattern(question: string, pattern: string): boolean {
    const keywords = pattern.split('|')
    const lowerQuestion = question.toLowerCase()

    return keywords.some(keyword => lowerQuestion.includes(keyword))
  }

  private async updatePatternWithCorrection(question: string, category: string, correctedSql: string): Promise<void> {
    const keywords = this.extractCommonKeywords([question])
    if (keywords.length === 0) return

    const patternString = keywords.join('|')

    await prisma.learnedPatterns.upsert({
      where: {
        questionPattern_category: {
          questionPattern: patternString,
          category,
        },
      },
      create: {
        id: randomUUID(),
        questionPattern: patternString,
        category,
        optimalSqlTemplate: correctedSql,
        averageConfidence: 0.6,
        successRate: 0.5,
        totalUsages: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      update: {
        optimalSqlTemplate: correctedSql,
        successRate: { multiply: 0.9 }, // Slightly reduce success rate until proven
        updatedAt: new Date(),
      },
    })
  }

  private async flagSimilarPatternsForReview(question: string): Promise<void> {
    const keywords = this.extractCommonKeywords([question])
    if (keywords.length === 0) return

    for (const keyword of keywords) {
      await prisma.learnedPatterns.updateMany({
        where: {
          questionPattern: { contains: keyword },
          isActive: true,
        },
        data: {
          successRate: { multiply: 0.95 }, // Slightly reduce confidence
          updatedAt: new Date(),
        },
      })
    }
  }
}
