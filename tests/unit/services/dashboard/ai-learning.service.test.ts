import { AILearningService } from '../../../../src/services/dashboard/ai-learning.service'
import { prismaMock } from '../../../__helpers__/setup'
import { ChatFeedbackType, ChatProcessingStatus } from '@prisma/client'
import logger from '../../../../src/config/logger'

// Mock the logger
jest.mock('../../../../src/config/logger')

// Mock crypto
jest.mock('crypto', () => ({
  randomUUID: jest.fn(() => 'mocked-uuid-123'),
}))

describe('AI Learning Service', () => {
  let aiLearningService: AILearningService

  beforeEach(() => {
    jest.clearAllMocks()
    aiLearningService = new AILearningService()
  })

  describe('recordChatInteraction', () => {
    it('should record a chat interaction successfully', async () => {
      // Arrange
      const mockInteraction = {
        venueId: 'venue-123',
        userId: 'user-456',
        userQuestion: '¿Cuáles fueron las ventas de hoy?',
        aiResponse: 'Las ventas de hoy fueron $1,500 MXN',
        sqlQuery: 'SELECT SUM(total) FROM "Order" WHERE DATE(createdAt) = CURRENT_DATE',
        sqlResult: [{ sum: 1500 }],
        confidence: 0.85,
        executionTime: 250,
        rowsReturned: 1,
        sessionId: 'session-789',
      }

      const mockTrainingData = {
        id: 'mocked-uuid-123',
        ...mockInteraction,
        responseCategory: 'sales',
        wasCorrect: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      prismaMock.chatTrainingData.create.mockResolvedValue(mockTrainingData as any)

      // Act
      const result = await aiLearningService.recordChatInteraction(mockInteraction)

      // Assert
      expect(result).toBe('mocked-uuid-123')
      expect(prismaMock.chatTrainingData.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'mocked-uuid-123',
          venueId: 'venue-123',
          userId: 'user-456',
          userQuestion: '¿Cuáles fueron las ventas de hoy?',
          aiResponse: 'Las ventas de hoy fueron $1,500 MXN',
          sqlQuery: 'SELECT SUM(total) FROM "Order" WHERE DATE(createdAt) = CURRENT_DATE',
          confidence: 0.85,
          responseCategory: 'sales',
        }),
      })
    })

    it('should categorize questions correctly', async () => {
      // Arrange
      const salesInteraction = {
        venueId: 'venue-123',
        userId: 'user-456',
        userQuestion: '¿Cuánto vendimos esta semana?',
        aiResponse: 'Test response',
        confidence: 0.8,
        sessionId: 'session-789',
      }

      prismaMock.chatTrainingData.create.mockResolvedValue({
        id: 'test-id',
        responseCategory: 'sales',
      } as any)

      // Act
      await aiLearningService.recordChatInteraction(salesInteraction)

      // Assert
      expect(prismaMock.chatTrainingData.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          responseCategory: 'sales',
        }),
      })
    })

    it('should handle recording errors', async () => {
      // Arrange
      const mockInteraction = {
        venueId: 'venue-123',
        userId: 'user-456',
        userQuestion: 'Test question',
        aiResponse: 'Test response',
        confidence: 0.8,
        sessionId: 'session-789',
      }

      prismaMock.chatTrainingData.create.mockRejectedValue(new Error('Database error'))

      // Act & Assert
      await expect(aiLearningService.recordChatInteraction(mockInteraction)).rejects.toThrow('Database error')
      expect(logger.error).toHaveBeenCalledWith('❌ Failed to record chat interaction:', expect.any(Error))
    })
  })

  describe('processFeedback', () => {
    it('should create new feedback when none exists', async () => {
      // Arrange
      const mockFeedback = {
        trainingDataId: 'training-123',
        feedbackType: ChatFeedbackType.INCORRECT,
        correctedResponse: 'This is the correct response',
        correctedSql: 'SELECT * FROM "Order"',
        adminNotes: 'User feedback notes',
      }

      prismaMock.chatFeedback.findFirst.mockResolvedValue(null)
      prismaMock.chatFeedback.create.mockResolvedValue({ id: 'feedback-123' } as any)
      prismaMock.chatTrainingData.update.mockResolvedValue({ id: 'training-123' } as any)
      prismaMock.chatTrainingData.findUnique.mockResolvedValue({
        id: 'training-123',
        userQuestion: 'Test question',
        responseCategory: 'sales',
      } as any)

      // Act
      await aiLearningService.processFeedback(mockFeedback)

      // Assert
      expect(prismaMock.chatFeedback.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'mocked-uuid-123',
          trainingDataId: 'training-123',
          feedbackType: ChatFeedbackType.INCORRECT,
          correctedResponse: 'This is the correct response',
          processingStatus: ChatProcessingStatus.PENDING,
        }),
      })

      expect(prismaMock.chatTrainingData.update).toHaveBeenCalledWith({
        where: { id: 'training-123' },
        data: expect.objectContaining({
          wasCorrect: false,
        }),
      })
    })

    it('should update existing feedback', async () => {
      // Arrange
      const mockFeedback = {
        trainingDataId: 'training-123',
        feedbackType: ChatFeedbackType.CORRECT,
        adminNotes: 'Updated notes',
      }

      const existingFeedback = {
        id: 'existing-feedback-123',
        feedbackType: ChatFeedbackType.INCORRECT,
      }

      prismaMock.chatFeedback.findFirst.mockResolvedValue(existingFeedback as any)
      prismaMock.chatFeedback.update.mockResolvedValue({ id: 'existing-feedback-123' } as any)
      prismaMock.chatTrainingData.update.mockResolvedValue({ id: 'training-123' } as any)

      // Act
      await aiLearningService.processFeedback(mockFeedback)

      // Assert
      expect(prismaMock.chatFeedback.update).toHaveBeenCalledWith({
        where: { id: 'existing-feedback-123' },
        data: expect.objectContaining({
          feedbackType: ChatFeedbackType.CORRECT,
          adminNotes: 'Updated notes',
          processingStatus: ChatProcessingStatus.PENDING,
        }),
      })
    })

    it('should handle processing errors', async () => {
      // Arrange
      const mockFeedback = {
        trainingDataId: 'training-123',
        feedbackType: ChatFeedbackType.CORRECT,
      }

      prismaMock.chatFeedback.findFirst.mockRejectedValue(new Error('Database error'))

      // Act & Assert
      await expect(aiLearningService.processFeedback(mockFeedback)).rejects.toThrow('Database error')
      expect(logger.error).toHaveBeenCalledWith('❌ Failed to process feedback:', expect.any(Error))
    })
  })

  describe('learnFromSuccessfulInteractions', () => {
    it('should learn patterns from successful interactions', async () => {
      // Arrange
      const mockSuccessfulInteractions = [
        {
          id: 'interaction-1',
          userQuestion: '¿Cuáles fueron las ventas de hoy?',
          responseCategory: 'sales',
          sqlQuery: 'SELECT SUM(total) FROM "Order"',
          confidence: 0.9,
          wasCorrect: true,
        },
        {
          id: 'interaction-2',
          userQuestion: '¿Cuánto vendimos hoy?',
          responseCategory: 'sales',
          sqlQuery: 'SELECT SUM(total) FROM "Order"',
          confidence: 0.85,
          wasCorrect: true,
        },
      ]

      prismaMock.chatTrainingData.findMany.mockResolvedValue(mockSuccessfulInteractions as any)
      prismaMock.learnedPatterns.upsert.mockResolvedValue({ id: 'pattern-123' } as any)

      // Act
      await aiLearningService.learnFromSuccessfulInteractions()

      // Assert
      expect(prismaMock.chatTrainingData.findMany).toHaveBeenCalledWith({
        where: {
          confidence: { gte: 0.8 },
          wasCorrect: true,
          sqlQuery: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('🧠 Learned'))
    })

    it('should handle learning errors', async () => {
      // Arrange
      prismaMock.chatTrainingData.findMany.mockRejectedValue(new Error('Database error'))

      // Act
      await aiLearningService.learnFromSuccessfulInteractions()

      // Assert
      expect(logger.error).toHaveBeenCalledWith('❌ Failed to learn from successful interactions:', expect.any(Error))
    })
  })

  describe('getLearnedGuidance', () => {
    it('should return guidance from matching patterns', async () => {
      // Arrange
      const mockPatterns = [
        {
          id: 'pattern-123',
          questionPattern: 'ventas|vendimos',
          category: 'sales',
          optimalSqlTemplate: 'SELECT SUM(total) FROM "Order"',
          successRate: 0.9,
          totalUsages: 5,
          lastUsed: new Date(),
        },
      ]

      prismaMock.learnedPatterns.findMany.mockResolvedValue(mockPatterns as any)
      prismaMock.learnedPatterns.update.mockResolvedValue({ id: 'pattern-123' } as any)

      // Act
      const result = await aiLearningService.getLearnedGuidance('¿Cuáles fueron las ventas de hoy?', 'sales')

      // Assert
      expect(result).toEqual({
        suggestedSqlTemplate: 'SELECT SUM(total) FROM "Order"',
        confidenceBoost: expect.any(Number),
        patternMatch: 'ventas|vendimos',
      })

      expect(prismaMock.learnedPatterns.update).toHaveBeenCalledWith({
        where: { id: 'pattern-123' },
        data: {
          totalUsages: { increment: 1 },
          lastUsed: expect.any(Date),
        },
      })
    })

    it('should return empty guidance when no patterns match', async () => {
      // Arrange
      prismaMock.learnedPatterns.findMany.mockResolvedValue([])

      // Act
      const result = await aiLearningService.getLearnedGuidance('random question', 'general')

      // Assert
      expect(result).toEqual({ confidenceBoost: 0 })
    })

    it('should handle guidance errors gracefully', async () => {
      // Arrange
      prismaMock.learnedPatterns.findMany.mockRejectedValue(new Error('Database error'))

      // Act
      const result = await aiLearningService.getLearnedGuidance('test question', 'sales')

      // Assert
      expect(result).toEqual({ confidenceBoost: 0 })
      expect(logger.error).toHaveBeenCalledWith('❌ Failed to get learned guidance:', expect.any(Error))
    })
  })

  describe('getLearningAnalytics', () => {
    it('should return comprehensive learning analytics', async () => {
      // Arrange
      prismaMock.chatTrainingData.count.mockResolvedValueOnce(100) // total interactions
      prismaMock.chatTrainingData.count.mockResolvedValueOnce(80) // correct responses
      prismaMock.chatTrainingData.aggregate.mockResolvedValue({
        _avg: { confidence: 0.85 },
      } as any)

      const mockCategoryStats = [
        {
          responseCategory: 'sales',
          _count: { id: 50 },
          _avg: { confidence: 0.9 },
        },
        {
          responseCategory: 'staff',
          _count: { id: 30 },
          _avg: { confidence: 0.8 },
        },
      ]
      prismaMock.chatTrainingData.groupBy.mockResolvedValue(mockCategoryStats as any)

      // Mock correct counts for categories
      prismaMock.chatTrainingData.count
        .mockResolvedValueOnce(40) // sales correct
        .mockResolvedValueOnce(25) // staff correct

      prismaMock.learnedPatterns.count.mockResolvedValue(15)

      // Act
      const result = await aiLearningService.getLearningAnalytics()

      // Assert
      expect(result).toEqual({
        totalInteractions: 100,
        accuracyRate: 0.8,
        averageConfidence: 0.85,
        categoryPerformance: {
          sales: {
            total: 50,
            correct: 40,
            averageConfidence: 0.9,
          },
          staff: {
            total: 30,
            correct: 25,
            averageConfidence: 0.8,
          },
        },
        learnedPatterns: 15,
      })
    })

    it('should handle analytics errors', async () => {
      // Arrange
      prismaMock.chatTrainingData.count.mockRejectedValue(new Error('Database error'))

      // Act & Assert
      await expect(aiLearningService.getLearningAnalytics()).rejects.toThrow('Database error')
      expect(logger.error).toHaveBeenCalledWith('❌ Failed to get learning analytics:', expect.any(Error))
    })
  })

  describe('Helper Methods', () => {
    describe('categorizeQuestion', () => {
      it('should categorize sales questions correctly', async () => {
        // Arrange
        const salesQuestions = [
          '¿Cuáles fueron las ventas de hoy?',
          '¿Cuánto vendimos esta semana?',
          'Mostrar ingresos del mes',
          'Ganancias totales',
        ]

        // Act & Assert (indirect testing through recordChatInteraction)
        for (const question of salesQuestions) {
          prismaMock.chatTrainingData.create.mockResolvedValue({
            id: 'test',
            responseCategory: 'sales',
          } as any)

          await aiLearningService.recordChatInteraction({
            venueId: 'venue-123',
            userId: 'user-456',
            userQuestion: question,
            aiResponse: 'Response',
            confidence: 0.8,
            sessionId: 'session-789',
          })

          expect(prismaMock.chatTrainingData.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
              responseCategory: 'sales',
            }),
          })

          jest.clearAllMocks()
        }
      })

      it('should categorize temporal questions correctly', async () => {
        // Arrange
        const temporalQuestion = '¿Qué vendimos ayer por la mañana?'

        prismaMock.chatTrainingData.create.mockResolvedValue({
          id: 'test',
          responseCategory: 'temporal',
        } as any)

        // Act
        await aiLearningService.recordChatInteraction({
          venueId: 'venue-123',
          userId: 'user-456',
          userQuestion: temporalQuestion,
          aiResponse: 'Response',
          confidence: 0.8,
          sessionId: 'session-789',
        })

        // Assert
        expect(prismaMock.chatTrainingData.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            responseCategory: 'temporal',
          }),
        })
      })

      it('should default to general category', async () => {
        // Arrange
        const generalQuestion = 'Random question without keywords'

        prismaMock.chatTrainingData.create.mockResolvedValue({
          id: 'test',
          responseCategory: 'general',
        } as any)

        // Act
        await aiLearningService.recordChatInteraction({
          venueId: 'venue-123',
          userId: 'user-456',
          userQuestion: generalQuestion,
          aiResponse: 'Response',
          confidence: 0.8,
          sessionId: 'session-789',
        })

        // Assert
        expect(prismaMock.chatTrainingData.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            responseCategory: 'general',
          }),
        })
      })
    })
  })
})
