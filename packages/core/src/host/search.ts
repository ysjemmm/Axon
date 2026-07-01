/**
 * 搜索抽象（执行端 ① 的一部分）
 *
 * 把"高效的全文/文件名搜索"作为一个独立能力域，由各形态注入具体实现：
 *   · VSCodeAgentHost —— 直接 execFile spawn 宿主自带的 ripgrep（argv 数组，绝不经过 shell）
 *   · NodeAgentHost   —— 暂不提供（为 undefined），core 自动退化为纯 fs 遍历
 *
 * 设计原则：
 * - host 只负责"找到原始命中"，返回结构化数据；格式化成模型可见文本由 core 负责。
 * - host 实现绝不拼接 shell 命令字符串。参数一律以 argv 数组传给搜索进程，
 *   从根上规避不同操作系统/不同 shell（PowerShell / cmd / bash）的引号与转义差异。
 * - 唯一与操作系统相关的信息（ripgrep 二进制名）收敛在 host 实现内部一处。
 * - 基础设施级故障（二进制找不到、进程无法启动）应 Fail-Fast 抛错，
 *   不得静默返回空结果掩盖问题。
 */

/** 一条内容命中（grep 模式） */
export interface ContentMatch {
  /** 命中文件的绝对路径 */
  file: string;
  /** 命中行号（1-indexed） */
  line: number;
  /** 命中行文本（已去除行尾换行） */
  text: string;
  /** 上一行文本（上下文）；不存在时为 undefined */
  before?: string;
  /** 下一行文本（上下文）；不存在时为 undefined */
  after?: string;
}

/** 内容搜索入参 */
export interface ContentSearchOptions {
  /** 搜索起始目录（绝对路径） */
  dir: string;
  /** 搜索正则（取自已校验合法的 RegExp.source，大小写不敏感由实现保证） */
  pattern: string;
  /**
   * 文件过滤模式：兼容后缀（".ts"）与 glob（"*.ts" / "**\/*.ts"）两种写法。
   * 由实现转换为搜索进程的对应过滤参数。
   */
  includePattern?: string;
  /** 最多返回多少条命中（实现应在达到上限附近尽早停止） */
  maxMatches: number;
  /** 需要跳过的目录名集合（如 node_modules / .git），由 core 注入避免重复定义 */
  ignoredDirs: string[];
}

/** 文件名/目录名搜索入参 */
export interface FileSearchOptions {
  /** 搜索起始目录（绝对路径） */
  dir: string;
  /** 名称子串（大小写不敏感匹配，由实现保证） */
  query: string;
  /** file=搜文件名，dir=搜目录名 */
  kind: "file" | "dir";
  /** 最多返回多少条 */
  maxResults: number;
  /** 需要跳过的目录名集合 */
  ignoredDirs: string[];
}

/**
 * 高效搜索能力。形态不支持时整个 search 域为 undefined，core 退化为纯 fs 遍历。
 */
export interface HostSearch {
  /**
   * 内容搜索（grep）。返回结构化命中列表（绝对路径 + 行号 + 上下文）。
   * 实现内部以 argv 数组调用搜索进程，绝不拼 shell 字符串。
   * 进程无法启动等基础设施故障应抛错（Fail-Fast），不得吞掉返回空数组。
   */
  searchContent(opts: ContentSearchOptions): Promise<ContentMatch[]>;
  /**
   * 文件名/目录名搜索。返回匹配的绝对路径列表（dir 模式返回目录绝对路径）。
   */
  searchFiles(opts: FileSearchOptions): Promise<string[]>;
}
