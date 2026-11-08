// Keytel et al. 2005, doi:10.1080/02640410470001730089, Table V (without VO2max): kJ/min, converted to kcal/min.
// This population equation is NOT a personalized calibration, an all-day TDEE estimate, or a food-budget credit.
import type { Exercise, HrSample, Sex } from "@/data/types";
import type { Metric } from "@/lib/reasons";

const CARDIO = new Set(["WALKING", "RUNNING", "RUNNING_TREADMILL", "BIKING", "BIKING_STATIONARY", "ROWING_MACHINE", "STAIR_CLIMBING_MACHINE", "ELLIPTICAL"]);
// 2024 Adult Compendium (ages 19–59), general/moderate activities, not competitive/high-intensity variants.
// pacompendium.com/sports/ and /conditioning-exercise/. These are coarse population means, not HR fits.
const METS: Readonly<Record<string, number>> = {
  BADMINTON: 5.5, TENNIS: 6.8, RACQUETBALL: 7, SQUASH: 7.3, TABLE_TENNIS: 4,
  BASKETBALL: 7.5, SOCCER: 7, VOLLEYBALL: 3, BASEBALL: 5, SOFTBALL: 5, CRICKET: 4.8,
  GOLF: 4.5, GYMNASTICS: 3.8, STRENGTH_TRAINING: 3.5, WEIGHTLIFTING: 3.5,
  CALISTHENICS: 3.5, BOOT_CAMP: 5, YOGA: 2.3, PILATES: 2.8, STRETCHING: 2.3,
};
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

export type ExerciseEnergy = {
  kcal: Metric<number>;
  recordedMinutes: number;
  modeledMinutes: number;
  /** HR present during any workout, even a sport outside the calorie equation's scope. */
  hrCoveredMinutes: number;
  /** Mutually exclusive exclusions; together with modeledMinutes they account for recordedMinutes. */
  excludedMinutes: { exerciseType: number; profile: number; hrRange: number; hrMissing: number };
  /** Combined gross exercise estimate: HR first, activity METs next, wearable interval energy last. */
  estimatedKcal: Metric<number>;
  metKcal: number;
  wearableKcal: number;
  metMinutes: number;
  wearableMinutes: number;
  coveredMinutes: number;
  uncoveredMinutes: number;
};

/** Exercise-only comparator. Count overlapping workouts once and never extend a HR sample over a gap >60 seconds.
 * Keep the HR fit within its population and 90–150 bpm steady cardio. Named sports use Compendium METs; generic
 * workouts follow minute-level wearable energy, not a pro-rated daily total. All methods include resting energy
 * during their covered minutes. `from`/`to` are local midnights, so DST days need no special case. */
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
  const eligibleMinutes = eligible.reduce((s, r) => s + (r.end - r.start) / 60, 0);
  const { age, weightKg, sex } = person;
  const applicable = age >= 18 && age <= 45 && weightKg !== null && weightKg >= 47 && weightKg <= 120;
  let seconds = 0;
  let hrSeconds = 0;
  let outOfRangeSeconds = 0;
  let kcal = 0;
  const modeled: Interval[] = [];
  for (let i = 0; i < hr.length; i++) {
    const h = hr[i];
    const end = Math.min(h.ts + 60, hr[i + 1]?.ts ?? h.ts + 60, to);
    if (!Number.isFinite(h.bpm) || h.bpm <= 0) continue;
    for (const r of recorded) hrSeconds += Math.max(0, Math.min(end, r.end) - Math.max(h.ts, r.start));
    if (!applicable) continue;
    for (const r of eligible) {
      const span = Math.max(0, Math.min(end, r.end) - Math.max(h.ts, r.start));
      if (!span) continue;
      if (!(h.bpm >= 90 && h.bpm <= 150)) {
        outOfRangeSeconds += span;
        continue;
      }
      const kj = sex === "male"
        ? -55.0969 + 0.6309 * h.bpm + 0.1988 * weightKg! + 0.2017 * age
        : -20.4022 + 0.4472 * h.bpm - 0.1263 * weightKg! + 0.074 * age;
      kcal += (kj / 4.184) * (span / 60);
      seconds += span;
      modeled.push({ start: Math.max(h.ts, r.start), end: Math.min(end, r.end) });
    }
  }
  const modeledSpans = union(modeled);
  const workouts = exercises.filter((e) => e.startTs < to && e.endTs > from).slice().sort((a, b) => a.id.localeCompare(b.id));
  const restPerMinute = weightKg !== null && Number.isFinite(weightKg) && weightKg > 0 ? 3.5 * weightKg / 200 : null;
  const metWorkouts = restPerMinute !== null && age >= 19 && age <= 59 ? workouts.filter((e) => METS[e.type] !== undefined) : [];
  const wearable = workouts.flatMap((e) => (e.calorieIntervals ?? []).filter((r) => r.endTs > r.startTs && r.endTs - r.startTs <= 60 && Number.isFinite(r.kcal) && r.kcal >= 0 && (!r.active || restPerMinute !== null))
    .map((r) => ({ ...r, start: Math.max(from, e.startTs, r.startTs), end: Math.min(to, e.endTs, r.endTs) })))
    .filter((r) => r.end > r.start).sort((a, b) => Number(a.active) - Number(b.active) || a.startTs - b.startTs || a.endTs - b.endTs || a.kcal - b.kcal);
  const bounds = [...new Set([...recorded, ...modeledSpans, ...wearable, ...metWorkouts.map((e) => ({ start: Math.max(from, e.startTs), end: Math.min(to, e.endTs) }))].flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
  let metMinutes = 0, wearableMinutes = 0, metKcal = 0, wearableKcal = 0;
  let modeledIndex = 0;
  for (let i = 1; i < bounds.length; i++) {
    const start = bounds[i - 1], end = bounds[i];
    while (modeledSpans[modeledIndex]?.end <= start) modeledIndex++;
    if (modeledSpans[modeledIndex]?.start <= start && modeledSpans[modeledIndex]?.end >= end) continue;
    const minutes = (end - start) / 60;
    const met = metWorkouts.find((e) => e.startTs <= start && e.endTs >= end);
    if (met) {
      metMinutes += minutes;
      metKcal += METS[met.type] * restPerMinute! * minutes;
      continue;
    }
    const energy = wearable.find((r) => r.start <= start && r.end >= end);
    if (energy) {
      wearableMinutes += minutes;
      wearableKcal += energy.kcal * (end - start) / (energy.endTs - energy.startTs) + (energy.active ? restPerMinute! * minutes : 0);
    }
  }
  const coveredMinutes = seconds / 60 + metMinutes + wearableMinutes;
  return {
    recordedMinutes,
    modeledMinutes: seconds / 60,
    hrCoveredMinutes: hrSeconds / 60,
    estimatedKcal: { value: coveredMinutes > 0 ? kcal + metKcal + wearableKcal : null, reason: coveredMinutes > 0 ? null : "no_data", provisional: coveredMinutes > 0 },
    metKcal, wearableKcal, metMinutes, wearableMinutes, coveredMinutes,
    uncoveredMinutes: Math.max(0, recordedMinutes - coveredMinutes),
    excludedMinutes: {
      exerciseType: Math.max(0, recordedMinutes - eligibleMinutes),
      profile: applicable ? 0 : eligibleMinutes,
      hrRange: outOfRangeSeconds / 60,
      hrMissing: applicable ? Math.max(0, eligibleMinutes - (seconds + outOfRangeSeconds) / 60) : 0,
    },
    kcal: { value: seconds > 0 ? kcal : null, reason: seconds > 0 ? null : recordedMinutes > 0 ? "insufficient_hr_data" : "no_data", provisional: seconds > 0 },
  };
}
