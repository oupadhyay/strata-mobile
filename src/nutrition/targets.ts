// Daily nutrition targets: calories, protein, carbs and fat. Each is the person's own number when they set one
// (Nutrition › Targets, kept on the phone by src/state/nutrition.ts), else Pulse's suggestion from their own data:
//  - protein: 1.6 g per kg of their latest weight (the point past which more protein stopped adding lean mass in
//    resistance-trained adults, Morton et al. 2018, Br J Sports Med); with no weight reading, the same per kg of a
//    healthy weight for their height (BMI 22); with neither, 100 g;
//  - calories: maintenance inferred from intake and weight; until calibrated, the explicitly non-personalized
//    2,000 kcal food-label reference. Wearable calorie burn never raises the food budget;
//  - fat: 30 % of the calories (inside the 20-35 % the dietary guidelines give);
//  - carbs: the calories left after protein and fat.
// No React or database, so the tests run in node. The "basis" sentences and errors are translated here (nutrition, errors).
import { getLocale, localeFixed } from "@/lib/locale";
import { i18n } from "@/i18n/config";
import { quantity, type UnitSystem } from "@/lib/units";

export const MACRO_KEYS = ["protein", "carbs", "fat"] as const;
export type MacroKey = (typeof MACRO_KEYS)[number];
export const TARGET_KEYS = ["kcal", ...MACRO_KEYS] as const;
export type TargetKey = (typeof TARGET_KEYS)[number];

/** Percentages of the calorie budget, not of gram totals. Kept as percentages so later calorie changes scale them. */
export type MacroSplit = Record<MacroKey, number>;
/** The person's own gram targets, or a percentage split; null without a split follows Pulse's suggestion. */
export type CustomTargets = Record<TargetKey, number | null> & { split?: MacroSplit };
export const NO_CUSTOM: CustomTargets = { kcal: null, protein: null, carbs: null, fat: null };

export const PROTEIN_G_PER_KG = 1.6;
export const REFERENCE_BMI = 22;
export const DEFAULT_PROTEIN_G = 100;
export const DEFAULT_KCAL = 2000;
export const FAT_SHARE = 0.3;

export type TargetLimit = { min: number; max: number; unit: string };
export const TARGET_LIMITS: Record<TargetKey, TargetLimit> = {
  kcal: { min: 800, max: 8000, unit: "kcal" },
  protein: { min: 0, max: 400, unit: "g" },
  carbs: { min: 0, max: 1000, unit: "g" },
  fat: { min: 0, max: 400, unit: "g" },
};

/** One resolved target: its value, whether it is the person's own, and where it comes from in a few words. */
export type Target = { value: number; custom: boolean; basis: string };
export type Targets = Record<TargetKey, Target>;

const group = (v: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
const kg1 = (v: number) => localeFixed(Math.round(v * 10) / 10, 1);

/** The protein suggestion: 1.6 g per kg of the latest weight, else of a healthy weight for the height, else 100 g. */
export function proteinTarget(weightKg: number | null, heightCm: number | null, units?: UnitSystem): Target {
  const q = quantity("kg", units);
  if (weightKg !== null && Number.isFinite(weightKg) && weightKg >= 20 && weightKg <= 300) {
    return { value: Math.round(weightKg * PROTEIN_G_PER_KG), custom: false, basis: i18n.t("energy:proteinWeight", { per: localeFixed(PROTEIN_G_PER_KG / q.change(1), q.unit === "kg" ? 1 : 2), weight: kg1(q.value(weightKg)), unit: q.unit }) };
  }
  if (heightCm !== null && Number.isFinite(heightCm) && heightCm >= 100 && heightCm <= 250) {
    const kg = REFERENCE_BMI * (heightCm / 100) ** 2;
    const h = quantity("cm", units);
    return { value: Math.round(kg * PROTEIN_G_PER_KG), custom: false, basis: i18n.t("energy:proteinHeight", { height: localeFixed(h.value(heightCm), h.unit === "cm" ? 0 : 1), heightUnit: h.unit, weight: Math.round(q.value(kg)), unit: q.unit }) };
  }
  return { value: DEFAULT_PROTEIN_G, custom: false, basis: i18n.t("nutrition:basis.proteinDefault", { perKg: PROTEIN_G_PER_KG }) };
}

/** Maintenance is a reference, not a chosen weight-loss goal. The person's own calorie target always wins. */
export function calorieTarget(expenditureKcal: number | null): Target {
  if (expenditureKcal !== null && Number.isFinite(expenditureKcal) && expenditureKcal >= 800 && expenditureKcal <= 8000) {
    return { value: Math.round(expenditureKcal / 50) * 50, custom: false, basis: i18n.t("energy:maintenanceBasis") };
  }
  return { value: DEFAULT_KCAL, custom: false, basis: i18n.t("energy:referenceBasis") };
}

/** Every target: the person's own where set, else the suggestions (fat and carbs follow the calories and protein). */
export function resolveTargets(custom: CustomTargets, input: { weightKg: number | null; heightCm: number | null; expenditureKcal: number | null; units?: UnitSystem }): Targets {
  const kcal = custom.kcal !== null ? { value: custom.kcal, custom: true, basis: i18n.t("nutrition:basis.own") } : calorieTarget(input.expenditureKcal);
  return { kcal, ...resolveMacros(custom, kcal.value, proteinTarget(input.weightKg, input.heightCm, input.units)) };
}

/** Resolve macros for a calorie budget; the editor and saved targets use the same suggestions. */
export function resolveMacros(custom: CustomTargets, kcal: number, suggestedProtein: Target): Pick<Targets, MacroKey> {
  const split = custom.split;
  if (split) {
    const target = (k: MacroKey): Target => ({
      value: Math.round(kcal * split[k] / 100 / (k === "fat" ? 9 : 4)),
      custom: true,
      basis: i18n.t("nutrition:targets.percentBasis", { pct: split[k], kcal: group(kcal) }),
    });
    return { protein: target("protein"), carbs: target("carbs"), fat: target("fat") };
  }
  const own = (k: MacroKey): Target | null => (custom[k] !== null ? { value: custom[k], custom: true, basis: i18n.t("nutrition:basis.own") } : null);
  const protein = own("protein") ?? suggestedProtein;
  const fat = own("fat") ?? { value: Math.round((kcal * FAT_SHARE) / 9), custom: false, basis: i18n.t("nutrition:basis.fat", { pct: Math.round(FAT_SHARE * 100), kcal: group(kcal) }) };
  const left = kcal - protein.value * 4 - fat.value * 9;
  const carbs = own("carbs") ?? { value: Math.max(0, Math.round(left / 4)), custom: false, basis: i18n.t("nutrition:basis.carbs") };
  return { protein, carbs, fat };
}

/** Progress toward a target, 0-1 (more than the target reads full); null without a value. */
export const progressOf = (value: number | null, target: number) => (value === null || !(target > 0) ? null : Math.max(0, Math.min(1, value / target)));

/** Null when `value` may be `key`'s target (null: Pulse's suggestion), else why not. */
export function validateTarget(key: TargetKey, value: number | null): string | null {
  if (value === null) return null;
  const l = TARGET_LIMITS[key];
  if (!Number.isFinite(value)) return i18n.t("errors:goals.enterNumber");
  if (!Number.isInteger(value)) return i18n.t("errors:goals.wholeOnly");
  if (value < l.min || value > l.max) return i18n.t("nutrition:basis.between", { low: group(l.min), high: group(l.max), unit: l.unit });
  return null;
}

/** A field's text: blank is Pulse's suggestion (null); else the number and the error to show, if any. */
export function parseTarget(key: TargetKey, text: string): { value: number | null; error: string | null } {
  const t = text.trim().replace(/[,\s](?=\d{3}\b)/g, "");
  if (t === "") return { value: null, error: null };
  const n = /^\d+([.]\d+)?$/.test(t) ? Number(t) : NaN;
  const error = Number.isNaN(n) ? i18n.t("errors:goals.enterNumber") : validateTarget(key, n);
  return { value: error ? null : n, error };
}

/** Percentages share one validation rule for stored numbers and typed fields. */
export function validateMacroSplit(split: MacroSplit): string | null {
  const total = split.protein + split.carbs + split.fat;
  if (MACRO_KEYS.some((k) => !Number.isFinite(split[k]) || split[k] < 0 || split[k] > 100)) {
    return i18n.t("nutrition:targets.splitError");
  }
  return Math.abs(total - 100) > 1e-6 ? i18n.t("nutrition:targets.splitTotalError", { total: new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 6 }).format(total) }) : null;
}

/** All three percentages are required, each 0–100, totaling 100. Decimal commas and points are accepted. */
export function parseMacroSplit(text: Record<MacroKey, string>): { value: MacroSplit | null; error: string | null } {
  const read = (k: MacroKey) => {
    const s = text[k].trim().replace(",", ".");
    return /^\d+([.]\d+)?$/.test(s) ? Number(s) : NaN;
  };
  const split: MacroSplit = { protein: read("protein"), carbs: read("carbs"), fat: read("fat") };
  const error = validateMacroSplit(split);
  return { value: error ? null : split, error };
}

/** Stored JSON → custom targets; anything missing, broken or out of range follows the suggestion. */
export function parseCustomTargets(raw: string | null): CustomTargets {
  let v: unknown = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: CustomTargets = { ...NO_CUSTOM };
  for (const k of TARGET_KEYS) {
    const t = o[k];
    if (typeof t === "number" && validateTarget(k, t) === null) out[k] = t;
  }
  if (o.split && typeof o.split === "object") {
    const s = o.split as MacroSplit;
    if (MACRO_KEYS.every((k) => typeof s[k] === "number") && validateMacroSplit(s) === null) {
      return { kcal: out.kcal, protein: null, carbs: null, fat: null, split: { protein: s.protein, carbs: s.carbs, fat: s.fat } };
    }
  }
  return out;
}
