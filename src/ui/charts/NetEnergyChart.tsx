import { Fragment } from "react";
import { Group, RoundedRect } from "@shopify/react-native-skia";
import { FORMATS } from "@/lib/format";
import { alpha } from "../color";
import { useTheme } from "../theme";
import { bandCenters, linearScale } from "./geometry";
import { ChartFigure, ChartLabel, DashedLine, GridLines, PlotCanvas } from "./ChartFrame";

type NetBar = {
  label: string;
  calculated: number | null;
  wearable: number | null;
  provisional?: boolean;
  status: "complete" | "partial" | "ongoing" | "missing";
};

/** Paired signed bars share one symmetric kcal scale. Unusable food days never get a numeric mark. */
export function NetEnergyChart({ summary, data }: { summary: string; data: NetBar[] }) {
  const { c } = useTheme();
  return (
    <ChartFigure summary={summary} height={216}>
      {({ width, height }) => {
        const [x0, x1, y0, y1] = [46, width - 4, 12, height - 44];
        const limit = Math.max(250, Math.ceil(Math.max(...data.flatMap((d) => d.status === "complete" ? [Math.abs(d.calculated ?? 0), Math.abs(d.wearable ?? 0)] : [0])) / 250) * 250);
        const y = linearScale([-limit, limit], [y1, y0]);
        const ticks = [-limit, -limit / 2, 0, limit / 2, limit];
        const { centers, step } = bandCenters(data.length, x0, x1);
        const bw = Math.min(12, step * 0.28);
        return (
          <>
            <PlotCanvas width={width} height={height}>
              {data.map((d, i) => d.status === "partial" && <RoundedRect key={i} x={centers[i] - step * 0.43} y={y0} width={step * 0.86} height={y1 - y0} r={4} color={alpha(c.warning, 0.1)} />)}
              <GridLines ys={ticks.filter((v) => v !== 0).map(y)} x0={x0} x1={x1} />
              <DashedLine x1={x0} x2={x1} y1={y(0)} y2={y(0)} color={c["chart-cursor"]} dash={[1, 0]} />
              {data.map((d, i) => d.status === "complete" && (
                <Group key={i}>
                  {([d.calculated, d.wearable] as const).map((value, k) => {
                    if (value === null) return null;
                    const h = Math.max(2, Math.abs(y(value) - y(0)));
                    return <RoundedRect key={k} x={centers[i] + (k ? 2 : -bw - 2)} y={value === 0 ? y(0) - 1 : value > 0 ? y(0) - h : y(0)} width={bw} height={h} r={2} color={k ? c["foreground-secondary"] : c["energy-active"]} opacity={!k && d.provisional ? 0.45 : 1} />;
                  })}
                </Group>
              ))}
            </PlotCanvas>
            {ticks.map((v) => <ChartLabel key={v} x={x0 - 8} y={y(v)} anchor="end" w={42}>{v > 0 ? `+${FORMATS.grouped(v)}` : FORMATS.grouped(v)}</ChartLabel>)}
            {data.map((d, i) => {
              const marker = d.status === "partial" ? "!" : d.status === "ongoing" ? "…" : d.status === "missing" || (d.calculated === null && d.wearable === null) ? "—" : d.provisional && d.calculated !== null ? "~" : "";
              return <Fragment key={i}>
                <ChartLabel x={centers[i]} y={y1 + 16} w={step}>{d.label}</ChartLabel>
                {!!marker && <ChartLabel x={centers[i]} y={y1 + 32} w={step} color={d.status === "partial" ? c["warning-text"] : c["muted-foreground"]}>{marker}</ChartLabel>}
              </Fragment>;
            })}
          </>
        );
      }}
    </ChartFigure>
  );
}
