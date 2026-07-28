import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: true,
});

const cases = {
  "5列正确分隔行": [
    "| 路线 | 底层原理 | 语言 | 风险 | 自研难度 |",
    "|---|---|---|---|---|",
    "| Hook | 挂真实 PC | C++ | 相对低 | 中 |",
  ].join("\n"),

  "5列表头+3列分隔行(截图那种)": [
    "| 路线 | 底层原理 | 语言 | 风险 | 自研难度 |",
    "|---|------|------|",
    "| Hook | 挂真实 PC | C++ | 相对低 | 中 |",
  ].join("\n"),

  "表格前无空行(紧跟正文)": [
    "重新给你一张能正常渲染的：",
    "| 路线 | 底层原理 | 语言 | 风险 | 自研难度 |",
    "|---|---|---|---|---|",
    "| Hook | 挂真实 | C++ | 低 | 中 |",
  ].join("\n"),

  "表头列数多于分隔行但分隔行也5段": [
    "| A | B | C | D | E |",
    "| --- | --- | --- | --- | --- |",
    "| 1 | 2 | 3 | 4 | 5 |",
  ].join("\n"),
};

for (const [name, input] of Object.entries(cases)) {
  const html = md.render(input);
  const isTable = html.includes("<table>");
  console.log("========", name, "========");
  console.log("渲染成表格:", isTable);
  console.log(html.slice(0, 300));
  console.log("");
}
