/**
 * 文件系统抽象（执行端 ① 的一部分）
 *
 * 把 tools.ts 里直接 import 的 node:fs/promises 收敛到这个接口。
 * - NodeAgentHost：用 node:fs/promises 实现（web/cli/server 形态）
 * - VSCodeAgentHost：用 vscode.workspace.fs 实现（Code OSS 形态，享受虚拟文件系统/远程能力）
 *
 * 设计约定：
 * - 所有路径均为【已解析的绝对路径】。多工作区路径解析（resolveInWorkspaces）属于
 *   core 的纯逻辑，在调用 host 之前完成，host 实现不关心工作区概念。
 * - read/stat 对“不存在”返回 null，而非抛错——把“文件不存在”从异常路径变成正常返回值，
 *   对齐 tools.ts 中 readEffectiveContent 现有的“平静处理不存在”语义。
 */

/** 目录项（与现有 fsBrowser.DirEntry 对齐） */
export interface DirEntry {
  name: string;
  /** 绝对路径 */
  path: string;
}

/**
 * readdir 返回的子项：在 DirEntry 基础上带文件/目录类型标志。
 * tools 的递归遍历（search / list_dir / searchContent）依赖此标志区分目录与文件，
 * 因此 readdir 必须可靠提供，不能像 DirEntry 那样省略。
 */
export interface DirChild extends DirEntry {
  isFile: boolean;
  isDir: boolean;
}

/** 文件/目录元信息 */
export interface StatInfo {
  isFile: boolean;
  isDir: boolean;
}

/** Agent 可用的文件系统能力 */
export interface HostFileSystem {
  /** 读取文件文本内容；文件不存在返回 null（不抛错） */
  read(absPath: string): Promise<string | null>;

  /** 写入文件文本内容；父目录不存在时由实现负责创建 */
  write(absPath: string, content: string): Promise<void>;

  /** 查询元信息；路径不存在返回 null */
  stat(absPath: string): Promise<StatInfo | null>;

  /** 列出目录直接子项；目录不存在或不可访问时由实现决定（建议抛错，与 node readdir 一致） */
  readdir(absPath: string): Promise<DirChild[]>;

  /** 递归创建目录（mkdir -p 语义） */
  mkdirp(absPath: string): Promise<void>;

  /** 递归删除路径（rm -rf 语义；路径不存在视为成功，不抛错） */
  remove(absPath: string): Promise<void>;
}
