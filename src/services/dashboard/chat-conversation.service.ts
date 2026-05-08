import { ChatConversationStatus, ChatMessageRole, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { ForbiddenError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

type MessageRole = 'user' | 'assistant' | 'system'

interface EnsureConversationInput {
  conversationId?: string
  venueId: string
  userId: string
  title?: string
  metadata?: Prisma.InputJsonObject
}

interface AppendMessageInput {
  conversationId: string
  venueId: string
  userId: string
  role: MessageRole
  content: string
  trainingDataId?: string
  metadata?: Prisma.InputJsonObject
}

interface LearningEventInput {
  venueId: string
  userId: string
  conversationId?: string
  messageId?: string
  trainingDataId?: string
  eventType: string
  intent?: string
  toolUsed?: string
  wasAnswered?: boolean
  confidence?: number
  failureReason?: string
  metadata?: Prisma.InputJsonObject
}

const MAX_MESSAGE_CHARS = 6000

const trimText = (value: string, max = MAX_MESSAGE_CHARS) => {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

const toPrismaRole = (role: MessageRole): ChatMessageRole => {
  if (role === 'user') return ChatMessageRole.USER
  if (role === 'assistant') return ChatMessageRole.ASSISTANT
  return ChatMessageRole.SYSTEM
}

const fromPrismaRole = (role: ChatMessageRole): MessageRole => {
  if (role === ChatMessageRole.USER) return 'user'
  if (role === ChatMessageRole.ASSISTANT) return 'assistant'
  return 'system'
}

export class ChatConversationService {
  async ensureConversation(input: EnsureConversationInput) {
    if (input.conversationId) {
      const conversation = await prisma.chatConversation.findUnique({
        where: { id: input.conversationId },
      })

      if (!conversation || conversation.status === ChatConversationStatus.DELETED || conversation.deletedAt) {
        throw new NotFoundError('No se encontró la conversación solicitada.')
      }

      if (conversation.venueId !== input.venueId || conversation.userId !== input.userId) {
        logger.warn('🚨 Cross-tenant chat conversation access blocked', {
          conversationId: input.conversationId,
          requestedVenueId: input.venueId,
          requestedUserId: input.userId,
          ownerVenueId: conversation.venueId,
          ownerUserId: conversation.userId,
        })
        throw new ForbiddenError('No tienes acceso a esta conversación.')
      }

      return conversation
    }

    return prisma.chatConversation.create({
      data: {
        venueId: input.venueId,
        userId: input.userId,
        title: input.title || 'Nueva conversación',
        metadata: input.metadata || undefined,
      },
    })
  }

  async appendMessage(input: AppendMessageInput) {
    const content = trimText(input.content)
    const role = toPrismaRole(input.role)

    const message = await prisma.chatMessage.create({
      data: {
        conversationId: input.conversationId,
        venueId: input.venueId,
        userId: input.userId,
        role,
        content,
        trainingDataId: input.trainingDataId,
        metadata: input.metadata || undefined,
      },
    })

    const titleUpdate =
      input.role === 'user'
        ? {
            title: content.slice(0, 80) || 'Nueva conversación',
          }
        : {}

    await prisma.chatConversation.update({
      where: { id: input.conversationId },
      data: {
        ...titleUpdate,
        lastMessage: content.slice(0, 500),
        messageCount: { increment: 1 },
        updatedAt: new Date(),
      },
    })

    return message
  }

  async getRecentHistory(conversationId: string, venueId: string, userId: string, limit = 10) {
    await this.ensureConversation({ conversationId, venueId, userId })

    const messages = await prisma.chatMessage.findMany({
      where: {
        conversationId,
        venueId,
        userId,
        role: { in: [ChatMessageRole.USER, ChatMessageRole.ASSISTANT] },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    return messages.reverse().map(message => ({
      role: fromPrismaRole(message.role) as 'user' | 'assistant',
      content: message.content,
      timestamp: message.createdAt,
      ...(message.trainingDataId ? { trainingDataId: message.trainingDataId } : {}),
    }))
  }

  async listConversations(venueId: string, userId: string, limit = 20, cursor?: string) {
    const conversations = await prisma.chatConversation.findMany({
      where: {
        venueId,
        userId,
        status: ChatConversationStatus.ACTIVE,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        summary: true,
        lastMessage: true,
        messageCount: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    const hasMore = conversations.length > limit
    const page = hasMore ? conversations.slice(0, limit) : conversations

    return {
      conversations: page,
      nextCursor: hasMore ? page[page.length - 1]?.id || null : null,
    }
  }

  async getConversation(conversationId: string, venueId: string, userId: string) {
    const conversation = await this.ensureConversation({ conversationId, venueId, userId })
    const messages = await prisma.chatMessage.findMany({
      where: {
        conversationId,
        venueId,
        userId,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        role: true,
        content: true,
        metadata: true,
        trainingDataId: true,
        createdAt: true,
      },
    })

    return {
      id: conversation.id,
      title: conversation.title,
      summary: conversation.summary,
      lastMessage: conversation.lastMessage,
      messageCount: conversation.messageCount,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: messages.map(message => ({
        ...message,
        role: fromPrismaRole(message.role),
      })),
    }
  }

  async createConversation(venueId: string, userId: string, title?: string) {
    return this.ensureConversation({ venueId, userId, title })
  }

  async deleteConversation(conversationId: string, venueId: string, userId: string) {
    await this.ensureConversation({ conversationId, venueId, userId })

    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: {
        status: ChatConversationStatus.DELETED,
        deletedAt: new Date(),
      },
    })
  }

  async recordLearningEvent(input: LearningEventInput) {
    try {
      await prisma.chatLearningEvent.create({
        data: {
          venueId: input.venueId,
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          trainingDataId: input.trainingDataId,
          eventType: input.eventType,
          intent: input.intent,
          toolUsed: input.toolUsed,
          wasAnswered: input.wasAnswered,
          confidence: input.confidence,
          failureReason: input.failureReason,
          metadata: input.metadata || undefined,
        },
      })
    } catch (error) {
      logger.warn('Failed to record chat learning event', { error })
    }
  }
}

export default new ChatConversationService()
