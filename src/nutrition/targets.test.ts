// Protein uses stored kg regardless of display units; calorie suggestions use inferred maintenance, never wearable
// burn. Until calibrated the food-label reference is explicit, and the person's chosen target always wins.
import { describe, expect, it } from "vitest";
import { calorieTarget, DEFAULT_KCAL, DEFAULT_PROTEIN_G, NO_CUSTOM, parseCustomTargets, parseMacroSplit, parseTarget, progressOf, proteinTarget, resolveTargets, validateTarget } from "./targets";

describe("protein target", () => {
  it("is 1.6 g per kg of the latest weight", () => {
    expect(proteinTarget(72.4, 178)).toEqual({ value: 116, custom: false, basis: "1.6 g per kg at 72.4 kg" });
    expect(proteinTarget(90, null).value).toBe(144);
  });

  it("falls back to a healthy weight for the height, then to 100 g", () => {
    const h = proteinTarget(null, 165);
    expect(h.value).toBe(Math.round(22 * 1.65 ** 2 * 1.6)); // 59.9 kg → 96 g
    expect(h.basis).toContain("165 cm (60 kg)");
    expect(proteinTarget(null, null)).toMatchObject({ value: DEFAULT_PROTEIN_G, custom: false });
    // An implausible reading is no weight.
    expect(proteinTarget(4, null).value).toBe(DEFAULT_PROTEIN_G);
  });

  it("converts the explanation, not the protein calculation, to the selected units", () => {
    const metric = proteinTarget(72.4, 178, "metric");
    const imperial = proteinTarget(72.4, 178, "imperial");
    expect(imperial.value).toBe(metric.value);
    expect(imperial.basis).toBe("0.73 g per lb at 159.6 lb");
    expect(proteinTarget(null, 165, "imperial").basis).toContain("65.0 in (132 lb)");
  });
});

describe("calorie target", () => {
  it("rounds inferred maintenance to the nearest 50 without claiming a weight-loss goal", () => {
    expect(calorieTarget(2374)).toMatchObject({ value: 2350, custom: false });
    expect(calorieTarget(2375).value).toBe(2400);
    expect(calorieTarget(2375).basis).toContain("not a chosen weight-loss target");
  });

  it("labels an unknown estimate as a non-personalized reference", () => {
    expect(calorieTarget(null)).toMatchObject({ value: DEFAULT_KCAL, custom: false });
    expect(calorieTarget(null).basis).toContain("not a personalized estimate");
  });
});

describe("all targets", () => {
  it("sets fat at 30 % of the calories and carbs from what is left", () => {
    const t = resolveTargets(NO_CUSTOM, { weightKg: 70, heightCm: 175, expenditureKcal: 2200 });
    expect(t.kcal.value).toBe(2200);
    expect(t.protein.value).toBe(112);
    expect(t.fat.value).toBe(73);
    expect(t.carbs.value).toBe(Math.round((2200 - 112 * 4 - 73 * 9) / 4));
  });

  it("takes the person's own numbers, and the rest follows them", () => {
    const t = resolveTargets({ kcal: 1800, protein: 150, carbs: null, fat: 50 }, { weightKg: 70, heightCm: null, expenditureKcal: 3250 });
    expect(t.kcal).toEqual({ value: 1800, custom: true, basis: "Your target" });
    expect(t.protein.value).toBe(150);
    expect(t.fat.value).toBe(50);
    expect(t.carbs).toMatchObject({ value: Math.round((1800 - 600 - 450) / 4), custom: false });
    // Never a negative carb target.
    expect(resolveTargets({ kcal: 1000, protein: 300, carbs: null, fat: null }, { weightKg: null, heightCm: null, expenditureKcal: null }).carbs.value).toBe(0);
  });

  it("measures progress up to full", () => {
    expect(progressOf(58, 116)).toBe(0.5);
    expect(progressOf(200, 116)).toBe(1);
    expect(progressOf(null, 116)).toBeNull();
    expect(progressOf(10, 0)).toBeNull();
  });
});

describe("the person's own targets", () => {
  it("reads a field: blank is Pulse's suggestion, else a whole number in range", () => {
    expect(parseTarget("protein", " ")).toEqual({ value: null, error: null });
    expect(parseTarget("kcal", "2,300")).toEqual({ value: 2300, error: null });
    expect(parseTarget("protein", "120.5")).toEqual({ value: null, error: "Whole numbers only" });
    expect(parseTarget("protein", "lots")).toEqual({ value: null, error: "Enter a number" });
    expect(parseTarget("kcal", "300")).toEqual({ value: null, error: "Between 800 and 8,000 kcal" });
    expect(validateTarget("fat", null)).toBeNull();
  });

  it("reads what was stored tolerantly", () => {
    expect(parseCustomTargets(null)).toEqual(NO_CUSTOM);
    expect(parseCustomTargets("{broken")).toEqual(NO_CUSTOM);
    expect(parseCustomTargets(JSON.stringify({ protein: 140, kcal: 50, fat: "60", carbs: 210 }))).toEqual({ kcal: null, protein: 140, carbs: 210, fat: null });
  });

  it("keeps an explicit zero macro target distinct from a blank suggestion", () => {
    expect(parseTarget("carbs", "0")).toEqual({ value: 0, error: null });
    expect(parseTarget("carbs", "")).toEqual({ value: null, error: null });
    const custom = parseCustomTargets(JSON.stringify({ kcal: 1800, protein: 150, carbs: 0, fat: 80 }));
    expect(resolveTargets(custom, { weightKg: 72, heightCm: null, expenditureKcal: 2400 }).carbs).toEqual({ value: 0, custom: true, basis: "Your target" });
    expect(validateTarget("fat", -1)).not.toBeNull();
  });
});

describe("a custom macro split", () => {
  it("uses each nutrient's calorie density and keeps the split as the calorie budget changes", () => {
    const custom = parseCustomTargets(JSON.stringify({ ...NO_CUSTOM, kcal: 2110, split: { protein: 23.5, carbs: 41.5, fat: 35 } }));
    const input = { weightKg: 72, heightCm: 178, expenditureKcal: 2674 };
    const t = resolveTargets(custom, input);
    // 495.85 / 4, 875.65 / 4 and 738.5 / 9 kcal per nutrient, rounded to whole grams.
    expect([t.protein.value, t.carbs.value, t.fat.value]).toEqual([124, 219, 82]);
    expect([t.protein.custom, t.carbs.custom, t.fat.custom]).toEqual([true, true, true]);
    const changed = resolveTargets({ ...custom, kcal: 1800 }, { ...input, units: "imperial" });
    expect([changed.protein.value, changed.carbs.value, changed.fat.value]).toEqual([106, 187, 70]);
    const maintenance = resolveTargets({ ...custom, kcal: null }, input);
    expect(maintenance.kcal.value).toBe(2650);
    expect([maintenance.protein.value, maintenance.carbs.value, maintenance.fat.value]).toEqual([156, 275, 103]);
  });

  it("requires all percentages to be in range and total 100, with decimal points or commas", () => {
    expect(parseMacroSplit({ protein: "23,5", carbs: "41.5", fat: "35" })).toEqual({ value: { protein: 23.5, carbs: 41.5, fat: 35 }, error: null });
    expect(parseMacroSplit({ protein: "0", carbs: "100", fat: "0" })).toEqual({ value: { protein: 0, carbs: 100, fat: 0 }, error: null });
    for (const text of [
      { protein: "23.5", carbs: "41.5", fat: "34.9" },
      { protein: "23.5", carbs: "41.5", fat: "35.1" },
      { protein: "101", carbs: "0", fat: "-1" },
      { protein: "", carbs: "65", fat: "35" },
    ]) {
      const parsed = parseMacroSplit(text);
      expect(parsed.value, JSON.stringify(text)).toBeNull();
      expect(parsed.error, JSON.stringify(text)).toBeTruthy();
    }
  });

  it("round-trips percentages, replaces old gram overrides, and ignores a broken split", () => {
    const grams = { kcal: 1800, protein: 140, carbs: 175, fat: 60 };
    const split = { protein: 25, carbs: 45, fat: 30 };
    expect(parseCustomTargets(JSON.stringify({ ...grams, split }))).toEqual({ ...NO_CUSTOM, kcal: 1800, split });
    expect(parseCustomTargets(JSON.stringify({ ...grams, split: { protein: 101, carbs: 0, fat: -1 } }))).toEqual(grams);
    expect(parseCustomTargets(JSON.stringify({ ...grams, split: { protein: "25", carbs: 45, fat: 30 } }))).toEqual(grams);
    // A small accepted percentage is serialized in exponent notation; it must not disappear on reopening.
    const precise = { protein: 0.0000001, carbs: 99.9999999, fat: 0 };
    expect(parseMacroSplit({ protein: "0.0000001", carbs: "99.9999999", fat: "0" }).value).toEqual(precise);
    expect(parseCustomTargets(JSON.stringify({ ...NO_CUSTOM, split: precise }))).toEqual({ ...NO_CUSTOM, split: precise });
  });
});
