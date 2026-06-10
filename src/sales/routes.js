// Sales-plan API: a 4-5-4 monthly plan vs. live Shopify wholesale actuals.
import express from "express";
import { generatePeriods } from "./calendar.js";
import { fetchWholesaleActuals } from "./shopify-actuals.js";
import {
  ensurePeriods, getAnnualGoal, setAnnualGoal,
  getTargets, setTarget, setTargets
} from "./db.js";

const round = (n) => Math.round(Number(n) || 0);
const todayStr = () => new Date().toISOString().slice(0, 10);

// "Difference across the rest of the year": lock closed months to their actuals,
// then spread (goal - locked) across the still-open months weighted by selling
// weeks. The result always sums to the annual goal.
function suggestTargets({ periods, actualsByPeriod, annualGoal, today }) {
  const closedActual = periods
    .filter((p) => p.ends_on < today)
    .reduce((sum, p) => sum + (actualsByPeriod[p.period_index] || 0), 0);
  const openPeriods = periods.filter((p) => p.ends_on >= today);
  const openWeeks = openPeriods.reduce((s, p) => s + p.weeks, 0);
  const remaining = Math.max(0, annualGoal - closedActual);

  const out = {};
  for (const p of periods) {
    if (p.ends_on < today) {
      out[p.period_index] = round(actualsByPeriod[p.period_index] || 0);
    } else if (openWeeks > 0) {
      out[p.period_index] = round((remaining * p.weeks) / openWeeks);
    } else {
      out[p.period_index] = 0;
    }
  }
  return out;
}

function parseFy(req) {
  const fy = parseInt(req.query.fy || req.body?.fiscal_year, 10);
  return Number.isFinite(fy) ? fy : 2026;
}

export function createSalesRouter({ shopifyGraphQL }) {
  const router = express.Router();

  // Full plan + live actuals in one payload.
  router.get("/api/sales/plan", async (req, res) => {
    try {
      const fy = parseFy(req);
      const today = todayStr();
      const periods = await ensurePeriods(fy);
      const annualGoal = await getAnnualGoal(fy);

      let actuals;
      try {
        actuals = await fetchWholesaleActuals({ shopifyGraphQL, fiscalYear: fy, today });
      } catch (err) {
        return res.status(502).json({
          error: "Could not load Shopify wholesale actuals.",
          detail: err.message
        });
      }

      // Auto-seed the plan the first time so the dashboard is never empty.
      let targets = await getTargets(fy);
      let seeded = false;
      if (Object.keys(targets).length === 0) {
        targets = suggestTargets({ periods, actualsByPeriod: actuals.byPeriod, annualGoal, today });
        await setTargets(fy, targets);
        seeded = true;
      }

      const currentPeriod = periods.find((p) => p.starts_on <= today && today <= p.ends_on);
      const rows = periods.map((p) => {
        const target = Number(targets[p.period_index] || 0);
        const actual = round(actuals.byPeriod[p.period_index] || 0);
        const isClosed = p.ends_on < today;
        const isCurrent = currentPeriod && p.period_index === currentPeriod.period_index;
        return {
          period_index: p.period_index,
          label: p.label,
          starts_on: p.starts_on,
          ends_on: p.ends_on,
          weeks: p.weeks,
          target,
          actual,
          delta: actual - target,
          attainment: target > 0 ? actual / target : null,
          status: isClosed ? "closed" : isCurrent ? "current" : "future"
        };
      });

      const bookedYTD = round(actuals.total);
      const plannedTotal = rows.reduce((s, r) => s + r.target, 0);
      const remainingToGoal = Math.max(0, annualGoal - bookedYTD);
      const openPeriods = rows.filter((r) => r.status !== "closed");
      const openWeeks = openPeriods.reduce((s, r) => s + r.weeks, 0);

      res.json({
        fiscal_year: fy,
        annual_goal: annualGoal,
        as_of: actuals.asOf,
        source: actuals.source,
        seeded,
        periods: rows,
        totals: {
          goal: annualGoal,
          booked_ytd: bookedYTD,
          planned_total: plannedTotal,
          remaining_to_goal: remainingToGoal,
          attainment_to_goal: annualGoal > 0 ? bookedYTD / annualGoal : null,
          open_periods: openPeriods.length,
          avg_needed_per_open_period: openPeriods.length
            ? round(remainingToGoal / openPeriods.length) : 0,
          avg_needed_per_open_week: openWeeks
            ? round(remainingToGoal / openWeeks) : 0
        },
        by_vendor: actuals.byVendor
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Set one month's target.
  router.put("/api/sales/plan/target", express.json(), async (req, res) => {
    try {
      const fy = parseFy(req);
      const idx = parseInt(req.body.period_index, 10);
      const amount = Number(req.body.target_amount);
      if (!(idx >= 1 && idx <= 12) || !Number.isFinite(amount)) {
        return res.status(400).json({ error: "period_index (1-12) and target_amount required" });
      }
      await ensurePeriods(fy);
      await setTarget(fy, idx, amount);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Change the annual goal (does not reseed; call /reseed to redistribute).
  router.put("/api/sales/plan/goal", express.json(), async (req, res) => {
    try {
      const fy = parseFy(req);
      const amount = Number(req.body.annual_goal);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: "annual_goal must be a non-negative number" });
      }
      const goal = await setAnnualGoal(fy, amount);
      res.json({ ok: true, annual_goal: goal });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rebuild the monthly targets from the current goal + live actuals
  // (closed months locked to actuals, remainder spread across open months).
  router.post("/api/sales/plan/reseed", express.json(), async (req, res) => {
    try {
      const fy = parseFy(req);
      const today = todayStr();
      const periods = await ensurePeriods(fy);
      const annualGoal = await getAnnualGoal(fy);
      const actuals = await fetchWholesaleActuals({ shopifyGraphQL, fiscalYear: fy, today });
      const targets = suggestTargets({ periods, actualsByPeriod: actuals.byPeriod, annualGoal, today });
      await setTargets(fy, targets);
      res.json({ ok: true, targets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
