-- CreateTable
CREATE TABLE "mcp_tool_calls" (
    "id" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "staffId" TEXT,
    "orgId" TEXT,
    "venueId" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_tool_calls_createdAt_idx" ON "mcp_tool_calls"("createdAt");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_outcome_createdAt_idx" ON "mcp_tool_calls"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_venueId_createdAt_idx" ON "mcp_tool_calls"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_staffId_createdAt_idx" ON "mcp_tool_calls"("staffId", "createdAt");
