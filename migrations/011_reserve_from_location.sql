-- On-hand reservations can draw from Bogota as well as Warehouse (same
-- building; Warehouse is drained first). Each reservation records which
-- location its units are held at so the transfer moves Shopify inventory
-- from the right place. Safe to run more than once.

ALTER TABLE wholesale_reservations ADD COLUMN IF NOT EXISTS from_location TEXT;

-- Everything reserved before this migration came from the Warehouse.
UPDATE wholesale_reservations
   SET from_location = 'Warehouse'
 WHERE source = 'on_hand' AND from_location IS NULL;
