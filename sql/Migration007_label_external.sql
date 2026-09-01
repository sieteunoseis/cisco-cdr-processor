-- sql/Migration007_label_external.sql
-- Marks a label rule as denoting numbers that are never internal DNs (e.g.
-- Spam), so the DN Map can exclude them from its label picker.
ALTER TABLE label_rules ADD COLUMN IF NOT EXISTS external BOOLEAN NOT NULL DEFAULT false;

-- Existing Spam rules were created by the spam-check flow before this
-- column existed — they're external by definition, so backfill them.
UPDATE label_rules SET external = true WHERE label = 'Spam' AND external = false;
