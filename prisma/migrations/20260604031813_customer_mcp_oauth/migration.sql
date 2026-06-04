-- CreateTable
CREATE TABLE "public"."mcp_oauth_clients" (
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT,
    "clientName" TEXT,
    "redirectUris" TEXT[],
    "grantTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope" TEXT,
    "tokenEndpointAuthMethod" TEXT DEFAULT 'none',
    "clientIdIssuedAt" INTEGER,
    "clientSecretExpiresAt" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("clientId")
);

-- CreateTable
CREATE TABLE "public"."mcp_auth_codes" (
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "activeOrg" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resource" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_auth_codes_pkey" PRIMARY KEY ("codeHash")
);

-- CreateTable
CREATE TABLE "public"."mcp_refresh_tokens" (
    "tokenHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "activeOrg" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_refresh_tokens_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE INDEX "mcp_auth_codes_expiresAt_idx" ON "public"."mcp_auth_codes"("expiresAt");

-- CreateIndex
CREATE INDEX "mcp_refresh_tokens_staffId_idx" ON "public"."mcp_refresh_tokens"("staffId");

-- CreateIndex
CREATE INDEX "mcp_refresh_tokens_expiresAt_idx" ON "public"."mcp_refresh_tokens"("expiresAt");
