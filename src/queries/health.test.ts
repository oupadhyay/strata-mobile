// Health Monitor's view over the 180-day demo seed: each vital's number, status and the count agree.
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "@/data/memory";
import { seedDemo } from "@/data/seed";
import type { Profile } from "@/data/types";
import { addDays } from "@/lib/time";
import { runPipeline } from "@/pipeline";
import type { QueryCtx } from "./ctx";
import { getHealthHub, getMonitor } from "./health";

const TZ = "Asia/Kolkata";
const TODAY = "2026-10-02";
const NOW = Date.parse("2026-10-02T14:00:00+05:30") / 1000;
const PROFILE: Profile = { birthDate: "1990-01-01", sex: "male", maxHr: 183, heightCm: 178, timeZone: TZ };
let ctx: QueryCtx;

beforeAll(async () => {
  const store = new MemoryStore();
  await seedDemo(store, { today: TODAY, timeZone: TZ, now: NOW });
  await runPipeline(store, PROFILE, { today: TODAY });
  // The day's own readings drift from the night values Recovery read (as Health Connect's daily records do): the screen
  // must still show the value the monitor judged.
  const metrics = await store.allMetrics();
  await store.upsertMetrics(metrics.map((m) => ({ ...m, respBpm: m.respBpm == null ? null : m.respBpm + 4, hrvMs: m.hrvMs == null ? null : m.hrvMs * 2 })));
  ctx = { store, profile: PROFILE, timeZone: TZ, today: TODAY, now: NOW, sync: { lastSyncTs: NOW, firstDay: addDays(TODAY, -179), lastError: null } };
}, 120_000);

describe("getMonitor", () => {
  it("judges the number it shows: a vital's status matches its value against its range, and the count matches the statuses", async () => {
    for (let k = 0; k < 90; k++) {
      const vm = await getMonitor(addDays(TODAY, -k), ctx);
      for (const v of vm.vitals) {
        if (v.status === "no_data" || !v.range || v.metric.value === null) continue;
        const within = v.metric.value >= v.range.low && v.metric.value <= v.range.high;
        expect(within, `${vm.day} ${v.key}: ${v.metric.value} against [${v.range.low}, ${v.range.high}] is ${v.status}`).toBe(v.status === "in_range");
      }
      if (vm.count.value) {
        expect(vm.count.value.inRange).toBe(vm.vitals.filter((v) => v.status === "in_range").length);
        expect(vm.count.value.outOfRange).toBe(vm.vitals.filter((v) => v.status === "high" || v.status === "low").length);
      }
    }
  });
});

describe("getHealthHub", () => {
  it("shows today's logged calories, preserves a recorded zero and withholds missing or incomplete totals", async () => {
    const store = new MemoryStore();
    const query = { ...ctx, store, profile: { ...PROFILE } };
    await store.upsertDailyValues([
      { day: addDays(TODAY, -1), key: "calories_in", value: 3150 },
      { day: TODAY, key: "calories_in", value: 1375 },
      { day: TODAY, key: "protein", value: 90 },
      { day: addDays(TODAY, 1), key: "calories_in", value: 2700 },
    ]);
    expect((await getHealthHub(query)).nutrition).toEqual({ value: 1375, reason: null, provisional: true });

    await store.replaceDailyValues({ from: TODAY, to: TODAY }, ["calories_in"], []);
    expect((await getHealthHub(query)).nutrition).toEqual({ value: null, reason: "no_data", provisional: false });

    await store.upsertDailyValues([{ day: TODAY, key: "calories_in", value: 0 }]);
    expect((await getHealthHub(query)).nutrition).toEqual({ value: 0, reason: null, provisional: true });

    await store.upsertDailyValues([
      { day: TODAY, key: "calories_in", value: 1487 },
      { day: TODAY, key: "nutrition_missing_energy", value: 1 },
    ]);
    expect((await getHealthHub(query)).nutrition).toEqual({ value: null, reason: "no_data", provisional: false });

    await store.replaceDailyValues({ from: TODAY, to: TODAY }, ["nutrition_missing_energy"], []);
    query.profile.nutrition = { excludedDays: [TODAY], plan: null };
    expect((await getHealthHub(query)).nutrition).toEqual({ value: null, reason: "no_data", provisional: false });
  });
});
