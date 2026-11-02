// A day-based companion to the existing food logger, using Pulse's unchanged shells, type, charts and theme tokens.
import { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatDay, FORMATS, unitLabel } from "@/lib/format";
import { zoneOf } from "@/nutrition/balance";
import { parseTarget, TARGET_KEYS, TARGET_LIMITS } from "@/nutrition/targets";
import { getNutrition, type Averages, type NutritionVM } from "@/queries/nutrition";
import { ErrorView } from "@/screens/health/ErrorView";
import { Field, SwitchRow, TextField } from "@/screens/settings/controls";
import { useScreen } from "@/screens/useScreen";
import { setNutrition, useApp } from "@/state/app";
import { useNutritionTargets } from "@/state/nutrition";
import { Button } from "@/ui/Button";
import { CalorieBalanceChart } from "@/ui/charts/CalorieBalanceChart";
import { ColumnChart } from "@/ui/charts/ColumnChart";
import { TrendChart } from "@/ui/charts/TrendChart";
import { cn } from "@/ui/cn";
import { KeyStatRow } from "@/ui/metrics/KeyStatRow";
import { CAPTION } from "@/ui/metrics/primitives";
import { Segmented } from "@/ui/Segmented";
import { DetailShell } from "@/ui/shells/DetailShell";
import { useSelectedDay } from "@/ui/shells/DateSwitcher";
import { EmptyState } from "@/ui/shells/EmptyState";
import { SectionShell } from "@/ui/shells/SectionShell";
import { Skeleton } from "@/ui/Skeleton";
import { Text } from "@/ui/Text";
import { toast } from "@/ui/Toast";
import { Today } from "./NutritionHero";

const grouped = (v: number) => FORMATS.grouped(v);
const grams = (v: number) => FORMATS.int(v);
const show = (v: number | null, f: (x: number) => string) => (v === null ? "--" : f(v));
const metric = (value: number | null) => ({ value, reason: value === null ? "no_data" as const : null, provisional: false });

/** One period's daily averages, in the existing overview's two flat tiles. */
function AverageTile({ title, a }: { title: string; a: Averages }) {
  const { t: tr } = useTranslation("nutrition");
  const macros = [tr("numbers.protein", { value: show(a.protein, grams) }), tr("numbers.carbs", { value: show(a.carbs, grams) }), tr("numbers.fat", { value: show(a.fat, grams) })].join(" · ");
  const days = tr("averages.days", { days: a.days, span: a.span });
  return (
    <View accessible accessibilityLabel={`${title}: ${a.days === 0 ? tr("averages.none") : `${tr("numbers.kcal", { value: show(a.kcal, grouped) })}, ${macros}, ${days}`}`} className="min-w-0 flex-1 gap-2 rounded-xl bg-inset p-3">
      <Text className="text-[10px] font-bold uppercase leading-3 tracking-[0.1em] text-foreground-secondary">{title}</Text>
      {a.days === 0 ? <Text className={CAPTION}>{tr("averages.none")}</Text> : (
        <>
          <Text className="font-numeric text-[30px] font-bold leading-9 tracking-[-0.01em] tabular-nums">
            {show(a.kcal, grouped)}<Text className="text-sm font-medium leading-5">{` ${tr("unit.kcal")}`}</Text>
          </Text>
          <Text className={cn(CAPTION, "tabular-nums")}>{macros}</Text>
          <Text className={cn(CAPTION, "tabular-nums")}>{days}</Text>
        </>
      )}
    </View>
  );
}

function History({ vm }: { vm: NutritionVM }) {
  const { t } = useTranslation("nutrition");
  const { t: e } = useTranslation("energy");
  const [key, setKey] = useState<"protein" | "kcal">("kcal");
  const target = vm.targets[key].value;
  const unit = key === "protein" ? "g" : "kcal";
  const data = vm.history.map((h) => ({ label: h.day.slice(8), title: h.day, value: h[key] }));
  return (
    <View className="gap-3">
      <Segmented label={t("history.chart")} fill value={key} onChange={setKey} options={[{ value: "kcal", label: t("history.calories") }, { value: "protein", label: t("history.protein") }]} />
      {data.some((d) => d.value !== null) ? <ColumnChart summary={key === "protein" ? t("history.summaryProtein") : t("history.summaryCalories")} data={data} format={key === "protein" ? "int" : "grouped"} unit={unit} tickEvery={7} yAxis reference={{ y: target, label: `${show(target, key === "protein" ? grams : grouped)} ${unitLabel(unit)}` }} /> : <EmptyState body={t("history.empty")} />}
      <Text className={CAPTION}>{e("historyNote")}</Text>
    </View>
  );
}

function CalorieTarget({ placeholder }: { placeholder: number }) {
  const { t } = useTranslation("energy");
  const { custom, save } = useNutritionTargets();
  const [text, setText] = useState(custom.kcal === null ? "" : String(custom.kcal));
  const [pending, setPending] = useState(false);
  const parsed = parseTarget("kcal", text);
  const submit = async () => {
    if (pending || parsed.error) return;
    setPending(true);
    try {
      await save({ ...custom, kcal: parsed.value });
      toast.success(t("saved"));
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setPending(false);
    }
  };
  return (
    <View className="gap-3 pt-3">
      <Field label={t("calorieTarget")} hint={t("targetHint")} error={parsed.error ?? undefined}>
        <TextField variant="input" accessibilityLabel={t("calorieTarget")} keyboardType="number-pad" value={text} onChangeText={setText} placeholder={String(placeholder)} editable={!pending} onSubmitEditing={() => void submit()} invalid={!!parsed.error} />
      </Field>
      <Button variant="outline" disabled={pending || !!parsed.error} onPress={() => void submit()}>{t(pending ? "saving" : "saveTarget")}</Button>
    </View>
  );
}

export function NutritionScreen() {
  const { t } = useTranslation("nutrition");
  const { t: e } = useTranslation("energy");
  const [day] = useSelectedDay();
  const profile = useApp((s) => s.profile);
  const { custom, ready } = useNutritionTargets();
  const { data: vm, error, reload } = useScreen((ctx) => ready ? getNutrition(ctx, custom, day) : Promise.resolve(null), ["nutrition", custom, ready, day]);
  const [pending, setPending] = useState(false);
  if (!vm) return error ? <ErrorView detail retry={reload} /> : <DetailShell title={t("title")} dateSwitcher={{ mode: "day" }} loading hero={<Skeleton className="h-64 w-full rounded-2xl" />} />;

  const energy = vm.energy;
  const prefs = profile?.nutrition ?? { excludedDays: [], plan: null };
  const persist = async (next: typeof prefs) => {
    if (pending || !profile) return;
    setPending(true);
    try {
      await setNutrition(next);
      toast.success(e("saved"));
    } catch {
      toast.error(e("saveFailed"));
    } finally {
      setPending(false);
    }
  };
  const data = energy.balanceDays.map((d) => ({ label: formatDay(d.day, { weekday: "short" }), kcalIn: d.kcalIn, kcalOut: d.kcalOut, zone: d.kcalIn === null ? null : zoneOf(d.kcalIn, vm.targets.kcal.value) }));
  const estimateNote = energy.state === "calibrating" ? e("calibrating") : e(energy.state, { day: energy.estimatedOn });

  return (
    <DetailShell
      title={t("title")}
      dateSwitcher={{ mode: "day" }}
      info={{ title: t("info.title"), body: e("info") }}
      hero={<Today vm={vm} />}
      primary={
        <SectionShell variant="card" title={e("balance")} info={{ title: e("balance"), body: [e("assumption"), e("chartNote")].join("\n\n") }}>
          <Text className={CAPTION}>{e("source")}</Text>
          <KeyStatRow variant="row" label={e("tdee")} metric={energy.tdee} unit="kcal" format="grouped" direction="none" />
          <Text className={CAPTION}>{estimateNote}</Text>
          <KeyStatRow variant="row" label={e(energy.deficit !== null && energy.deficit < 0 ? "surplus" : "deficit")} metric={{ ...metric(energy.deficit === null ? null : Math.abs(energy.deficit)), provisional: energy.deficit !== null }} unit="kcal" format="grouped" direction="none" />
          {vm.day === vm.today && <Text className={CAPTION}>{e("dayNotFinished")}</Text>}
          {energy.missingEnergy && <Text className={CAPTION}>{e("missingEnergy")}</Text>}
          <SwitchRow label={e("partial")} hint={e("partialHint")} value={energy.excluded} disabled={pending} onChange={(on) => void persist({ ...prefs, excludedDays: on ? [...prefs.excludedDays, vm.day] : prefs.excludedDays.filter((d) => d !== vm.day) })} />
          <View className="gap-3 pt-4">
            <CalorieBalanceChart summary={e("chart")} data={data} goal={vm.targets.kcal.value} goalLabel={t("history.target")} />
            <Text className={CAPTION}>{e("chartKey")}</Text>
          </View>
        </SectionShell>
      }
      secondary={[
        <SectionShell key="weight" variant="card" title={e("weight")} info={{ title: e("weight"), body: e("weightNote") }}>
          <KeyStatRow variant="row" label={e("trend")} caption={energy.weightDay ? e("weightDate", { day: energy.weightDay }) : undefined} metric={energy.weight} unit={energy.weightUnit} format="decimal1" direction="none" href={`/metric/weight?d=${vm.day}`} />
          <TrendChart label={e("weight")} data={{ value: energy.weightHistory, reason: null, provisional: false }} format="decimal1" unit={energy.weightUnit} colorBy="single" level sparse fixedRange="m" headline="day" />
          <Text className={CAPTION}>{e("weightHistoryNote")}</Text>
          {energy.expectedWeight !== null ? (
            <>
              <KeyStatRow variant="row" label={e("originalPlan")} metric={metric(energy.expectedWeight)} unit={energy.weightUnit} format="decimal1" direction="none" />
              <KeyStatRow variant="row" label={e("planGap")} metric={metric(energy.planGap)} unit={energy.weightUnit} format="decimal1" direction="none" />
              <Text className={CAPTION}>{e("planNote", { day: energy.planStart })}</Text>
            </>
          ) : !energy.planStart && (
            <View className="gap-3 pt-3">
              <Text className={CAPTION}>{e("planNeeds")}</Text>
              <Button variant="outline" disabled={pending || !energy.planCandidate} onPress={() => energy.planCandidate && void persist({ ...prefs, plan: energy.planCandidate })}>{e("startPlan")}</Button>
            </View>
          )}
        </SectionShell>,
        <SectionShell key="targets" variant="card" title={t("screen.targets")} info={false}>
          {TARGET_KEYS.map((k) => <KeyStatRow key={k} variant="row" label={t(`target.${k}`)} caption={vm.targets[k].basis} metric={metric(vm.targets[k].value)} unit={TARGET_LIMITS[k].unit} format={k === "kcal" ? "grouped" : "int"} direction="none" />)}
          <CalorieTarget key={custom.kcal} placeholder={vm.suggested.kcal.value} />
        </SectionShell>,
        <SectionShell key="activity" variant="card" title={e("activity")} info={{ title: e("activity"), body: [e("hrNote"), e("wearableNote")].join("\n\n") }}>
          <KeyStatRow variant="row" label={e("recordedMinutes")} metric={metric(energy.activity.recordedMinutes || null)} unit="min" format="int" direction="none" />
          <KeyStatRow variant="row" label={e("hrEnergy")} metric={energy.activity.kcal} unit="kcal" format="grouped" direction="none" />
          <Text className={CAPTION}>{e("hrCoverage", { modeled: grams(energy.activity.modeledMinutes), recorded: grams(energy.activity.recordedMinutes) })}</Text>
          <Text className={CAPTION}>{e("activityNote")}</Text>
          <KeyStatRow variant="row" label={e("wearable")} metric={{ ...metric(energy.wearableKcal), provisional: vm.day === vm.today }} unit="kcal" format="grouped" direction="none" />
        </SectionShell>,
        <SectionShell key="averages" variant="card" title={t("averages.title")} info={{ title: t("averages.title"), body: e("averagesNote") }}>
          <View className="flex-row gap-3"><AverageTile title={t("averages.last7")} a={vm.week} /><AverageTile title={t("averages.last30")} a={vm.month} /></View>
        </SectionShell>,
        <SectionShell key="history" variant="card" title={t("averages.last30")} info={false}><History vm={vm} /></SectionShell>,
      ]}
    />
  );
}
