import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/time";
import { expenditureHistory, plannedWeight, type IntakeDay } from "./expenditure";

// Independently synthesize morning weights from a 2,450 kcal/day expenditure, with unequal days of food.
function history(n = 36): IntakeDay[] {
  let weightKg = 83.7;
  return Array.from({ length: n }, (_, i) => {
    const kcal = [1830, 2210, 1970, 2630, 2080][i % 5];
    const r = { day: addDays("2026-09-01", i), kcal, weightKg };
    weightKg += (kcal - 2450) / 7700;
    return r;
  });
}

describe("exponentially weighted expenditure", () => {
  it("recovers energy balance with unequal intake and sparse weigh-ins, without wearable calories", () => {
    const rows = history().map((r, i) => ({ ...r, weightKg: i % 3 === 1 ? null : r.weightKg }));
    const last = expenditureHistory(rows).at(-1)!;
    expect(last.state).toBe("ready");
    expect(last.tdee.value).toBeCloseTo(2450, 6);
    expect(last.trendKg.value).toBeGreaterThan(rows.at(-1)!.weightKg!);
    const prefix = expenditureHistory(rows.slice(0, 25));
    expect(expenditureHistory(rows).slice(0, 25)).toEqual(prefix);
    // A huge food entry today cannot affect expenditure inferred from earlier intake and morning weigh-ins.
    expect(expenditureHistory([...rows.slice(0, -1), { ...rows.at(-1)!, kcal: 7000 }]).at(-1)!.tdee).toEqual(last.tdee);
  });

  it("requires fourteen complete intervals, not fourteen dates or two weigh-ins", () => {
    expect(expenditureHistory(history(14)).at(-1)!.tdee.value).toBeNull();
    expect(expenditureHistory(history(15)).at(-1)!.tdee.value).toBeCloseTo(2450, 6);
    const sparse = history(20).map((r, i) => ({ ...r, weightKg: i === 0 || i === 19 ? r.weightKg : null }));
    expect(expenditureHistory(sparse).at(-1)!.state).toBe("calibrating");
  });

  it("weights a recent weight change exponentially rather than fitting an unweighted line", () => {
    const rows = history(22).map((r, i) => ({ ...r, weightKg: r.weightKg! + (i >= 17 ? 0.6 : 0) }));
    const last = expenditureHistory(rows).at(-1)!;
    // Independent weighted pairwise-slope identity and closed-form EWMA, not the implementation's centroid fold.
    expect(last.tdee.value).toBeCloseTo(2134.599795392612, 6);
    expect(last.trendKg.value).toBeCloseTo(83.41323309406592, 8);
  });

  it("holds across missing or excluded intake, then recalibrates from a complete interval", () => {
    for (const replacement of [{ kcal: null }, { excluded: true }]) {
      const rows = history(38).map((r, i) => i === 20 ? { ...r, ...replacement } : r);
      const result = expenditureHistory(rows);
      expect(result[21]).toMatchObject({ state: "holding", tdee: { value: expect.any(Number), tags: ["stale_baseline"] } });
      expect(result[34].state).toBe("holding");
      expect(result[35].state).toBe("ready");
      expect(result[35].tdee.value).toBeCloseTo(2450, 6);
    }
    // An absent calendar row is a gap too, not a one-day interval.
    expect(expenditureHistory(history(25).filter((_, i) => i !== 20)).at(-1)!.state).toBe("holding");
  });

  it("keeps an explicitly known zero distinct from missing intake", () => {
    let weightKg = 79.3;
    const rows = history(18).map((r, i) => {
      const kcal = i === 9 ? 0 : 2070;
      const out = { ...r, kcal, weightKg };
      weightKg += (kcal - 2360) / 7700;
      return out;
    });
    expect(expenditureHistory(rows).at(-1)!.tdee.value).toBeCloseTo(2360, 6);
    expect(expenditureHistory(rows.map((r, i) => i === 9 ? { ...r, kcal: null } : r)).at(-1)!.tdee.value).toBeNull();
  });

  it("withholds implausible fits and stops presenting an old weight as current", () => {
    const rows = history(15).map((r, i) => ({ ...r, weightKg: 83 - i * 2 }));
    expect(expenditureHistory(rows).at(-1)!.tdee.value).toBeNull();
    const missing = history(25).map((r, i) => ({ ...r, weightKg: i > 15 ? null : r.weightKg }));
    expect(expenditureHistory(missing).at(-1)).toMatchObject({ state: "holding", trendKg: { value: null } });
  });

  it("compares with a fixed original plan in kg, without inventing a pre-plan trajectory", () => {
    const plan = { startDay: "2026-09-10", startWeightKg: 81.8, maintenanceKcal: 2460, targetKcal: 1910 };
    expect(plannedWeight(plan, "2026-09-09")).toBeNull();
    expect(plannedWeight(plan, "2026-09-10")).toBe(81.8);
    expect(plannedWeight(plan, "2026-09-24")).toBeCloseTo(80.8, 8);
  });
});
