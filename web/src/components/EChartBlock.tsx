import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { normalizeEChart, type NormalizedEChart } from "@agora/core";
import type { EChartsType } from "echarts";
import { Icon } from "../lib/icons";

function ChartCanvas({ chart, source, expanded = false }: { chart: NormalizedEChart; source: string; expanded?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<EChartsType | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    void import("echarts").then(echarts => {
      if (cancelled || !ref.current) return;
      const rendered = echarts.init(ref.current, undefined, { renderer: "canvas" });
      instance.current = rendered;
      rendered.setOption(chart.option);
      observer = new ResizeObserver(() => rendered.resize());
      observer.observe(ref.current);
      // A modal's first layout follows its mount; resize once more after paint.
      if (expanded) requestAnimationFrame(() => rendered.resize());
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => {
      cancelled = true;
      observer?.disconnect();
      instance.current?.dispose();
      instance.current = null;
    };
  }, [chart, expanded]);

  if (loadError) return <div className="ago-chart-load-error">Could not load the chart renderer.<pre>{source}</pre></div>;
  return <div ref={ref} className="ago-chart-canvas" style={{ height: chart.height }} role="img" aria-label={chart.title} />;
}

function ChartModal({ chart, source, onClose }: { chart: NormalizedEChart; source: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div className="ago-chart-overlay" role="dialog" aria-modal="true" aria-label={chart.title}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ago-chart-modal">
        <header>
          <strong>{chart.title}</strong>
          <button ref={closeRef} type="button" aria-label="Close chart" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="ago-chart-scroll expanded">
          <div className="ago-chart-stage" style={{ width: chart.width ?? "100%", minWidth: "100%" }}>
            <ChartCanvas chart={chart} source={source} expanded />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function EChartBlock({ source }: { source: string }) {
  const result = useMemo(() => {
    try { return { chart: normalizeEChart(source), error: "" }; }
    catch (error) { return { chart: null, error: (error as Error).message }; }
  }, [source]);
  const [open, setOpen] = useState(false);

  if (!result.chart) {
    return (
      <div className="ago-chart-error" role="alert">
        <strong>Could not render ECharts chart</strong>
        <span>{result.error}</span>
        <pre>{source}</pre>
      </div>
    );
  }
  const chart = result.chart;
  return (
    <div className="ago-chart-block">
      <div className="ago-chart-head">
        <span>{chart.title}</span>
        <button type="button" onClick={() => setOpen(true)} aria-label={`Expand chart: ${chart.title}`}>
          <Icon name="maximize-2" /> expand
        </button>
      </div>
      <div className="ago-chart-scroll">
        <div className="ago-chart-stage" style={{ width: chart.width ?? "100%", minWidth: "100%" }}>
          <ChartCanvas chart={chart} source={source} />
        </div>
      </div>
      {open ? <ChartModal chart={chart} source={source} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
