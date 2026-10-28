/**
 * 独立 server 的额度凭证存储：~/.axon/secrets/quota.json，权限 0600。
 *
 * IDE 里用的是 VS Code SecretStorage（系统钥匙串）；server 没有钥匙串可用，
 * 和 providers.json 里的 API Key 一样放在用户目录，只是单独一个仅本人可读的文件。
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SecretKV } from "@axon/core";

export class FileSecretStore implements SecretKV {
  private cache: Record<string, string> | null = null;
  /** 串行化写入，避免并发保存时后写的覆盖先写的 */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path = join(homedir(), ".axon", "secrets", "quota.json")) {}

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.path, "utf8"));
      this.cache = parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private persist(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.path, JSON.stringify(this.cache ?? {}, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.chmod(this.path, 0o600).catch(() => undefined);
    });
    return this.writing;
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.load())[key];
  }

  async store(key: string, value: string): Promise<void> {
    (await this.load())[key] = value;
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    const data = await this.load();
    if (!(key in data)) return;
    delete data[key];
    await this.persist();
  }
}
