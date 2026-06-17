/**
 * FileCommandTrustStore —— 命令信任白名单的 JSON 文件持久化（web / cli / server 形态）
 *
 * 单文件 `~/.axon/trusted-commands.json`，结构为 { [工作区绝对路径]: string[] }。
 * 只存"用户批准的"规则（内置只读默认集由 CommandGate 自带，不入此文件）。
 * save 时用 CommandTrustTrie 做包含去重，保证落盘列表始终最简。
 *
 * 读写均为同步小文件操作（在会话创建/批准时各一次），无需异步。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { CommandTrustTrie, type TrustRule, type CommandTrustStore } from "@axon/core";

type TrustMap = Record<string, string[]>;

export class FileCommandTrustStore implements CommandTrustStore {
  private readonly file: string;

  constructor(file?: string) {
    this.file = file ?? join(homedir(), ".axon", "trusted-commands.json");
  }

  private readMap(): TrustMap {
    try {
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as TrustMap) : {};
    } catch {
      return {};
    }
  }

  private writeMap(map: TrustMap): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(map, null, 2), "utf-8");
  }

  /** 读出某工作区已信任的模式串（不含内置默认集） */
  load(workspace: string): string[] {
    const patterns = this.readMap()[workspace];
    return Array.isArray(patterns) ? patterns : [];
  }

  /** 持久化一条新批准的规则（经 trie 去重后写回） */
  save(workspace: string, rule: TrustRule): void {
    const map = this.readMap();
    const trie = CommandTrustTrie.fromStrings(map[workspace] ?? []);
    trie.add(rule);
    map[workspace] = trie.serialize();
    this.writeMap(map);
  }
}
