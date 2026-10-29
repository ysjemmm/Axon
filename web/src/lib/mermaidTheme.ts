/**
 * 聊天里 Mermaid 图的外观：手绘风格 + 多巴胺配色，跟随明暗主题。
 *
 * · 手绘：Mermaid 11 自带的 look: "handDrawn"（roughjs 画的手绘线条和蜡笔式斜线填充），
 *   流程图、状态图、类图等走新渲染器的图都支持；时序图、饼图等不支持手绘的仍是常规线条，但配色一致。
 * · 多巴胺配色：Mermaid 主题只能给所有节点同一种颜色，所以渲染完再按节点依次换上调色板里的颜色。
 *   主题变量里先填调色板第一个颜色，没被逐个上色的部分（子图、甘特图等）也是协调的颜色。
 * · 种子固定（handDrawnSeed），同一张图每次画出来的笔触一样，切主题、重新挂载时不会「抖一下」。
 */

interface Swatch {
  /** 填充 */
  fill: string;
  /** 描边 */
  stroke: string;
}

/** 浅色：柔和的糖果色填充 + 饱和的描边 */
const LIGHT: Swatch[] = [
  { fill: "#ffd6e7", stroke: "#f0457f" }, // 草莓
  { fill: "#cdeaff", stroke: "#2f8cf0" }, // 天空
  { fill: "#fff0b3", stroke: "#e8a500" }, // 柠檬
  { fill: "#c9f5dd", stroke: "#14b36b" }, // 薄荷
  { fill: "#e8dbff", stroke: "#8b5cf6" }, // 薰衣草
  { fill: "#ffe0c7", stroke: "#ff7a1a" }, // 橘子
  { fill: "#c8f4f4", stroke: "#0fb5b5" }, // 青柠水
];

/** 深色：低明度的色块 + 明亮的描边，保持鲜艳又不刺眼 */
const DARK: Swatch[] = [
  { fill: "#4a1f35", stroke: "#ff7ab0" },
  { fill: "#17344f", stroke: "#5fb0ff" },
  { fill: "#463b12", stroke: "#ffd34d" },
  { fill: "#143d2b", stroke: "#3ddc97" },
  { fill: "#33244f", stroke: "#b794ff" },
  { fill: "#4a2a14", stroke: "#ff9d57" },
  { fill: "#123f40", stroke: "#4fe0e0" },
];

/** 手写感字体：Windows 有 Segoe Print，macOS 有 Bradley Hand / Chalkboard；中文落到系统字体 */
const FONT = `"Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Sans MS", "PingFang SC", "Microsoft YaHei", sans-serif`;

export function mermaidPalette(dark: boolean): Swatch[] {
  return dark ? DARK : LIGHT;
}

/** mermaid.initialize 的配置 */
export function mermaidConfig(dark: boolean) {
  const p = mermaidPalette(dark);
  const text = dark ? "#eceef3" : "#2b2f3a";
  const ink = dark ? "#9aa3b5" : "#596173";
  const [a, b, c] = p;
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    suppressErrorRendering: true,
    theme: "base" as const,
    look: "handDrawn" as const,
    handDrawnSeed: 7,
    fontFamily: FONT,
    themeVariables: {
      darkMode: dark,
      background: "transparent",
      fontFamily: FONT,
      fontSize: "14px",
      primaryColor: a.fill,
      primaryBorderColor: a.stroke,
      primaryTextColor: text,
      secondaryColor: b.fill,
      secondaryBorderColor: b.stroke,
      secondaryTextColor: text,
      tertiaryColor: c.fill,
      tertiaryBorderColor: c.stroke,
      tertiaryTextColor: text,
      textColor: text,
      nodeTextColor: text,
      lineColor: ink,
      edgeLabelBackground: dark ? "#1f2229" : "#ffffff",
      clusterBkg: dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
      clusterBorder: ink,
      // 时序图
      actorBkg: a.fill,
      actorBorder: a.stroke,
      actorTextColor: text,
      actorLineColor: ink,
      signalColor: ink,
      signalTextColor: text,
      labelBoxBkgColor: c.fill,
      labelBoxBorderColor: c.stroke,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: c.fill,
      noteBorderColor: c.stroke,
      noteTextColor: text,
      activationBkgColor: b.fill,
      activationBorderColor: b.stroke,
      // 饼图
      ...Object.fromEntries(p.map((s, i) => [`pie${i + 1}`, s.stroke])),
      pieStrokeColor: dark ? "#1f2229" : "#ffffff",
      pieOuterStrokeColor: "transparent",
      pieTitleTextColor: text,
      pieSectionTextColor: dark ? "#16181d" : "#ffffff",
      pieLegendTextColor: text,
      // 甘特图
      taskBkgColor: b.fill,
      taskBorderColor: b.stroke,
      activeTaskBkgColor: a.fill,
      activeTaskBorderColor: a.stroke,
      doneTaskBkgColor: p[3].fill,
      doneTaskBorderColor: p[3].stroke,
      critBkgColor: p[5].fill,
      critBorderColor: p[5].stroke,
      taskTextColor: text,
      taskTextDarkColor: text,
      sectionBkgColor: dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
      gridColor: dark ? "#3a3f4b" : "#e5e7eb",
    },
  };
}

const same = (x: string | null, y: string) => !!x && x.trim().toLowerCase() === y.toLowerCase();

/**
 * 渲染完成后按节点依次上色。
 * 手绘节点：roughjs 的斜线填充是一条「描边颜色 = 填充色」的路径，轮廓是另一条路径，按颜色区分替换；
 * 常规节点（不支持手绘的图）：直接给形状设 fill / stroke。
 */
export function decorateMermaidSvg(svg: SVGSVGElement, dark: boolean): void {
  const p = mermaidPalette(dark);
  const base = p[0];
  const nodes = Array.from(svg.querySelectorAll<SVGGElement>("g.node, g.rough-node")).filter((g) => !g.closest(".cluster") || g.classList.contains("node"));
  nodes.forEach((node, i) => {
    const sw = p[i % p.length];
    // 节点里除文字以外的图形：形状、手绘填充 / 轮廓、类图的分隔线
    const shapes = Array.from(node.querySelectorAll<SVGElement>("rect, polygon, circle, ellipse, path, line"))
      .filter((el) => !el.closest(".label, foreignObject, text"));
    for (const el of shapes) {
      const fill = el.getAttribute("fill");
      const stroke = el.getAttribute("stroke");
      if (fill === null && stroke === null) {
        el.style.fill = sw.fill;
        el.style.stroke = sw.stroke;
        continue;
      }
      if (fill && fill !== "none") el.setAttribute("fill", same(fill, base.stroke) ? sw.stroke : sw.fill);
      if (stroke && stroke !== "none") el.setAttribute("stroke", same(stroke, base.fill) ? sw.fill : sw.stroke);
    }
  });

  // 时序图的参与者：同一个参与者上下两个框颜色一致
  const actorColor = new Map<string, Swatch>();
  svg.querySelectorAll<SVGRectElement>("rect.actor").forEach((rect) => {
    const name = rect.getAttribute("name") ?? rect.parentElement?.textContent ?? "";
    if (!actorColor.has(name)) actorColor.set(name, p[actorColor.size % p.length]);
    const sw = actorColor.get(name)!;
    rect.style.fill = sw.fill;
    rect.style.stroke = sw.stroke;
  });
}
