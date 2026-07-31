/**
 * modelPricing — Desktop 的 provider-scoped 价格投影。
 *
 * XD 模型与价格只来自 model-access-server 的同一次 GET /models 响应。这里不再
 * 直接请求 LiteLLM；模型同步成功时整体替换 XD quote，失败时保留上一份成功快照。
 * Gateway per-token 数值在这里转换为 per-Mtok；新版服务端下发的原生币种优先，
 * 旧版服务端缺失时才回退构建区域。
 */

import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  gatewayLedgerCurrency,
  gatewayPricingCatalog,
  declaredSingleGatewayCurrency,
  declaresGatewayTokenPrice,
  hasMixedGatewayCurrencies,
  getModelPriceQuote,
  subscriptionDirectPriceQuote,
} from '../../shared/modelPriceQuote.js';
import type { ModelAccessGatewayModel } from '../../shared/modelAccess.js';
import { providerSecretStorageKey } from '../../shared/providerSecrets.js';
import {
  gatewayCurrencyForRegion,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type MoneyCurrency,
} from '../../shared/regionalMoney.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import { setActiveLedgerCurrency } from './ledgerCurrency.js';
import { createLogger } from '../logger.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { resolveOwnerScopedSecretStorageKey } from '../secrets/providerSecretStore.js';

export { getModelPriceQuote } from '../../shared/modelPriceQuote.js';
export type {
  ModelPriceQuote as ModelPrice,
  ModelPricingCatalog as ModelPricingMap,
} from '../../shared/regionalMoney.js';

const log = createLogger('modelPricing');
// v8:账号币种与报价同快照持久化；无报价模型也可能明确声明结算币种。
// v7:币种改为优先使用 Model Access 明确声明，不能复用按 region 猜测的旧 quote。
// v6:所有 Gateway 模型统一按服务端 costDiscount 计费。v5 的 codex/ quote 已
// 硬编码乘过 0.15 且丢弃 costDiscount，不能继续复用。
const DISK_CACHE_VERSION = 8;
const DISK_CACHE_FILE = 'model-pricing.json';

export const MODEL_PRICING_CHANGED_CHANNEL = 'usage:model-pricing-changed';

interface DiskCachePayload {
  version: number;
  scope: string;
  fetchedAt: number;
  pricing: ModelPricingCatalog;
  accountCurrency: MoneyCurrency | null;
}

let cache: ModelPricingCatalog | null = null;
let cacheScope: string | null = null;
let cacheAt = 0;
let modelSyncInflight: Promise<unknown> | null = null;
let gatewayAccountCurrency: MoneyCurrency | null = null;
let gatewayAccountCurrencyScope: string | null = null;
/**
 * 最后一次拿到**真实**报价的时刻(retained 兜底的年龄基准)。
 * 刻意与 cacheAt 分开:cacheAt 每次同步都会刷新(含无价轮),用它做基准等于让
 * 陈旧报价无限续期。冷启动由磁盘快照的 fetchedAt 播种,重启不重置年龄。
 */
let lastPricedAt = 0;
let lastPricedAtScope: string | null = null;
/**
 * retained 报价的最大年龄。超过就不再沿用 —— 网关调价后继续按旧价记账是错的,
 * 而 24h 足以覆盖一次服务端故障窗口。超龄后钱不记、token 回退仍在。
 */
const RETAINED_PRICING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const hydratedScopes = new Set<string>();
const hydrateInflightByScope = new Map<string, Promise<ModelPricingCatalog | null>>();

function resolveGatewayAccountCurrency(
  models: readonly ModelAccessGatewayModel[],
): MoneyCurrency | null {
  if (models.length === 0) return null;
  const currencies = new Set(
    models
      .map((model) => model.currency)
      .filter((currency): currency is MoneyCurrency => currency === 'CNY' || currency === 'USD'),
  );
  if (currencies.size > 1) {
    log.warn('xd gateway models returned mixed currencies; account quota currency unavailable');
    return null;
  }
  return currencies.values().next().value ?? gatewayCurrencyForRegion(CURRENT_CINDY_REGION);
}

function currentKeyCacheIdentity(): string {
  try {
    const physicalKey = resolveOwnerScopedSecretStorageKey(providerSecretStorageKey('xd'));
    if (!physicalKey) return 'key=missing';
    const file = path.join(app.getPath('userData'), 'safe-storage', `${physicalKey}.enc`);
    const stat = statSync(file, { bigint: true });
    return `key=${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return 'key=missing';
  }
}

function currentScope(userId?: string): string {
  return [
    'v1',
    `region=${CURRENT_CINDY_REGION}`,
    `base=${getClientEndpoint('modelAccessApiBaseUrl').trim()}`,
    `user=${userId ?? getCurrentDbClientUserId() ?? 'anonymous'}`,
    currentKeyCacheIdentity(),
  ].join('|');
}

function diskCachePath(): string {
  return path.join(app.getPath('userData'), 'cache', DISK_CACHE_FILE);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateQuote(
  value: unknown,
  providerId: string,
  modelId: string,
): ModelPriceQuote | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const quote = value as Partial<ModelPriceQuote>;
  if (
    quote.providerId !== providerId ||
    quote.modelId !== modelId ||
    (quote.currency !== 'CNY' && quote.currency !== 'USD') ||
    quote.source !== 'gateway' ||
    quote.approximate !== false ||
    !isNonNegativeFinite(quote.inputPerMtok) ||
    !isNonNegativeFinite(quote.outputPerMtok)
  ) {
    return undefined;
  }
  const next: ModelPriceQuote = {
    providerId,
    modelId,
    currency: quote.currency,
    source: 'gateway',
    approximate: false,
    inputPerMtok: quote.inputPerMtok,
    outputPerMtok: quote.outputPerMtok,
  };
  if (isNonNegativeFinite(quote.cacheReadPerMtok)) {
    next.cacheReadPerMtok = quote.cacheReadPerMtok;
  }
  if (isNonNegativeFinite(quote.cacheCreatePerMtok)) {
    next.cacheCreatePerMtok = quote.cacheCreatePerMtok;
  }
  if (
    typeof quote.costDiscount === 'number' &&
    Number.isFinite(quote.costDiscount) &&
    quote.costDiscount > 0 &&
    quote.costDiscount <= 1
  ) {
    next.costDiscount = quote.costDiscount;
  }
  return next;
}

function validateCatalog(value: unknown): ModelPricingCatalog | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const catalog = value as Record<string, unknown>;
  if (Object.keys(catalog).length === 0) return {};
  const xdValue = catalog.xd;
  if (!xdValue || typeof xdValue !== 'object' || Array.isArray(xdValue)) return null;
  const xd: Record<string, ModelPriceQuote> = {};
  const entries = Object.entries(xdValue);
  for (const [rawModelId, rawQuote] of entries) {
    const modelId = rawModelId.trim();
    if (!modelId) continue;
    const quote = validateQuote(rawQuote, 'xd', modelId);
    if (quote) xd[modelId] = quote;
  }
  if (Object.keys(xd).length > 0) return { xd };
  return entries.length === 0 ? {} : null;
}

async function writeDiskCache(
  scope: string,
  pricing: ModelPricingCatalog,
  accountCurrency: MoneyCurrency | null,
  fetchedAt: number,
): Promise<void> {
  try {
    const file = diskCachePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const payload: DiskCachePayload = {
      version: DISK_CACHE_VERSION,
      scope,
      fetchedAt,
      pricing,
      accountCurrency,
    };
    await fs.writeFile(file, JSON.stringify(payload), 'utf8');
    hydratedScopes.add(scope);
  } catch (err) {
    log.debug(
      'write model pricing cache failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function hydrateFromDisk(scope: string): Promise<ModelPricingCatalog | null> {
  if (hydratedScopes.has(scope)) return cacheScope === scope ? cache : null;
  const existing = hydrateInflightByScope.get(scope);
  if (existing) return existing;
  const hydrateInflight = (async () => {
    try {
      const raw = JSON.parse(
        await fs.readFile(diskCachePath(), 'utf8'),
      ) as Partial<DiskCachePayload>;
      if (
        raw.version !== DISK_CACHE_VERSION ||
        raw.scope !== scope ||
        !Number.isFinite(raw.fetchedAt) ||
        Number(raw.fetchedAt) <= 0 ||
        (raw.accountCurrency !== null &&
          raw.accountCurrency !== 'CNY' &&
          raw.accountCurrency !== 'USD')
      ) {
        return null;
      }
      const pricing = validateCatalog(raw.pricing);
      if (!pricing) return null;
      if (currentScope() !== scope) return null;
      cache = pricing;
      cacheScope = scope;
      cacheAt = Number(raw.fetchedAt);
      // 磁盘快照里只可能是真实报价(retained 轮不写盘、approximate 过不了 validateQuote),
      // 所以它的 fetchedAt 就是「最后一次真实报价」的时刻 —— 用它播种年龄基准,让 retained
      // 的最大年龄跨重启延续,而不是每次冷启动重新给陈旧价 24 小时。
      if (pricing.xd) {
        lastPricedAt = Number(raw.fetchedAt);
        lastPricedAtScope = scope;
      }
      // 账本币种必须在这里恢复,而不是只在 getGatewayAccountCurrency 里:那个函数只服务
      // 可选的账号配额查询,而计费热路径(register.ts 的 turn 记账、prewarm)走的是
      // getModelPricing / getModelPricingForModel。冷启动只命中磁盘缓存(/models 尚未
      // 完成或失败)时若不在此同步,currentLedgerCurrency() 会回落构建默认币种,把该账号
      // 用缓存报价算出的金额当异币种丢弃 —— 等于这一段时间完全不计费。
      gatewayAccountCurrency = raw.accountCurrency;
      gatewayAccountCurrencyScope = scope;
      setActiveLedgerCurrency(raw.accountCurrency);
      log.debug(`hydrated model pricing cache: ${Object.keys(pricing.xd ?? {}).length} XD quotes`);
      return pricing;
    } catch (err) {
      const code =
        typeof err === 'object' && err && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code !== 'ENOENT') {
        log.debug(
          'hydrate model pricing cache failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      return null;
    } finally {
      hydratedScopes.add(scope);
      hydrateInflightByScope.delete(scope);
    }
  })();
  hydrateInflightByScope.set(scope, hydrateInflight);
  return hydrateInflight;
}

function broadcastPricing(pricing: ModelPricingCatalog | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(MODEL_PRICING_CHANGED_CHANNEL, pricing);
    }
  }
}

/**
 * 目录整体不带价格时,保留上一份快照里**仍出现在本次清单**的报价。
 *
 * 为什么需要:目录一次不下发价格字段,整条计费链就静默归零 —— 报价为空 →
 * 算不出 turnMoney → 日账本 / 按模型统计 / 消息费用全为 0,而 token 照记。
 * 实例:2026-07-30 傍晚起目录 67 个模型全部不带 inputCostPerToken,客户端一整天
 * 几百万 token 一分钱没记,日志里也无任何异常(覆盖率告警的条件是
 * quoteCount < pricedCount,0 < 0 不成立)。
 *
 * ── 不变量 ────────────────────────────────────────────────────────────────
 * retained 报价是**内存态的降级兜底**,三条边界共同约束它:
 *   (a) 只在「目录可信 + 确实没下发任何价格字段」时启用。两个反例都必须排除:
 *       · 混币目录(两种以上币种声明)—— gatewayPricingCatalog 对它也返回 {},
 *         但那是刻意的整份拒绝(混币 catalog 会被账本守卫按模型选择性丢弃,比
 *         整份没有报价更难发现),不能被本兜底绕过;
 *       · 显式全 0 的免费目录 —— 它**下发了**价格,只是价为零。判据用
 *         declaresGatewayTokenPrice 而不是 isPricedGatewayModel:后者对全 0 目录
 *         同样返回 false,会把「模型改成免费」误判成「服务端没下发价格」,于是对
 *         已经免费的模型继续按上一份付费报价计费最长 24 小时。
 *   (a-3) 币种必须同源:新目录显式声明的币种与旧报价不一致时不启用(账号换了结算
 *       币种,旧价不可信)。相应地 replaceGatewayModelPricing 在 retained 轮沿用
 *       上一份账本币种 —— 无价响应常常省略可选的 currency 字段,若按构建区域重新
 *       推导,账本币种会与 retained 金额分叉并被守卫整批丢弃,兜底白做。
 *   (b) 有最大年龄(RETAINED_PRICING_MAX_AGE_MS),且年龄以**最后一次真实报价**
 *       为准 —— 无价刷新不续期,否则连续无价会让陈旧价无限期进账本。
 *   (c) 绝不写入磁盘缓存。磁盘上永远只留本次真实结果或上一份精确快照:
 *       validateQuote 明确要求 approximate === false,把 retained 写进去等于
 *       让下次冷启动 hydrate 整体判无效(entries > 0 但全不通过 → validateCatalog
 *       返回 null),重启后反而回到「无价 = 全链归零」。跳过写盘则重启后 hydrate
 *       拿到的是最后一份**精确**快照。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 另两条既有边界:按本次清单过滤(已下架模型的旧价不复活);scope 不同(换号 /
 * 换区 / 换 key)不复用,旧账号的价格不外溢。保留的 quote 标 approximate +
 * reference-price → 金额仍进账本(用量真实发生过,记 0 才是确定性错误),但明确
 * 标注为按最后已知价折算,不谎称与账单精确一致。
 */
function retainKnownGatewayQuotes(
  models: readonly ModelAccessGatewayModel[],
  scope: string,
): ModelPricingCatalog | null {
  if (models.length === 0) return null;
  if (cacheScope !== scope) return null;
  // (a-1) 目录不可信(混币)→ 维持 gatewayPricingCatalog 的整份拒绝,不启用兜底。
  if (hasMixedGatewayCurrencies(models)) return null;
  // (a-2) 目录下发了价格字段(含显式全 0 的免费声明)→ 这是有效价格,必须立刻生效。
  // 只有字段整体缺失才是「服务端没下发价格」那个故障态。
  if (models.some(declaresGatewayTokenPrice)) return null;
  // (a-3) 新目录显式声明的币种与旧报价不一致 → 账号换了结算币种,旧报价不可信。
  // 沿用会让 retained 金额与账本币种分叉,被守卫按异币种整批丢弃(等于兜底白做),
  // 更糟的是按错币种记账。宁可回落无价。
  const previousCurrency = gatewayLedgerCurrency(cache);
  const declaredCurrency = declaredSingleGatewayCurrency(models);
  if (declaredCurrency && previousCurrency && declaredCurrency !== previousCurrency) {
    return null;
  }
  // (b) 最后一次真实报价太久以前 → 不再沿用。此后回落无价:钱不再记(避免按早已
  // 调整过的价格持续累计错误金额),token 回退仍保证消息那一格有事实可看。
  if (
    lastPricedAtScope !== scope ||
    lastPricedAt <= 0 ||
    Date.now() - lastPricedAt > RETAINED_PRICING_MAX_AGE_MS
  ) {
    return null;
  }
  const previous = cache?.xd;
  if (!previous) return null;
  const xd: Record<string, ModelPriceQuote> = {};
  for (const model of models) {
    const modelId = model.id.trim();
    if (!modelId) continue;
    const quote = previous[modelId];
    if (!quote) continue;
    xd[modelId] = quote.approximate
      ? quote
      : { ...quote, approximate: true };
  }
  return Object.keys(xd).length > 0 ? { xd } : null;
}

/**
 * 与模型同步同快照更新 XD quote。models 非空但没有标准 input/output 价格时，
 * 回落到上一份快照里仍在清单内的报价(见 retainKnownGatewayQuotes 的三条边界);
 * 连旧报价也没有(冷启动首次同步就无价、混币目录、retained 超龄)时投影为空。
 */
export function replaceGatewayModelPricing(
  models: readonly ModelAccessGatewayModel[],
  authenticatedUserId?: string,
): ModelPricingCatalog {
  // /models can finish a few milliseconds before localDb takeover has exposed
  // its user through getCurrentDbClientUserId(). The model-access caller
  // therefore passes the authenticated user captured when the request starts,
  // so a valid startup snapshot is never persisted under `anonymous`.
  const scope = currentScope(authenticatedUserId);
  const fetched = gatewayPricingCatalog(models, CURRENT_CINDY_REGION);
  let pricing = fetched;
  let retainedFromLastSnapshot = false;
  if (!fetched.xd) {
    const retained = retainKnownGatewayQuotes(models, scope);
    if (retained) {
      const ageHours = ((Date.now() - lastPricedAt) / 3_600_000).toFixed(1);
      log.warn(
        `xd gateway models returned no prices; retained ${Object.keys(retained.xd ?? {}).length} quote(s) from the last snapshot (marked approximate, ${ageHours}h old, disk snapshot left intact)`,
      );
      pricing = retained;
      retainedFromLastSnapshot = true;
    }
  }
  cache = pricing;
  cacheScope = scope;
  cacheAt = Date.now();
  if (fetched.xd) {
    // 只有真实报价才推进年龄基准 —— retained 轮不续期(见 retainKnownGatewayQuotes (b))。
    lastPricedAt = cacheAt;
    lastPricedAtScope = scope;
  }
  // retained 轮的账本币种必须与 retained 报价同源:无价响应常常连可选的 currency
  // 字段一起省略,此时 resolveGatewayAccountCurrency 会按**构建区域**重新推导。若账号
  // 结算币种本来就不等于构建区域(CN 构建 + USD 结算是正常组合),账本币种会被改成
  // 区域币种,而 retained 金额仍是旧的账号币种 → 被账本守卫按异币种整批丢弃,兜底白做。
  // 币种不一致的目录已在 retainKnownGatewayQuotes (a-3) 拒绝启用,所以走到这里的
  // retained 一定与上一份币种同源。
  gatewayAccountCurrency = retainedFromLastSnapshot
    ? (gatewayLedgerCurrency(pricing) ?? resolveGatewayAccountCurrency(models))
    : resolveGatewayAccountCurrency(models);
  gatewayAccountCurrencyScope = scope;
  // 账本写入层据此判断"这一笔是不是本账号的结算币种"。目录为空(登出 / clear)或混合
  // 币种时 resolveGatewayAccountCurrency 返回 null，账本随之回落构建默认值。
  setActiveLedgerCurrency(gatewayAccountCurrency);
  hydratedScopes.add(scope);
  // retained 轮不写盘(见 retainKnownGatewayQuotes (c)):approximate quote 过不了
  // validateQuote,写进去会让下次冷启动整份判无效;跳过则磁盘上留着最后一份精确快照,
  // 重启后 hydrate 正好恢复它。
  if (!retainedFromLastSnapshot) {
    void writeDiskCache(scope, pricing, gatewayAccountCurrency, cacheAt);
  }
  broadcastPricing(pricing);
  return pricing;
}

export function clearGatewayModelPricing(): void {
  replaceGatewayModelPricing([]);
}

export function trackGatewayModelPricingSync(sync: Promise<unknown>): void {
  modelSyncInflight = sync;
  void sync.then(
    () => {
      if (modelSyncInflight === sync) modelSyncInflight = null;
    },
    () => {
      if (modelSyncInflight === sync) modelSyncInflight = null;
    },
  );
}

export function isModelPricingRefreshInFlight(): boolean {
  return modelSyncInflight !== null;
}

export async function getModelPricing(): Promise<ModelPricingCatalog | null> {
  const scope = currentScope();
  if (cacheScope === scope) return cache;
  return hydrateFromDisk(scope);
}

/**
 * 记账热路径等待 inflight 同步的上限:/models 请求本身不设超时,黑洞网络下
 * 不能让记账写入无限期挂起(app 等待期间退出会丢整轮账)。超时后直接用当前
 * 已落地的投影计价；Gateway quote 缺失时不记录金额，避免把 SDK 的 USD 字段
 * 当成当前区域的 Gateway 价格。
 */
const PRICING_SYNC_WAIT_MS = 3_000;

async function waitForModelPricingSync(): Promise<void> {
  if (!modelSyncInflight) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      modelSyncInflight.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PRICING_SYNC_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Model Access 账号用量与模型目录属于同一个 Gateway 租户，因而共用目录声明的
 * 原生币种。混合币种或尚无当前账号目录时返回 null，调用方不再根据组织名称猜测。
 */
export async function getGatewayAccountCurrency(
  authenticatedUserId?: string,
): Promise<MoneyCurrency | null> {
  await waitForModelPricingSync();
  const scope = currentScope(authenticatedUserId);
  if (gatewayAccountCurrencyScope === scope) return gatewayAccountCurrency;
  // 本轮 /models 没跑成时，磁盘缓存里的报价同样能定出币种。hydrateFromDisk 内部会在
  // 落盘缓存生效的同时把币种写回缓存与账本事实源（那里才是所有取价路径的共同入口），
  // 所以这里只需触发一次 hydrate 再读结果。
  await getModelPricing();
  if (gatewayAccountCurrencyScope === scope) return gatewayAccountCurrency;
  return cacheScope === scope ? gatewayLedgerCurrency(cache) : null;
}

/**
 * 计费热路径等待模型同步已经落下的本地投影，不再自己联网。providerId 是必需的，
 * 同模型从 XD/OpenAI/订阅来源进入时不会串价。
 */
export async function getModelPricingForModel(
  providerId: string | null | undefined,
  modelId: string,
): Promise<ModelPricingCatalog | null> {
  await waitForModelPricingSync();
  const pricing = await getModelPricing();
  void getModelPriceQuote(pricing, providerId, modelId);
  return pricing;
}

export function getCodexSubscriptionValuePrice(
  modelId: string,
  pricing: ModelPricingCatalog | null | undefined,
): ModelPriceQuote | undefined {
  return getModelPriceQuote(pricing, 'openai', modelId);
}

export function getSubscriptionDirectValuePrice(modelId: string): ModelPriceQuote | undefined {
  return subscriptionDirectPriceQuote(modelId);
}

/** 启动只读磁盘快照；真正的新价格仍由 /models 同步整体替换。 */
export async function prewarmModelPricing(): Promise<void> {
  try {
    await getModelPricing();
  } catch (err) {
    log.debug('prewarm model pricing failed:', err instanceof Error ? err.message : String(err));
  }
}

export function __resetModelPricingCacheForTesting(): void {
  cache = null;
  cacheScope = null;
  cacheAt = 0;
  modelSyncInflight = null;
  gatewayAccountCurrency = null;
  gatewayAccountCurrencyScope = null;
  lastPricedAt = 0;
  lastPricedAtScope = null;
  hydratedScopes.clear();
  hydrateInflightByScope.clear();
}
