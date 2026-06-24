/**
 * 快照系统类型定义
 *
 * Snapshotter 是策略模式接口：git 仓库用 GitSnapshotter（refs/axon/ 命名空间），
 * 非 git 项目用 FsSnapshotter（.axon/snapshots/ 文件副本）。
 * SnapshotManager 通过策略接口统一管理，不关心底层实现。
 */

/** 单个快照条目 */
export interface Snapshot {
  /** 唯一 id（turnId 或自增序号） */
  id: string;
  /** 快照创建时间戳 */
  createdAt: number;
  /** 快照描述（用于 UI 展示） */
  label: string;
  /** 该快照涉及的文件列表（仅写文件类工具） */
  files: string[];
}

/** 快照策略接口（Strategy Pattern） */
export interface Snapshotter {
  /** 初始化：检测 git 可用性等，返回是否支持 */
  init(): Promise<boolean>;

  /**
   * 创建快照（在写文件操作执行前调用）。
   * @param id 快照 id
   * @param files 即将被修改的文件绝对路径列表
   * @returns 是否成功
   */
  create(id: string, files: string[]): Promise<boolean>;

  /**
   * 回滚到指定快照。
   * @param id 快照 id
   * @returns 是否成功
   */
  restore(id: string): Promise<boolean>;

  /** 列出所有快照 */
  list(): Promise<Snapshot[]>;

  /** 删除指定快照（清理用） */
  remove(id: string): Promise<boolean>;

  /** 策略名称（用于日志/UI） */
  readonly name: string;
}
