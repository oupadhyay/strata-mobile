// A day-based companion to the existing food logger, using Pulse's unchanged shells, type, charts and theme tokens.
import { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { DAY, formatDay, FORMATS, unitLabel } from "@/lib/format";
import { addDays } from "@/lib/time";
import { RANGES } from "@/lib/url";
import { zoneOf } from "@/nutrition/balance";
import { getNutrition, type NutritionVM } from "@/queries/nutrition";
import { ErrorView } from "@/screens/health/ErrorView";
import { SwitchRow } from "@/screens/settings/controls";
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
import { ActivityComparison, ActivityComparisonInfo } from "./ActivityComparison";
import { Today } from "./NutritionHero";

const grouped = (v: number) => FORMATS.grouped(v);
const grams = (v: number) => FORMATS.int(v);
const show = (v: number | null, f: (x: number) => string) => (v === null ? "--" : f(v));
const metric = (value: number | null) => ({ value, reason: value === null ? "no_data" as const : null, provisional: false });

/** Three compact rows share a 0–150% scale; the goal tick stays aligned and coverage stays separate. */
function MacroAverages({ vm }: { vm: NutritionVM }) {
  const { t } = useTranslation("nutrition");
  const { t: e } = useTranslation("energy");
  const [period, setPeriod] = useState<"7" | "30">("7");
  const a = period === "7" ? vm.week : vm.month;
  const from = addDays(vm.day, -a.span);
  const to = addDays(vm.day, -1);
  const scale = 1.5;
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-2">
        <Text className={cn(CAPTION, "shrink")}>{e("macroComparison")}</Text>
        <Segmented label={e("macroPeriod")} value={period} onChange={setPeriod} options={[
          { value: "7", label: e("range7"), accessibilityLabel: t("averages.last7") },
          { value: "30", label: e("range30"), accessibilityLabel: t("averages.last30") },
        ]} />
      </View>
      <View className="gap-2">
        {(["protein", "carbs", "fat"] as const).map((key) => {
          const value = a[key];
          const target = vm.targets[key].value;
          const ratio = value !== null && target > 0 ? value / target : null;
          const label = t(`target.${key}`);
          return (
            <View key={key} accessible accessibilityRole="image" accessibilityLabel={e(value === null ? "macroMissingA11y" : "macroAverageA11y", { label, value: show(value, grams), target: grams(target) })}>
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="gap-1">
                <View className="flex-row items-baseline justify-between gap-2">
                  <Text className={cn(CAPTION, "text-foreground-secondary")}>{label}</Text>
                  <Text className={cn(CAPTION, "tabular-nums")}><Text className="font-bold text-foreground">{show(value, grams)}</Text>{t("today.macroOf", { target: grams(target) })}</Text>
                </View>
                <View className={cn("relative h-1.5 rounded-xs", value === null ? "border-y border-dashed border-border" : "bg-foreground/10")}>
                  {ratio !== null && <>
                    <View className="h-full rounded-xs bg-energy-active" style={{ width: `${Math.max(0, Math.min(1, ratio / scale)) * 100}%` }} />
                    <View className="absolute -top-0.5 h-2.5 w-px bg-foreground" style={{ left: `${100 / scale}%` }} />
                    {ratio > scale && <View className="absolute right-0 top-0 size-1.5 rotate-45 border-r-2 border-t-2 border-energy-active" />}
                  </>}
                </View>
              </View>
            </View>
          );
        })}
      </View>
      <View accessible accessibilityLabel={e("logCoverageA11y", { days: a.days, span: a.span, from: formatDay(from, DAY.short), to: formatDay(to, DAY.short) })} className="gap-1 border-t border-border pt-2">
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="gap-1">
          <View className="flex-row items-baseline justify-between gap-2">
            <Text className={CAPTION}>{e("logCoverage")}</Text>
            <Text className={cn(CAPTION, "font-numeric font-bold tabular-nums text-foreground-secondary")}>{FORMATS.pct(a.days / a.span * 100)}</Text>
          </View>
          <View className="flex-row gap-1">
            {a.coverage.map((known, i) => <View key={i} className={cn("h-1.5 min-w-0 flex-1 rounded-xs border border-muted-foreground", known && "bg-foreground-secondary border-foreground-secondary")} />)}
          </View>
          <View className="flex-row gap-1">
            {a.span === 7 ? a.coverage.map((_, i) => <Text key={i} className="min-w-0 flex-1 text-center text-[10px] leading-3 text-muted-foreground">{formatDay(addDays(from, i), { weekday: "narrow" })}</Text>) : <>
              <Text className="flex-1 text-[10px] leading-3 text-muted-foreground">{formatDay(from, DAY.monthDay)}</Text>
              <Text className="text-[10px] leading-3 text-muted-foreground">{formatDay(to, DAY.monthDay)}</Text>
            </>}
          </View>
        </View>
      </View>
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
      <Text className={CAPTION}>{e("historyLegend")}</Text>
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

  return (
    <DetailShell
      title={t("title")}
      dateSwitcher={{ mode: "day" }}
      info={{ title: t("info.title"), body: e("info") }}
      hero={<Today vm={vm} />}
      primary={
        <SectionShell variant="card" title={e("balance")} action={{ label: e("targets"), href: `/nutrition-targets?d=${vm.day}` }} info={{ title: e("balance"), body: [e("calibrationNote"), e("assumption"), e("chartNote"), e("dayNotFinished"), e("partialHint")].join("\n\n") }}>
          {energy.state === "calibrating" ? <Text className="text-xl font-semibold leading-7">{e("calibrating")}</Text> : (
            <>
              <KeyStatRow variant="row" label={e("tdee")} metric={energy.tdee} unit="kcal" format="grouped" direction="none" />
              <Text className={CAPTION}>{e(energy.state, { day: energy.estimatedOn })}</Text>
              {energy.deficit !== null && <KeyStatRow variant="row" label={e(energy.deficit < 0 ? "surplus" : "deficit")} metric={{ ...metric(Math.abs(energy.deficit)), provisional: true }} unit="kcal" format="grouped" direction="none" />}
            </>
          )}
          <View className="gap-3 pt-4">
            <CalorieBalanceChart summary={e("chart")} data={data} goal={vm.targets.kcal.value} goalLabel={t("history.target")} />
            <Text className={CAPTION}>{e(data.some((d) => d.kcalOut !== null) ? "chartKey" : "intakeKey")}</Text>
          </View>
          {energy.missingEnergy && energy.excluded && <Text className={CAPTION}>{e("missingEnergy")}</Text>}
          <SwitchRow rule label={e("partial")} value={energy.excluded} disabled={pending} onChange={(on) => void persist({
            ...prefs,
            excludedDays: [...prefs.excludedDays.filter((d) => d !== vm.day), ...(on ? [vm.day] : [])],
            completeDays: [...(prefs.completeDays ?? []).filter((d) => d !== vm.day), ...(!on ? [vm.day] : [])],
          })} />
        </SectionShell>
      }
      secondary={[
        <SectionShell key="weight" variant="card" title={e("weight")} action={{ label: e("weighIns"), href: `/metric/weight?d=${vm.day}` }} info={{ title: e("weight"), body: [e("weightNote"), e("weightHistoryNote"), energy.planStart ? e("planNote", { day: energy.planStart }) : e("planRequirements")].join("\n\n") }}>
          <TrendChart label={e("weight")} data={{ value: energy.weightHistory, reason: null, provisional: false }} format="decimal1" unit={energy.weightUnit} colorBy="single" level sparse ranges={RANGES} headline="day" />
          {energy.expectedWeight !== null ? (
            <>
              <KeyStatRow variant="row" label={e("originalPlan")} metric={metric(energy.expectedWeight)} unit={energy.weightUnit} format="decimal1" direction="none" />
              <KeyStatRow variant="row" label={e("planGap")} metric={metric(energy.planGap)} unit={energy.weightUnit} format="decimal1" direction="none" />
            </>
          ) : !energy.planStart && (
            <View className="gap-3 pt-3">
              {!energy.planCandidate && <Text className={CAPTION}>{e("planNeeds")}</Text>}
              <Button variant="outline" disabled={pending || !energy.planCandidate} onPress={() => energy.planCandidate && void persist({ ...prefs, plan: energy.planCandidate })}>{e("startPlan")}</Button>
            </View>
          )}
        </SectionShell>,
        <SectionShell key="activity" variant="card" title={e("activity")} info={{ title: e("activity"), body: <ActivityComparisonInfo energy={energy} /> }}>
          <ActivityComparison energy={energy} />
        </SectionShell>,
        <SectionShell key="averages" variant="card" title={t("averages.title")} info={{ title: t("averages.title"), body: e("averagesNote") }}>
          <View className="gap-3">
            <Text className={CAPTION}>{e("rollingAverage")}</Text>
            <TrendChart label={e("rollingAverage")} data={{ value: vm.rolling.map((a) => ({ date: a.date, value: a.kcal })), reason: null, provisional: false }} format="grouped" unit="kcal" colorBy="single" level fixedRange="m" headline="day" />
            <MacroAverages vm={vm} />
          </View>
        </SectionShell>,
        <SectionShell key="history" variant="card" title={t("averages.last30")} info={{ title: t("averages.last30"), body: e("historyNote") }}><History vm={vm} /></SectionShell>,
      ]}
    />
  );
}
