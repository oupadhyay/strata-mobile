// Calories in vs. out on the Nutrition screen: today's balance and the 7-day chart, from the in-memory store.
import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "@/data/memory";
import type { Store } from "@/data/store";
import { emptyMetrics, type Profile } from "@/data/types";
import { addDays } from "@/lib/time";
import { NO_CUSTOM } from "@/nutrition/targets";
import type { QueryCtx } from "./ctx";
import { getNutrition } from "./nutrition";

const TZ = "Asia/Kolkata";
const TODAY = "2026-10-02";
const PROFILE: Profile = { birthDate: "1990-01-01", sex: "male", maxHr: 183, heightCm: 178, timeZone: TZ };

let store: Store;
let ctx: QueryCtx;
beforeEach(() => {
  store = openMemoryStore();
  ctx = { store, profile: PROFILE, timeZone: TZ, today: TODAY, now: Date.parse(`${TODAY}T20:00:00+05:30`) / 1000, sync: { lastSyncTs: null, firstDay: null, lastError: null } };
});
const eat = (day: string, kcal: number) => store.upsertDailyValues([{ day, key: "calories_in", value: kcal }]);
const burn = (day: string, calories: number) => store.upsertMetrics([{ ...emptyMetrics(day), calories }]);

describe("calories in vs. out", () => {
  it("sums today as in, out and the balance, and zones each day against the goal", async () => {
    // Goal 2,000 (nothing burned long enough to suggest one, so the default).
    await eat(TODAY, 1092);
    await burn(TODAY, 544);
    await eat(addDays(TODAY, -1), 1700); // under
    await eat(addDays(TODAY, -2), 2000); // in zone
    await eat(addDays(TODAY, -3), 2300); // over
    const { balance } = await getNutrition(ctx, NO_CUSTOM);
    expect(balance.goal).toBe(2000);
    expect(balance.kcalIn).toEqual({ value: 1092, reason: null, provisional: true });
    expect(balance.kcalOut).toEqual({ value: 544, reason: null, provisional: true });
    expect(balance.net).toBe(548);
    expect(balance.days.map((d) => d.day)).toHaveLength(7);
    expect(balance.days[6].day).toBe(TODAY);
    expect(balance.days.slice(3, 6).map((d) => d.zone)).toEqual(["over", "in", "under"]);
    // No food, no zone and no bar; no burn, no bar.
    expect(balance.days[0]).toEqual({ day: addDays(TODAY, -6), kcalIn: null, kcalOut: null, zone: null });
  });

  it("says no data, never a number, when today has no burn or no food", async () => {
    const { balance } = await getNutrition(ctx, NO_CUSTOM);
    expect(balance.kcalIn).toEqual({ value: null, reason: "no_data", provisional: false });
    expect(balance.kcalOut).toEqual({ value: null, reason: "no_data", provisional: false });
    expect(balance.net).toBeNull();
  });

  it("measures against the person's own calorie target", async () => {
    await eat(TODAY, 1500);
    const { balance } = await getNutrition(ctx, { ...NO_CUSTOM, kcal: 1500 });
    expect(balance.goal).toBe(1500);
    expect(balance.days[6].zone).toBe("in");
  });
});

/** Morning weights independently follow 2,450 kcal/day expenditure; the wearable deliberately disagrees. */
async function seedEnergy() {
  let weightKg = 83.7;
  const rows = Array.from({ length: 40 }, (_, i) => {
    const day = addDays(TODAY, i - 39);
    const kcal = [1830, 2210, 1970, 2630, 2080][i % 5];
    const row = { day, kcal, weightKg };
    weightKg += (kcal - 2450) / 7700;
    return row;
  });
  await store.upsertMetrics(rows.map((r) => ({ ...emptyMetrics(r.day), weightKg: r.weightKg, calories: 4100 })));
  await store.upsertDailyValues(rows.flatMap((r) => [{ day: r.day, key: "calories_in", value: r.kcal }, { day: r.day, key: "protein", value: 100 }]));
  return rows;
}

describe("intake and weight energy balance", () => {
  it("browses local days causally, withholding today's deficit and never crediting wearable burn", async () => {
    const rows = await seedEnergy();
    const custom = { ...NO_CUSTOM, kcal: 1980 };
    const vm = await getNutrition(ctx, custom);
    expect(vm.energy.state).toBe("ready");
    expect(vm.energy.tdee.value).toBeCloseTo(2450, 6);
    expect(vm.energy.weight.value).toBeCloseTo(82.50066979357528, 8); // independent closed-form EWMA
    expect(vm.energy.deficit).toBeNull();
    expect(vm.targets.kcal.value).toBe(1980);
    expect(vm.energy.wearableKcal).toBe(4100);

    const yesterday = await getNutrition(ctx, custom, addDays(TODAY, -1));
    expect(yesterday.day).toBe(addDays(TODAY, -1));
    expect(yesterday.totals.kcal).toBe(2630);
    expect(yesterday.energy.deficit).toBeCloseTo(-180, 6); // a surplus, not an inverted deficit
    expect(yesterday.history.at(-1)).toMatchObject({ day: yesterday.day, kcal: 2630 });
    expect(yesterday.history.at(-1)).not.toHaveProperty("provisional");
    expect((await getNutrition(ctx, custom, addDays(TODAY, -2))).energy.deficit).toBeCloseTo(480, 6);

    const day = addDays(TODAY, -10);
    const past = await getNutrition(ctx, custom, day);
    await store.upsertMetrics(rows.filter((r) => r.day > day).map((r) => ({ ...emptyMetrics(r.day), weightKg: 100, calories: 7800 })));
    await store.upsertDailyValues(rows.filter((r) => r.day > day).map((r) => ({ day: r.day, key: "calories_in", value: 6000 })));
    expect((await getNutrition(ctx, custom, day)).energy).toEqual(past.energy);
  });

  it("shows known calories on incomplete days but withholds them from expenditure estimates", async () => {
    await seedEnergy();
    const gap = addDays(TODAY, -2);
    await store.upsertDailyValues([{ day: gap, key: "nutrition_missing_energy", value: 1 }, { day: gap, key: "protein", value: 300 }]);
    const partial = await getNutrition(ctx, NO_CUSTOM, gap);
    expect(partial.totals).toMatchObject({ kcal: 1970, protein: 300 });
    expect(partial.energy).toMatchObject({ missingEnergy: true, excluded: true });
    expect(partial.energy.deficit).toBeNull();
    expect(partial.energy.comparisonDays.at(-1)?.calculatedNet.value).toBeNull();
    const held = await getNutrition(ctx, NO_CUSTOM);
    expect(held.energy).toMatchObject({ state: "holding", tdee: { tags: ["stale_baseline"] }, deficit: null });
    expect(held.energy.comparisonDays.at(-2)).toMatchObject({ expenditureState: "holding", calculatedExpenditure: { value: null }, calculatedNet: { value: null } });
    expect(held.energy.balanceDays.at(-3)?.kcalIn).toBeNull();
    expect(held.week).toMatchObject({ kcal: 2225, protein: 100, days: 6 });

    // Macro data alone cannot supply a calorie total: do not substitute zero or a macro-derived estimate.
    await store.replaceDailyValues({ from: gap, to: gap }, ["calories_in"], []);
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [], completeDays: [gap], plan: null } };
    const unknown = await getNutrition(ctx, NO_CUSTOM, gap);
    expect(unknown.totals).toMatchObject({ kcal: null, protein: 300 });
    expect(unknown.energy).toMatchObject({ excluded: false, deficit: null });
    expect(unknown.energy.balanceDays.at(-1)?.kcalIn).toBeNull();
    await eat(gap, 1970);
    await store.replaceDailyValues({ from: gap, to: gap }, ["nutrition_missing_energy"], []);
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [gap], plan: null } };
    const reviewed = await getNutrition(ctx, NO_CUSTOM);
    expect(reviewed.energy.state).toBe("holding");
    expect(reviewed.week.days).toBe(6);
    const reviewedDay = await getNutrition(ctx, NO_CUSTOM, gap);
    expect(reviewedDay.totals).toMatchObject({ kcal: 1970, protein: 300 });
    expect(reviewedDay.energy).toMatchObject({ excluded: true, missingEnergy: false, deficit: null });
    expect(await store.dailyValues({ from: gap, to: gap })).toContainEqual({ day: gap, key: "calories_in", value: 1970 });
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [], plan: null } };
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.tdee.value).toBeCloseTo(2450, 6);
  });

  it("uses a persisted complete review for charts, averages and estimates, even after re-import", async () => {
    await seedEnergy();
    const gap = addDays(TODAY, -2);
    await store.upsertDailyValues([{ day: gap, key: "nutrition_missing_energy", value: 1 }]);
    const plan = { startDay: addDays(TODAY, -14), startWeightKg: 81.8, maintenanceKcal: 2460, targetKcal: 1910 };
    await store.setProfile({ ...PROFILE, nutrition: { excludedDays: [], completeDays: [gap], plan } });
    ctx.profile = (await store.getProfile())!;

    const reviewedDay = await getNutrition(ctx, NO_CUSTOM, gap);
    expect(reviewedDay.totals.kcal).toBe(1970);
    expect(reviewedDay.energy).toMatchObject({ excluded: false, missingEnergy: true });
    expect(reviewedDay.energy.deficit).toBeCloseTo(480, 6);
    expect(reviewedDay.energy.comparisonDays.at(-1)?.calculatedNet.value).toBeCloseTo(-480, 6);
    const reviewed = await getNutrition(ctx, NO_CUSTOM);
    expect(reviewed.energy.state).toBe("ready");
    expect(reviewed.energy.tdee.value).toBeCloseTo(2450, 6);
    expect(reviewed.energy.balanceDays.at(-3)?.kcalIn).toBe(1970);
    expect(reviewed.history.at(-3)?.kcal).toBe(1970);
    expect(reviewed.week).toMatchObject({ kcal: 2189, days: 7, coverage: Array(7).fill(true) });
    expect(reviewed.month.days).toBe(30);
    expect(reviewed.rolling.at(-1)).toMatchObject({ kcal: 2189, days: 7 });

    // Re-import rewrites source rows and flags, not the person's local review or original plan.
    const metric = (await store.allMetrics()).find((r) => r.day === gap)!;
    const values = await store.dailyValues({ from: gap, to: gap });
    await store.clearImported({ from: gap, to: gap }, 0, ctx.now);
    await store.upsertMetrics([metric]);
    await store.upsertDailyValues(values);
    ctx.profile = (await store.getProfile())!;
    expect(ctx.profile.nutrition).toEqual({ excludedDays: [], completeDays: [gap], plan });
    expect((await getNutrition(ctx, NO_CUSTOM)).energy).toEqual(reviewed.energy);

    const other = addDays(gap, 1);
    await store.upsertDailyValues([{ day: other, key: "nutrition_missing_energy", value: 1 }]);
    const scoped = await getNutrition(ctx, NO_CUSTOM);
    expect(scoped.energy.balanceDays.at(-3)?.kcalIn).toBe(1970);
    expect(scoped.energy.balanceDays.at(-2)?.kcalIn).toBeNull();
    expect((await getNutrition(ctx, NO_CUSTOM, other)).energy.excluded).toBe(true);

    // Turning it back on excludes the day again; it never deletes the known total.
    ctx.profile = { ...ctx.profile, nutrition: { excludedDays: [gap], completeDays: [], plan } };
    const excluded = await getNutrition(ctx, NO_CUSTOM, gap);
    expect(excluded.totals.kcal).toBe(1970);
    expect(excluded.energy).toMatchObject({ excluded: true, deficit: null });
    expect(excluded.energy.balanceDays.at(-1)?.kcalIn).toBeNull();
  });

  it("keeps the original plan fixed while converting weight, changes and protein explanations to the profile's units", async () => {
    await seedEnergy();
    const plan = { startDay: addDays(TODAY, -14), startWeightKg: 81.8, maintenanceKcal: 2460, targetKcal: 1910 };
    await store.setProfile({ ...PROFILE, display: { units: "metric", hours: 24 }, nutrition: { excludedDays: [], plan } });
    ctx.profile = (await store.getProfile())!;
    const custom = { ...NO_CUSTOM, kcal: 2100 };
    const kg = await getNutrition(ctx, custom);
    expect(kg.energy.expectedWeight).toBeCloseTo(80.8, 8);
    expect(kg.energy.planGap).toBeCloseTo(1.7006697935752868, 8);
    ctx.profile = { ...ctx.profile, display: { units: "imperial", hours: 12 } };
    const lb = await getNutrition(ctx, custom);
    expect(lb.energy.weightUnit).toBe("lb");
    expect(lb.energy.weight.value).toBeCloseTo(181.882842940568, 8);
    expect(lb.energy.expectedWeight).toBeCloseTo(80.8 * 2.2046226218, 8);
    expect(lb.energy.planGap).toBeCloseTo(3.7493350991280137, 8);
    expect(lb.energy.tdee).toEqual(kg.energy.tdee);
    expect(lb.targets.protein.value).toBe(kg.targets.protein.value);
    expect(lb.targets.protein.basis).toContain("g per lb");
    expect(lb.energy.weightHistory.at(-1)?.value).toBeCloseTo(181.882842940568, 8);
    expect((await store.getProfile())?.nutrition?.plan).toEqual(plan);
  });

  it("exposes older weigh-ins in profile units without inventing measurements between them", async () => {
    const first = addDays(TODAY, -209);
    const middle = addDays(TODAY, -80);
    const recent = addDays(TODAY, -2);
    await store.upsertMetrics([
      { ...emptyMetrics(first), weightKg: 88.6 },
      { ...emptyMetrics(middle), weightKg: 84.3 },
      { ...emptyMetrics(recent), weightKg: 82.9 },
      { ...emptyMetrics(addDays(TODAY, 1)), weightKg: 40.8 },
    ]);
    const vm = await getNutrition(ctx, NO_CUSTOM);
    expect(vm.energy.weightHistory).toHaveLength(210);
    expect(vm.energy.weightHistory[0]).toEqual({ date: first, value: 88.6 });
    expect(vm.energy.weightHistory.find((p) => p.date === middle)?.value).toBe(84.3);
    expect(vm.energy.weightHistory.at(-3)).toEqual({ date: recent, value: 82.9 });
    expect(vm.energy.weightHistory.filter((p) => p.value !== null)).toHaveLength(3);
    expect(vm.energy.weightHistory.at(-1)).toEqual({ date: TODAY, value: null });

    ctx.profile = { ...PROFILE, display: { units: "imperial", hours: 12 } };
    const lb = await getNutrition(ctx, NO_CUSTOM);
    expect(lb.energy.weightUnit).toBe("lb");
    expect(lb.energy.weightHistory[0].value).toBeCloseTo(195.32956429148, 8);
    const past = await getNutrition(ctx, NO_CUSTOM, middle);
    expect(past.energy.weightHistory.at(-1)).toMatchObject({ date: middle });
    expect(past.energy.weightHistory.filter((p) => p.value !== null)).toHaveLength(2);
  });

  it("plots trailing seven-calendar-day averages before the selected date, excluding unknown logs but counting recorded zero", async () => {
    const selected = addDays(TODAY, -2);
    const at = (offset: number) => addDays(selected, offset);
    const inputs = [
      [-37, 9000, 450], [-36, 1100, 55], [-34, 2300, 115], [-33, 9999, 999],
      [-32, 0, 0], [-31, 4000, 300], [-30, 1700, 85], [-29, 5200, 260],
      [-8, 3500, 175], [-7, 1400, 70], [-6, 2600, 130], [-4, 9000, 450],
      [-3, 4000, 200], [-2, 0, 0], [-1, 2000, 100], [0, 6500, 325], [1, 7000, 350],
    ];
    await store.upsertDailyValues([
      ...inputs.flatMap(([offset, kcal, protein]) => [
        { day: at(offset), key: "calories_in", value: kcal },
        { day: at(offset), key: "protein", value: protein },
      ]),
      ...[-33, -4].map((offset) => ({ day: at(offset), key: "nutrition_missing_energy", value: 1 })),
    ]);
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [at(-31), at(-3)], plan: null } };
    const vm = await getNutrition(ctx, NO_CUSTOM, selected);
    expect(vm.rolling).toHaveLength(30);
    expect(vm.rolling[0]).toEqual({ date: at(-30), kcal: 1275, protein: 63.8, carbs: null, fat: null, days: 4, span: 7, coverage: [true, false, true, false, true, false, true] });
    expect(vm.rolling.at(-1)).toEqual({ date: at(-1), kcal: 1500, protein: 75, carbs: null, fat: null, days: 4, span: 7, coverage: [true, true, false, false, false, true, true] });
    expect(vm.rolling.find((p) => p.date === at(-15))).toEqual({ date: at(-15), kcal: null, protein: null, carbs: null, fat: null, days: 0, span: 7, coverage: Array(7).fill(false) });
    // The strip keeps calendar positions, including recorded zero, but excludes unknown and reviewed logs.
    expect(vm.week).toMatchObject({ days: 4, span: 7, fat: null, coverage: [true, true, false, false, false, true, true] });
    expect(vm.month).toMatchObject({ days: 7, span: 30, coverage: Array.from({ length: 30 }, (_, i) => [0, 1, 22, 23, 24, 28, 29].includes(i)) });
    await eat(selected, 100);
    expect((await getNutrition(ctx, NO_CUSTOM, selected)).rolling).toEqual(vm.rolling);
  });

  it("offers an original plan only after calibration, with an explicit target and today's weigh-in", async () => {
    await seedEnergy();
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.planCandidate).toBeNull();
    const custom = { ...NO_CUSTOM, kcal: 1980 };
    const candidate = (await getNutrition(ctx, custom)).energy.planCandidate!;
    expect(candidate).toMatchObject({ startDay: TODAY, targetKcal: 1980 });
    expect(candidate.maintenanceKcal).toBeCloseTo(2450, 6);
    expect(candidate.startWeightKg).toBeCloseTo(82.50066979357528, 8);
    const latest = (await store.allMetrics()).at(-1)!;
    await store.upsertMetrics([{ ...latest, weightKg: null }]);
    expect((await getNutrition(ctx, custom)).energy.planCandidate).toBeNull();
  });

  it.each([
    { sex: "male" as const, heightCm: 178, weightKg: 79, bmr: 1727.5, wearable: -477.5 },
    { sex: "female" as const, heightCm: 165, weightKg: 67, bmr: 1360.25, wearable: -110.25 },
  ])("keeps wearable BMR plus active energy independent of calculated calibration ($sex)", async (expected) => {
    const day = addDays(TODAY, -1);
    ctx.profile = { ...PROFILE, sex: expected.sex, heightCm: expected.heightCm };
    await store.upsertMetrics([{ ...emptyMetrics(day), weightKg: expected.weightKg, calories: 8000 }]);
    await eat(day, 1900);
    await store.upsertDailyValues([{ day, key: "active_calories", value: 650 }]);
    const startTs = Date.parse(`${day}T10:00:00+05:30`) / 1000;
    await store.upsertExercises([{ id: "cardio", day, startTs, endTs: startTs + 1800, type: "RUNNING", name: null, calories: 9000, distanceM: null }]);
    await store.putHr(Array.from({ length: 30 }, (_, i) => ({ ts: startTs + i * 60, bpm: 120 })));
    const vm = await getNutrition(ctx, { ...NO_CUSTOM, kcal: 1975 }, day);
    const d = vm.energy.comparisonDays.at(-1)!;
    expect(d.status).toBe("complete");
    expect(d.bmr).toEqual({ value: expected.bmr, reason: null, provisional: true });
    expect(d.activity.kcal.value).not.toBeNull();
    expect(d.calculatedNet.value).toBeNull(); // even valid exercise energy is not whole-day expenditure
    expect(d.expenditureState).toBe("calibrating");
    expect(d.wearableNet.value).toBe(expected.wearable);
    expect(d.wearableActive.value).toBe(650); // not 8,000 total burn or 9,000 reported workout burn
    expect(vm.targets.kcal.value).toBe(1975);
    expect(vm.energy.state).toBe("calibrating");
    ctx.profile = { ...ctx.profile, display: { units: "imperial", hours: 12 } };
    expect((await getNutrition(ctx, { ...NO_CUSTOM, kcal: 1975 }, day)).energy.comparisonDays).toEqual(vm.energy.comparisonDays);
  });

  it("uses calibrated whole-day expenditure with twice-weekly weights, no BMR or exercise required", async () => {
    const rows = await seedEnergy();
    await store.upsertMetrics(rows.map((r, i) => ({ ...emptyMetrics(r.day), weightKg: [0, 3].includes(i % 7) ? r.weightKg : null, calories: 4100 })));
    ctx.profile = { ...PROFILE, heightCm: null }; // no estimated BMR, but calibration is valid
    const day = addDays(TODAY, -1);
    const vm = await getNutrition(ctx, { ...NO_CUSTOM, kcal: 1975 }, day);
    const d = vm.energy.comparisonDays.at(-1)!;
    expect(d).toMatchObject({ expenditureState: "ready", intake: 2630, bmr: { value: null }, activity: { kcal: { value: null } }, wearableNet: { value: null } });
    expect(d.calculatedExpenditure.value).toBeCloseTo(2450, 6);
    expect(d.calculatedNet.value).toBeCloseTo(180, 6); // not intake − BMR − exercise, wearable burn, or food target
    expect(vm.energy.comparisonDays.at(-2)?.calculatedNet.value).toBeCloseTo(-480, 6);
    expect(vm.energy.comparisonDays.every((r) => r.calculatedNet.value !== null)).toBe(true);
    const startTs = Date.parse(`${day}T10:00:00+05:30`) / 1000;
    await store.upsertExercises([
      { id: "sport", day, startTs, endTs: startTs + 120, type: "BADMINTON", name: null, calories: null, distanceM: null },
      { id: "generic", day, startTs: startTs + 120, endTs: startTs + 240, type: "OTHER_WORKOUT", name: "Racket sports", calories: null, distanceM: null,
        calorieIntervals: [2, 3].map((i) => ({ startTs: startTs + i * 60, endTs: startTs + (i + 1) * 60, kcal: 6, active: false })) },
    ]);
    const withExercise = await getNutrition(ctx, { ...NO_CUSTOM, kcal: 1975 }, day);
    expect(withExercise.energy.activity).toMatchObject({ metMinutes: 2, wearableMinutes: 2, wearableKcal: 12, coveredMinutes: 4, uncoveredMinutes: 0 });
    expect(withExercise.energy.comparisonDays.at(-1)?.calculatedNet).toEqual(d.calculatedNet);
    expect(withExercise.energy.comparisonDays.at(-1)?.calculatedExpenditure).toEqual(d.calculatedExpenditure);
    expect(withExercise.targets).toEqual(vm.targets);
    expect(withExercise.energy.netTrends).toEqual(vm.energy.netTrends);
    const earlyVm = await getNutrition(ctx, NO_CUSTOM, rows[17].day);
    const early = earlyVm.energy.comparisonDays.at(-1)!;
    expect(early.expenditureState).toBe("preliminary");
    expect(early.calculatedExpenditure.value).toBeCloseTo(2450, 6);
    expect(early.calculatedNet.value).toBeCloseTo(-480, 6);
    expect(earlyVm.energy).toMatchObject({ state: "calibrating", tdee: { value: null }, planCandidate: null });
    expect(earlyVm.targets.kcal.value).toBe(2000); // display-only, not the 2450 early fit
    // Later calibration must not relabel earlier estimates as calibrated; today's net stays withheld.
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.comparisonDays.at(-1)).toMatchObject({ expenditureState: "ready", status: "ongoing", calculatedNet: { value: null } });
  });

  it("honors complete-day review and food gaps for an early estimate without changing targets", async () => {
    const rows = await seedEnergy();
    await store.upsertMetrics(rows.map((r, i) => ({ ...emptyMetrics(r.day), weightKg: [31, 38].includes(i) ? r.weightKg : null })));
    const day = addDays(TODAY, -1);
    const selected = async () => (await getNutrition(ctx, NO_CUSTOM, day)).energy.comparisonDays.at(-1)!;
    const early = await selected();
    expect(early.expenditureState).toBe("preliminary");
    expect(early.calculatedNet.value).toBeCloseTo(180, 6);
    await store.upsertDailyValues([{ day, key: "nutrition_missing_energy", value: 1 }]);
    expect(await selected()).toMatchObject({ status: "partial", calculatedNet: { value: null } });
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [], completeDays: [day], plan: null } };
    expect((await selected()).calculatedNet.value).toBeCloseTo(180, 6);
    const gap = addDays(day, -2);
    await store.replaceDailyValues({ from: gap, to: gap }, ["calories_in"], []);
    expect(await selected()).toMatchObject({ expenditureState: "calibrating", calculatedExpenditure: { value: null }, calculatedNet: { value: null } });
    // Neither a complete review nor wearable calories can manufacture the missing intake interval.
    ctx.profile.nutrition!.completeDays!.push(gap);
    await store.upsertDailyValues([{ day, key: "active_calories", value: 650 }]);
    expect((await selected()).calculatedNet.value).toBeNull();
    const current = await getNutrition(ctx, NO_CUSTOM);
    expect(current.energy.planCandidate).toBeNull();
    expect(current.targets.kcal.value).toBe(2000);
  });

  it("withholds partial, flagged, missing and unfinished net days, but retains explicit zero", async () => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(TODAY, i - 6));
    await store.upsertMetrics(days.map((day) => ({ ...emptyMetrics(day), weightKg: 79, calories: 3000 })));
    await store.upsertDailyValues(days.flatMap((day, i) => [
      ...(i !== 5 ? [{ day, key: "calories_in", value: i === 0 ? 0 : 1900 }] : []),
      { day, key: "active_calories", value: i === 0 ? 0 : 650 },
    ]));
    await store.upsertDailyValues([{ day: days[3], key: "nutrition_missing_energy", value: 1 }]);
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [days[2]], plan: null } };
    const starts = days.map((d) => Date.parse(`${d}T10:00:00+05:30`) / 1000);
    await store.upsertExercises(days.map((day, i) => ({ id: day, day, startTs: starts[i], endTs: starts[i] + 60, type: "RUNNING", name: null, calories: null, distanceM: null })));
    await store.putHr(starts.map((ts) => ({ ts, bpm: 120 })));
    const { energy } = await getNutrition(ctx, NO_CUSTOM);
    expect(energy.comparisonDays.map((d) => d.status)).toEqual(["complete", "complete", "partial", "partial", "complete", "missing", "ongoing"]);
    for (const i of [2, 3, 5, 6]) {
      expect(energy.comparisonDays[i].calculatedNet.value).toBeNull();
      expect(energy.comparisonDays[i].wearableNet.value).toBeNull();
    }
    expect(energy.comparisonDays[0].wearableNet.value).toBe(-1727.5);
    expect(energy.comparisonDays[1].calculatedNet.value).toBeNull(); // not yet calibrated
    expect(energy.comparisonDays[1].wearableNet.value).toBe(-477.5);

    // A review clears the automatic safety check, not missing inputs or an unfinished day.
    ctx.profile = { ...ctx.profile, nutrition: { excludedDays: [days[2]], completeDays: [days[3], days[5], TODAY], plan: null } };
    const reviewed = (await getNutrition(ctx, NO_CUSTOM)).energy.comparisonDays;
    expect(reviewed.map((d) => d.status)).toEqual(["complete", "complete", "partial", "complete", "complete", "missing", "ongoing"]);
    expect(reviewed[3].intake).toBe(1900);
    expect(reviewed[3].calculatedNet.value).toBeNull(); // confirming intake cannot create calibration
    expect(reviewed[3].wearableNet.value).toBe(-477.5);
    for (const i of [2, 5, 6]) {
      expect(reviewed[i].calculatedNet.value).toBeNull();
      expect(reviewed[i].wearableNet.value).toBeNull();
    }
    ctx.profile = { ...ctx.profile, nutrition: { excludedDays: [days[2], days[3]], completeDays: [days[3]], plan: null } };
    const excluded = (await getNutrition(ctx, NO_CUSTOM)).energy.comparisonDays[3];
    expect(excluded.status).toBe("partial");
    expect(excluded.calculatedNet.value).toBeNull();
    expect(excluded.wearableNet.value).toBeNull();
  });

  it("never substitutes total burn, absent workouts or a future/stale weight for missing inputs", async () => {
    const day = addDays(TODAY, -1);
    await eat(day, 1900);
    await store.upsertMetrics([{ ...emptyMetrics(addDays(day, -30)), weightKg: 79 }, { ...emptyMetrics(day), calories: 3500 }]);
    const d = (await getNutrition(ctx, NO_CUSTOM, day)).energy.comparisonDays.at(-1)!;
    expect(d.bmr.value).toBe(1727.5); // 30-day weight boundary included
    expect(d.activity.kcal.value).toBeNull();
    expect(d.wearableActive.value).toBeNull();
    expect(d.calculatedNet.value).toBeNull();
    expect(d.wearableNet.value).toBeNull();
    await store.upsertDailyValues([{ day, key: "active_calories", value: 0 }]);
    const past = (await getNutrition(ctx, NO_CUSTOM, day)).energy.comparisonDays.at(-1)!;
    expect(past.wearableNet.value).toBe(172.5);
    // Tomorrow's weight must not backfill the earlier comparison.
    await store.upsertMetrics([{ ...emptyMetrics(TODAY), weightKg: 100 }]);
    await eat(TODAY, 1900);
    await store.upsertDailyValues([{ day: TODAY, key: "active_calories", value: 0 }]);
    const week = (await getNutrition(ctx, NO_CUSTOM)).energy.comparisonDays;
    expect(week.at(-1)?.bmr.value).toBe(1937.5);
    expect(week.at(-2)).toEqual(past);
    ctx.profile = { ...PROFILE, heightCm: null };
    expect((await getNutrition(ctx, NO_CUSTOM, day)).energy.comparisonDays.at(-1)?.wearableNet.value).toBeNull();
    ctx.profile = PROFILE;
    await store.upsertMetrics([{ ...emptyMetrics(addDays(day, -30)) }, { ...emptyMetrics(addDays(day, -31)), weightKg: 79 }]);
    const stale = (await getNutrition(ctx, NO_CUSTOM, day)).energy.comparisonDays.at(-1)!;
    expect(stale.bmr.value).toBeNull();
    expect(stale.wearableNet.value).toBeNull();
  });

  it("uses elapsed HR minutes across DST and clips a cross-midnight workout to each local day", async () => {
    const day = "2026-11-01"; // 25-hour day in New York, not a fixed 86,400-second day
    ctx = { ...ctx, today: "2026-11-02", now: Date.parse("2026-11-02T12:00:00-05:00") / 1000, timeZone: "America/New_York", profile: { ...PROFILE, timeZone: "America/New_York" } };
    const a = Date.parse("2026-11-01T01:55:00-04:00") / 1000;
    const b = Date.parse("2026-11-01T23:50:00-05:00") / 1000;
    await store.upsertMetrics([{ ...emptyMetrics(day), weightKg: 79, calories: 8000 }]);
    await store.upsertExercises([a, b].map((startTs, i) => ({ id: String(i), day, startTs, endTs: startTs + (i ? 20 : 15) * 60, type: "RUNNING", name: null, calories: 9000, distanceM: null })));
    await store.putHr([...[a, b].flatMap((startTs, i) => Array.from({ length: i ? 20 : 15 }, (_, k) => ({ ts: startTs + k * 60, bpm: 120 }))), { ts: b - 3600, bpm: 140 }]);
    const vm = await getNutrition(ctx, NO_CUSTOM, day);
    expect(vm.energy.activity.recordedMinutes).toBe(25);
    expect(vm.energy.activity.modeledMinutes).toBe(25);
    expect(vm.energy.activity.kcal.value).toBeCloseTo(25 * 43.5775 / 4.184, 6); // Table V, male, 36 years, 79 kg
    expect(vm.targets.kcal.value).toBe(2000);
    const next = await getNutrition(ctx, NO_CUSTOM);
    expect(next.energy.activity.recordedMinutes).toBe(10);
    expect(next.energy.activity.modeledMinutes).toBe(10);
  });

  it("compares equal completed calendar windows, preserving coverage, provisional maturity and reviewed food gaps", async () => {
    let weightKg = 90;
    const rows = Array.from({ length: 90 }, (_, i) => {
      const offset = i - 89;
      const kcal = offset === 0 ? 7000 : offset >= -7 ? 1800 : offset >= -14 ? 2100 : offset >= -30 ? 2200 : 2400;
      const row = { day: addDays(TODAY, offset), weightKg, kcal };
      weightKg += (kcal - 2500) / 7700;
      return row;
    });
    await store.upsertMetrics(rows.map((r) => ({ ...emptyMetrics(r.day), weightKg: r.weightKg, calories: 8000 })));
    await store.upsertDailyValues(rows.map((r) => ({ day: r.day, key: "calories_in", value: r.kcal })));
    const { energy } = await getNutrition(ctx, NO_CUSTOM);
    const [week, month] = energy.netTrends;
    expect(week).toMatchObject({ span: 7, recent: { from: addDays(TODAY, -7), to: addDays(TODAY, -1), days: 7, preliminary: false }, previous: { from: addDays(TODAY, -14), to: addDays(TODAY, -8), days: 7 } });
    expect(week.recent.value).toBeCloseTo(-700, 6);
    expect(week.previous.value).toBeCloseTo(-400, 6);
    expect(week.change).toBeCloseTo(-300, 6);
    expect(month).toMatchObject({ recent: { days: 30 }, previous: { from: addDays(TODAY, -60), to: addDays(TODAY, -31), days: 30 } });
    expect(month.recent.value).toBeCloseTo(-12500 / 30, 6);
    expect(month.previous.value).toBeCloseTo(-100, 6);
    expect(month.change).toBeCloseTo(-9500 / 30, 6);
    expect(energy.comparisonDays.at(-1)?.calculatedNet.value).toBeNull(); // today's 7,000 must not inflate means
    const earlier = await getNutrition(ctx, NO_CUSTOM, rows[10].day);
    expect(earlier.energy.netTrends[0]).toMatchObject({ recent: { days: 4, preliminary: true }, previous: { days: 0, value: null }, change: null });

    const gap = addDays(TODAY, -3);
    await store.upsertDailyValues([{ day: gap, key: "nutrition_missing_energy", value: 1 }]);
    const partial = (await getNutrition(ctx, NO_CUSTOM)).energy.netTrends[0];
    expect(partial.recent.days).toBe(4); // gap itself plus two later held days are withheld
    expect(partial.recent.value).toBeCloseTo(-700, 6);
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [], completeDays: [gap], plan: null } };
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.netTrends).toEqual(energy.netTrends);
  });

  it.each([
    { weights: [80, 79, 78], goal: 75, pace: -0.625, trend: 78.75 },
    { weights: [78, 79, 80], goal: 83, pace: 0.625, trend: 79.25 },
  ])("projects a saved weight goal from observed trend without changing the calorie budget ($goal kg)", async ({ weights, goal, pace, trend }) => {
    await store.upsertMetrics(weights.map((weightKg, i) => ({ ...emptyMetrics(addDays(TODAY, (i - 2) * 7)), weightKg })));
    const plan = { startDay: addDays(TODAY, -21), startWeightKg: 81, maintenanceKcal: 2400, targetKcal: 1800 };
    await store.setProfile({ ...PROFILE, nutrition: { excludedDays: [], completeDays: [addDays(TODAY, -2)], plan, goalWeightKg: goal } });
    ctx.profile = (await store.getProfile())!;
    const vm = await getNutrition(ctx, { ...NO_CUSTOM, kcal: 1980 });
    expect(vm.energy.goal).toMatchObject({ state: "estimate", weight: goal, weeks: { value: 6, provisional: true }, pace: { value: pace, provisional: true } });
    expect(vm.targets.kcal.value).toBe(1980);
    expect(vm.energy.weight.value).toBe(trend);
    expect(vm.energy.state).toBe("calibrating"); // food/calorie calibration is not a prerequisite for a weight trend
    expect((await store.getProfile())?.nutrition).toMatchObject({ plan, goalWeightKg: goal });
    const earlier = (await getNutrition(ctx, NO_CUSTOM, addDays(TODAY, -1))).energy.goal;
    expect(earlier).toMatchObject({ state: "needWeights", weeks: { value: null } }); // no borrowing today's weigh-in
    ctx.profile = { ...ctx.profile, display: { units: "imperial", hours: 12 } };
    const lb = (await getNutrition(ctx, NO_CUSTOM)).energy.goal;
    expect(lb.weeks).toEqual(vm.energy.goal.weeks);
    expect(lb.weight).toBeCloseTo(goal * 2.2046226218, 8);
    expect(lb.pace.value).toBeCloseTo(pace * 2.2046226218, 8);
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [], plan, goalWeightKg: trend } };
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.goal).toMatchObject({ state: "reached", weeks: { value: null } });
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [], plan, goalWeightKg: goal === 75 ? 83 : 75 } };
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.goal).toMatchObject({ state: "away", weeks: { value: null } });
  });

  it("withholds a goal ETA for flat, sparse and stale weights instead of forecasting from wearable burn", async () => {
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [], plan: null, goalWeightKg: 70 } };
    const times = [-21, -14, -7];
    await store.upsertMetrics(times.map((offset) => ({ ...emptyMetrics(addDays(TODAY, offset)), weightKg: 80, calories: 6000 })));
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.goal).toMatchObject({ state: "steady", weeks: { value: null }, pace: { value: 0 } });
    const next = { ...ctx, today: addDays(TODAY, 1), now: ctx.now + 86400 };
    expect((await getNutrition(next, NO_CUSTOM)).energy.goal).toMatchObject({ state: "needWeights", weeks: { value: null }, pace: { value: null } });
    await store.upsertMetrics([{ ...emptyMetrics(addDays(TODAY, -14)), weightKg: null }]);
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.goal).toMatchObject({ state: "needWeights", weeks: { value: null } });
    ctx.profile = PROFILE;
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.goal).toMatchObject({ state: "unset", weeks: { value: null } });
  });
});
