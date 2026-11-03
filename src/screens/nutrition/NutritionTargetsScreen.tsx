// On-phone calorie and macro targets. Health Connect supplies intake, not the goals set in another food app.
import { useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { getLocale, localeFixed } from "@/lib/locale";
import { MACRO_KEYS, NO_CUSTOM, parseMacroSplit, parseTarget, resolveMacros, type CustomTargets, type MacroKey, type Targets } from "@/nutrition/targets";
import { getNutrition } from "@/queries/nutrition";
import { ErrorView } from "@/screens/health/ErrorView";
import { HINT, ROW, ROW_LABEL, TextField } from "@/screens/settings/controls";
import { useScreen } from "@/screens/useScreen";
import { useNutritionTargets } from "@/state/nutrition";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Segmented } from "@/ui/Segmented";
import { useSelectedDay } from "@/ui/shells/DateSwitcher";
import { DetailShell } from "@/ui/shells/DetailShell";
import { SectionShell } from "@/ui/shells/SectionShell";
import { Skeleton } from "@/ui/Skeleton";
import { Text } from "@/ui/Text";
import { toast } from "@/ui/Toast";

type MacroMode = "auto" | "grams" | "percent";

function TargetEditor({ suggested }: { suggested: Targets }) {
  const { t } = useTranslation("nutrition");
  const { t: tr } = useTranslation("energy");
  const { custom, save } = useNutritionTargets();
  const [calories, setCalories] = useState(custom.kcal === null ? "" : String(custom.kcal));
  const [mode, setMode] = useState<MacroMode>(() => custom.split ? "percent" : MACRO_KEYS.some((k) => custom[k] !== null) ? "grams" : "auto");
  const [text, setText] = useState<Record<MacroKey, string>>(() => Object.fromEntries(MACRO_KEYS.map((k) => [k, custom.split ? custom.split[k].toLocaleString(getLocale(), { useGrouping: false, maximumSignificantDigits: 21 }) : custom[k] === null ? "" : String(custom[k])])) as Record<MacroKey, string>);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = useRef(false);
  const parsed = parseTarget("kcal", calories);
  const grams = { protein: parseTarget("protein", text.protein), carbs: parseTarget("carbs", text.carbs), fat: parseTarget("fat", text.fat) };
  const split = parseMacroSplit(text);
  const draft: CustomTargets = {
    ...NO_CUSTOM,
    kcal: parsed.value,
    ...(mode === "grams" ? { protein: grams.protein.value, carbs: grams.carbs.value, fat: grams.fat.value } : {}),
    ...(mode === "percent" && split.value ? { split: split.value } : {}),
  };
  const kcal = parsed.value ?? suggested.kcal.value;
  const macros = resolveMacros(draft, kcal, suggested.protein);
  const invalidGram = mode === "grams" ? MACRO_KEYS.find((k) => grams[k].error) : undefined;
  const macroError = mode === "percent" ? split.error : invalidGram ? t("targets.fieldError", { label: t(`target.${invalidGram}`), error: grams[invalidGram].error }) : null;
  const macroKcal = macros.protein.value * 4 + macros.carbs.value * 4 + macros.fat.value * 9;
  const pick = (next: MacroMode) => {
    if (saving.current) return;
    // Leave an invalid draft without converting its missing values into zero goals.
    const from = macroError ? resolveMacros(custom, kcal, suggested.protein) : macros;
    if (next === "grams") setText({ protein: String(from.protein.value), carbs: String(from.carbs.value), fat: String(from.fat.value) });
    if (next === "percent") {
      const energy = from.protein.value * 4 + from.carbs.value * 4 + from.fat.value * 9;
      const source = energy > 0 ? from : resolveMacros(NO_CUSTOM, kcal, suggested.protein);
      const total = source.protein.value * 4 + source.carbs.value * 4 + source.fat.value * 9;
      // Round cumulative shares in tenths so a zero-carb split cannot acquire a negative rounding remainder.
      const protein = Math.round(source.protein.value * 4 / total * 1000);
      const carbs = Math.round((source.protein.value + source.carbs.value) * 4 / total * 1000) - protein;
      setText({ protein: String(protein / 10), carbs: String(carbs / 10), fat: String((1000 - protein - carbs) / 10) });
    }
    setMode(next);
    setSaveError(null);
  };
  const submit = async () => {
    if (saving.current || parsed.error || macroError) return;
    saving.current = true;
    setPending(true);
    setSaveError(null);
    try {
      await save(draft);
      toast.success(tr("saved"));
    } catch {
      setSaveError(tr("saveFailed"));
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  const hint = mode === "auto" ? t("targets.autoHint") : mode === "grams" ? t("targets.gramsHint", { kcal: localeFixed(macroKcal, 0), budget: localeFixed(kcal, 0) }) : t("targets.percentHint", { total: 100 });
  return (
    <View className="gap-4">
      <View>
        <View className={ROW}>
          <Text className={ROW_LABEL}>{t("target.kcal")}</Text>
          <View className="w-32">
            <TextField variant="number" accessibilityLabel={tr("calorieTarget")} keyboardType="number-pad" returnKeyType="done" selectTextOnFocus value={calories} onChangeText={(s) => { setCalories(s); setSaveError(null); }} placeholder={String(suggested.kcal.value)} editable={!pending} onSubmitEditing={() => void submit()} invalid={!!parsed.error} right={<Text className={cn(HINT, "px-2")}>kcal</Text>} />
          </View>
        </View>
        <Text accessibilityLiveRegion="polite" className={cn(HINT, parsed.error && "text-recovery-red-text")}>{parsed.error ?? t("targets.calorieHint", { kcal: localeFixed(suggested.kcal.value, 0) })}</Text>
      </View>
      <View className="gap-3">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="shrink text-xs font-bold uppercase leading-4 tracking-[0.1em] text-foreground-secondary">{t("targets.macros")}</Text>
          <View pointerEvents={pending ? "none" : "auto"} accessibilityState={{ disabled: pending }} className={cn(pending && "opacity-disabled")}>
            <Segmented<MacroMode> label={t("targets.format")} value={mode} onChange={pick} options={[
              { value: "auto", label: t("targets.auto"), accessibilityLabel: t("targets.autoAria") },
              { value: "grams", label: t("targets.grams"), accessibilityLabel: t("targets.gramsAria") },
              { value: "percent", label: t("targets.percent"), accessibilityLabel: t("targets.percentAria") },
            ]} />
          </View>
        </View>
        <View className="gap-2">
          <View className="flex-row gap-3">
            {MACRO_KEYS.map((k) => <Text key={k} className={cn(HINT, "min-w-0 flex-1")}>{t(`target.${k}`)}</Text>)}
          </View>
          <View className="flex-row gap-3">
            {MACRO_KEYS.map((k) => {
              const invalid = mode === "grams" ? !!grams[k].error : mode === "percent" && !!split.error;
              const unit = mode === "percent" ? "%" : "g";
              const detail = invalid || !!parsed.error ? "--" : mode === "percent" ? `${macros[k].value} g` : t("targets.share", { pct: localeFixed(macros[k].value * (k === "fat" ? 9 : 4) / kcal * 100, 1) });
              return (
                <View key={k} className="min-w-0 flex-1 gap-2">
                  <TextField variant="input" accessibilityLabel={t("targets.fieldAria", { label: t(`target.${k}`), unit })} keyboardType={mode === "percent" ? "decimal-pad" : "number-pad"} returnKeyType="done" selectTextOnFocus value={mode === "auto" ? String(macros[k].value) : text[k]} placeholder={mode === "percent" ? undefined : String(macros[k].value)} onChangeText={(s) => { setText((v) => ({ ...v, [k]: s })); setSaveError(null); }} editable={!pending && mode !== "auto"} invalid={invalid} onSubmitEditing={() => void submit()} right={<Text className={cn(HINT, "px-2")}>{unit}</Text>} />
                  <Text className={cn(HINT, "tabular-nums")}>{detail}</Text>
                </View>
              );
            })}
          </View>
        </View>
        <Text accessibilityLiveRegion="polite" className={cn(HINT, macroError && "text-recovery-red-text")}>{macroError ?? hint}</Text>
      </View>
      <Text className={HINT}>{t("targets.syncNote")}</Text>
      <Button variant="outline" disabled={pending || !!parsed.error || !!macroError} onPress={() => void submit()}>{pending ? tr("saving") : t("targets.save")}</Button>
      {!!saveError && <Text accessibilityLiveRegion="polite" className={cn(HINT, "text-recovery-red-text")}>{saveError}</Text>}
    </View>
  );
}

export function NutritionTargetsScreen() {
  const { t } = useTranslation("nutrition");
  const [day] = useSelectedDay();
  const { ready } = useNutritionTargets();
  // Suggestions do not depend on custom targets. Saving must not replace the active form with a new query skeleton.
  const { data: vm, error, reload } = useScreen((ctx) => ready ? getNutrition(ctx, NO_CUSTOM, day) : Promise.resolve(null), ["nutrition", NO_CUSTOM, ready, day]);
  if (!vm) return error ? <ErrorView detail retry={reload} /> : <DetailShell title={t("screen.targets")} loading primary={<Skeleton className="h-80 rounded-2xl" />} />;

  return (
    <DetailShell
      title={t("screen.targets")}
      backHref={`/nutrition?d=${vm.day}`}
      primary={
        <SectionShell variant="card" title={t("screen.targets")} info={{ title: t("screen.targets"), body: `${t("targets.infoBody")}\n\n${vm.suggested.kcal.basis}\n\n${vm.suggested.protein.basis}` }}>
          <TargetEditor suggested={vm.suggested} />
        </SectionShell>
      }
    />
  );
}
