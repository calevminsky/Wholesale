-- Line Sheet Builder — saved filters + line sheets.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS saved_filters (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  filter_tree JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS line_sheets (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  customer        TEXT,
  description     TEXT,
  filter_tree     JSONB NOT NULL,
  saved_filter_id INTEGER REFERENCES saved_filters(id) ON DELETE SET NULL,
  pins            TEXT[] DEFAULT '{}',
  excludes        TEXT[] DEFAULT '{}',
  pricing         JSONB DEFAULT '{}'::jsonb,
  display_opts    JSONB DEFAULT '{}'::jsonb,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_line_sheets_updated
  ON line_sheets (updated_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_line_sheets_saved_filter
  ON line_sheets (saved_filter_id);
