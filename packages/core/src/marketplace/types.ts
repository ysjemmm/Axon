/**
 * Marketplace（Skill/Power 远程源）的数据模型
 *
 * 设计目标：让团队能把内部 Skill/Power 仓库配成一个可浏览、可一键安装的"源"，
 * 不绑定任何特定平台（GitHub/GitLab/自建对象存储都行）——只要求仓库按约定
 * 提供一个 index.json 索引文件 + 对应的 SKILL.md/POWER.md 原文可通过 HTTP(S) 直接读取。
 *
 * 远程仓库最小约定：
 *   <源根 URL>/index.json                 索引文件（见 MarketplaceIndex）
 *   <源根 URL>/<index 里声明的 path>       对应条目的 SKILL.md / POWER.md 原文
 *
 * index.json 示例：
 * {
 *   "skills": [{ "name": "code-review", "description": "...", "path": "skills/code-review/SKILL.md" }],
 *   "powers": [{ "name": "db-toolkit", "description": "...", "path": "powers/db-toolkit/POWER.md" }]
 * }
 */

/** 单个远程源配置（用户手动增删） */
export interface MarketplaceSource {
  /** 源唯一名称（用户自定义，展示用） */
  name: string;
  /** 源根 URL（必须 http/https），index.json 相对此 URL 拼接 */
  url: string;
  /** 备注说明（可选） */
  description?: string;
}

/** marketplaces.json 文件结构 */
export interface MarketplaceConfigFile {
  sources?: MarketplaceSource[];
}

/** index.json 里单个条目的元信息 */
export interface MarketplaceItemMeta {
  name: string;
  description?: string;
  /** 相对源根 URL 的路径，如 "skills/code-review/SKILL.md" */
  path: string;
}

/** 远程源的 index.json 结构 */
export interface MarketplaceIndex {
  skills?: MarketplaceItemMeta[];
  powers?: MarketplaceItemMeta[];
}

/** 拉取到的某源条目列表（前端展示用，附带来源信息） */
export interface MarketplaceItem extends MarketplaceItemMeta {
  /** 条目类型 */
  kind: "skill" | "power";
  /** 所属源名称 */
  sourceName: string;
}
