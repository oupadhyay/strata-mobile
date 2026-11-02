// Keytel et al. 2005, doi:10.1080/02640410470001730089, Table V (without VO2max): kJ/min, converted to kcal/min.
// This population equation is NOT a personalized calibration, an all-day TDEE estimate, or a food-budget credit.
import type { Exercise, HrSample, Sex } from "@/data/types";
import type { Metric } from "@/lib/reasons";

const CARDIO = new Set(["WALKING", "RUNNING", "RUNNING_TREADMILL", "BIKING", "BIKING_STATIONARY", "ROWING_MACHINE", "STAIR_CLIMBING_MACHINE", "ELLIPTICAL"]);
type Interval = { start: number; end: number };

function union(intervals: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const r of intervals.sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export type ExerciseEnergy = { kcal: Metric<number>; recordedMinutes: number; modeledMinutes: number };

/** Exercise-only comparator. Count overlapping workouts once and never extend a HR sample over a gap >60 seconds.
 * Conservatively restrict the equation to its population and 90–150 bpm steady-state cardio; retain other sports'
 * recorded minutes without claiming their calorie burn. `from`/`to` are local midnights, so DST days need no special case. */
export function exerciseEnergy(
  exercises: readonly Exercise[],
  hr: readonly HrSample[],
  from: number,
  to: number,
  person: { sex: Sex; age: number; weightKg: number | null },
): ExerciseEnergy {
  const intervals = (rows: readonly Exercise[]) => union(rows.flatMap((e) => {
    const start = Math.max(from, e.startTs);
    const end = Math.min(to, e.endTs);
    return end > start ? [{ start, end }] : [];
  }));
  const recorded = intervals(exercises);
  const eligible = intervals(exercises.filter((e) => CARDIO.has(e.type)));
  const recordedMinutes = recorded.reduce((s, r) => s + (r.end - r.start) / 60, 0);
  const { age, weightKg, sex } = person;
  const applicable = age >= 18 && age <= 45 && weightKg !== null && weightKg >= 47 && weightKg <= 120;
  let seconds = 0;
  let kcal = 0;
  for (let i = 0; i < hr.length; i++) {
    const h = hr[i];
    if (!applicable || !(h.bpm >= 90 && h.bpm <= 150)) continue;
    const end = Math.min(h.ts + 60, hr[i + 1]?.ts ?? h.ts + 60, to);
    for (const r of eligible) {
      const span = Math.max(0, Math.min(end, r.end) - Math.max(h.ts, r.start));
      if (!span) continue;
      const kj = sex === "male"
        ? -55.0969 + 0.6309 * h.bpm + 0.1988 * weightKg! + 0.2017 * age
        : -20.4022 + 0.4472 * h.bpm - 0.1263 * weightKg! + 0.074 * age;
      kcal += (kj / 4.184) * (span / 60);
      seconds += span;
    }
  }
  return {
    recordedMinutes,
    modeledMinutes: seconds / 60,
    kcal: { value: seconds > 0 ? kcal : null, reason: seconds > 0 ? null : recordedMinutes > 0 ? "insufficient_hr_data" : "no_data", provisional: seconds > 0 },
  };
}
