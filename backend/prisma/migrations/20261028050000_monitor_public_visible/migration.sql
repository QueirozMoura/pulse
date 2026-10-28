-- Visibilidade pública do monitor. Aditiva e segura: só adiciona uma coluna com DEFAULT true,
-- então todos os monitores existentes continuam públicos. Nenhuma tabela é recriada e nenhum dado é alterado.
ALTER TABLE "monitors" ADD COLUMN "public_visible" BOOLEAN NOT NULL DEFAULT true;
