-- Embedding dedupe was removed: cross-language duplicates (GeekNews KR vs HN EN) scored
-- 0.37-0.63 and never crossed the threshold. The ranker now flags duplicates instead.
alter table topics drop column embedding;
