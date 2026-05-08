-- Persist dashboard chatbot conversations server-side.

CREATE TYPE "ChatConversationStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');
CREATE TYPE "ChatMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

CREATE TABLE "ChatConversation" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT,
  "summary" TEXT,
  "lastMessage" TEXT,
  "messageCount" INTEGER NOT NULL DEFAULT 0,
  "status" "ChatConversationStatus" NOT NULL DEFAULT 'ACTIVE',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "ChatMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "metadata" JSONB,
  "trainingDataId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatLearningEvent" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT,
  "messageId" TEXT,
  "trainingDataId" TEXT,
  "eventType" TEXT NOT NULL,
  "intent" TEXT,
  "toolUsed" TEXT,
  "wasAnswered" BOOLEAN,
  "confidence" DOUBLE PRECISION,
  "failureReason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChatLearningEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatConversation_venueId_userId_updatedAt_idx" ON "ChatConversation"("venueId", "userId", "updatedAt");
CREATE INDEX "ChatConversation_venueId_status_updatedAt_idx" ON "ChatConversation"("venueId", "status", "updatedAt");
CREATE INDEX "ChatConversation_userId_status_updatedAt_idx" ON "ChatConversation"("userId", "status", "updatedAt");

CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");
CREATE INDEX "ChatMessage_venueId_userId_createdAt_idx" ON "ChatMessage"("venueId", "userId", "createdAt");
CREATE INDEX "ChatMessage_trainingDataId_idx" ON "ChatMessage"("trainingDataId");

CREATE INDEX "ChatLearningEvent_venueId_eventType_createdAt_idx" ON "ChatLearningEvent"("venueId", "eventType", "createdAt");
CREATE INDEX "ChatLearningEvent_userId_createdAt_idx" ON "ChatLearningEvent"("userId", "createdAt");
CREATE INDEX "ChatLearningEvent_conversationId_idx" ON "ChatLearningEvent"("conversationId");
CREATE INDEX "ChatLearningEvent_trainingDataId_idx" ON "ChatLearningEvent"("trainingDataId");

ALTER TABLE "ChatConversation"
  ADD CONSTRAINT "ChatConversation_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatConversation"
  ADD CONSTRAINT "ChatConversation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_trainingDataId_fkey"
  FOREIGN KEY ("trainingDataId") REFERENCES "ChatTrainingData"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChatLearningEvent"
  ADD CONSTRAINT "ChatLearningEvent_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatLearningEvent"
  ADD CONSTRAINT "ChatLearningEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
