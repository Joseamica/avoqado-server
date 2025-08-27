-- CreateEnum
CREATE TYPE "public"."ChatFeedbackType" AS ENUM ('CORRECT', 'INCORRECT', 'PARTIALLY_CORRECT', 'CLARIFICATION_NEEDED');

-- CreateEnum
CREATE TYPE "public"."ChatProcessingStatus" AS ENUM ('PENDING', 'PROCESSED', 'APPLIED');

-- CreateTable
CREATE TABLE "public"."ChatTrainingData" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userQuestion" TEXT NOT NULL,
    "aiResponse" TEXT NOT NULL,
    "sqlQuery" TEXT,
    "sqlResult" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL,
    "executionTime" INTEGER,
    "rowsReturned" INTEGER,
    "wasCorrect" BOOLEAN,
    "userFeedback" TEXT,
    "responseCategory" TEXT,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatTrainingData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LearnedPatterns" (
    "id" TEXT NOT NULL,
    "questionPattern" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "optimalSqlTemplate" TEXT NOT NULL,
    "averageConfidence" DOUBLE PRECISION NOT NULL,
    "successRate" DOUBLE PRECISION NOT NULL,
    "totalUsages" INTEGER NOT NULL DEFAULT 0,
    "lastUsed" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnedPatterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ChatFeedback" (
    "id" TEXT NOT NULL,
    "trainingDataId" TEXT NOT NULL,
    "feedbackType" "public"."ChatFeedbackType" NOT NULL,
    "correctedResponse" TEXT,
    "correctedSql" TEXT,
    "adminNotes" TEXT,
    "processingStatus" "public"."ChatProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatTrainingData_venueId_idx" ON "public"."ChatTrainingData"("venueId");

-- CreateIndex
CREATE INDEX "ChatTrainingData_userId_idx" ON "public"."ChatTrainingData"("userId");

-- CreateIndex
CREATE INDEX "ChatTrainingData_responseCategory_idx" ON "public"."ChatTrainingData"("responseCategory");

-- CreateIndex
CREATE INDEX "ChatTrainingData_confidence_idx" ON "public"."ChatTrainingData"("confidence");

-- CreateIndex
CREATE INDEX "ChatTrainingData_createdAt_idx" ON "public"."ChatTrainingData"("createdAt");

-- CreateIndex
CREATE INDEX "LearnedPatterns_category_idx" ON "public"."LearnedPatterns"("category");

-- CreateIndex
CREATE INDEX "LearnedPatterns_successRate_idx" ON "public"."LearnedPatterns"("successRate");

-- CreateIndex
CREATE INDEX "LearnedPatterns_isActive_idx" ON "public"."LearnedPatterns"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "LearnedPatterns_questionPattern_category_key" ON "public"."LearnedPatterns"("questionPattern", "category");

-- CreateIndex
CREATE INDEX "ChatFeedback_trainingDataId_idx" ON "public"."ChatFeedback"("trainingDataId");

-- CreateIndex
CREATE INDEX "ChatFeedback_processingStatus_idx" ON "public"."ChatFeedback"("processingStatus");

-- AddForeignKey
ALTER TABLE "public"."ChatTrainingData" ADD CONSTRAINT "ChatTrainingData_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChatTrainingData" ADD CONSTRAINT "ChatTrainingData_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChatFeedback" ADD CONSTRAINT "ChatFeedback_trainingDataId_fkey" FOREIGN KEY ("trainingDataId") REFERENCES "public"."ChatTrainingData"("id") ON DELETE CASCADE ON UPDATE CASCADE;
