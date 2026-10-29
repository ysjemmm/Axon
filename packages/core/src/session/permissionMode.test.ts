import { describe, expect, it } from "vitest";
import { isCatastrophicCommand, normalizePermissionMode } from "./permissionMode.js";

describe("权限模式", () => {
  it("只拦极少数毁盘命令，日常删除 / 重置不拦", () => {
    for (const cmd of ["rm -rf /", "rm -rf ~", "sudo rm -rf /*", "rm -fr $HOME", "Remove-Item -Recurse -Force C:\\", "rd /s /q C:\\", "mkfs.ext4 /dev/sda1", "format D:", "dd if=/dev/zero of=/dev/sda", ":(){ :|:& };:"]) {
      expect(isCatastrophicCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ["rm -rf node_modules", "rm -rf ./dist", "git reset --hard", "rm -rf /tmp/build", "Remove-Item -Recurse -Force .\\out", "npm run format", "del /q temp.txt"]) {
      expect(isCatastrophicCommand(cmd), cmd).toBe(false);
    }
  });

  it("未知值一律按安全模式", () => {
    expect(normalizePermissionMode("auto")).toBe("auto");
    expect(normalizePermissionMode("root")).toBe("safe");
    expect(normalizePermissionMode(undefined)).toBe("safe");
  });
});
