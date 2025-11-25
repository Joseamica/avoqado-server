-- CreateEnum
CREATE TYPE "public"."TokenQueryType" AS ENUM ('SIMPLE_QUERY', 'COMPLEX_SINGLE', 'COMPLEX_CONSENSUS', 'RESULT_INTERPRETATION', 'INTENT_CLASSIFICATION', 'CONVERSATION');

-- CreateEnum
CREATE TYPE "public"."TokenPurchaseType" AS ENUM ('MANUAL', 'AUTO_RECHARGE', 'PROMOTIONAL');

-- CreateEnum
CREATE TYPE "public"."TokenPurchaseStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED');

-- CreateTable
CREATE TABLE "public"."ChatbotTokenBudget" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "monthlyFreeTokens" INTEGER NOT NULL DEFAULT 10000,
    "currentMonthUsed" INTEGER NOT NULL DEFAULT 0,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "extraTokensBalance" INTEGER NOT NULL DEFAULT 0,
    "overageTokensUsed" INTEGER NOT NULL DEFAULT 0,
    "overageWarningShown" BOOLEAN NOT NULL DEFAULT false,
    "autoRechargeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoRechargeThreshold" INTEGER NOT NULL DEFAULT 1000,
    "autoRechargeAmount" INTEGER NOT NULL DEFAULT 10000,
    "stripeTokenProductId" TEXT,
    "stripePriceId" TEXT,
    "totalTokensUsed" BIGINT NOT NULL DEFAULT 0,
    "totalTokensPurchased" BIGINT NOT NULL DEFAULT 0,
    "totalAmountSpent" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatbotTokenBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TokenUsageRecord" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "queryType" "public"."TokenQueryType" NOT NULL,
    "trainingDataId" TEXT,
    "estimatedCost" DECIMAL(8,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TokenPurchase" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "tokenAmount" INTEGER NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeInvoiceId" TEXT,
    "purchaseType" "public"."TokenPurchaseType" NOT NULL,
    "triggeredBy" TEXT,
    "status" "public"."TokenPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TokenPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatbotTokenBudget_venueId_key" ON "public"."ChatbotTokenBudget"("venueId");

-- CreateIndex
CREATE INDEX "ChatbotTokenBudget_venueId_idx" ON "public"."ChatbotTokenBudget"("venueId");

-- CreateIndex
CREATE INDEX "ChatbotTokenBudget_currentPeriodEnd_idx" ON "public"."ChatbotTokenBudget"("currentPeriodEnd");

-- CreateIndex
CREATE INDEX "TokenUsageRecord_budgetId_idx" ON "public"."TokenUsageRecord"("budgetId");

-- CreateIndex
CREATE INDEX "TokenUsageRecord_createdAt_idx" ON "public"."TokenUsageRecord"("createdAt");

-- CreateIndex
CREATE INDEX "TokenUsageRecord_userId_idx" ON "public"."TokenUsageRecord"("userId");

-- CreateIndex
CREATE INDEX "TokenUsageRecord_queryType_idx" ON "public"."TokenUsageRecord"("queryType");

-- CreateIndex
CREATE UNIQUE INDEX "TokenPurchase_stripePaymentIntentId_key" ON "public"."TokenPurchase"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "TokenPurchase_budgetId_idx" ON "public"."TokenPurchase"("budgetId");

-- CreateIndex
CREATE INDEX "TokenPurchase_status_idx" ON "public"."TokenPurchase"("status");

-- CreateIndex
CREATE INDEX "TokenPurchase_stripePaymentIntentId_idx" ON "public"."TokenPurchase"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "TokenPurchase_createdAt_idx" ON "public"."TokenPurchase"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."ChatbotTokenBudget" ADD CONSTRAINT "ChatbotTokenBudget_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TokenUsageRecord" ADD CONSTRAINT "TokenUsageRecord_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "public"."ChatbotTokenBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TokenPurchase" ADD CONSTRAINT "TokenPurchase_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "public"."ChatbotTokenBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
