import type { InteractionRequest } from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';

import { formatWecomInteractionPrompt } from '../textInteractions';

function permissionRequest(input: Record<string, unknown>): InteractionRequest {
  return {
    kind: 'permission',
    requestId: 'permission-1',
    toolName: 'Bash',
    displayName: '运行命令',
    input,
  };
}

describe('formatWecomInteractionPrompt', () => {
  it('在允许用户审批前展示工具参数', () => {
    const prompt = formatWecomInteractionPrompt(
      permissionRequest({
        command: 'pnpm test',
        path: 'D:\\workspace\\cindy',
      }),
    );

    expect(prompt).toContain('需要确认工具“运行命令”');
    expect(prompt).toContain('"command": "pnpm test"');
    expect(prompt).toContain('"path": "D:\\\\workspace\\\\cindy"');
    expect(prompt).toContain('回复“允许”执行一次');
  });

  it('截断过长参数，避免审批提示无限增长', () => {
    const prompt = formatWecomInteractionPrompt(
      permissionRequest({ payload: 'x'.repeat(2_000) }),
    );

    expect(prompt).toContain('…（已截断）');
    expect(prompt).not.toContain('x'.repeat(1_000));
    expect(prompt.length).toBeLessThan(1_100);
  });

  it('参数无法序列化时显示明确占位', () => {
    const input: Record<string, unknown> = {};
    input.self = input;

    expect(formatWecomInteractionPrompt(permissionRequest(input))).toContain('<无法序列化>');
  });
});
