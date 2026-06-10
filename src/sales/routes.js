// Sales-plan API: a 4-5-4 monthly plan vs. wholesale actuals from the reporting
// DB (yb_reports). No Shopify API dependency — everything is Postgres.
import express from "express";
import { getFiscalPeriods, getCurrentFiscalPosition, periodStatus } from "./calendar.js";
import { fetchWholesaleActuals } from "./actuals.js";
import { getAnnualGoal, setAnnualGoal, getTargets, setTarget, setTargets } from "./db.js";

const round = (n) => Math.round(Number(n) || 0);

// "Difference across the rest of the year": lock closed months to their actuals,
// then spread (goal - locked) across the still-open months weighted by selling
// weeks. Always sums to the annual goal.
function suggestTargets({ periods, actualsByPeriod, annualGoal, current, fiscalYear }) {
  const status = (p) => periodStatus(fiscalYear, p.period_index, current);
  const closedActual = periods
    .filter((p) => status(p) === "closed")
    .reduce((sum, p) => sum + (actualsByPeriod[p.period_index] || 0), 0);
  const openWeeks = periods
    .filter((p) => status(p) !== "closed")
    .reduce((s, p) => s + p.weeks, 0);
  const remaining = Math.max(0, annualGoal - closedActual);

  const out = {};
  for (const p of periods) {
    if (status(p) === "closed") out[p.period_index] = round(actualsByPeriod[p.period_index] || 0);
    else if (openWeeks > 0) out[p.period_index] = round((remaining * p.weeks) / openWeeks);
    else out[p.period_index] = 0;
  }
  return out;
}

async function resolveFy(req) {
  const raw = parseInt(req.query.fy || req.body?.fiscal_year, 10);
  if (Number.isFinite(raw)) return raw;
  return (await getCurrentFiscalPosition()).fiscal_year;
}

export function createSalesRouter() {
  const router = express.Router();

  router.get("/api/sales/plan", async (req, res) => {
    try {
      const fy = await resolveFy(req);
      const current = await getCurrentFiscalPosition();
      const periods = await getFiscalPeriods(fy);
      if (periods.length === 0) {
        return res.status(404).json({ error: `No fiscal_calendar rows for FY${fy}.` });
      }
      const annualGoal = await getAnnualGoal(fy);
      const actuals = await fetchWholesaleActuals(fy);

      // Auto-seed the plan the first time so the dashboard is never empty.
      let targets = await getTargets(fy);
      let seeded = false;
      if (Object.keys(targets).length === 0) {
        targets = suggestTargets({ periods, actualsByPeriod: actuals.byPeriod, annualGoal, current, fiscalYear: fy });
        await setTargets(fy, targets);
        seeded = true;
      }

      const rows = periods.map((p) => {
        const target = Number(targets[p.period_index] || 0);
        const actual = round(actuals.byPeriod[p.period_index] || 0);
        const status = periodStatus(fy, p.period_index, current);
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
          status
        };
      });

      const bookedYTD = round(actuals.total);
      const plannedTotal = rows.reduce((s, r) => s + r.target, 0);
      const remainingToGoal = Math.max(0, annualGoal - bookedYTD);
      const openRows = rows.filter((r) => r.status !== "closed");
      const openWeeks = openRows.reduce((s, r) => s + r.weeks, 0);

      res.json({
        fiscal_year: fy,
        annual_goal: annualGoal,
        as_of: actuals.asOf,
        source: "yb_reports",
        seeded,
        periods: rows,
        totals: {
          goal: annualGoal,
          booked_ytd: bookedYTD,
          planned_total: plannedTotal,
          remaining_to_goal: remainingToGoal,
          attainment_to_goal: annualGoal > 0 ? bookedYTD / annualGoal : null,
          open_periods: openRows.length,
          avg_needed_per_open_period: openRows.length ? round(remainingToGoal / openRows.length) : 0,
          avg_needed_per_open_week: openWeeks ? round(remainingToGoal / openWeeks) : 0
        },
        by_vendor: actuals.byVendor
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/api/sales/plan/target", express.json(), async (req, res) => {
    try {
      const fy = await resolveFy(req);
      const idx = parseInt(req.body.period_index, 10);
      const amount = Number(req.body.target_amount);
      if (!(idx >= 1 && idx <= 12) || !Number.isFinite(amount)) {
        return res.status(400).json({ error: "period_index (1-12) and target_amount required" });
      }
      await setTarget(fy, idx, amount);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/api/sales/plan/goal", express.json(), async (req, res) => {
    try {
      const fy = await resolveFy(req);
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

  // Rebuild monthly targets from the current goal + live actuals (closed months
  // locked to actuals, remainder spread across open months by selling weeks).
  router.post("/api/sales/plan/reseed", express.json(), async (req, res) => {
    try {
      const fy = await resolveFy(req);
      const current = await getCurrentFiscalPosition();
      const periods = await getFiscalPeriods(fy);
      const annualGoal = await getAnnualGoal(fy);
      const actuals = await fetchWholesaleActuals(fy);
      const targets = suggestTargets({ periods, actualsByPeriod: actuals.byPeriod, annualGoal, current, fiscalYear: fy });
      await setTargets(fy, targets);
      res.json({ ok: true, targets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
