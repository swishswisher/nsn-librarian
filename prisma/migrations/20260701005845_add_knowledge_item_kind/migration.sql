-- CreateEnum
CREATE TYPE "KnowledgeItemKind" AS ENUM ('DOCUMENT', 'IMAGE', 'AUDIO', 'VIDEO', 'EMAIL', 'PRESENTATION', 'SPREADSHEET', 'ARCHIVE', 'UNKNOWN');

-- AlterTable
ALTER TABLE "LibraryDocument" ADD COLUMN     "itemKind" "KnowledgeItemKind" NOT NULL DEFAULT 'DOCUMENT';

-- CreateIndex
CREATE INDEX "LibraryDocument_itemKind_idx" ON "LibraryDocument"("itemKind");
