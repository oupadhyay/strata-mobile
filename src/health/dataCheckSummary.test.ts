import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyMetrics } from "@/data/types";
import { MemoryStore } from "@/data/memory";
import { permissionState, readAll } from "./connect";
import { runDataCheck } from "./dataCheck";
import { formatReport, summarize, type RawRecord } from "./dataCheckSummary";

vi.mock("./connect", () => ({ permissionState: vi.fn(), readAll: vi.fn() }));
vi.mock("./importState", () => ({ readImportState: async () => ({ version: 9 }) }));

const TZ = "Asia/Kolkata";
const at = (day: string, t: string) => `${day}T${t}+05:30`;
const fitbit = (type?: number) => ({ dataOrigin: "com.fitbit.FitbitMobile", device: type == null ? null : { type } });

describe("data check summary", () => {
  it("splits a day's steps by app and device and shows what Pulse stored", () => {
    const steps: RawRecord[] = [
      { metadata: fitbit(1), startTime: at("2026-10-06", "08:00:00"), endTime: at("2026-10-06", "09:00:00"), count: 4000 },
      { metadata: fitbit(1), startTime: at("2026-10-06", "18:00:00"), endTime: at("2026-10-06", "19:00:00"), count: 2000 },
      { metadata: fitbit(2), startTime: at("2026-10-06", "08:00:00"), endTime: at("2026-10-06", "09:00:00"), count: 4500 },
    ];
    const spo2: RawRecord[] = [{ metadata: fitbit(1), time: at("2026-10-06", "06:30:00"), percentage: 96 }];
    const m = { ...emptyMetrics("2026-10-06"), steps: 6000, spo2Pct: 96 };
    const [day] = summarize({ Steps: steps, OxygenSaturation: spo2 }, [], [m], [], ["2026-10-06"], TZ);
    const st = day.metrics.find((x) => x.key === "steps")!;
    expect(st.pulse).toBe(6000);
    expect(st.sources.map((s) => [s.source, s.value])).toEqual([
      ["Fitbit app/watch", 6000],
      ["Fitbit app/phone", 4500],
    ]);
    const sp = day.metrics.find((x) => x.key === "spo2")!;
    expect(sp.sources[0].detail).toBe("06:30 96");
    const text = formatReport([day]);
    expect(text).toContain("Steps: Pulse 6000");
    expect(text).toContain("Fitbit app/watch: 6000");
  });
});

describe("nutrition data check export", () => {
  const opts = { timeZone: "America/Los_Angeles", now: new Date("2026-11-05T07:00:00Z"), days: 1 };
  const reportOf = (text: string) => JSON.parse(text.split("Nutrition record comparison (JSON)\n")[1]);
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(permissionState).mockResolvedValue({ granted: ["Nutrition"], missing: [], history: true, background: false });
    vi.mocked(readAll).mockResolvedValue([]);
  });

  it("exports every food, raw times and offsets, chosen and alternate origins, and stored vs recomputed totals without writing", async () => {
    // Selected visible foods, not a reconstruction of the owner's whole day. The midnight interval is a control.
    const food = (id: string, time: string, kcal: number | null, protein = 0, carbs = 0, fat = 0, origin = "com.fitnow.loseit") => ({
      metadata: { id, dataOrigin: origin }, name: id, mealType: 2,
      startTime: new Date(`2026-11-04T${time}-08:00`).toISOString(),
      endTime: new Date(Date.parse(`2026-11-04T${time}-08:00`) + 60_000).toISOString(),
      startZoneOffset: { id: "-08:00", totalSeconds: -28800 },
      ...(kcal !== null && { energy: { inKilocalories: kcal } }),
      protein: { inGrams: protein }, totalCarbohydrate: { inGrams: carbs }, totalFat: { inGrams: fat },
    });
    const foods = [
      food("bun", "12:25:00", 170, 6, 32, 2.5),
      food("tomatoes", "12:25:00", 2), // Same time, no macros: still a distinct calorie record.
      food("cucumber", "12:26:00", null, 0, 1),
      { ...food("ranch", "19:05:00", 148, 0.406, 1.334, 15.573), mealType: 3 },
      { ...food("coconut", "19:42:00", 50, 0, 13), mealType: 3 },
      { ...food("shake", "21:13:00", 150, 30, 3, 2.5), mealType: 4 },
      food("mirror", "12:25:00", 2000, 80, 200, 70, "com.fitbit.FitbitMobile"),
      { ...food("midnight-control", "00:00:00", 20), startTime: "2026-11-03T23:59:00-08:00", endTime: "2026-11-04T00:01:00-08:00" },
    ];
    vi.mocked(readAll).mockImplementation(async (_type, range) => foods.filter((r) => {
      const time = Date.parse(r.startTime);
      return time >= range.start.getTime() && time < range.end.getTime();
    }) as never);
    const store = new MemoryStore();
    await store.upsertDailyValues([{ day: "2026-11-04", key: "calories_in", value: 1355 }]);
    await store.addLoggedEntries([
      { id: "hc-food-old", day: "2026-11-04", ts: Date.parse("2026-11-04T12:00:00-08:00") / 1000, type: "nutrition-log", data: { name: "old food", kcal: 100 }, source: "health_connect", createdAt: 0 },
      { id: "private", day: "2026-11-04", ts: Date.parse("2026-11-04T12:00:00-08:00") / 1000, type: "symptom-log", data: { note: "not food" }, source: "pulse", createdAt: 0 },
    ]);
    const before = await store.dailyValues();
    const { text } = await runDataCheck(store, opts);
    const report = reportOf(text);
    expect(report.status).toBe("ok");
    expect(report.timeZone).toBe("America/Los_Angeles");
    expect(report.readRange).toEqual({ start: "2026-11-03T08:00:00.000Z", end: "2026-11-05T07:00:00.000Z" });
    expect(report.records).toHaveLength(8);
    expect(report.records.find((r: { id: string }) => r.id === "cucumber")).toMatchObject({ kcal: null, carbs: 1 });
    expect(report.records.find((r: { id: string }) => r.id === "shake")).toMatchObject({
      mealType: 4, kcal: 150, startTime: "2026-11-05T05:13:00.000Z",
      startZoneOffset: { id: "-08:00", totalSeconds: -28800 }, startInProfileZone: { day: "2026-11-04", time: "21:13:00" },
    });
    expect(report.storedDailyValues).toEqual(before);
    expect(report.recomputedDailyValues).toEqual([
      { day: "2026-11-04", key: "calories_in", value: 530 },
      { day: "2026-11-04", key: "carbs", value: 50.3 },
      { day: "2026-11-04", key: "fat", value: 20.6 },
      { day: "2026-11-04", key: "nutrition_missing_energy", value: 1 },
      { day: "2026-11-04", key: "protein", value: 36.4 },
    ]);
    expect(report.perOriginDailyValues.find((r: { origin: string }) => r.origin === "com.fitbit.FitbitMobile").values)
      .toContainEqual({ day: "2026-11-04", key: "calories_in", value: 2000 });
    expect(report.recomputedFoodEntries.map((r: { id: string }) => r.id).sort()).toEqual([
      "hc-food-bun", "hc-food-coconut", "hc-food-ranch", "hc-food-shake", "hc-food-tomatoes",
    ]);
    expect(report.storedFoodEntries.map((r: { id: string }) => r.id)).toEqual(["hc-food-old"]);
    expect(text).not.toContain("not food");
    expect(await store.dailyValues()).toEqual(before);
    expect(await store.loggedEntries(0)).toHaveLength(2);
  });

  it("compares stored exercise coverage with fresh Health Connect HR without changing stored samples", async () => {
    vi.mocked(permissionState).mockResolvedValue({ granted: ["Nutrition", "HeartRate", "ExerciseSession", "TotalCaloriesBurned"], missing: [], history: true, background: false });
    const start = Date.parse("2026-11-04T10:00:00-08:00") / 1000;
    const samples = Array.from({ length: 99 }, (_, i) => ({ ts: start + i * 60, bpm: i < 13 ? 120 : 165 }));
    const workout = { id: "workout", day: "2026-11-04", startTs: start, endTs: start + 99 * 60, type: "RUNNING", name: null, calories: null, distanceM: null };
    const store = new MemoryStore();
    await store.setProfile({ birthDate: "1994-01-01", sex: "male", heightCm: 178, maxHr: 188, timeZone: opts.timeZone });
    await store.upsertMetrics([{ ...emptyMetrics(workout.day), weightKg: 79 }]);
    await store.upsertExercises([workout]);
    await store.putHr(samples.slice(0, 13)); // simulate imported HR missing the rest, not a real device diagnosis
    vi.mocked(readAll).mockImplementation(async (type) => {
      if (type === "HeartRate") return [{ metadata: { dataOrigin: "com.fitbit.FitbitMobile" }, samples: samples.map((s) => ({ time: new Date(s.ts * 1000).toISOString(), beatsPerMinute: s.bpm })) }] as never;
      if (type === "ExerciseSession") return [{ metadata: { id: workout.id }, exerciseType: 56, startTime: new Date(start * 1000).toISOString(), endTime: new Date(workout.endTs * 1000).toISOString() }] as never;
      if (type === "TotalCaloriesBurned") return samples.map((s) => ({ metadata: fitbit(), startTime: new Date(s.ts * 1000).toISOString(), endTime: new Date((s.ts + 60) * 1000).toISOString(), energy: { inKilocalories: 6 } })) as never;
      return [];
    });
    const coverage = reportOf((await runDataCheck(store, opts)).text).exerciseEnergyComparison;
    expect(coverage.reads.map((r: { status: string }) => r.status)).toEqual(["ok", "ok", "permission_missing", "ok"]);
    expect(coverage.days[0].stored).toMatchObject({ recordedMinutes: 99, hrCoveredMinutes: 13, modeledMinutes: 13, excludedMinutes: { exerciseType: 0, profile: 0, hrRange: 0, hrMissing: 86 } });
    for (const key of ["healthConnect", "storedWorkoutsWithHealthConnectHr"]) {
      expect(coverage.days[0][key]).toMatchObject({ recordedMinutes: 99, hrCoveredMinutes: 99, modeledMinutes: 13, excludedMinutes: { exerciseType: 0, profile: 0, hrRange: 86, hrMissing: 0 } });
    }
    expect(coverage.days[0].healthConnect).toMatchObject({ coveredMinutes: 99, wearableMinutes: 86, wearableKcal: 516, uncoveredMinutes: 0 });
    expect(coverage.days[0].stored).toMatchObject({ coveredMinutes: 13, uncoveredMinutes: 86 });
    expect(coverage.days[0].workouts).toHaveLength(1);
    expect(coverage.days[0].workouts[0].healthConnectCalorieIntervals).toHaveLength(99);
    expect((await store.allExercises())[0].calorieIntervals).toBeUndefined();
    expect(await store.readHr(start, workout.endTs)).toEqual(samples.slice(0, 13));
  });

  it.each(["permission_missing", "read_failed", "ok", "skipped_records"])("distinguishes %s from a complete empty read", async (status) => {
    vi.mocked(permissionState).mockResolvedValue({ granted: status === "permission_missing" ? [] : ["Nutrition", "HeartRate", "ExerciseSession", "ActiveCaloriesBurned", "TotalCaloriesBurned"], missing: [], history: false, background: false });
    if (status === "read_failed") vi.mocked(readAll).mockRejectedValue(new Error("refused"));
    if (status === "skipped_records") vi.mocked(readAll).mockImplementation(async (_type, _range, options) => {
      options?.onSkipped?.({ start: new Date("2026-11-04T20:00:00Z"), end: new Date("2026-11-04T20:00:00.001Z") });
      return [];
    });
    const report = reportOf((await runDataCheck(new MemoryStore(), opts)).text);
    expect(report.status).toBe(status);
    expect(report.records).toEqual(status === "permission_missing" || status === "read_failed" ? null : []);
    expect(report.recomputedDailyValues).toEqual(status === "permission_missing" || status === "read_failed" ? null : []);
    expect(report.skipped).toHaveLength(status === "skipped_records" ? 1 : 0);
    expect(report.exerciseEnergyComparison.reads.map((r: { status: string }) => r.status)).toEqual([status, status, status, status]);
    expect(report.exerciseEnergyComparison.days[0].healthConnect === null).toBe(status === "permission_missing" || status === "read_failed");
  });
});
