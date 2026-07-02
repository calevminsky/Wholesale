-- Two distinct populations share wholesale_orders and must not be conflated:
--   origin 'importer' — real-time orders (rep uploads / manual drafts) filled
--                       immediately from existing stock via preview -> submit.
--                       These NEVER feed the preorder-fulfillment ledger.
--   origin 'portal'   — buyer self-service portal orders (mixed preorder +
--                       in-stock). Only these drive wholesale_open_demand,
--                       the on-hand sweep, and the yb-reports dashboard.
-- Safe to run more than once.

ALTER TABLE wholesale_orders
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'importer';

-- Backfill: portal-built orders tag every item with _sources like
-- "(portal:slug)" / "(season:full:slug)" / "(season:off:slug)".
UPDATE wholesale_orders
   SET origin = 'portal'
 WHERE origin = 'importer'
   AND (items::text LIKE '%(portal:%' OR items::text LIKE '%(season:%');

-- The demand views (portal-only + Shopify fallback) are defined in
-- 010_shopify_fallback.sql — see the note there on view ownership.
