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

  it("withholds incomplete imported calories and reviewed partial days without altering source data", async () => {
    await seedEnergy();
    const gap = addDays(TODAY, -2);
    await store.upsertDailyValues([{ day: gap, key: "nutrition_missing_energy", value: 1 }, { day: gap, key: "protein", value: 300 }]);
    const partial = await getNutrition(ctx, NO_CUSTOM, gap);
    expect(partial.totals).toMatchObject({ kcal: null, protein: 300 });
    expect(partial.energy.deficit).toBeNull();
    const held = await getNutrition(ctx, NO_CUSTOM);
    expect(held.energy).toMatchObject({ state: "holding", tdee: { tags: ["stale_baseline"] }, deficit: null });
    expect(held.energy.balanceDays.at(-3)?.kcalIn).toBeNull();
    expect(held.week).toMatchObject({ kcal: 2225, protein: 100, days: 6 });

    await store.replaceDailyValues({ from: gap, to: gap }, ["nutrition_missing_energy"], []);
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [gap], plan: null } };
    const reviewed = await getNutrition(ctx, NO_CUSTOM);
    expect(reviewed.energy.state).toBe("holding");
    expect(reviewed.week.days).toBe(6);
    expect((await getNutrition(ctx, NO_CUSTOM, gap)).energy.excluded).toBe(true);
    expect(await store.dailyValues({ from: gap, to: gap })).toContainEqual({ day: gap, key: "calories_in", value: 1970 });
    ctx.profile = { ...PROFILE, nutrition: { excludedDays: [], plan: null } };
    expect((await getNutrition(ctx, NO_CUSTOM)).energy.tdee.value).toBeCloseTo(2450, 6);
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
});
