-- CreateTable
CREATE TABLE "CrmErased" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "erasedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmErased_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmErased_keyHash_scope_key" ON "CrmErased"("keyHash", "scope");
