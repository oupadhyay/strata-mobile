// The fork's energy-balance view, kept separate from Pulse's wearable calorie totals and stored recovery scores.
import { expenditureHistory, plannedWeight, type WeightPlan } from "@/core/algorithms/expenditure";
import { exerciseEnergy } from "@/core/algorithms/exerciseEnergy";
import { addDays, localMidnight, wholeYears } from "@/lib/time";
import { quantity } from "@/lib/units";
import { finite, type DayRow, type QueryCtx } from "./common";

export function intakeOf(row: DayRow | undefined, excluded = false): number | null {
  if (excluded || (row?.extra.nutrition_missing_energy ?? 0) > 0) return null;
  return finite(row?.extra.calories_in) ? row.extra.calories_in : null;
}

export async function getNutritionEnergy(ctx: QueryCtx, rows: Map<string, DayRow>, day: string, customKcal: number | null) {
  const excluded = new Set(ctx.profile.nutrition?.excludedDays ?? []);
  const history = expenditureHistory([...rows.values()].map((r) => ({ day: r.day, kcal: intakeOf(r), weightKg: r.metrics?.weightKg ?? null, excluded: excluded.has(r.day) })));
  const current = history.at(-1)!;
  const byDay = new Map(history.map((h) => [h.day, h]));
  const from = localMidnight(day, ctx.timeZone);
  const to = Math.min(ctx.now, localMidnight(addDays(day, 1), ctx.timeZone));
  const exercises = (await ctx.store.allExercises()).filter((e) => e.startTs < to && e.endTs > from);
  const hr = exercises.length ? await ctx.store.readHr(from - 60, to) : [];
  const recentWeight = [...rows.values()].reverse().find((r) => r.day >= addDays(day, -30) && finite(r.metrics?.weightKg))?.metrics?.weightKg ?? null;
  const activity = exerciseEnergy(exercises, hr, from, to, { sex: ctx.profile.sex, age: wholeYears(ctx.profile.birthDate, day), weightKg: recentWeight });
  const q = quantity("kg", ctx.profile.display?.units);
  const plan = ctx.profile.nutrition?.plan ?? null;
  const expectedKg = plan ? plannedWeight(plan, day) : null;
  const planCandidate: WeightPlan | null = day === ctx.today && !plan && customKcal !== null && current.state === "ready" && current.weightDay === day && current.trendKg.value !== null
    ? { startDay: day, startWeightKg: current.trendKg.value, maintenanceKcal: current.tdee.value!, targetKcal: customKcal }
    : null;
  const kcalIn = intakeOf(rows.get(day), excluded.has(day));
  return {
    ...current,
    excluded: excluded.has(day),
    missingEnergy: (rows.get(day)?.extra.nutrition_missing_energy ?? 0) > 0,
    // A partial current day or a held calibration cannot substantiate a daily deficit.
    deficit: day < ctx.today && current.state === "ready" && kcalIn !== null ? current.tdee.value! - kcalIn : null,
    activity,
    wearableKcal: rows.get(day)?.metrics?.calories ?? null,
    weight: { ...current.trendKg, value: current.trendKg.value === null ? null : q.value(current.trendKg.value) },
    weightUnit: q.unit,
    expectedWeight: expectedKg === null ? null : q.value(expectedKg),
    planGap: expectedKg === null || current.trendKg.value === null || current.weightDay !== day ? null : q.change(current.trendKg.value - expectedKg),
    planCandidate,
    planStart: plan?.startDay ?? null,
    weightHistory: history.map((h) => ({ date: h.day, value: rows.get(h.day)?.metrics?.weightKg == null || h.trendKg.value === null ? null : q.value(h.trendKg.value) })),
    balanceDays: Array.from({ length: 7 }, (_, i) => {
      const d = addDays(day, i - 6);
      const estimate = byDay.get(d);
      return { day: d, kcalIn: intakeOf(rows.get(d), excluded.has(d)), kcalOut: estimate?.state === "ready" ? estimate.tdee.value : null };
    }),
  };
}
