import type { NormalizedEChart } from "@agora/core";

const ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js";

/* The stage fills the WebView viewport rather than taking the option's own
   pixel height: the native side owns the box (bounded inline, full height when
   expanded), so a phone rotation or a taller device repaints at the new size
   instead of leaving dead space below the chart. */
export function echartHtml(chart: NormalizedEChart): string {
  const option = JSON.stringify(chart.option).replace(/</g, "\\u003c");
  const source = JSON.stringify(JSON.stringify(chart.option, null, 2)).replace(/</g, "\\u003c");
  const width = chart.width ? `${chart.width}px` : "100vw";
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5">
<style>
html,body{margin:0;background:#0b0d12;color:#d9deea;overflow-x:auto;overflow-y:hidden}
#stage{width:${width};min-width:100vw;height:100vh}#err{padding:14px;color:#fca5a5;font:12px ui-monospace,monospace;white-space:pre-wrap}
</style></head><body><div id="stage"></div><script src="${ECHARTS_CDN}"></script><script>
(()=>{const stage=document.getElementById("stage");try{if(!window.echarts)throw new Error("Could not load the chart renderer (offline?)");const chart=echarts.init(stage,null,{renderer:"canvas"});chart.setOption(${option});const resize=()=>chart.resize();addEventListener("resize",resize);if(window.ResizeObserver)new ResizeObserver(resize).observe(stage)}catch(e){const err=document.createElement("div");err.id="err";err.textContent=String(e&&e.message||e)+"\\n\\n"+${source};stage.replaceWith(err)}})();
</script></body></html>`;
}
