import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { DAY, formatDay, FORMATS } from "@/lib/format";
import type { NutritionVM } from "@/queries/nutrition";
import { NetEnergyChart } from "@/ui/charts/NetEnergyChart";
import { CAPTION } from "@/ui/metrics/primitives";
import { ActionLink } from "@/ui/shells/SectionShell";
import { Text } from "@/ui/Text";

/** Comparison only: neither series feeds the target, adaptive expenditure model or remaining-food dial. */
export function ActivityComparison({ energy }: { energy: NutritionVM["energy"] }) {
  const { t } = useTranslation("energy");
  const days = energy.comparisonDays;
  const selected = days.at(-1)!;
  const signed = (value: number | null) => value === null ? "—" : `${Math.round(value) > 0 ? "+" : ""}${FORMATS.grouped(Math.round(value) || 0)}`;
  const describe = (d: typeof selected) => t("netDayA11y", {
    day: formatDay(d.day, DAY.short), status: t(`netStatus.${d.status}`),
    calculated: signed(d.calculatedNet.value), wearable: signed(d.wearableNet.value), estimate: t(`netEstimateState.${d.expenditureState}`),
  });
  return (
    <View className="gap-3">
      <View className="flex-row gap-3">
        {(["calculated", "wearable"] as const).map((key) => (
          <View key={key} className="min-w-0 flex-1 gap-1">
            <View className="flex-row items-center gap-2">
              <View className={key === "calculated" ? "h-3 w-1 rounded-xs bg-energy-active" : "h-3 w-1 rounded-xs bg-foreground-secondary"} />
              <Text className="shrink text-xs font-semibold leading-4 text-foreground-secondary">{t(key === "calculated" ? "netCalculated" : "netWearable")}</Text>
            </View>
            <Text className="font-numeric text-[28px] font-bold leading-8 tabular-nums">{signed(selected[key === "calculated" ? "calculatedNet" : "wearableNet"].value)}</Text>
            <Text className={CAPTION}>{key === "calculated" ? t(`netEstimateState.${selected.expenditureState}`) : t("netKcal")}</Text>
          </View>
        ))}
      </View>
      {selected.status !== "complete" && <Text className="text-xs font-semibold leading-4 text-warning-text">{t(`netStatus.${selected.status}`)}</Text>}
      <View className="gap-1">
        <Text className={CAPTION}>{t("netPeriod", { from: formatDay(days[0].day, DAY.short), to: formatDay(selected.day, DAY.short) })}</Text>
        <NetEnergyChart summary={[t("netChart"), ...days.map(describe)].join(". ")} data={days.map((d) => ({
          label: formatDay(d.day, { weekday: "short" }), status: d.status,
          calculated: d.calculatedNet.value, wearable: d.wearableNet.value, provisional: d.expenditureState === "preliminary",
        }))} />
        <Text className={CAPTION}>{t("netSigns")}</Text>
      </View>
      <View className="gap-3 border-t border-border pt-3">
        {energy.netTrends.map((r) => <View key={r.span} className="gap-1">
          <View className="flex-row items-baseline justify-between gap-2">
            <Text className={CAPTION}>{t("netAverage", { count: r.span })}</Text>
            <Text className="font-numeric text-sm font-semibold tabular-nums">{t("netAverageValue", { value: signed(r.recent.value) })}</Text>
          </View>
          <Text className={CAPTION}>{t(r.change === null ? "netTrendMissing" : "netTrendChange", {
            value: signed(r.change), days: r.recent.days, previous: r.previous.days, span: r.span,
            period: t(r.span === 7 ? "netPriorWeek" : "netPriorMonth"),
          })}{r.recent.preliminary || r.previous.preliminary ? ` · ${t("netEarly")}` : ""}</Text>
        </View>)}
      </View>
      <View className="gap-1 border-t border-border pt-3">
        <View className="flex-row items-baseline justify-between gap-2">
          <Text className={CAPTION}>{t("weightGoal")}</Text>
          <ActionLink label={t(energy.goal.state === "unset" ? "setGoal" : "editGoal")} href={`/nutrition-targets?d=${selected.day}`} />
        </View>
        <Text className="text-sm font-semibold leading-5">{energy.goal.state === "estimate"
          ? t(energy.goal.weeks.value! > 52 ? "goalLong" : "goalWeeks", { count: energy.goal.weeks.value!, weight: FORMATS.decimal1(energy.goal.weight!), unit: energy.weightUnit })
          : t(`goalState.${energy.goal.state}`)}</Text>
        {energy.goal.state === "estimate" && <Text className={CAPTION}>{t("goalPace", { value: FORMATS.decimal1(energy.goal.pace.value!), unit: energy.weightUnit })}</Text>}
      </View>
    </View>
  );
}

/** Detailed inputs stay reachable without competing with the comparison's readouts. */
export function ActivityComparisonInfo({ energy }: { energy: NutritionVM["energy"] }) {
  const { t } = useTranslation("energy");
  const selected = energy.comparisonDays.at(-1)!;
  const kcal = (value: number | null) => value === null ? "—" : FORMATS.grouped(value);
  return <>
    <Text className={CAPTION}>{t("netInputs", { intake: kcal(selected.intake) })}{"\n"}{t("netExpenditureValue", { value: kcal(selected.calculatedExpenditure.value) })}{"\n"}{t("netBmrActive", { bmr: kcal(selected.bmr.value), active: kcal(selected.wearableActive.value) })}</Text>
    <View className="gap-1">
      <Text className="text-sm font-semibold leading-5">{t(energy.activity.estimatedKcal.value === null ? "exerciseEnergyMissing" : "exerciseEnergyValue", { value: kcal(energy.activity.estimatedKcal.value) })}</Text>
      <Text className={CAPTION}>{t("exerciseCoverage", { covered: FORMATS.decimal1(energy.activity.coveredMinutes), recorded: FORMATS.decimal1(energy.activity.recordedMinutes) })}</Text>
      <Text className={CAPTION}>{t("exerciseMethods", {
        hr: FORMATS.decimal1(energy.activity.modeledMinutes), met: FORMATS.decimal1(energy.activity.metMinutes),
        wearable: FORMATS.decimal1(energy.activity.wearableMinutes), uncovered: FORMATS.decimal1(energy.activity.uncoveredMinutes),
      })}</Text>
    </View>
    <Text className={CAPTION}>{t("hrAudit", {
      covered: FORMATS.decimal1(energy.activity.hrCoveredMinutes), type: FORMATS.decimal1(energy.activity.excludedMinutes.exerciseType),
      range: FORMATS.decimal1(energy.activity.excludedMinutes.hrRange), missing: FORMATS.decimal1(energy.activity.excludedMinutes.hrMissing), profile: FORMATS.decimal1(energy.activity.excludedMinutes.profile),
    })}{"\n"}{t("hrEnergyValue", { value: kcal(energy.activity.kcal.value) })}{"\n"}{t("wearableValue", { value: kcal(energy.wearableKcal) })}</Text>
    {(["netMarkers", "netProvisionalKey", "netTrendsNote", "goalNote", "netNote", "hrNote", "wearableNote"] as const).map((key) => <Text key={key} className="text-[15px] leading-[22px] text-foreground-body">{t(key)}</Text>)}
  </>;
}
