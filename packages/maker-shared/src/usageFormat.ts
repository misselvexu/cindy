/**
 * usageFormat — 用量数字展示的共享口径(desktop 与 mobile 共用一份)。
 *
 * 消息底部那一格在拿不到金额时退回显示本轮 token,两端必须给出同一个数字形态
 * —— 各写一份必然漂移(同一轮在桌面读作 2.1M、在手机读作 2,097k 就无从核对)。
 */

/** 紧凑 token 数: ≥1B 用 X.XB, ≥1M 用 X.XM, ≥1k 用 X.Xk, 否则原值。 */
export function formatCompactTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
