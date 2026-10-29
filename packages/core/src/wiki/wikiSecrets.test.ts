import { describe, expect, it } from "vitest";
import { findSecrets, isSensitivePath } from "./wikiSecrets.js";

describe("isSensitivePath", () => {
  it("挡住凭据文件，放行示例文件", () => {
    for (const p of [".env", "config/.env.production", "certs/server.pem", "id_rsa", "C:\\repo\\.npmrc", "credentials.json", "secrets.yaml"]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
    for (const p of [".env.example", "src/env.ts", "README.md", "keys.ts", "secret-santa.md"]) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});

describe("findSecrets", () => {
  it("识别常见格式", () => {
    const text = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_" + "x".repeat(36),
      "postgres://admin:hunter22@db:5432/app",
      "password = Abc123456789xyz",
    ].join("\n");
    expect(findSecrets(text).map((f) => f.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it("不把代码引用、占位符、类型声明当成密钥", () => {
    const text = "token: string\napiKey = this.config.apiKey\npassword: ${DB_PASSWORD}\nsecret = <your-secret>\naccess_key = xxxxxxxxxxxx";
    expect(findSecrets(text)).toEqual([]);
  });
});
