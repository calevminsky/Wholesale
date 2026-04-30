-- Store the Shopify customer GID so it can be attached to orders on submission.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS shopify_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_customers_shopify_id
  ON customers (shopify_id) WHERE shopify_id IS NOT NULL AND archived_at IS NULL;
