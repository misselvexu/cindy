import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  getCurrentDbClientUserId: vi.fn(() => 'user-a' as string | null),
  electronAppGetPath: vi.fn(() => ''),
  getClientEndpoint: vi.fn(() => 'https://model-access.example.test'),
  resolveOwnerScopedSecretStorageKey: vi.fn(() => 'provider-xd'),
  statSync: vi.fn(() => ({
    dev: 1n,
    ino: 2n,
    size: 3n,
    mtimeNs: 4n,
    ctimeNs: 5n,
  })),
  send: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  statSync: mocks.statSync,
}));
vi.mock('electron', () => ({
  app: {
    getPath: mocks.electronAppGetPath,
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: mocks.send },
      },
    ],
  },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../localDb/client/current', () => ({
  getCurrentDbClientUserId: mocks.getCurrentDbClientUserId,
}));
vi.mock('../../clientEndpointsService', () => ({
  getClientEndpoint: mocks.getClientEndpoint,
}));
vi.mock('../../secrets/providerSecretStore', () => ({
  resolveOwnerScopedSecretStorageKey: mocks.resolveOwnerScopedSecretStorageKey,
}));

import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { DEFAULT_USAGE_CURRENCY } from '../../../shared/regionalMoney';
import {
  __resetActiveLedgerCurrencyForTesting,
  currentLedgerCurrency,
} from '../ledgerCurrency';
import {
  __flushDiskWritesForTesting,
  __resetModelPricingCacheForTesting,
  clearGatewayModelPricing,
  getCodexSubscriptionValuePrice,
  getModelPricing,
  getModelPricingForModel,
  getSubscriptionDirectValuePrice,
  MODEL_PRICING_CHANGED_CHANNEL,
  prewarmModelPricing,
  replaceGatewayModelPricing,
  trackGatewayModelPricingSync,
} from '../modelPricing';

let tempUserDataDir: string | null = null;
const EXPECTED_GATEWAY_CURRENCY =
  CURRENT_CINDY_REGION === 'global' ? 'USD' : 'CNY';

function userDataPath(...segments: string[]): string {
  if (!tempUserDataDir) throw new Error('temp userData is not initialized');
  return path.join(tempUserDataDir, ...segments);
}

function expectedScope(userId = 'user-a'): string {
  return `v1|region=${CURRENT_CINDY_REGION}|base=https://model-access.example.test|user=${userId}|key=1:2:3:4:5`;
}

beforeEach(async () => {
  tempUserDataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-model-pricing-'));
  mocks.electronAppGetPath.mockReturnValue(tempUserDataDir);
  mocks.getCurrentDbClientUserId.mockReturnValue('user-a');
  mocks.getClientEndpoint.mockReturnValue('https://model-access.example.test');
  mocks.resolveOwnerScopedSecretStorageKey.mockReturnValue('provider-xd');
  mocks.statSync.mockReturnValue({
    dev: 1n,
    ino: 2n,
    size: 3n,
    mtimeNs: 4n,
    ctimeNs: 5n,
  });
  mocks.send.mockClear();
  __resetModelPricingCacheForTesting();
});

afterEach(async () => {
  // 写盘是串行 + fire-and-forget 的,必须在 mock 被 restore 前 flush 干净:否则
  // 排队中的写入会在 app.getPath mock 失效后执行,把缓存写进工作区
  // (apps/desktop/cache/),既污染仓库又让下一个用例读到残留。
  await __flushDiskWritesForTesting();
  vi.restoreAllMocks();
  if (tempUserDataDir) {
    await rm(tempUserDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    tempUserDataDir = null;
  }
});

describe('gateway model pricing projection', () => {
  it('converts model-groups per-token values to provider-scoped per-Mtok quotes', () => {
    const pricing = replaceGatewayModelPricing([
      {
        id: 'claude-sonnet-4',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        cacheReadInputTokenCost: 0.0000003,
        cacheCreationInputTokenCost: 0.00000375,
        costDiscount: 0.4,
      },
      {
        id: 'codex/gpt-5.5',
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000008,
        cacheReadInputTokenCost: 0.0000002,
      },
    ]);

    expect(pricing).toEqual({
      xd: {
        'claude-sonnet-4': {
          providerId: 'xd',
          modelId: 'claude-sonnet-4',
          currency: EXPECTED_GATEWAY_CURRENCY,
          source: 'gateway',
          approximate: false,
          inputPerMtok: 3,
          outputPerMtok: 15,
          cacheReadPerMtok: 0.3,
          cacheCreatePerMtok: 3.75,
          costDiscount: 0.4,
        },
        'codex/gpt-5.5': {
          providerId: 'xd',
          modelId: 'codex/gpt-5.5',
          currency: EXPECTED_GATEWAY_CURRENCY,
          source: 'gateway',
          approximate: false,
          inputPerMtok: 2,
          outputPerMtok: 8,
          cacheReadPerMtok: expect.closeTo(0.2),
        },
      },
    });
    expect(mocks.send).toHaveBeenCalledWith(MODEL_PRICING_CHANGED_CHANNEL, pricing);
  });

  it('keeps legal zero tiers but drops missing, invalid and 0/0 standard prices', () => {
    const pricing = replaceGatewayModelPricing([
      {
        id: 'free-output',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0,
        cacheReadInputTokenCost: 0,
      },
      {
        id: 'missing-output',
        inputCostPerToken: 0.000001,
      },
      {
        id: 'zero-both',
        inputCostPerToken: 0,
        outputCostPerToken: 0,
      },
      {
        id: 'negative',
        inputCostPerToken: -1,
        outputCostPerToken: 1,
      },
    ]);

    expect(pricing?.xd?.['free-output']).toMatchObject({
      inputPerMtok: 1,
      outputPerMtok: 0,
      cacheReadPerMtok: 0,
    });
    expect(Object.keys(pricing?.xd ?? {})).toEqual(['free-output']);
  });

  it('never revives quotes for models that left the catalog', async () => {
    replaceGatewayModelPricing([
      {
        id: 'priced',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
      },
    ]);
    expect(await getModelPricing()).not.toBeNull();

    // 'priced' 已不在本次清单里 → 它的旧报价不得复活(下架模型继续计费是错的)。
    expect(replaceGatewayModelPricing([{ id: 'unpriced' }])).toEqual({});
    expect(await getModelPricing()).toEqual({});
    expect(mocks.send).toHaveBeenLastCalledWith(MODEL_PRICING_CHANGED_CHANNEL, {});

    clearGatewayModelPricing();
    expect(await getModelPricing()).toEqual({});
  });

  it('retains last known quotes for models still listed when the catalog drops all prices', async () => {
    replaceGatewayModelPricing([
      {
        id: 'still-listed',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
      {
        id: 'dropped-later',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
      },
    ]);

    // 目录仍返回模型、但整体不带价格字段(2026-07-30 现场)。仍在清单里的条目沿用
    // 最后已知报价,并标 approximate;这一轮不在清单的 'dropped-later' 一并消失。
    const retained = replaceGatewayModelPricing([{ id: 'still-listed' }]);
    expect(Object.keys(retained.xd ?? {})).toEqual(['still-listed']);
    expect(retained.xd?.['still-listed']).toMatchObject({
      providerId: 'xd',
      modelId: 'still-listed',
      source: 'gateway',
      approximate: true,
      inputPerMtok: 3,
      outputPerMtok: 15,
    });
    expect(await getModelPricing()).toEqual(retained);
  });

  it('does not carry retained quotes across accounts', async () => {
    replaceGatewayModelPricing([
      {
        id: 'shared-id',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);

    // 换账号(scope 变化)后目录无价:上一个账号的报价不得外溢到新账号。
    mocks.getCurrentDbClientUserId.mockReturnValue('user-b');
    expect(replaceGatewayModelPricing([{ id: 'shared-id' }], 'user-b')).toEqual({});
  });

  it('keeps rejecting mixed-currency catalogs instead of falling back to retained quotes', () => {
    replaceGatewayModelPricing([
      {
        id: 'model-a',
        currency: 'USD',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);

    // 混币目录同样让 gatewayPricingCatalog 返回 {},但那是刻意的整份拒绝
    // (混币 catalog 会被账本守卫按模型选择性丢弃,比整份没有报价更难发现)。
    // 判据是「一个 priced model 都没有」,不是「投影为空」—— 这里仍有 priced model。
    const mixed = replaceGatewayModelPricing([
      {
        id: 'model-a',
        currency: 'USD',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
      {
        id: 'model-b',
        currency: 'CNY',
        inputCostPerToken: 0.00002,
        outputCostPerToken: 0.0001,
      },
    ]);
    expect(mixed).toEqual({});
  });

  it('never revives paid quotes for a catalog that explicitly prices everything at zero', async () => {
    replaceGatewayModelPricing([
      {
        id: 'was-paid',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);

    // 模型从付费调成免费:目录**下发了**价格,只是全为 0。这不是「服务端没下发价格」
    // 那个故障态,兜底绝不能启用 —— 否则已经免费的模型还会按旧付费价继续计费。
    const free = replaceGatewayModelPricing([
      {
        id: 'was-paid',
        inputCostPerToken: 0,
        outputCostPerToken: 0,
        cacheReadInputTokenCost: 0,
        cacheCreationInputTokenCost: 0,
      },
    ]);
    expect(free).toEqual({});
    expect(await getModelPricing()).toEqual({});
  });

  it('does not fall back when only some price fields are present', () => {
    replaceGatewayModelPricing([
      {
        id: 'partial',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);

    // 只下发 input 没下发 output:产不出报价,但目录确实带了价格字段 —— 属于
    // 服务端形状变化而非「整体没下发」,同样不启用兜底(宁可不记,不要错记)。
    expect(replaceGatewayModelPricing([{ id: 'partial', inputCostPerToken: 0.000004 }])).toEqual({});
  });

  it('does not fall back for a mixed-currency catalog even when it carries no prices', () => {
    replaceGatewayModelPricing([
      {
        id: 'model-a',
        currency: 'USD',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);

    // 混币 + 无价:目录本身已不可信,兜底不得借「没下发价格」之名启用。
    expect(
      replaceGatewayModelPricing([
        { id: 'model-a', currency: 'USD' },
        { id: 'model-b', currency: 'CNY' },
      ]),
    ).toEqual({});
  });

  it('keeps the ledger currency aligned with retained quotes when the catalog omits currency', () => {
    __resetActiveLedgerCurrencyForTesting();
    // 账号结算币种刻意选成与构建区域不同的那个 —— CN 构建 + USD 结算是正常组合。
    const accountCurrency = EXPECTED_GATEWAY_CURRENCY === 'USD' ? 'CNY' : 'USD';
    replaceGatewayModelPricing([
      {
        id: 'aligned',
        currency: accountCurrency,
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);
    expect(currentLedgerCurrency()).toBe(accountCurrency);

    // 无价响应通常连可选的 currency 字段一起省略。此时若按构建区域重新推导账本币种,
    // retained 金额(旧账号币种)会被账本守卫按异币种整批丢弃 —— 兜底就白做了。
    const retained = replaceGatewayModelPricing([{ id: 'aligned' }]);
    expect(retained.xd?.aligned?.currency).toBe(accountCurrency);
    expect(currentLedgerCurrency()).toBe(accountCurrency);
  });

  it('does not reuse retained quotes when the catalog switches currency', () => {
    const first = EXPECTED_GATEWAY_CURRENCY === 'USD' ? 'CNY' : 'USD';
    const second = first === 'USD' ? 'CNY' : 'USD';
    replaceGatewayModelPricing([
      {
        id: 'switching',
        currency: first,
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);

    // 账号换了结算币种(新目录显式声明另一种币种、但没带价格)→ 旧报价不可信,
    // 沿用会按错币种记账。宁可回落无价。
    expect(replaceGatewayModelPricing([{ id: 'switching', currency: second }])).toEqual({});
  });

  it('stops reusing retained quotes once the last real pricing is too old', () => {
    const realAt = Date.parse('2026-07-30T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(realAt);
    replaceGatewayModelPricing([
      {
        id: 'aging',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);

    // 23h 后仍在窗口内 —— 沿用最后已知报价。
    vi.spyOn(Date, 'now').mockReturnValue(realAt + 23 * 3_600_000);
    expect(Object.keys(replaceGatewayModelPricing([{ id: 'aging' }]).xd ?? {})).toEqual(['aging']);

    // retained 轮不推进年龄基准:再过 2h(距最后一次真实报价 25h)即超龄,
    // 回落无价 —— 钱不再按早已可能调整过的价格累计,token 回退仍保证可见性。
    vi.spyOn(Date, 'now').mockReturnValue(realAt + 25 * 3_600_000);
    expect(replaceGatewayModelPricing([{ id: 'aging' }])).toEqual({});
  });

  it('lets a late hydrate recover the disk snapshot after an unpriced cold-start sync', async () => {
    // 先造出磁盘上的精确快照。
    replaceGatewayModelPricing([
      {
        id: 'cold-start',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw.pricing.xd['cold-start'].approximate).toBe(false);
    });

    // 冷启动:内存全空(prewarm 还没跑),/models 先返回一份无价目录。
    // 此时 cacheScope 尚未指向本账号 → retained 必然拿不到旧报价。
    __resetModelPricingCacheForTesting();
    expect(replaceGatewayModelPricing([{ id: 'cold-start' }])).toEqual({});

    // 这一轮绝不能覆盖磁盘上的精确快照。断言「没被改写」收敛不到 waitFor 上
    // (等不到变化),只能给足时间窗;慢 runner 上过短只会漏检、不会误报。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const onDisk = JSON.parse(
      await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'),
    );
    expect(onDisk.pricing.xd['cold-start'].approximate).toBe(false);

    // 也不能把该 scope 标成已 hydrate —— 否则迟到的 prewarm 会被短路挡住,
    // 永远读不回磁盘上最后一份精确报价。
    const hydrated = await getModelPricing();
    expect(hydrated?.xd?.['cold-start']).toMatchObject({ inputPerMtok: 3 });
    // 但它是在「网关不下发价格」故障态下被当作工作副本使用的,必须与内存 retained
    // 路径同款标近似 —— 否则后续计费会以精确账单金额呈现(无 ~ 前缀、无来源说明)。
    expect(hydrated?.xd?.['cold-start']?.approximate).toBe(true);
    // 磁盘本身仍是精确快照,没被这次投影改写。
    const stillPrecise = JSON.parse(
      await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'),
    );
    expect(stillPrecise.pricing.xd['cold-start'].approximate).toBe(false);
  });

  it('recovers a precise snapshot as-is once the catalog carries prices again', async () => {
    replaceGatewayModelPricing([
      { id: 'recovered', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
    ]);

    // 先进入故障态,再让目录恢复正常 —— 故障标记必须被清掉,
    // 否则之后从磁盘恢复的精确报价会被一直说成近似。
    replaceGatewayModelPricing([{ id: 'recovered' }]);
    replaceGatewayModelPricing([
      { id: 'recovered', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
    ]);

    // 写盘是 fire-and-forget,必须等到**内容**落定再断言 —— 只等「文件存在」会在慢
    // runner 上读到上一次写入的中间态甚至半截 JSON(CI 上就这样红过一次)。
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw.pricing.xd.recovered.approximate).toBe(false);
    });

    __resetModelPricingCacheForTesting();
    const hydrated = await getModelPricing();
    expect(hydrated?.xd?.recovered?.approximate).toBe(false);
  });

  it('never persists an approximate retained quote when the disk has no snapshot yet', async () => {
    // 第一轮就有价 → 内存有精确报价;但让写盘还没落地时紧接着来一轮无价。
    // preserveDiskQuotes 的「磁盘已有精确快照就整份保留」分支此时不成立,若继续把
    // retained(approximate)报价写进磁盘,下次 hydrate 会因 validateQuote 整份判无效
    // —— 又回到「无价 = 全链归零」。这一分支只允许落币种事实,报价必须留空。
    replaceGatewayModelPricing([
      { id: 'no-disk-yet', currency: 'USD', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
    ]);
    const retained = replaceGatewayModelPricing([{ id: 'no-disk-yet' }]);
    expect(retained.xd?.['no-disk-yet']?.approximate).toBe(true);

    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      // 磁盘上要么是那份精确快照,要么是空报价 —— 绝不允许出现 approximate 报价。
      const onDisk = raw.pricing?.xd?.['no-disk-yet'];
      expect(onDisk === undefined || onDisk.approximate === false).toBe(true);
      expect(raw.accountCurrency).toBe('USD');
    });
  });

  it('keeps the disk cache parseable under back-to-back syncs', async () => {
    // 写盘全是 fire-and-forget。连续多轮同步(有价 / 无价交替)若并发写同一文件,
    // fs.writeFile 的「截断 + 逐块写」会让读者拿到半截 JSON —— hydrate 那边只能 catch
    // 成缓存失效,冷启动又回到没有报价。串行链 + 原子 rename 必须让文件始终可解析。
    for (let i = 0; i < 8; i += 1) {
      replaceGatewayModelPricing([
        {
          id: 'churn',
          currency: 'USD',
          inputCostPerToken: 0.000003 + i * 1e-9,
          outputCostPerToken: 0.000015,
        },
      ]);
      replaceGatewayModelPricing([{ id: 'churn' }]);
    }

    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw.scope).toBe(expectedScope());
      expect(raw.accountCurrency).toBe('USD');
    });

    // 落盘内容必须能被 hydrate 接受(没有半截 JSON、也没有 approximate 报价)。
    __resetModelPricingCacheForTesting();
    const hydrated = await getModelPricing();
    expect(hydrated).not.toBeNull();
    for (const quote of Object.values(hydrated?.xd ?? {})) {
      expect(quote.approximate).toBe(false);
    }
  });

  it('does not let a mixed-currency catalog open the cold-start retain path', async () => {
    replaceGatewayModelPricing([
      {
        id: 'mixed-guard',
        currency: 'USD',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw.pricing.xd['mixed-guard'].approximate).toBe(false);
    });

    // 混币 + 无价格字段 = 整份不可信,内存与冷启动两条路径都必须拒绝:
    // · 内存:retainKnownGatewayQuotes 不沿用旧报价 → 投影为空;
    // · 冷启动:也不能把「没下发价格」当作留门理由 —— 否则 hydrateFromDisk 会把磁盘上的
    //   精确快照原样恢复(不标近似、不过年龄闸)继续记账,从另一条路绕过混币拒绝。
    __resetModelPricingCacheForTesting();
    expect(
      replaceGatewayModelPricing([
        { id: 'mixed-guard', currency: 'USD' },
        { id: 'other', currency: 'CNY' },
      ]),
    ).toEqual({});

    // 本轮不记账(与本 PR 之前对混币目录的行为一致),token 回退仍显示用量。
    expect(await getModelPricing()).toEqual({});

    // 但磁盘那份仍是可信事实,一个字段都没被覆盖 —— 目录恢复正常后还能用。
    await __flushDiskWritesForTesting();
    const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
    expect(raw.pricing.xd['mixed-guard']).toMatchObject({
      inputPerMtok: 3,
      approximate: false,
    });
  });

  it('stops serving a retained quote once it crosses the age limit while cached', async () => {
    const realAt = Date.parse('2026-07-20T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(realAt);
    replaceGatewayModelPricing([
      { id: 'ages-out', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
    ]);

    // 23h 时来一轮无价 → 仍在窗口内,沿用并进入 cache。
    vi.spyOn(Date, 'now').mockReturnValue(realAt + 23 * 3_600_000);
    expect(replaceGatewayModelPricing([{ id: 'ages-out' }]).xd?.['ages-out']).toMatchObject({
      approximate: true,
    });
    await expect(getModelPricing()).resolves.toMatchObject({
      xd: { 'ages-out': { approximate: true } },
    });

    // 又过 2h(距最后一次真实报价 25h)但**没有**新的 sync —— 目录不周期刷新,断网时
    // 更不会有。若年龄闸只在进入 cache 那一刻跑过一次,这份陈旧价会无限期充当计费基准。
    // 取用时必须复查。
    vi.spyOn(Date, 'now').mockReturnValue(realAt + 25 * 3_600_000);
    await expect(getModelPricing()).resolves.toEqual({});
    await expect(getModelPricingForModel('xd', 'ages-out')).resolves.toEqual({});
  });

  it('treats a future-dated snapshot as unusable instead of permanently fresh', async () => {
    const realAt = Date.parse('2026-07-20T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(realAt);
    replaceGatewayModelPricing([
      { id: 'clock-skew', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
    ]);

    // 时钟回拨(或快照带了未来时间戳):Date.now() - pricedAt 变成负数,
    // 「小于上限」恒成立 —— 若不显式要求 age >= 0,本该停用的陈旧价会一直可用。
    vi.spyOn(Date, 'now').mockReturnValue(realAt - 48 * 3_600_000);
    expect(replaceGatewayModelPricing([{ id: 'clock-skew' }])).toEqual({});
    await expect(getModelPricing()).resolves.toEqual({});
  });

  it('refuses to bill from a disk snapshot that is already too old', async () => {
    const realAt = Date.parse('2026-07-20T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(realAt);
    replaceGatewayModelPricing([
      { id: 'stale-disk', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
    ]);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw.pricing.xd['stale-disk'].approximate).toBe(false);
    });

    // 离线数天后开机:磁盘快照已超龄,而冷启动第一条 /models 又是无价目录。
    // 故障态下把这份陈旧快照当计费基准会绕过 24h 年龄闸 —— 断网时更不会有新的 sync
    // 来重新评估,它会长期充当基准。年龄闸必须在 hydrate 这条路径上同样生效。
    vi.spyOn(Date, 'now').mockReturnValue(realAt + 30 * 3_600_000);
    __resetModelPricingCacheForTesting();
    expect(replaceGatewayModelPricing([{ id: 'stale-disk' }])).toEqual({});
    await expect(getModelPricing()).resolves.toEqual({});
  });

  it('still uses a fresh disk snapshot as an approximate working copy', async () => {
    const realAt = Date.parse('2026-07-20T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(realAt);
    replaceGatewayModelPricing([
      { id: 'fresh-disk', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
    ]);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw.pricing.xd['fresh-disk'].approximate).toBe(false);
    });

    // 同样的冷启动顺序,但快照还在 24h 窗口内 → 照常沿用,并标近似。
    vi.spyOn(Date, 'now').mockReturnValue(realAt + 6 * 3_600_000);
    __resetModelPricingCacheForTesting();
    replaceGatewayModelPricing([{ id: 'fresh-disk' }]);
    const hydrated = await getModelPricing();
    expect(hydrated?.xd?.['fresh-disk']).toMatchObject({
      inputPerMtok: 3,
      approximate: true,
    });
  });

  it('keeps the preserved disk snapshot internally consistent (quotes + currency + age)', async () => {
    __resetActiveLedgerCurrencyForTesting();
    const accountCurrency = EXPECTED_GATEWAY_CURRENCY === 'USD' ? 'CNY' : 'USD';
    replaceGatewayModelPricing([
      {
        id: 'consistent',
        currency: accountCurrency,
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);
    const before = await vi.waitFor(async () =>
      JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8')),
    );
    expect(before.accountCurrency).toBe(accountCurrency);

    // 无价响应通常省略 currency。此前的写法会把「磁盘的 pricing + 本次按构建区域推导的
    // accountCurrency」拼在一起写盘,于是磁盘上出现「旧币种报价 + 新币种账本」这种自相
    // 矛盾的组合,下次 hydrate 出来的金额会被账本守卫整批丢弃。整份保留才对。
    //
    // 这类「证明什么都没发生」的断言收敛不到 waitFor 上(等不到变化),只能给足时间窗:
    // 慢 runner 上 20ms 可能还没轮到那次错误写入,漏检而非误报 —— 留 150ms。
    replaceGatewayModelPricing([{ id: 'consistent' }]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = JSON.parse(
      await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'),
    );
    expect(after).toEqual(before);
  });

  it('leaves the last precise disk snapshot intact on retained rounds', async () => {
    replaceGatewayModelPricing([
      {
        id: 'precise',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
      },
    ]);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw.pricing.xd.precise.approximate).toBe(false);
    });

    // retained 轮不得覆盖磁盘快照:approximate quote 过不了 validateQuote,写进去
    // 会让下次冷启动整份判无效 → 重启后回到「无价 = 全链归零」。
    // 同上:断言「磁盘没被改写」无法用 waitFor 收敛,给足 150ms 时间窗。
    replaceGatewayModelPricing([{ id: 'precise' }]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterRetained = JSON.parse(
      await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'),
    );
    expect(afterRetained.pricing.xd.precise.approximate).toBe(false);

    // 于是冷启动 hydrate 拿回的是那份**精确**报价,而不是丢失全部报价。
    __resetModelPricingCacheForTesting();
    const hydrated = await getModelPricing();
    expect(hydrated?.xd?.precise).toMatchObject({ approximate: false, inputPerMtok: 3 });
  });

  it('hydrates a successful empty pricing snapshot as loaded', async () => {
    replaceGatewayModelPricing([
      {
        id: 'free',
        inputCostPerToken: 0,
        outputCostPerToken: 0,
      },
    ]);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw.pricing).toEqual({});
    });

    __resetModelPricingCacheForTesting();
    await expect(getModelPricing()).resolves.toEqual({});
  });
});

describe('pricing cache lifecycle', () => {
  it('persists the model-sync projection and hydrates it without any network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pricing = replaceGatewayModelPricing([
      {
        id: 'gpt-5.5',
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.00003,
        costDiscount: 0.2,
      },
    ]);

    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw).toMatchObject({
        // 账号币种与报价同快照持久化后升到 8:旧缓存缺少账号币种，
        // 必须靠版本号失效掉。改缓存结构时同步这里。
        version: 8,
        scope: expectedScope(),
        pricing,
      });
    });

    __resetModelPricingCacheForTesting();
    await expect(getModelPricing()).resolves.toEqual(pricing);
    await prewarmModelPricing();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores the active ledger currency when only the disk cache is hydrated', async () => {
    // 模型即使没有可计价 quote，也可能明确声明账号结算币种；两者必须同快照恢复。
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    replaceGatewayModelPricing([
      {
        id: 'gpt-5.5',
        currency: 'USD',
      },
    ]);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw).toMatchObject({
        pricing: {},
        accountCurrency: 'USD',
      });
    });

    // 模拟重启:清掉内存缓存与账本币种，只留磁盘缓存
    __resetModelPricingCacheForTesting();
    __resetActiveLedgerCurrencyForTesting();
    expect(currentLedgerCurrency()).toBe(DEFAULT_USAGE_CURRENCY);

    await expect(getModelPricing()).resolves.toEqual({});

    expect(currentLedgerCurrency()).toBe('USD');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists a startup snapshot under the authenticated user before localDb is ready', async () => {
    mocks.getCurrentDbClientUserId.mockReturnValue(null);
    const pricing = replaceGatewayModelPricing(
      [
        {
          id: 'early-model',
          inputCostPerToken: 0.000001,
          outputCostPerToken: 0.000002,
        },
      ],
      'user-a',
    );

    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw).toMatchObject({
        scope: expectedScope('user-a'),
        pricing,
      });
    });

    mocks.getCurrentDbClientUserId.mockReturnValue('user-a');
    await expect(getModelPricing()).resolves.toEqual(pricing);
  });

  it('does not hydrate another account pricing snapshot', async () => {
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 6,
        scope: expectedScope(),
        fetchedAt: Date.now(),
        pricing: {
          xd: {
            secret: {
              providerId: 'xd',
              modelId: 'secret',
              currency: 'USD',
              source: 'gateway',
              approximate: false,
              inputPerMtok: 1,
              outputPerMtok: 2,
            },
          },
        },
      }),
      'utf8',
    );
    mocks.getCurrentDbClientUserId.mockReturnValue('user-b');

    await expect(getModelPricing()).resolves.toBeNull();
  });

  it('does not hydrate pricing written for an older gateway key identity', async () => {
    replaceGatewayModelPricing([
      {
        id: 'gpt-5.5',
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.00003,
      },
    ]);
    await vi.waitFor(async () => {
      await expect(
        readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'),
      ).resolves.toContain(expectedScope());
    });

    __resetModelPricingCacheForTesting();
    mocks.statSync.mockReturnValue({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 6n,
      ctimeNs: 7n,
    });

    await expect(getModelPricing()).resolves.toBeNull();
  });

  it('rejects malformed or non-gateway disk quotes', async () => {
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 6,
        scope: expectedScope(),
        fetchedAt: Date.now(),
        pricing: {
          xd: {
            bad: {
              providerId: 'xd',
              modelId: 'bad',
              currency: 'USD',
              source: 'subscription-reference',
              approximate: true,
              inputPerMtok: -1,
              outputPerMtok: 2,
            },
          },
        },
      }),
      'utf8',
    );
    await expect(getModelPricing()).resolves.toBeNull();
  });

  it('requires provider identity on accounting lookups', async () => {
    replaceGatewayModelPricing([
      {
        id: 'same-id',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
      },
    ]);
    await expect(getModelPricingForModel('xd', 'same-id')).resolves.toMatchObject({
      xd: { 'same-id': { inputPerMtok: 1, outputPerMtok: 2 } },
    });
    await expect(getModelPricingForModel('openai', 'same-id')).resolves.toMatchObject({
      xd: { 'same-id': { inputPerMtok: 1, outputPerMtok: 2 } },
    });
  });

  it('bounds the accounting-path wait when a model sync hangs', async () => {
    replaceGatewayModelPricing([
      {
        id: 'gpt-x',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
      },
    ]);
    vi.useFakeTimers();
    try {
      // 永不 settle 的同步:黑洞网络下 /models fetch 没有超时。
      trackGatewayModelPricingSync(new Promise(() => {}));
      let settled = false;
      const lookup = getModelPricingForModel('xd', 'gpt-x').then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(lookup).resolves.toMatchObject({
        xd: { 'gpt-x': { inputPerMtok: 1, outputPerMtok: 2 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reference pricing helpers', () => {
  it('returns subscription reference quotes separately from the XD cache', () => {
    expect(getCodexSubscriptionValuePrice('gpt-5.5', null)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      currency: 'USD',
      source: 'subscription-reference',
      approximate: true,
      inputPerMtok: 5,
      outputPerMtok: 30,
      cacheReadPerMtok: 0.5,
    });
    expect(getSubscriptionDirectValuePrice('chatgpt/gpt-5.5')).toMatchObject({
      providerId: 'openai',
      modelId: 'chatgpt/gpt-5.5',
      source: 'subscription-reference',
    });
    expect(getSubscriptionDirectValuePrice('unknown')).toBeUndefined();
  });
});
