// Data check, device part: reads the last `days` days of every checked type from Health Connect (all apps) and compares them with Pulse's stored rows. See dataCheckSummary.ts.
import type { Store } from "@/data/store";
import { metricsWithLoggedBody } from "@/data/body";
import { exerciseEnergy } from "@/core/algorithms/exerciseEnergy";
import { addDays, localDay, localMidnight, wall, wholeYears } from "@/lib/time";
import { permissionState, readAll, type ReadType } from "./connect";
import { CHECK_METRICS, formatReport, summarize, type DayCheck, type RawRecord } from "./dataCheckSummary";
import { mapDailyValues, mapExternalEntries, mapExercises, mapHr, SOURCE_DAILY_KEYS, ts, type NutritionRecord } from "./import";
import { readImportState } from "./importState";

export async function runDataCheck(store: Store, opts: { timeZone: string; days?: number; now?: Date }): Promise<{ days: DayCheck[]; text: string }> {
  const tz = opts.timeZone;
  const now = opts.now ?? new Date();
  const today = localDay(Math.floor(now.getTime() / 1000), tz);
  const n = opts.days ?? 10;
  const days = Array.from({ length: n }, (_, i) => addDays(today, -i));
  const range = { start: new Date(localMidnight(days[n - 1], tz) * 1000), end: now };
  const perms = await permissionState();
  const granted = new Set<string>(perms.granted);
  const raw: Partial<Record<ReadType, RawRecord[]>> = {};
  for (const cm of CHECK_METRICS) {
    if (!granted.has(cm.type) || raw[cm.type]) continue;
    raw[cm.type] = (await readAll(cm.type, range).catch(() => [])) as unknown as RawRecord[];
  }
  const sleepRaw = granted.has("SleepSession") ? ((await readAll("SleepSession", { start: new Date(range.start.getTime() - 86_400_000), end: now }).catch(() => [])) as unknown as RawRecord[]) : [];
  const [metrics, sessions, values] = await Promise.all([store.allMetrics(), store.allSessions(), store.dailyValues({ from: days[n - 1], to: today })]);
  const checked = summarize(raw, sleepRaw, metrics, sessions, days, tz, values);

  // Read food directly, not via the change feed or the stored log (which omits macro-only foods). Keep the lead day
  // used by sync so an interval begun before the report window can still contribute to its first day's roll-up.
  const nutritionRange = { start: new Date(range.start.getTime() - 86_400_000), end: now };
  const skipped: { start: string; end: string }[] = [];
  let records: NutritionRecord[] | null = null;
  let status = "permission_missing";
  if (granted.has("Nutrition")) {
    try {
      records = await readAll("Nutrition", nutritionRange, {
        onSkipped: (r) => skipped.push({ start: r.start.toISOString(), end: r.end.toISOString() }),
      });
      status = skipped.length ? "skipped_records" : "ok";
    } catch {
      status = "read_failed";
    }
  }
  const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const inWindow = <T extends { day: string }>(rows: T[]) => rows.filter((r) => r.day >= days[n - 1] && r.day <= today);
  const nutritionKeys = new Set(Object.keys(SOURCE_DAILY_KEYS).filter((k) => SOURCE_DAILY_KEYS[k] === "Nutrition"));
  const storedFood = (await store.loggedEntries(range.start.getTime() / 1000, Number.MAX_SAFE_INTEGER))
    .filter((r) => r.type === "nutrition-log" && r.day <= today);
  const origins = [...new Set((records ?? []).map((r) => r.metadata?.dataOrigin ?? ""))];
  // Compare the exact stored model inputs with fresh Health Connect reads, not assumed wearable coverage.
  const activitySkipped: { type: string; start: string; end: string }[] = [];
  const [profile, body, storedExercises, storedHr, sourceHr, sourceExercises, sourceActive, sourceTotal] = await Promise.all([
    store.getProfile(), metricsWithLoggedBody(store), store.allExercises(), store.readHr(range.start.getTime() / 1000 - 60, now.getTime() / 1000),
    granted.has("HeartRate") ? readAll("HeartRate", nutritionRange, {
      onSkipped: (r) => activitySkipped.push({ type: "HeartRate", start: r.start.toISOString(), end: r.end.toISOString() }),
    }).catch(() => null) : null,
    granted.has("ExerciseSession") ? readAll("ExerciseSession", nutritionRange, {
      onSkipped: (r) => activitySkipped.push({ type: "ExerciseSession", start: r.start.toISOString(), end: r.end.toISOString() }),
    }).catch(() => null) : null,
    granted.has("ActiveCaloriesBurned") ? readAll("ActiveCaloriesBurned", nutritionRange, {
      onSkipped: (r) => activitySkipped.push({ type: "ActiveCaloriesBurned", start: r.start.toISOString(), end: r.end.toISOString() }),
    }).catch(() => null) : null,
    granted.has("TotalCaloriesBurned") ? readAll("TotalCaloriesBurned", nutritionRange, {
      onSkipped: (r) => activitySkipped.push({ type: "TotalCaloriesBurned", start: r.start.toISOString(), end: r.end.toISOString() }),
    }).catch(() => null) : null,
  ]);
  const freshHr = sourceHr === null ? null : mapHr(sourceHr);
  const freshExercises = sourceExercises === null ? null : mapExercises(sourceExercises, sourceActive ?? [], [], tz, sourceTotal ?? []);
  const weights = body.slice().reverse();
  const activity = {
    note: "Read-only exercise audit. HR exclusions describe only the Keytel equation, not overall estimate coverage. HR-modeled, MET and wearable-fallback minutes never overlap; together with uncoveredMinutes they equal recordedMinutes. All energy estimates include rest during covered minutes. Named activities use coarse 2024 Adult Compendium METs; generic workouts follow minute-or-finer wearable total calories at 1x, or active calories plus estimated 1-MET rest. Daily/hourly totals never masquerade as minute-level coverage. Compare stored with fresh Health Connect results and calorie intervals to distinguish missing imports from unavailable inputs.",
    profileAvailable: profile !== null,
    skipped: activitySkipped,
    reads: [
      { type: "HeartRate", status: !granted.has("HeartRate") ? "permission_missing" : sourceHr === null ? "read_failed" : activitySkipped.some((r) => r.type === "HeartRate") ? "skipped_records" : "ok", records: sourceHr?.length ?? null, origins: [...new Set((sourceHr ?? []).map((r) => r.metadata?.dataOrigin ?? ""))] },
      { type: "ExerciseSession", status: !granted.has("ExerciseSession") ? "permission_missing" : sourceExercises === null ? "read_failed" : activitySkipped.some((r) => r.type === "ExerciseSession") ? "skipped_records" : "ok", records: sourceExercises?.length ?? null },
      { type: "ActiveCaloriesBurned", status: !granted.has("ActiveCaloriesBurned") ? "permission_missing" : sourceActive === null ? "read_failed" : activitySkipped.some((r) => r.type === "ActiveCaloriesBurned") ? "skipped_records" : "ok", records: sourceActive?.length ?? null, origins: [...new Set((sourceActive ?? []).map((r) => r.metadata?.dataOrigin ?? ""))] },
      { type: "TotalCaloriesBurned", status: !granted.has("TotalCaloriesBurned") ? "permission_missing" : sourceTotal === null ? "read_failed" : activitySkipped.some((r) => r.type === "TotalCaloriesBurned") ? "skipped_records" : "ok", records: sourceTotal?.length ?? null, origins: [...new Set((sourceTotal ?? []).map((r) => r.metadata?.dataOrigin ?? ""))] },
    ],
    days: days.map((day) => {
      const from = localMidnight(day, tz);
      const to = Math.min(now.getTime() / 1000, localMidnight(addDays(day, 1), tz));
      const person = { sex: profile?.sex ?? "male" as const, age: profile ? wholeYears(profile.birthDate, day) : 0,
        weightKg: weights.find((r) => r.day <= day && r.day >= addDays(day, -30) && r.weightKg !== null)?.weightKg ?? null };
      const workouts = storedExercises.filter((e) => e.startTs < to && e.endTs > from);
      return {
        day, person,
        stored: exerciseEnergy(workouts, storedHr, from, to, person),
        healthConnect: freshHr !== null && freshExercises !== null ? exerciseEnergy(freshExercises, freshHr, from, to, person) : null,
        storedWorkoutsWithHealthConnectHr: freshHr === null ? null : exerciseEnergy(workouts, freshHr, from, to, person),
        workouts: workouts.map((e) => ({ id: e.id, type: e.type, name: e.name, start: new Date(e.startTs * 1000).toISOString(), end: new Date(e.endTs * 1000).toISOString(),
          calorieIntervals: e.calorieIntervals ?? null, healthConnectCalorieIntervals: freshExercises?.find((f) => f.id === e.id)?.calorieIntervals ?? null,
          stored: exerciseEnergy([e], storedHr, from, to, person) })),
      };
    }),
  };
  const nutrition = {
    generatedAt: now.toISOString(),
    timeZone: tz,
    deviceTimeZone,
    historyPermission: perms.history,
    exerciseEnergyComparison: activity,
    sync: await store.getSyncState(),
    importState: await readImportState(),
    window: { from: days[n - 1], to: today },
    readRange: { start: nutritionRange.start.toISOString(), end: now.toISOString() },
    status,
    skipped,
    note: "Read-only snapshot. Native bridge zero energy may mean absent energy, not a zero-calorie food. Recomputed values use the current importer; they are not an independent source total.",
    storedDailyValues: values.filter((v) => nutritionKeys.has(v.key)),
    recomputedDailyValues: records === null ? null : inWindow(mapDailyValues({ Nutrition: records }, tz)),
    perOriginDailyValues: records === null ? null : origins.map((origin) => ({
      origin,
      values: inWindow(mapDailyValues({ Nutrition: records.filter((r) => (r.metadata?.dataOrigin ?? "") === origin) }, tz)),
    })),
    storedFoodEntries: storedFood,
    recomputedFoodEntries: records === null ? null : inWindow(mapExternalEntries({ Nutrition: records }, tz)),
    records: records?.map((r) => ({
      id: r.metadata?.id ?? null,
      origin: r.metadata?.dataOrigin ?? null,
      lastModifiedTime: r.metadata?.lastModifiedTime ?? null,
      name: r.name ?? null,
      mealType: r.mealType,
      startTime: r.startTime,
      endTime: r.endTime,
      // 4.1.3's native bridge returns these, but its Nutrition result declarations omit them.
      startZoneOffset: (r as NutritionRecord & { startZoneOffset?: unknown }).startZoneOffset ?? null,
      endZoneOffset: (r as NutritionRecord & { endZoneOffset?: unknown }).endZoneOffset ?? null,
      startInProfileZone: wall(ts(r.startTime), tz),
      startInDeviceZone: wall(ts(r.startTime), deviceTimeZone),
      kcal: r.energy?.inKilocalories ?? null,
      protein: r.protein?.inGrams ?? null,
      carbs: r.totalCarbohydrate?.inGrams ?? null,
      fat: r.totalFat?.inGrams ?? null,
    })) ?? null,
  };
  return { days: checked, text: `${formatReport(checked)}\n\nNutrition record comparison (JSON)\n${JSON.stringify(nutrition, null, 2)}` };
}
