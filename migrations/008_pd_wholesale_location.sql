-- Register 'Wholesale' as a pd allocation/receiving destination. Cross-schema
-- on purpose: the pd row is required by the same feature migration 007 ships
-- (yb-pd's allocation pre-pass + Wholesale receive bucket), all apps share one
-- database/role, and this runner is the only one that executes on every boot.
-- Kept in its own file so a permission hiccup could never block 007's tables.
INSERT INTO pd.location (name) VALUES ('Wholesale') ON CONFLICT (name) DO NOTHING;
