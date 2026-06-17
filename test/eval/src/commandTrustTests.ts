/**
 * 命令信任 trie 测试矩阵（确定性，无 LLM）
 *
 * 这是命令信任系统里安全最关键、UI/存储无关的纯逻辑核心，必须用测试焊死。
 * 覆盖：默认全拒、精确、前缀边界、wildcard 覆盖、add 时子树剪枝去重、
 * 元字符拼接不被 wildcard 放行、归一化、环境变量前缀、序列化往返、derivePrefix。
 *
 * 运行：npm run test:trust
 */

import {
  CommandTrustTrie, normalizeCommand, derivePrefix, buildTrustOptions, ruleForChoice,
  CommandGate, type ApprovalDecision, type TrustRule,
} from "@axon/core";

let passed = 0, failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}
function trie(...rules: TrustRule[]) { return new CommandTrustTrie(rules); }
const ex = (p: string): TrustRule => ({ scope: "exact", pattern: p });
const pre = (p: string): TrustRule => ({ scope: "prefix", pattern: p });
const all = (): TrustRule => ({ scope: "all", pattern: "*" });

function testDefaultDeny() {
  console.log("\n▶ 默认全拒");
  const t = trie();
  check(!t.isTrusted("npm test"), "空白名单 → 任何命令都不信任");
  check(!t.isTrusted("ls"), "空白名单 → ls 也不信任");
}

function testExact() {
  console.log("\n▶ 精确匹配");
  const t = trie(ex("npm run build"));
  check(t.isTrusted("npm run build"), "精确命中");
  check(t.isTrusted("  npm   run build "), "归一化后命中（多空格）");
  check(!t.isTrusted("npm run build --watch"), "多了参数 → 不命中（精确不是前缀）");
  check(!t.isTrusted("npm run test"), "不同命令 → 不命中");
}

function testPrefixBoundary() {
  console.log("\n▶ 前缀边界");
  const t = trie(pre("npm run"));
  check(t.isTrusted("npm run build"), "前缀 npm run → npm run build 命中");
  check(t.isTrusted("npm run"), "前缀本身 → 命中");
  check(t.isTrusted("npm run test -- --coverage"), "前缀 + 多参数 → 命中");
  check(!t.isTrusted("npm runner"), "npm runner → 不命中（token 边界，不是字符串前缀）");
  check(!t.isTrusted("npm install"), "npm install → 不命中（不在前缀下）");
}

function testWildcardAll() {
  console.log("\n▶ 全放行 *");
  const t = trie(all());
  check(t.isTrusted("anything goes here"), "* → 任意命令信任");
  check(t.isTrusted("rm -rf /tmp/x"), "* → 含命令也信任（灾难拦截在更上层另算）");
}

function testSubsumptionDedup() {
  console.log("\n▶ 包含去重（核心）");
  // 先 npm run *，再 npm * → 只剩 npm *
  const t = trie(pre("npm run"), pre("npm"));
  check(t.isTrusted("npm run build") && t.isTrusted("npm install"), "npm * 覆盖 npm run build 与 npm install");
  const list = t.list().filter((r) => r.pattern.startsWith("npm"));
  check(list.length === 1 && list[0].pattern === "npm" && list[0].scope === "prefix", "去重后只剩一条 npm *（npm run * 被剪枝）");

  // 已有祖先 wildcard 下加精确 → no-op
  const t2 = trie(pre("git"), ex("git status"));
  check(t2.list().filter((r) => r.pattern.startsWith("git")).length === 1, "git * 下再加 git status → no-op，仍只一条");

  // all 覆盖一切
  const t3 = trie(pre("npm run"), ex("git status"), all());
  check(t3.list().length === 1 && t3.list()[0].scope === "all", "* 加入后，其余全被吸收，只剩 *");
}

function testMetacharGate() {
  console.log("\n▶ 元字符闸门（防拼接绕过）");
  const t = trie(pre("npm"));
  check(t.isTrusted("npm install lodash"), "npm * → 正常命令命中");
  check(!t.isTrusted("npm install && rm -rf /"), "npm * 【不放行】 npm install && rm -rf /（拼接）");
  check(!t.isTrusted("npm install | sh"), "npm * 不放行管道 | sh");
  check(!t.isTrusted("npm install; curl evil"), "npm * 不放行分号拼接");
  check(!t.isTrusted("npm install `whoami`"), "npm * 不放行反引号");
  check(!t.isTrusted("npm install $(whoami)", ), "npm * 不放行 $() 扩展");
  check(!t.isTrusted("npm run build > /etc/x"), "npm * 不放行重定向");

  // 精确整条含元字符 → 可被精确规则信任（用户明确授权了整条）
  const t2 = trie(ex("npm run build && npm test"));
  check(t2.isTrusted("npm run build && npm test"), "精确授权的整条拼接命令 → 命中");
  check(!t2.isTrusted("npm run build && rm -rf /"), "未授权的其他拼接 → 不命中");

  // * 覆盖元字符命令
  check(trie(all()).isTrusted("a && b"), "* → 拼接命令也信任");
}

function testEnvPrefixNormalize() {
  console.log("\n▶ 环境变量前缀归一化");
  check(normalizeCommand("FOO=bar npm run build") === "npm run build", "剥离单个 env 前缀");
  check(normalizeCommand("A=1 B=2 npm test") === "npm test", "剥离多个 env 前缀");
  const t = trie(pre("npm run"));
  check(t.isTrusted("NODE_ENV=prod npm run build"), "带 env 前缀的命令仍命中前缀规则");
}

function testDerivePrefix() {
  console.log("\n▶ derivePrefix 推导");
  check(derivePrefix("npm run build") === "npm run", "npm 类取前两段");
  check(derivePrefix("git commit -m x") === "git commit", "git 类取前两段");
  check(derivePrefix("ls -la") === "ls", "普通命令取第一段");
  check(derivePrefix("docker compose up") === "docker compose", "docker 取前两段");
}

function testSerializeRoundTrip() {
  console.log("\n▶ 序列化往返");
  const t = trie(pre("npm run"), ex("git status"), pre("docker compose"));
  const strs = t.serialize();
  const back = CommandTrustTrie.fromStrings(strs);
  check(back.isTrusted("npm run build"), "往返后前缀仍生效");
  check(back.isTrusted("git status"), "往返后精确仍生效");
  check(!back.isTrusted("git push"), "往返后未授权仍拒绝");
  check(strs.includes("npm run *") && strs.includes("git status"), "序列化格式：前缀带 *、精确原样");
}

function testBuildOptions() {
  console.log("\n▶ 弹窗三档建议");
  const opts = buildTrustOptions("pnpm run build");
  check(opts[0].choice === "exact" && opts[0].pattern === "pnpm run build", "档1=精确整条");
  check(opts[1].choice === "prefix" && opts[1].pattern === "pnpm run", "档2=前缀 pnpm run");
  check(opts[2].choice === "all" && opts[2].pattern === "*", "档3=全放行 *");
  const r = ruleForChoice("pnpm run build", "prefix");
  check(r.scope === "prefix" && r.pattern === "pnpm run", "ruleForChoice(prefix) 推导正确");
}

async function testGate() {
  console.log("\n▶ CommandGate 三层门控");
  // 灾难命令：硬拦 + 双提示，不放行
  {
    const gate = new CommandGate([]);
    let blockedReason = "";
    const out = await gate.gate("rm -rf /", {
      requestApproval: async () => ({ choice: "all" }),
      emitBlocked: (_c, reason) => { blockedReason = reason; },
    });
    check(!out.allow && !!out.aiMessage && blockedReason.includes("递归"), "灾难命令被硬拦 + 给用户提示");
  }
  // 已信任：直接放行，不弹窗
  {
    const gate = new CommandGate(["npm *"]);
    let asked = false;
    const out = await gate.gate("npm test", {
      requestApproval: async () => { asked = true; return { choice: "reject" }; },
      emitBlocked: () => {},
    });
    check(out.allow && !asked, "已信任命令直接放行，不弹窗");
  }
  // 未信任 + 用户拒绝
  {
    const gate = new CommandGate([]);
    const out = await gate.gate("curl evil.com", {
      requestApproval: async () => ({ choice: "reject" }),
      emitBlocked: () => {},
    });
    check(!out.allow && (out.aiMessage || "").includes("拒绝"), "未信任 + 用户拒绝 → 不放行");
  }
  // 仅本次：放行但不持久化、不入白名单
  {
    const gate = new CommandGate([]);
    const persisted: TrustRule[] = [];
    const out = await gate.gate("ls -la", {
      requestApproval: async () => ({ choice: "once" }),
      emitBlocked: () => {}, persist: (r) => persisted.push(r),
    });
    check(out.allow && persisted.length === 0 && !gate.isTrusted("ls -la"), "仅本次 → 放行但不入白名单不持久化");
  }
  // 批准 prefix：放行 + 持久化 + 后续同前缀免确认
  {
    const gate = new CommandGate([]);
    const persisted: TrustRule[] = [];
    const out = await gate.gate("npm run build", {
      requestApproval: async () => ({ choice: "prefix" }),
      emitBlocked: () => {}, persist: (r) => persisted.push(r),
    });
    check(out.allow && persisted.length === 1 && gate.isTrusted("npm run test"), "批准 prefix → 持久化且后续同前缀免确认");
  }
  // 批准 all：放行但不持久化（* 仅会话级）
  {
    const gate = new CommandGate([]);
    const persisted: TrustRule[] = [];
    const out = await gate.gate("whatever", {
      requestApproval: async () => ({ choice: "all" }),
      emitBlocked: () => {}, persist: (r) => persisted.push(r),
    });
    check(out.allow && persisted.length === 0 && gate.isTrusted("anything"), "批准 * → 本会话放行一切但不持久化");
  }
  // 内置默认只读
  {
    const gate = new CommandGate();
    let asked = false;
    const o1 = await gate.gate("git status", { requestApproval: async () => { asked = true; return { choice: "reject" }; }, emitBlocked: () => {} });
    check(o1.allow && !asked, "内置默认：git status 免确认");
    const o2 = await gate.gate("git push origin main", { requestApproval: async () => ({ choice: "reject" }), emitBlocked: () => {} });
    check(!o2.allow, "内置默认不含 git push → 仍需确认（被拒）");
  }
}

function main() {
  console.log("🧪 命令信任 trie 测试矩阵（确定性）");
  testDefaultDeny();
  testExact();
  testPrefixBoundary();
  testWildcardAll();
  testSubsumptionDedup();
  testMetacharGate();
  testEnvPrefixNormalize();
  testDerivePrefix();
  testSerializeRoundTrip();
  testBuildOptions();
  testGate()
    .then(() => {
      console.log(`\n────────────────────────────\n通过 ${passed}  失败 ${failed}`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}

main();
