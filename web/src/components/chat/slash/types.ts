/**
 * 斜杠命令（Slash Command）模块的公共类型
 *
 * 设计目标：低耦合、高扩展。
 * - 菜单 UI、命令注册表只依赖这里的纯类型，不感知 VS Code / 扩展宿主。
 * - 一切“需要 IDE 能力”的操作（搜索文件、读取当前文件、抓取诊断）都收敛到
 *   {@link SlashCommandHost} 接口里，由宿主（ChatPanel + 扩展）实现并注入。
 * - 新增一条命令 = 往注册表里加一个 {@link SlashCommand} 声明，无需改动菜单或 hook。
 */

import type { LucideIcon } from "lucide-react";

/** 资源搜索范围 */
export type ResourceScope = "file" | "folder";

/** 一条可被选择加入上下文的工作区资源（文件 / 文件夹） */
export interface ResourceItem {
  /** 展示名（文件名 / 文件夹名） */
  name: string;
  /** 相对工作区根的路径（用于展示与过滤） */
  relativePath: string;
  /** 绝对路径（回传给扩展用） */
  path: string;
  /** 资源类型 */
  kind: ResourceScope;
}

/**
 * 命令运行时可用的宿主能力（由 ChatPanel 经扩展消息总线实现并注入）。
 * 这是斜杠命令系统与外部世界的唯一耦合点。
 */
export interface SlashCommandHost {
  /** 异步搜索工作区资源（文件 / 文件夹）。无宿主（非 IDE 环境）时返回空数组。 */
  searchResources: (query: string, scope: ResourceScope) => Promise<ResourceItem[]>;
  /** 把“当前编辑器打开的文件”加入上下文 */
  addActiveFileContext: () => void;
  /** 把指定资源（文件 / 文件夹）加入上下文 */
  addResourceContext: (item: ResourceItem) => void;
  /** 把“当前文件的问题 / 诊断”加入上下文 */
  addDiagnosticsContext: () => void;
}

/**
 * 一条斜杠命令的声明。
 * - kind="action"：选中即执行（如“当前文件”“问题”）。
 * - kind="search"：进入二级资源搜索（如“文件”“文件夹”），需指定 {@link scope}。
 */
export interface SlashCommand {
  id: string;
  /** 菜单展示标题 */
  label: string;
  /** 一句话说明 */
  description: string;
  /** 左侧图标 */
  icon: LucideIcon;
  /** 用于模糊过滤的关键词（中英文均可） */
  keywords?: string[];
  /** 命令类型 */
  kind: "action" | "search";
  /** search 类命令的资源范围 */
  scope?: ResourceScope;
  /** action 类命令：选中即执行的副作用 */
  run?: (host: SlashCommandHost) => void;
}
