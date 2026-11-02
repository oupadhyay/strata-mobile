import { describe, expect, it } from "vitest";
import type { Exercise } from "@/data/types";
import { exerciseEnergy } from "./exerciseEnergy";

const exercise = (startTs: number, endTs: number, type = "RUNNING"): Exercise => ({ id: `${startTs}-${endTs}`, day: "2026-10-01", startTs, endTs, type, name: null, calories: 9000, distanceM: null });

describe("exercise HR comparator", () => {
  // Hand-evaluated Table V numerators at 120 bpm, 79 kg, age 32: 42.7707 / 25.6521 kJ per minute.
  it.each([
    ["male" as const, 42.7707 / 4.184],
    ["female" as const, 25.6521 / 4.184],
  ])("uses %s coefficients and seconds, not Fitbit calories or samples outside the workout", (sex, expectedPerMinute) => {
    const result = exerciseEnergy([exercise(100, 220), exercise(160, 250)], [{ ts: 90, bpm: 150 }, { ts: 100, bpm: 120 }, { ts: 160, bpm: 120 }, { ts: 220, bpm: 120 }, { ts: 250, bpm: 150 }], 0, 230, { sex, age: 32, weightKg: 79 });
    expect(result.recordedMinutes).toBeCloseTo(130 / 60, 8);
    expect(result.modeledMinutes).toBeCloseTo(130 / 60, 8);
    expect(result.kcal.value).toBeCloseTo(expectedPerMinute * 130 / 60, 5);
  });

  it("retains basketball minutes without extrapolating a steady-state formula, or filling long HR gaps", () => {
    const person = { sex: "male" as const, age: 32, weightKg: 79 };
    const hr = [{ ts: 0, bpm: 120 }, { ts: 300, bpm: 120 }];
    expect(exerciseEnergy([exercise(0, 600, "BASKETBALL")], hr, 0, 600, person)).toMatchObject({ recordedMinutes: 10, modeledMinutes: 0, kcal: { value: null } });
    expect(exerciseEnergy([exercise(0, 600)], hr, 0, 600, person).modeledMinutes).toBe(2);
    expect(exerciseEnergy([exercise(0, 600)], hr, 0, 600, { ...person, age: 65 }).kcal.value).toBeNull();
    expect(exerciseEnergy([exercise(0, 600)], [{ ts: 0, bpm: 165 }], 0, 600, person).kcal.value).toBeNull();
  });
});
