// Percentage-only goals must survive reopening even when every individual gram target is null.
import { describe, expect, it, vi } from "vitest";
import { NO_CUSTOM, parseCustomTargets } from "@/nutrition/targets";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { storage.set(key, value); },
    removeItem: async (key: string) => { storage.delete(key); },
  },
}));
const { NUTRITION_TARGETS_KEY, saveNutritionTargets } = await import("./nutrition");

describe("saved nutrition targets", () => {
  it("preserves a split without a calorie override, then replaces or resets it without leaving stale goals", async () => {
    const split = { ...NO_CUSTOM, split: { protein: 25, carbs: 45, fat: 30 } };
    await saveNutritionTargets(split);
    expect(parseCustomTargets(storage.get(NUTRITION_TARGETS_KEY) ?? null)).toEqual(split);

    const grams = { kcal: 1850, protein: 145, carbs: 0, fat: 75 };
    await saveNutritionTargets(grams);
    expect(parseCustomTargets(storage.get(NUTRITION_TARGETS_KEY) ?? null)).toEqual(grams);

    await saveNutritionTargets(NO_CUSTOM);
    expect(storage.has(NUTRITION_TARGETS_KEY)).toBe(false);
    expect(parseCustomTargets(storage.get(NUTRITION_TARGETS_KEY) ?? null)).toEqual(NO_CUSTOM);
  });
});
