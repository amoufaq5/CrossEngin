-- Runs once, on first initialisation of an empty data directory.
-- Enables uuid_generate_v7() for the whole database so the migration applier's
-- pg_uuidv7 precondition passes and every meta.* id default resolves.
CREATE EXTENSION IF NOT EXISTS pg_uuidv7;
