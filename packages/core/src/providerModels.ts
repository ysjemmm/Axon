/**
 * Provider 模型列表的纯校验/归一化逻辑（零依赖，跨形态共用）。
 *
 * 约束：同一个 provider 内的 model id 必须唯一。
 *
 * 为什么必须唯一：model id 是发给端点的真实标识（见 providerTypes.ProviderModel.id）。
 * 同一 provider 下出现两个相同 id 时——
 *   · 模型选择器会列出两条一模一样的模型，用户无法分辨该选哪个；
 *   · 按 id 回查能力声明（thinking / vision / cacheControl，见 providers.ts 的 declared*For）
 *     只取第一条命中项，第二条的声明等于凭空消失，行为变得难以预测。
 * 因此凡是写入 provider.models 的入口，都先用 assertUniqueModelIds 拦一道。
 *
 * 参数只要求「能读出 id」这一最小结构，core / server / 前端各自的模型对象形状不同也能复用。
 */

/** 最小结构约束：只要能取出 id 的模型对象 */
export interface IdentifiableModel {
  id?: unknown;
}

/**
 * 归一化 model id：只去掉首尾空白。
 * 刻意不做大小写折叠——部分网关的模型名区分大小写，折叠会把两个真实不同的模型误判成重复。
 */
export function normalizeModelId(id: unknown): string {
  return typeof id === "string" ? id.trim() : "";
}

/**
 * 找出重复出现的 model id（按首次重复出现的顺序，每个 id 只列一次）。
 * 空 id 不参与判定——它本身就标识不了模型，由各入口的「id 必填」校验负责。
 */
export function findDuplicateModelIds(models: readonly IdentifiableModel[] | undefined | null): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const model of models || []) {
    const id = normalizeModelId(model?.id);
    if (!id) continue;
    if (seen.has(id)) {
      if (!duplicates.includes(id)) duplicates.push(id);
    } else {
      seen.add(id);
    }
  }
  return duplicates;
}

/** 是否含重复 model id */
export function hasDuplicateModelIds(models: readonly IdentifiableModel[] | undefined | null): boolean {
  return findDuplicateModelIds(models).length > 0;
}

/**
 * 校验同一 provider 下的 model id 唯一；有重复则抛错。
 * 错误信息里带上 provider 名与重复的 id，前端可直接展示，不必再加工。
 */
export function assertUniqueModelIds(models: readonly IdentifiableModel[] | undefined | null, providerName?: string): void {
  const duplicates = findDuplicateModelIds(models);
  if (duplicates.length === 0) return;
  const ids = duplicates.map((id) => `「${id}」`).join("、");
  const where = providerName ? `provider「${providerName}」下` : "该 provider 下";
  throw new Error(`${where}已存在模型 id ${ids}，同一个 provider 不能重复添加同一个 model id`);
}

/**
 * 按 id 去重，保留首次出现的那条。
 *
 * 用于配置解析时的兜底：手工编辑过的 providers.json 可能已经写入了重复项，
 * 读取阶段静默收敛，免得重复模型出现在选择器里。正常写入路径已被
 * assertUniqueModelIds 挡住，这里只是不让历史脏数据继续可见。
 * 空 id 的条目原样保留（不与任何条目合并）。
 */
export function dedupeModelsById<T extends IdentifiableModel>(models: readonly T[] | undefined | null): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const model of models || []) {
    const id = normalizeModelId(model?.id);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    result.push(model);
  }
  return result;
}
