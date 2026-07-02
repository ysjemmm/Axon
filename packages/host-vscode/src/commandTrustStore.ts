/**
 * VSCodeCommandTrustStore —— 命令信任白名单的 VS Code 配置持久化（进程内扩展形态）
 *
 * 数据源是 `axon.trustedCommands` 配置项：
 *  - load：读出配置的「生效值」（VS Code 自动合并 User / Workspace 作用域），
 *    供 CommandGate 与内置只读默认集合并。用户可直接在设置 UI / settings.json 里增删改。
 *  - save：审批弹窗选「加入白名单」时写回——只改对应作用域（有工作区→Workspace，否则 Global），
 *    用 CommandTrustTrie 做包含去重，保证落盘列表始终最简，且不把 User 级规则误拷进 Workspace。
 *
 * 这样「弹窗授权」和「设置管理」操作的是同一份数据，不分裂。
 */

import * as vscode from "vscode";
import { CommandTrustTrie, type TrustRule, type CommandTrustStore } from "@axon/core";

const CONFIG_SECTION = "axon";
const CONFIG_KEY = "trustedCommands";

export class VSCodeCommandTrustStore implements CommandTrustStore {
  /** 读出已信任的模式串（合并 User/Workspace 生效值；内置默认集由 CommandGate 自带，不在此） */
  load(_workspace: string): string[] {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    // ⚠️ VS Code 对数组类型配置的合并规则：workspace 层有值时直接覆盖 global 层，
    // 不是拼接。所以不能用 cfg.get()（返回 effective=workspace 覆盖后的值），
    // 必须分别读 globalValue 和 workspaceValue 再手动 union。
    const inspected = cfg.inspect<string[]>(CONFIG_KEY);
    const globalPatterns = Array.isArray(inspected?.globalValue) ? inspected!.globalValue! : [];
    const workspacePatterns = Array.isArray(inspected?.workspaceValue) ? inspected!.workspaceValue! : [];
    const merged = [...new Set([...globalPatterns, ...workspacePatterns])].filter((p): p is string => typeof p === "string");
    console.log(`[axon-trust:load] global=${globalPatterns.length} workspace=${workspacePatterns.length} merged=${merged.length} => ${JSON.stringify(merged)}`);
    return merged;
  }

  /** 持久化一条新批准的规则：在目标作用域内去重合并后写回 */
  save(_workspace: string, rule: TrustRule, target?: "user" | "workspace"): void {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const useGlobal = target === "user" || (!target && !hasFolder);
    const configTarget = useGlobal ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;

    const inspected = cfg.inspect<string[]>(CONFIG_KEY);
    const scopeValue = useGlobal ? inspected?.globalValue : inspected?.workspaceValue;
    const current = Array.isArray(scopeValue) ? scopeValue.filter((p): p is string => typeof p === "string") : [];

    const trie = CommandTrustTrie.fromStrings(current);
    trie.add(rule);
    const serialized = trie.serialize();
    console.log(`[axon-trust:save] target=${target} add=${rule.pattern} useGlobal=${useGlobal} before=${current.length} after=${serialized.length}`);
    void cfg.update(CONFIG_KEY, serialized, configTarget).then(undefined, (err: unknown) => {
      console.warn("[trust] 写回失败:", (err as Error).message);
    });
  }
}
