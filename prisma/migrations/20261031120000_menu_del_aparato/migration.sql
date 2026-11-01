-- Menú del aparato (31-oct-2026): «¿Dónde se usa?» en Menu y la tabla puente TerminalMenu.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Menu" ADD COLUMN "appliesToDevices" BOOLEAN NOT NULL DEFAULT true,
                   ADD COLUMN "appliesToOnline"  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Menu" ADD CONSTRAINT "Menu_appliesTo_alguno_check" CHECK ("appliesToDevices" OR "appliesToOnline");
CREATE TABLE "TerminalMenu" (
  "id" TEXT NOT NULL, "terminalId" TEXT NOT NULL, "menuId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TerminalMenu_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "TerminalMenu_terminalId_menuId_key" ON "TerminalMenu"("terminalId", "menuId");
CREATE INDEX "TerminalMenu_menuId_idx" ON "TerminalMenu"("menuId");
ALTER TABLE "TerminalMenu" ADD CONSTRAINT "TerminalMenu_terminalId_fkey" FOREIGN KEY ("terminalId")
  REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TerminalMenu" ADD CONSTRAINT "TerminalMenu_menuId_fkey" FOREIGN KEY ("menuId")
  REFERENCES "Menu"("id") ON DELETE CASCADE ON UPDATE CASCADE;
