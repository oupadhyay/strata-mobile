// An open, causal energy-balance estimate, not MacroFactor's proprietary algorithm. Fit body energy minus cumulative
// intake against elapsed calendar days; the negative slope is TDEE. Exponential weights favour recent weigh-ins.
// 7,700 kcal/kg is an approximation, not a measurement of fat loss. Water and incomplete food logs can bias the fit.
import { daysBetween } from "@/lib/time";
import type { Metric } from "@/lib/reasons";

export const ENERGY_PER_KG = 7700;
const HALF_LIFE = 7;
const WINDOW = 28;
const MIN_DAYS = 14;
const MIN_WEIGHTS = 7;
const MAX_WEIGHT_AGE = 7;

/** One local day, oldest first. Intake is the whole day's food; a weigh-in precedes that day's intake. */
export type IntakeDay = { day: string; kcal: number | null; weightKg: number | null; excluded?: boolean };
export type ExpenditureDay = {
  day: string;
  tdee: Metric<number>;
  state: "calibrating" | "ready" | "holding";
  estimatedOn: string | null;
  trendKg: Metric<number>;
  weightDay: string | null;
  intakeDays: number;
  weighIns: number;
};

export type WeightPlan = { startDay: string; startWeightKg: number; maintenanceKcal: number; targetKcal: number };

/** The original plan stays fixed when subsequent intake, targets or expenditure estimates change. */
export function plannedWeight(plan: WeightPlan, day: string): number | null {
  if (day < plan.startDay) return null;
  return plan.startWeightKg + ((plan.targetKcal - plan.maintenanceKcal) * daysBetween(plan.startDay, day)) / ENERGY_PER_KG;
}

const known = (v: number | null): v is number => v !== null && Number.isFinite(v);
const metric = (value: number | null, stale = false): Metric<number> => ({
  value,
  reason: value === null ? "calibrating" : null,
  provisional: value !== null,
  ...(stale && value !== null && { tags: ["stale_baseline"] }),
});
type WeighIn = { day: string; x: number; y: number };

/** Every estimate uses only that day and earlier data. Missing/excluded intake breaks the energy-balance interval;
 * it is never averaged away or replaced with zero. A prior estimate is held, explicitly stale, during a gap. */
export function expenditureHistory(days: readonly IntakeDay[]): ExpenditureDay[] {
  let points: WeighIn[] = [];
  let energyBefore = 0;
  let estimate: number | null = null;
  let estimatedOn: string | null = null;
  let trend: number | null = null;
  let weightDay: string | null = null;
  let previousDay: string | null = null;
  return days.map((r, i) => {
    if (previousDay !== null && daysBetween(previousDay, r.day) !== 1) {
      points = [];
      energyBefore = 0;
    }
    previousDay = r.day;
    const weight = known(r.weightKg) && r.weightKg > 0 ? r.weightKg : null;
    if (weight !== null) {
      const gap = weightDay ? daysBetween(weightDay, r.day) : 0;
      trend = trend === null || gap > MAX_WEIGHT_AGE ? weight : trend + (1 - 2 ** (-gap / HALF_LIFE)) * (weight - trend);
      weightDay = r.day;
      points.push({ day: r.day, x: i, y: ENERGY_PER_KG * weight - energyBefore });
    }
    points = points.filter((p) => daysBetween(p.day, r.day) <= WINDOW);
    const first = points[0];
    const last = points.at(-1);
    const intakeDays = first && last ? daysBetween(first.day, last.day) : 0;
    let ready = false;
    if (first && last && intakeDays >= MIN_DAYS && points.length >= MIN_WEIGHTS && daysBetween(last.day, r.day) <= MAX_WEIGHT_AGE) {
      const weighted = points.map((p) => ({ ...p, w: 2 ** (-daysBetween(p.day, r.day) / HALF_LIFE) }));
      const mass = weighted.reduce((s, p) => s + p.w, 0);
      const mx = weighted.reduce((s, p) => s + p.w * p.x, 0) / mass;
      const my = weighted.reduce((s, p) => s + p.w * p.y, 0) / mass;
      const variance = weighted.reduce((s, p) => s + p.w * (p.x - mx) ** 2, 0);
      const tdee = -weighted.reduce((s, p) => s + p.w * (p.x - mx) * (p.y - my), 0) / variance;
      // Reject an implausible fit; clamping would turn bad data into a believable number.
      if (tdee >= 800 && tdee <= 8000) {
        estimate = tdee;
        estimatedOn = last.day;
        ready = true;
      }
    }
    const out: ExpenditureDay = {
      day: r.day,
      tdee: metric(estimate, !ready),
      state: ready ? "ready" : estimate === null ? "calibrating" : "holding",
      estimatedOn,
      trendKg: metric(weightDay && daysBetween(weightDay, r.day) <= MAX_WEIGHT_AGE ? trend : null),
      weightDay,
      intakeDays,
      weighIns: points.length,
    };
    // Today's food cannot explain this morning's weigh-in. It enters tomorrow's fit, once the day has ended.
    if (r.excluded || !known(r.kcal) || r.kcal < 0) {
      points = [];
      energyBefore = 0;
    } else energyBefore += r.kcal;
    return out;
  });
}
