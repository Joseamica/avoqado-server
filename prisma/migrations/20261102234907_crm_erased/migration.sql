-- CreateTable
CREATE TABLE "CrmErased" (
    "keyHash" TEXT NOT NULL,
    "erasedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmErased_pkey" PRIMARY KEY ("keyHash")
);
