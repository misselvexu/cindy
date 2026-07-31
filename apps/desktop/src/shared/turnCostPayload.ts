/**
 * turnCostPayload — `usage:message-turn-cost` 的跨进程 payload 契约。
 *
 * 放在 shared 而不是 main:它是 main → renderer 的协议,两侧都要引用。曾经 main 与
 * preload 声明各写一份,漂移出「main 已放宽为可选、renderer 仍声明必填」的状态,消费方
 * 能在 typecheck 通过的情况下解引用 undefined;而让 renderer 的类型图反向 import main
 * 实现模块又会把 Electron / 数据库 / 调度器副作用拖进 renderer 工具链,违反
 * electron-security-and-process-boundaries.md §2 的分层(shared 只存跨进程协议、类型、
 * 常量和纯函数)。收在这里两个问题一起解决。
 */

import type { RegionalMoney } from './regionalMoney.js';
import type { TurnUsageDetails } from './turnUsageDetails.js';

/**
 * 金额字段整组可选:无报价轮(main 的 recordTurnUsageOnMessage)只带 turnUsageDetails,
 * 消费方据此退回 token 展示;若本用户轮此前已产生费用,则额外带 userTurnMoney 累计
 * (当前无价 segment 不入账,但已花的钱要继续可见)。有金额的轮次这些字段成组出现。
 */
export interface MessageTurnCostPayload {
  sessionId: string;
  /** 该轮最后一条 assistant 的 messages.client_id。 */
  clientId: string;
  turnMoney?: RegionalMoney;
  turnCostUsd?: number;
  turnCostIsEstimate?: boolean;
  /** User-visible cumulative cost from the latest real user prompt through this message. */
  userTurnMoney?: RegionalMoney;
  userTurnCostUsd?: number;
  /** True when any segment in userTurnCostUsd is a subscription-value estimate. */
  userTurnCostIsEstimate?: boolean;
  /** 本轮 token/cache 明细;旧消息或取不到 usage 时缺省。 */
  turnUsageDetails?: TurnUsageDetails;
}
