# 阶段 4：fork Code OSS 打造品牌化 Axon IDE

> 目标：基于 Code OSS（VS Code 的 MIT 内核）做品牌化发行版，把 `axon-ide` 扩展作为内置扩展塞进去，首启即 Axon IDE。
> 思路对标 VSCodium：克隆上游 → 覆盖 `product.json` → 内置扩展 → 编译打包。改 workbench 源码会导致 merge 灾难，尽量只靠 product.json + 内置扩展定制。

> 日常开发流程（watch、链接、build）见 `dev-guide.md`。本文档只讲**品牌化与发行打包**。

---

## 0. 环境前置

- **Node**：与上游 `.nvmrc` 一致（当前基线 1.123.0 用 **24.15.0**）。Code OSS 仓库内用 `npm`，不要用 pnpm。
- **Python 3** + **VS Build Tools 2022**（"使用 C++ 的桌面开发" + `MSVC v143 Spectre 缓解库 x64/x86`，缺它 native-watchdog 报 MSB8040）。
- 磁盘预留 10GB+。

已永久配置（用户级环境变量）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（新终端才生效）。

## 1. 基线

- 当前基线 tag：**1.123.0**（已克隆为 `d:\projects\axon-ide-shell`，分支 `axon/base`）。
- 浅克隆：`git clone --depth 1 --branch 1.123.0 <镜像>/microsoft/vscode.git axon-ide-shell`
- 扩展的 `engines.vscode` 不能高于基线版本，否则内置后不被加载。

### 首次 npm ci 踩坑速查
- Node 必须 24（用 22 编不过主体）。
- tree-sitter 在 Node 24 下编译崩 → 先 `nvm use 22.19.0` 进 `build/` 跑 `npm ci`，再 `nvm use 24.15.0` 回根目录 `npm ci`。
- 卡在扩展依赖下载 → `npm config set registry https://registry.npmmirror.com`，`npm ci` 可重跑续装。

## 2. 品牌化 product.json（核心开关）

仓库根 `product.json` 控制名称/图标/内置扩展/更新地址。关键字段：

```jsonc
{
  "nameShort": "Axon",
  "nameLong": "Axon IDE",
  "applicationName": "axon",
  "dataFolderName": ".axon-ide",        // 与扩展用的 ~/.axon 分开
  "win32MutexName": "axonide",
  "win32DirName": "Axon IDE",
  "win32NameVersion": "Axon IDE",
  "win32AppUserModelId": "Axon.AxonIDE",
  "win32ShellNameShort": "Axon IDE",
  "darwinBundleIdentifier": "com.yourorg.axonide",
  "linuxIconName": "axon-ide",
  "urlProtocol": "axon",
  "builtInExtensions": []
}
```

- **不要**填 Microsoft 遥测/画廊/更新端点。要支持装扩展可指向 Open VSX（`https://open-vsx.org`）。
- 图标：替换 `resources/` 下各平台图标（`win32/code.ico`、`darwin/code.icns`、`linux/code.png`），文件名保持上游约定只换内容。
- ⚠️ product.json 只在进程冷启动时读一次，改完必须**完全退出 Electron** 重启，`Ctrl+R` 无效。

## 3. 把扩展打成可内置产物

```powershell
# Axon monorepo 里
pnpm build                       # core/host/axon-ide 全量
pnpm --filter axon-ide build:web # 构建 web 并拷进扩展 media/web/

cd apps/vscode-extension
npx --yes @vscode/vsce package --no-dependencies -o axon-ide.vsix
```

- `--no-dependencies`：esbuild 已把 `@axon/*` bundle 进 `dist/extension.js`，运行时无需 node_modules。
- 确认 `.vscodeignore`：打进 `dist/`、`media/`、`package.json`、图标；忽略 `src/`。
- vsce 要求 `publisher`、`repository` 字段（已填占位）。

## 4. 内置进 Code OSS

**开发期**：用 junction 把 `extensions/axon-ide` 指向 Axon 源仓库（见 `dev-guide.md`）。

**发行期**：必须换成实拷贝，否则 `src/`、`node_modules` 会被打进发行包（体积爆炸 + 泄露源码）：

```powershell
rmdir extensions\axon-ide        REM junction 用 rmdir 删（不动源仓库）
mkdir extensions\axon-ide\dist
copy D:\projects\Axon\apps\vscode-extension\package.json   extensions\axon-ide\
xcopy /E /I /Y D:\projects\Axon\apps\vscode-extension\dist  extensions\axon-ide\dist
xcopy /E /I /Y D:\projects\Axon\apps\vscode-extension\media extensions\axon-ide\media
```

预编译内置扩展要点：`package.json` 的 `main` 指向已存在的 `./dist/extension.js`，
不要有 `scripts.compile` 强依赖（避免上游对它二次编译）。

## 5. 默认布局（首启即 Axon 形态）

- 扩展 `activationEvents` 已含 `onStartupFinished`，`activate` 里可聚焦 Axon 视图。
- 轻度定制走默认 settings（`configurationDefaults`）；重度定制才碰 workbench（不推荐）。
- 欢迎引导可贡献 `contributes.walkthroughs`。

## 6. 编译打包发行

```powershell
npm run gulp vscode-win32-x64                 # Windows x64 产物
npm run gulp vscode-win32-x64-archive         # 免安装 zip
npm run gulp vscode-win32-x64-system-setup    # 系统级安装包
# macOS/Linux：vscode-darwin-arm64 / vscode-linux-x64 等
```

任务名每版略有差异，`npm run gulp --tasks` 或查 `build/gulpfile.vscode.*.js` 确认。

**签名**（发行必需，避免被 SmartScreen/Gatekeeper 拦）：
- Windows：Authenticode 签名（signtool）
- macOS：codesign + notarize
- Linux：deb/rpm GPG 签名

无证书时首发可先出免签 zip 便携版自用。

## 7. 更新通道（后期可选）

自建 update server 实现 VS Code update 协议，`product.json` 配 `updateUrl`。起步可手动分发。

---

## 关键决策（执行前定）

1. 基线 tag：当前 1.123.0
2. fork 位置：`d:\projects\axon-ide-shell`（独立）
3. 扩展画廊：接 Open VSX 还是只带内置 Axon？
4. 签名证书：三平台是否就绪？首发是否先出便携 zip？
5. 首发平台：先 Windows 还是三平台？

## 进度

- [x] Code OSS 1.123.0 构建环境就绪，源码能编译启动
- [x] axon-ide 扩展通过 junction 接入 fork，开发联调跑通（侧栏/对话/原生 diff/终端执行）
- [ ] product.json 品牌化 + 图标
- [ ] 发行期换实拷贝 + gulp 打包 + 签名
