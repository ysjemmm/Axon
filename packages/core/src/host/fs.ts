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

/**
 * 文件/目录元信息。
 *
 * 为什么 mtimeMs / size 是【可选】而非必填：
 * 不同宿主提供元信息的能力不同 —— node:fs 的 Stats 两者都有；vscode.workspace.fs 则依赖
 * 具体 FileSystemProvider，虚拟文件系统（Remote-SSH / Dev Container / github.dev / 扩展注册
 * 的内存 FS）可能返回伪造的 0 或干脆不提供。把「拿不到」表达成 undefined，而不是给一个
 * 看着像真的假值 —— 消费方才能区分「文件确实没变」与「根本不知道变没变」。
 * 对以元信息判断「是否需要重新生成」的场景（如文档陈旧检测），这个区分是正确性的前提：
 * 拿假值当依据会得出「没变」，于是该更新的内容永远不更新。
 */
export interface StatInfo {
  isFile: boolean;
  isDir: boolean;
  /** 最后修改时间（epoch 毫秒）；宿主无法提供时为 undefined */
  mtimeMs?: number;
  /** 文件字节数；目录、或宿主无法提供时为 undefined */
  size?: number;
}

/** Agent 可用的文件系统能力 */
export interface HostFileSystem {
  /** 读取文件文本内容；文件不存在返回 null（不抛错） */
  read(absPath: string): Promise<string | null>;

  /** 读取文件原始字节；文件不存在返回 null。二进制安全（Office 文档快照等场景）。 */
  readBinary?(absPath: string): Promise<Uint8Array | null>;

  /** 写入文件文本内容；父目录不存在时由实现负责创建 */
  write(absPath: string, content: string): Promise<void>;

  /** 写入原始字节；父目录不存在时由实现负责创建。 */
  writeBinary?(absPath: string, bytes: Uint8Array): Promise<void>;

  /**
   * 追加文本到文件末尾；文件/父目录不存在时由实现负责创建。
   *
   * 为什么必须是独立能力，而不是让调用方 read + write 拼一下：
   * 追加日志类文件（JSONL trace）时，read+write 的成本随文件已有大小线性增长，
   * 整体累计到 O(n²)——一条几字节的事件也要把整个文件读出来再整个写回去。
   * trace 文件长到几十 MB 后，每条记录都是上百 MB 的磁盘 I/O 与同等的内存峰值。
   * 底层文件系统本就有 O(1) 的追加语义，这里把它暴露出来。
   */
  append(absPath: string, content: string): Promise<void>;

  /** 查询元信息；路径不存在返回 null */
  stat(absPath: string): Promise<StatInfo | null>;

  /** 列出目录直接子项；目录不存在或不可访问时由实现决定（建议抛错，与 node readdir 一致） */
  readdir(absPath: string): Promise<DirChild[]>;

  /** 递归创建目录（mkdir -p 语义） */
  mkdirp(absPath: string): Promise<void>;

  /** 递归删除路径（rm -rf 语义；路径不存在视为成功，不抛错） */
  remove(absPath: string): Promise<void>;
}
