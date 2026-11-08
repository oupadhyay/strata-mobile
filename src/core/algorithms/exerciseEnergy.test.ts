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

  it("accounts for all 99 minutes without confusing HR presence with equation eligibility", () => {
    const workouts = [exercise(0, 59 * 60), exercise(59 * 60, 99 * 60, "BASKETBALL")];
    const hr = Array.from({ length: 99 }, (_, i) => ({ ts: i * 60, bpm: i < 13 || i >= 59 ? 120 : 165 })).filter((h) => h.ts < 43 * 60 || h.ts >= 59 * 60);
    const person = { sex: "male" as const, age: 32, weightKg: 79 };
    expect(exerciseEnergy(workouts, hr, 0, 99 * 60, person)).toMatchObject({
      recordedMinutes: 99, modeledMinutes: 13, hrCoveredMinutes: 83,
      excludedMinutes: { exerciseType: 40, profile: 0, hrRange: 30, hrMissing: 16 },
    });
    expect(exerciseEnergy(workouts, hr, 0, 99 * 60, { ...person, age: 65 })).toMatchObject({
      recordedMinutes: 99, modeledMinutes: 0, hrCoveredMinutes: 83,
      excludedMinutes: { exerciseType: 40, profile: 59, hrRange: 0, hrMissing: 0 },
    });
    // Supported overlapping cardio wins over the unsupported-sport exclusion; it must not be counted twice.
    expect(exerciseEnergy([...workouts, exercise(59 * 60, 99 * 60)], hr, 0, 99 * 60, person)).toMatchObject({
      recordedMinutes: 99, modeledMinutes: 53, hrCoveredMinutes: 83,
      excludedMinutes: { exerciseType: 0, profile: 0, hrRange: 30, hrMissing: 16 },
    });
  });

  it("estimates named sports and strength from activity METs, with wearable fallback for the rest of all 99 minutes", () => {
    const workouts: Exercise[] = [
      exercise(0, 13 * 60),
      exercise(13 * 60, 43 * 60, "BADMINTON"),
      exercise(43 * 60, 63 * 60, "STRENGTH_TRAINING"),
      { ...exercise(63 * 60, 99 * 60, "OTHER_WORKOUT"), name: "Racket sports", calorieIntervals: Array.from({ length: 36 }, (_, i) => ({ startTs: (63 + i) * 60, endTs: (64 + i) * 60, kcal: 7, active: false })) },
    ];
    const hr = Array.from({ length: 99 }, (_, i) => ({ ts: i * 60, bpm: 120 }));
    const result = exerciseEnergy(workouts, hr, 0, 99 * 60, { sex: "male", age: 32, weightKg: 79 });
    // 5.5 MET badminton, 3.5 MET resistance training; kcal/min = MET × 3.5 × kg / 200.
    const metKcal = (30 * 5.5 + 20 * 3.5) * 3.5 * 79 / 200;
    expect(result).toMatchObject({ modeledMinutes: 13, metMinutes: 50, wearableMinutes: 36, coveredMinutes: 99, uncoveredMinutes: 0 });
    expect(result.metKcal).toBeCloseTo(metKcal, 8);
    expect(result.wearableKcal).toBe(252);
    expect(result.estimatedKcal.value).toBeCloseTo(13 * 42.7707 / 4.184 + metKcal + 252, 8);
  });

  it("counts overlapping methods once, clips calorie intervals at midnight, and never treats a coarse total as minute-level coverage", () => {
    const person = { sex: "male" as const, age: 32, weightKg: 79 };
    const unknown: Exercise = { ...exercise(-60, 180, "OTHER_WORKOUT"), calorieIntervals: [
      { startTs: -60, endTs: 0, kcal: 5, active: false },
      { startTs: 0, endTs: 60, kcal: 0, active: false },
      { startTs: 60, endTs: 120, kcal: 4, active: true },
      { startTs: 120, endTs: 3720, kcal: 900, active: false },
    ] };
    const fallback = exerciseEnergy([unknown, { ...unknown, id: "duplicate" }], [], 0, 180, person);
    expect(fallback).toMatchObject({ recordedMinutes: 3, coveredMinutes: 2, wearableMinutes: 2, uncoveredMinutes: 1 });
    // Active-only data gets estimated 1-MET rest added to match the other methods' gross-exercise basis.
    expect(fallback.estimatedKcal.value).toBeCloseTo(4 + 3.5 * 79 / 200, 8);
    const mixed = exerciseEnergy([unknown, exercise(0, 60), exercise(0, 120, "YOGA")], [{ ts: 0, bpm: 120 }], 0, 180, person);
    expect(mixed).toMatchObject({ modeledMinutes: 1, metMinutes: 1, wearableMinutes: 0, coveredMinutes: 2, uncoveredMinutes: 1 });
    expect(mixed.estimatedKcal.value).toBeCloseTo(42.7707 / 4.184 + 2.3 * 3.5 * 79 / 200, 8);
    expect(exerciseEnergy([unknown], [], 0, 60, { ...person, weightKg: null })).toMatchObject({ wearableMinutes: 1, estimatedKcal: { value: 0 } });
    expect(exerciseEnergy([unknown], [], 60, 120, { ...person, weightKg: null })).toMatchObject({ uncoveredMinutes: 1, estimatedKcal: { value: null } });
    expect(exerciseEnergy([exercise(0, 60, "OTHER_WORKOUT")], [], 0, 60, person).estimatedKcal.value).toBeNull();
  });
});
