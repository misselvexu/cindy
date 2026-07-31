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

    // 这一轮绝不能覆盖磁盘上的精确快照。
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await vi.waitFor(async () => {
      await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8');
    });

    // 先进入故障态,再让目录恢复正常 —— 故障标记必须被清掉,
    // 否则之后从磁盘恢复的精确报价会被一直说成近似。
    replaceGatewayModelPricing([{ id: 'recovered' }]);
    replaceGatewayModelPricing([
      { id: 'recovered', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
    ]);

    __resetModelPricingCacheForTesting();
    const hydrated = await getModelPricing();
    expect(hydrated?.xd?.recovered?.approximate).toBe(false);
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
    replaceGatewayModelPricing([{ id: 'consistent' }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    replaceGatewayModelPricing([{ id: 'precise' }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
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
