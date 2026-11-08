// The fork's energy-balance view, kept separate from Pulse's wearable calorie totals and stored recovery scores.
import { expenditureHistory, plannedWeight, type WeightPlan } from "@/core/algorithms/expenditure";
import { exerciseEnergy } from "@/core/algorithms/exerciseEnergy";
import type { Profile } from "@/data/types";
import { addDays, daysBetween, localMidnight, wholeYears } from "@/lib/time";
import { quantity } from "@/lib/units";
import { finite, maybe, type DayRow, type QueryCtx } from "./common";

/** An explicit review overrides automatic missing-energy detection, without changing imported records. */
export function incompleteDay(row: DayRow | undefined, review?: Profile["nutrition"]): boolean {
  if (!row) return false;
  if (review?.excludedDays.includes(row.day)) return true;
  return (row.extra.nutrition_missing_energy ?? 0) > 0 && !review?.completeDays?.includes(row.day);
}

export function intakeOf(row: DayRow | undefined, review?: Profile["nutrition"]): number | null {
  if (incompleteDay(row, review)) return null;
  return finite(row?.extra.calories_in) ? row.extra.calories_in : null;
}

export async function getNutritionEnergy(ctx: QueryCtx, rows: Map<string, DayRow>, day: string, customKcal: number | null) {
  const review = ctx.profile.nutrition;
  const history = expenditureHistory([...rows.values()].map((r) => ({ day: r.day, kcal: intakeOf(r, review), weightKg: r.metrics?.weightKg ?? null })));
  const current = history.at(-1)!;
  const byDay = new Map(history.map((h) => [h.day, h]));
  const from = localMidnight(addDays(day, -6), ctx.timeZone);
  const to = Math.min(ctx.now, localMidnight(addDays(day, 1), ctx.timeZone));
  const exercises = (await ctx.store.allExercises()).filter((e) => e.startTs < to && e.endTs > from);
  const hr = exercises.length ? await ctx.store.readHr(from - 60, to) : [];
  const weights = [...rows.values()].reverse();
  const netHistory = Array.from({ length: 61 }, (_, i) => {
    const d = addDays(day, i - 60);
    const row = rows.get(d);
    // An early fit is display-only; the calibrated baseline and target inputs remain unchanged.
    const estimate = byDay.get(d);
    const calculatedExpenditure = estimate?.state === "ready" ? estimate.tdee
      : estimate?.state === "calibrating" ? estimate.preliminaryTdee : maybe(null, "calibrating");
    const expenditureState = estimate?.state === "calibrating" && calculatedExpenditure.value !== null
      ? "preliminary" as const : estimate?.state ?? "calibrating";
    const intake = intakeOf(row, review);
    const status = incompleteDay(row, review) ? "partial" as const
      : d >= ctx.today ? "ongoing" as const : intake === null ? "missing" as const : "complete" as const;
    return { day: d, status, intake, expenditureState, calculatedExpenditure,
      calculatedNet: maybe(status === "complete" && intake !== null && calculatedExpenditure.value !== null ? intake - calculatedExpenditure.value : null, "no_data", true) };
  });
  // HR stays a seven-day batch: longer net comparisons do not scan extra samples or invent older coverage.
  const comparisonDays = netHistory.slice(-7).map((d) => {
    const start = localMidnight(d.day, ctx.timeZone);
    const end = Math.min(ctx.now, localMidnight(addDays(d.day, 1), ctx.timeZone));
    const weightKg = weights.find((r) => r.day <= d.day && r.day >= addDays(d.day, -30) && finite(r.metrics?.weightKg))?.metrics?.weightKg ?? null;
    const age = wholeYears(ctx.profile.birthDate, d.day);
    const activity = exerciseEnergy(exercises, hr, start, end, { sex: ctx.profile.sex, age, weightKg });
    const height = ctx.profile.heightCm;
    // Mifflin–St Jeor (1990), doi:10.1093/ajcn/51.2.241: resting kcal per 24 h, not measured BMR.
    const resting = age >= 19 && age <= 78 && finite(weightKg) && weightKg > 0 && finite(height) && height > 0
      ? 10 * weightKg + 6.25 * height - 5 * age + (ctx.profile.sex === "male" ? 5 : -161)
      : null;
    const bmr = maybe(resting !== null && resting > 0 ? resting : null, "no_data", true);
    // TotalCaloriesBurned already includes rest. Only ActiveCaloriesBurned belongs on top of BMR.
    const active = rows.get(d.day)?.extra.active_calories;
    const wearableActive = maybe(finite(active) && active >= 0 ? active : null, "no_data", true);
    return { ...d, bmr, activity, wearableActive,
      wearableNet: maybe(d.status === "complete" && d.intake !== null && bmr.value !== null && wearableActive.value !== null
        ? d.intake - bmr.value - wearableActive.value : null, "no_data", true) };
  });
  // Equal calendar windows; never substitute zero for unavailable net. Coverage accompanies every mean/delta.
  const completed = netHistory.filter((d) => d.day < ctx.today);
  const netTrends = ([7, 30] as const).map((span) => {
    const end = day < ctx.today ? day : addDays(day, -1);
    const average = (offset: number) => {
      const to = addDays(end, -offset);
      const from = addDays(to, 1 - span);
      const usable = completed.filter((d) => d.day >= from && d.day <= to && d.calculatedNet.value !== null);
      return { from, to, days: usable.length, value: usable.length ? usable.reduce((s, d) => s + d.calculatedNet.value!, 0) / usable.length : null,
        preliminary: usable.some((d) => d.expenditureState === "preliminary") };
    };
    const recent = average(0);
    const previous = average(span);
    return { span, recent, previous, change: recent.value !== null && previous.value !== null ? recent.value - previous.value : null };
  });
  const activity = comparisonDays.at(-1)!.activity;
  const q = quantity("kg", ctx.profile.display?.units);
  const goalKg = review?.goalWeightKg ?? null;
  const observed = history.filter((h) => h.day >= addDays(day, -28) && finite(rows.get(h.day)?.metrics?.weightKg) && h.trendKg.value !== null);
  const first = observed[0];
  const last = observed.at(-1);
  const span = first && last ? daysBetween(first.day, last.day) : 0;
  const fresh = !!last && daysBetween(last.day, day) <= 7;
  const paceKg = observed.length >= 3 && span >= 14 && fresh ? (last!.trendKg.value! - first!.trendKg.value!) * 7 / span : null;
  const distance = goalKg !== null && current.trendKg.value !== null ? goalKg - current.trendKg.value : null;
  const goalState = goalKg === null ? "unset" as const : !fresh || distance === null ? "needWeights" as const
    : Math.abs(distance) <= 0.1 ? "reached" as const : paceKg === null ? "needWeights" as const
      : Math.abs(paceKg) < 0.05 ? "steady" as const : distance * paceKg <= 0 ? "away" as const : "estimate" as const;
  const goalWeeks = goalState === "estimate" ? Math.max(1, Math.ceil(distance! / paceKg!)) : null;
  const plan = ctx.profile.nutrition?.plan ?? null;
  const expectedKg = plan ? plannedWeight(plan, day) : null;
  const planCandidate: WeightPlan | null = day === ctx.today && !plan && customKcal !== null && current.state === "ready" && current.weightDay === day && current.trendKg.value !== null
    ? { startDay: day, startWeightKg: current.trendKg.value, maintenanceKcal: current.tdee.value!, targetKcal: customKcal }
    : null;
  const kcalIn = intakeOf(rows.get(day), review);
  return {
    ...current,
    excluded: incompleteDay(rows.get(day), review),
    missingEnergy: (rows.get(day)?.extra.nutrition_missing_energy ?? 0) > 0,
    // A partial current day or a held calibration cannot substantiate a daily deficit.
    deficit: day < ctx.today && current.state === "ready" && kcalIn !== null ? current.tdee.value! - kcalIn : null,
    activity,
    comparisonDays,
    netTrends,
    goal: { state: goalState, weight: goalKg === null ? null : q.value(goalKg), weeks: maybe(goalWeeks, "no_data", true), pace: maybe(paceKg === null ? null : q.change(paceKg), "no_data", true) },
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
      return { day: d, kcalIn: intakeOf(rows.get(d), review), kcalOut: estimate?.state === "ready" ? estimate.tdee.value : null };
    }),
  };
}
