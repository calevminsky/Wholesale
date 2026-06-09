# Yakira Bella — Wholesale Ordering Portal

Buyer-facing catalog + cart for the wholesale offer. Buyers browse (by style or
by color), key quantities per size, choose shipping, review, and produce an order
in the exact shape the internal **wholesale importer** (this repo's Express app)
already ingests. The portal never touches inventory or Shopify orders — the
importer stays the system of record.

## Layout

```
wholesale-portal/
  server.mjs               # serves the portal + password-gated admin + rebuild API
  index.html app.js styles.css   # the buyer portal
  admin/                   # /admin — set off-price rules + per-style overrides
  build/
    build-catalog.mjs      # catalog pipeline (DB + Shopify + pricing -> catalog.json)
    build-accounts.mjs     # vendor links from the customers table -> accounts.json
    airtable-preorder.mjs  # fetch "Wholesale Fall2026" rows -> airtable-preorder.json
    airtable-preorder.json # pre-order snapshot the build merges in (committed)
    hidden.json            # optional {ids,handles,titles} excluded from catalog
    tiers.config.json      # FULL-tier rule (50% of MSRP) — full price only
    off-pricing.json       # OFF-tier rule + per-style overrides (edited via /admin)
    off-pricing.mjs        # shared off-rule model (build + admin)
    accounts.json          # token -> {name, slug, customer_id} (generated)
    assignments.json       # F26 price-assignment seed (full/off per product)
    handles.cache.json     # gid -> Shopify handle (committed; build keeps it warm)
  data/catalog.json        # generated artifact the buyer portal reads
```

## Run

```bash
cd wholesale-portal
node server.mjs                 # http://localhost:10000  (PORT to override)
#   buyer portal:  /?t=<token>
#   admin:         /admin   (set ADMIN_PASSWORD to gate it)
```
Run it with `server.mjs` (not a bare static server): account resolution
(`/api/account`) and the admin's save/rebuild both need it. The `build/` folder
(tokens, emails, pricing config) is deliberately **not** served to browsers.

## Browsing

Buyers land on **Non-Core** styles (the default), with **Core** and **All**
toggles. Off-price is hidden from the line sheet for now (the off-price admin
still exists for when it's re-enabled). Quantities are open — buyers type any
number per size; no on-hand counts are shown.

## Removing products (Emily's link)

A secret-link page lets a non-admin curate the line sheet:
`https://wholesale.yakirabella.com/curate?key=<CURATE_KEY>`. Tick styles → **Remove
selected** → buyers stop seeing them immediately. "Currently removed" lists them
with a **restore**. The page is disabled (404) until `CURATE_KEY` is set, so the
unguessable link is the only way in — no password.

Removals are **durable**: they're stored in Postgres (`wholesale_portal_hidden`
table in `yb_reports`, auto-created), and the server filters the served catalog
by that list at request time. So a removal takes effect instantly (no rebuild)
**and survives every redeploy/restart** — unlike the off-price/rebuild path,
which is recomputed on rebuild. The committed `data/catalog.json` is never
mutated by removals; it's filtered on the way out.

## Pricing

Prices use the SAME engine as the internal line-sheet builder
(`../src/linesheets/pricing.js`), so portal prices never drift. All whole dollars.

- **Full price** = 50% of MSRP (compare-at), floored at cost. Set in
  `build/tiers.config.json`. Buyers see a clean price (no discount framing).
- **Off price** = set in **/admin**: pick a default rule (ride current price /
  % off MSRP / % off current / flat price) and/or an exact override per style.
  Click **Save & rebuild catalog** to apply. Off-price cards show the markdown
  deal (struck MSRP + % off). Off styles not marked down in Shopify are logged
  by the build as "no wholesale discount."

## Vendors (wholesale accounts)

Generated from the importer's `customers` table, so orders carry the right
`customer_id`:

```bash
node build/build-accounts.mjs --base https://wholesale.yakirabella.com
# prints a portal link per active customer; tokens are stable across runs
```

## Catalog build

```bash
node build/build-catalog.mjs                 # writes data/catalog.json
node build/build-catalog.mjs --allow-drafts  # include DRAFT products
```
Needs `REPORTING_DATABASE_URL` (+ Shopify creds for any handle-cache misses).
Reuses the importer's `.env` automatically when run inside this repo.

### Pre-order styles (pre-season F26 from Airtable)

Upcoming F26 buys that aren't in Shopify yet (no handle, no on-hand stock) can't
flow through the availability-driven build above. They come from Airtable instead:
any **Products** row with the **Wholesale Fall2026** checkbox ticked. The build
merges them in **as Full-price styles** (same 50%-of-MSRP rule) — they're not
called out separately in the UI, just shown without live stock counts. Styles
still missing an MSRP show **Price TBD** and aren't orderable until priced.

**Estimated delivery.** Every card shows an est. delivery date, filterable
("By &lt;date&gt;") and sortable, and matched by search. In-stock styles =
**today + `delivery_default_days`** (14), computed live in the browser so it stays
fresh. Pre-stock styles = **Airtable `TrueETA` + 7 days** baked in at build
(`est_delivery`); no ETA → "Delivery TBD".

```bash
# refresh the pre-order snapshot from Airtable (read-only PAT):
AIRTABLE_API_KEY=pat... node build/airtable-preorder.mjs   # -> build/airtable-preorder.json
node build/build-catalog.mjs                                # merges it into catalog.json
```

Images: Airtable hands out expiring attachment URLs, so the fetch downloads each
style's photo (Product/Swatch, else Style Image) into `data/preorder-img/<id>.<ext>`
(committed) and stores that local path. Re-fetching overwrites by record id.

De-dupe: a pre-order row is dropped if its title matches a style already coming
from Shopify, so nothing is doubled. **To hide** a pre-order style, uncheck
*Wholesale Fall2026* in Airtable and re-fetch, or add its `airtable_id`/`handle`/
`title` to `build/hidden.json`. Set `AIRTABLE_API_KEY` on Render so the nightly
build picks up Airtable edits. (Pre-order order lines carry a slug handle, not a
real Shopify handle — fine while Submit is download-only.)

## Deploy (Render, same repo)

Deploy `wholesale-portal/` as a **Web Service**: build `npm install`, start
`node server.mjs`. Set `REPORTING_DATABASE_URL`, Shopify creds, `ADMIN_PASSWORD`
(gates `/admin`), `AIRTABLE_API_KEY` (pre-order pull on rebuild), and `CURATE_KEY`
(enables the `/curate` removal link). Custom domain `wholesale.yakirabella.com`. The admin's
**Save & rebuild** regenerates the catalog on demand; a nightly Cron Job can also
run `build-catalog.mjs` to refresh availability.

## Status / next pass

Built: catalog pipeline, buyer portal (by-style/by-color browse, per-size cart,
ship-all/ship-when-ready, review), off-price admin + per-style overrides, vendor
links from customers. **Submit** downloads an importer-ready CSV + items-JSON
(hand to the team to upload). Next: `POST /api/orders` to email/auto-submit, and
hashed per-account tokens (the `?t=` token is display-only today).
