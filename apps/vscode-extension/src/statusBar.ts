/**
 * Axon 底部状态栏入口
 *
 * 替代 Code OSS 内置的 Copilot 状态栏入口（fork 侧已注释其注册）。
 * 显示 Credits 用量和 Axon 品牌按钮，点击可聚焦右侧 Axon AI 对话栏。
 *
 * 说明：VS Code 状态栏 text 仅支持内置 codicon（`$(...)`）或纯文本，
 * 无法直接渲染自定义 svg。此处用 `$(sparkle)` 作为 AI 标识并附带
 * "Axon" 品牌文字；如需真正的 Axon logo，需将 svg 转为图标字体后
 * 通过 package.json 的 `contributes.icons` 注册再以 `$(axon-logo)` 引用。
 */

import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 点击状态栏按钮时执行的命令（聚焦 Axon 对话视图）。 */
const FOCUS_CHAT_COMMAND = "axon.focusChat";
/** 官方 Credits 用量刷新间隔：5 分钟。 */
const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** 相对更新时间重绘间隔：1 分钟，只更新文案，不请求接口。 */
const USAGE_RELATIVE_TIME_RENDER_INTERVAL_MS = 60 * 1000;

/**
 * Axon 官方账户用量展示数据。
 *
 * 这组数据独立于 core 的本地 credits 计费逻辑，后续由官方用量接口更新。
 * updatedAt 由 IDE 记录最近一次成功获取用量的时间，用于显示相对时间。
 */
export interface AxonUsageStats {
	usedCredits: number;
	totalCredits: number;
	updatedAt: number | null;
	errorMessage?: string;
}

/** 官方接口返回的最小数据结构：更新时间由 IDE 在成功更新时自动记录。 */
export type AxonUsageResponse = Pick<AxonUsageStats, "usedCredits" | "totalCredits">;

/** 官方用量接口的响应字段（只声明状态栏实际使用的字段）。 */
interface AxonUsageApiResponse {
	creditLimit?: unknown;
	totalCredits?: unknown;
}

/** 状态栏用量展示控制器，供后续 API 接入时更新数据。 */
export interface AxonUsageStatusBar {
	setUsage(usage: AxonUsageResponse): void;
	clearUsage(): void;
	refresh(): Promise<void>;
	dispose(): void;
}

function formatCredits(value: number): string {
	return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function formatCreditLimit(value: number): string {
	if (!Number.isFinite(value)) return "0";
	return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatUpdatedAt(updatedAt: number | null, now = Date.now()): string {
	if (!updatedAt) return "等待更新";
	const elapsed = Math.max(0, now - updatedAt);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "刚刚更新";
	if (minutes < 60) return `${minutes} 分钟前更新`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前更新`;
	const days = Math.floor(hours / 24);
	return `${days} 天前更新`;
}

function usageText(usage: AxonUsageStats): string {
	return `$(dashboard) ${formatCredits(usage.usedCredits)} / ${formatCreditLimit(usage.totalCredits)} Credits · ${formatUpdatedAt(usage.updatedAt)}`;
}

function usageTooltip(usage: AxonUsageStats, hasApiKey: boolean): string {
	if (!hasApiKey) {
		return "Axon 官方 Credits\n未配置 API Key，请前往 Provider 配置";
	}
	if (usage.errorMessage) {
		return `Axon 官方 Credits\n获取用量失败：${usage.errorMessage}`;
	}
	return usage.updatedAt
		? `Axon 官方 Credits\n已使用：${formatCredits(usage.usedCredits)}\n总额度：${formatCreditLimit(usage.totalCredits)}\n最近更新：${formatUpdatedAt(usage.updatedAt)}`
		: "Axon 官方 Credits\n等待官方用量接口返回数据";
}

/** 读取 Axon 官方 key：优先用户级 providers.json，其次兼容环境变量。 */
function readAxonApiKey(): string {
	try {
		const raw = readFileSync(join(homedir(), ".axon", "settings", "providers.json"), "utf8");
		const config = JSON.parse(raw) as { builtinApiKeys?: Record<string, unknown> };
		const key = config.builtinApiKeys?.axon;
		if (typeof key === "string" && key.trim()) return key.trim();
	} catch {
		/* 文件不存在或格式异常时继续读环境变量 */
	}
	return process.env.PROVIDER_AXON_API_KEY?.trim() || "";
}

/** 从 providers.json 读取 Axon 官方中转站地址，默认 sunnorthgod.top */
function readAxonBaseUrl(): string {
	try {
		const raw = readFileSync(join(homedir(), ".axon", "settings", "providers.json"), "utf8");
		const config = JSON.parse(raw) as { builtinBaseUrls?: Record<string, unknown> };
		const url = config.builtinBaseUrls?.axon;
		if (typeof url === "string" && url.trim()) return url.trim();
	} catch {
		/* 配置不存在时用默认值 */
	}
	return "https://ai.sunnorthgod.top:8443/v1";
}

/** 从 baseUrl 提取域名:端口（如 https://ai.sunnorthgod.top:8443/v1 → https://ai.sunnorthgod.top:8443） */
function usageApiOrigin(baseUrl: string): string {
	try {
		const u = new URL(baseUrl);
		return `${u.protocol}//${u.host}`;
	} catch {
		return "https://ai.sunnorthgod.top:8443";
	}
}

let currentUsageSnapshot: AxonUsageStats = { usedCredits: 0, totalCredits: 0, updatedAt: null };

function updateUsageCommand(item: vscode.StatusBarItem): void {
	item.command = {
		command: "axon.usage.openModal",
		title: "查看 Axon Credits 用量",
	};
}

/**
 * 创建并注册 Axon 状态栏入口。返回的 disposable 由调用方纳入
 * context.subscriptions 统一释放。
 */
export function registerAxonStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    "axon.aiChat",
    vscode.StatusBarAlignment.Right,
    100,
  );

  item.name = "Axon";
  item.text = "$(sparkle) Axon";
  item.tooltip = "点击打开 AI 对话";
  item.command = FOCUS_CHAT_COMMAND;
  item.show();

  context.subscriptions.push(item);
  return item;
}

/**
 * 注册底部状态栏的 Credits 展示，并返回后续接口可调用的更新句柄。
 * 当前不发起任何网络请求；官方用量接口接入后调用 controller.setUsage 即可。
 */
export function registerAxonUsageStatusBar(context: vscode.ExtensionContext): AxonUsageStatusBar {
	const item = vscode.window.createStatusBarItem(
		"axon.usage",
		// 右侧状态栏中 priority 越大越靠左；101 会显示在 Axon(100) 左边且保持独立按钮。
		vscode.StatusBarAlignment.Right,
		101,
	);
	let usage: AxonUsageStats = { usedCredits: 0, totalCredits: 0, updatedAt: null };
	currentUsageSnapshot = usage;
	let disposed = false;
	const refreshUsageTimer = setInterval(() => {
		if (!disposed) void controller.refresh();
	}, USAGE_REFRESH_INTERVAL_MS);
	const renderRelativeTimeTimer = setInterval(() => {
		if (disposed) return;
		item.text = usageText(usage);
		item.tooltip = usageTooltip(usage, !!readAxonApiKey());
		updateUsageCommand(item);
	}, USAGE_RELATIVE_TIME_RENDER_INTERVAL_MS);

	item.name = "Axon Credits 用量";
	item.text = usageText(usage);
	item.tooltip = usageTooltip(usage, !!readAxonApiKey());
	updateUsageCommand(item);
	item.show();
	context.subscriptions.push(item, {
		dispose: () => {
			clearInterval(refreshUsageTimer);
			clearInterval(renderRelativeTimeTimer);
		},
	});

	const controller: AxonUsageStatusBar = {
		setUsage(nextUsage) {
			usage = {
				usedCredits: Math.max(0, nextUsage.usedCredits),
				totalCredits: Math.max(0, nextUsage.totalCredits),
				updatedAt: Date.now(),
			};
			currentUsageSnapshot = usage;
			item.text = usageText(usage);
			item.tooltip = usageTooltip(usage, true);
			updateUsageCommand(item);
		},
		clearUsage() {
			usage = { usedCredits: 0, totalCredits: 0, updatedAt: null };
			currentUsageSnapshot = usage;
			item.text = usageText(usage);
			item.tooltip = usageTooltip(usage, !!readAxonApiKey());
			updateUsageCommand(item);
		},
		async refresh() {
			const apiKey = readAxonApiKey();
			if (!apiKey) {
				usage = { ...usage, errorMessage: undefined };
				currentUsageSnapshot = usage;
				item.tooltip = usageTooltip(usage, false);
				updateUsageCommand(item);
				return;
			}
			const origin = usageApiOrigin(readAxonBaseUrl());
			try {
				const response = await fetch(`${origin}/api/user/usage`, {
					headers: {
						accept: "application/json",
						"x-api-key": apiKey,
					},
				});
				if (!response.ok) {
					const text = await response.text().catch(() => "");
					throw new Error(text ? `HTTP ${response.status} - ${text}` : `HTTP ${response.status}`);
				}
				const data = await response.json() as AxonUsageApiResponse;
				const creditLimit = typeof data.creditLimit === "number" ? data.creditLimit : Number(data.creditLimit);
				const totalCredits = typeof data.totalCredits === "number" ? data.totalCredits : Number(data.totalCredits);
				if (!Number.isFinite(creditLimit) || !Number.isFinite(totalCredits)) throw new Error("用量响应字段无效");
				controller.setUsage({ usedCredits: totalCredits, totalCredits: creditLimit });
			} catch (error) {
				usage = { ...usage, errorMessage: (error as Error).message || "未知错误" };
				currentUsageSnapshot = usage;
				item.tooltip = usageTooltip(usage, true);
				updateUsageCommand(item);
			}
		},
		dispose() {
			disposed = true;
			clearInterval(refreshUsageTimer);
			clearInterval(renderRelativeTimeTimer);
			item.dispose();
		},
	};

	context.subscriptions.push(vscode.commands.registerCommand("axon.usage.openModal", async () => {
		const apiKey = readAxonApiKey();
		await vscode.commands.executeCommand("axon.showAccountUsageModal", {
			apiKey,
			usage: currentUsageSnapshot,
			errorMessage: currentUsageSnapshot.errorMessage,
			loading: !!apiKey,
		});
		if (!apiKey) return;
		await controller.refresh();
		await vscode.commands.executeCommand("axon.updateAccountUsageModal", {
			apiKey: readAxonApiKey(),
			usage: currentUsageSnapshot,
			errorMessage: currentUsageSnapshot.errorMessage,
			loading: false,
		});
	}));

	void controller.refresh();
	return controller;
}
