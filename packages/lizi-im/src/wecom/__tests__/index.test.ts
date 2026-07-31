import { describe, expect, it, vi } from "vitest";

import type { IMHost, IMMessageEvent } from "../../types.js";
import { decodeWecomLane } from "../codec.js";
import { WecomIM } from "../index.js";

type Handler = (payload?: unknown) => void;
type IpcHandler = (payload?: unknown) => Promise<unknown> | unknown;

class FakeClient {
  readonly handlers = new Map<string, Handler[]>();
  readonly sendMessage = vi.fn(async () => ({}));
  readonly sendMediaMessage = vi.fn(async () => ({}));
  readonly replyStream = vi.fn<
    (
      frame: unknown,
      streamId: string,
      content: string,
      finish: boolean,
    ) => Promise<Record<string, never>>
  >(async () => ({}));
  readonly replyMedia = vi.fn(async () => ({}));
  readonly uploadMedia = vi.fn(async () => ({ media_id: "media-1" }));
  readonly downloadFile = vi.fn(async () => ({
    buffer: Buffer.from("image"),
    filename: "photo.jpg",
  }));
  isConnected = false;
  connectError: Error | null = null;

  on(event: string, handler: Handler) {
    const entries = this.handlers.get(event) ?? [];
    entries.push(handler);
    this.handlers.set(event, entries);
    return this;
  }

  connect() {
    if (this.connectError) throw this.connectError;
    this.isConnected = true;
    this.emit("authenticated");
    return this;
  }

  disconnect() {
    this.isConnected = false;
  }

  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

function createHost() {
  const secrets = new Map<string, string>([
    ["wecom-bot-id", "bot-1"],
    ["wecom-bot-secret", "secret-1"],
  ]);
  const broadcasts: unknown[] = [];
  const ipcHandlers = new Map<string, IpcHandler>();
  const host: IMHost = {
    secrets: {
      read: (name) => secrets.get(name) ?? null,
      write: (name, value) => {
        secrets.set(name, value);
        return true;
      },
      remove: (name) => void secrets.delete(name),
      isAvailable: () => true,
    },
    ipc: {
      handle: (channel, handler) => void ipcHandlers.set(channel, handler),
      broadcast: (_channel, payload) => broadcasts.push(payload),
    },
    paths: {
      feishuMediaDir: "unused",
      wecomMediaDir: "unused",
    },
    httpPostForm: async () => ({ status: 200, body: {} }),
  };
  return { host, secrets, broadcasts, ipcHandlers };
}

function message(args: {
  id: string;
  sender: string;
  text: string;
  chatId?: string;
}) {
  return {
    body: {
      msgid: args.id,
      aibotid: "bot-1",
      chattype: args.chatId ? "group" : "single",
      ...(args.chatId ? { chatid: args.chatId } : {}),
      from: { userid: args.sender },
      msgtype: "text",
      text: { content: args.text },
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("WecomIM routing and ownership", () => {
  it("TOFU-binds the first DM sender and only accepts that owner afterwards", async () => {
    const { host, secrets } = createHost();
    const client = new FakeClient();
    const im = new WecomIM(host, {
      clientFactory: () => client as never,
    });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit(
      "message.text",
      message({ id: "m1", sender: "owner", text: "hello" }),
    );
    client.emit(
      "message.text",
      message({ id: "m2", sender: "other", text: "blocked" }),
    );
    await flush();

    expect(secrets.get("wecom-owner-user-id")).toBe("owner");
    expect(received.map((event) => event.text)).toEqual(["hello"]);
  });

  it("routes owner group messages through an encoded lane and active fallback uses chatid", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit(
      "message.text",
      message({
        id: "m-group",
        sender: "owner",
        text: "group task",
        chatId: "chat-123",
      }),
    );
    await flush();

    const lane = received[0]!.senderId;
    expect(decodeWecomLane(lane)).toEqual({
      kind: "group",
      targetId: "chat-123",
    });
    await im.sendMarkdownText(lane, "**ack**");
    expect(client.replyStream).toHaveBeenCalledOnce();

    await im.sendMarkdownText(lane, "**active**");
    expect(client.sendMessage).toHaveBeenCalledWith("chat-123", {
      msgtype: "markdown",
      markdown: { content: "**active**" },
    });
  });

  it("starts a passive stream before the turn and finalizes the same stream", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, {
      clientFactory: () => client as never,
      now: () => 1_000,
    });

    await im.init();
    const frame = message({ id: "m-stream", sender: "owner", text: "task" });
    client.emit("message.text", frame);
    await flush();

    await im.beginReply("owner");
    const streamId = client.replyStream.mock.calls[0]?.[1];
    expect(client.replyStream).toHaveBeenNthCalledWith(
      1,
      frame,
      expect.any(String),
      " ",
      false,
    );

    await im.commitFinal({
      userId: "owner",
      text: "final answer",
      terminal: "done",
    });

    expect(client.replyStream).toHaveBeenNthCalledWith(
      2,
      frame,
      streamId,
      "final answer",
      true,
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to active send after the passive stream safety window", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    let now = 1_000;
    const im = new WecomIM(host, {
      clientFactory: () => client as never,
      now: () => now,
    });

    await im.init();
    client.emit(
      "message.text",
      message({ id: "m-timeout", sender: "owner", text: "long task" }),
    );
    await flush();
    await im.beginReply("owner");
    now += 5 * 60_000;

    await im.commitFinal({
      userId: "owner",
      text: "late answer",
      terminal: "done",
    });

    expect(client.replyStream).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith("owner", {
      msgtype: "markdown",
      markdown: { content: "late answer" },
    });
  });

  it("deduplicates repeated callback message ids", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received = vi.fn();
    im.onMessage(received);

    await im.init();
    const frame = message({ id: "same", sender: "owner", text: "once" });
    client.emit("message.text", frame);
    client.emit("message.text", frame);
    await flush();

    expect(received).toHaveBeenCalledOnce();
  });

  it("surfaces a synchronous SDK startup failure instead of staying connecting", async () => {
    const { host } = createHost();
    const client = new FakeClient();
    client.connectError = new Error("invalid credentials");
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await expect(im.init()).resolves.toBeUndefined();

    expect(im.getStatus()).toEqual({
      kind: "error",
      reason: "invalid credentials",
    });
  });

  it("preserves the concrete authentication failure after retries are exhausted", async () => {
    const { host } = createHost();
    const client = new FakeClient();
    const im = new WecomIM(host, { clientFactory: () => client as never });

    await im.init();
    client.emit(
      "error",
      new Error("Authentication failed: invalid secret (code: 40001)"),
    );
    client.emit(
      "error",
      Object.assign(new Error("Max auth failure attempts exceeded (3)"), {
        code: "WS_AUTH_FAILURE_EXHAUSTED",
      }),
    );

    expect(im.getStatus()).toEqual({
      kind: "error",
      reason: "企业微信鉴权失败：invalid secret (code: 40001)",
    });
  });

  it.each([
    {
      channel: "wecomBot:set-config",
      payload: { botId: "bot-2", secret: "secret-2" },
    },
    { channel: "wecomBot:reconnect", payload: undefined },
    { channel: "wecomBot:disconnect", payload: undefined },
  ])(
    "does not mutate transport through $channel after the account generation changes",
    async ({ channel, payload }) => {
      const { host, secrets, ipcHandlers } = createHost();
      const gate = deferred<void>();
      let active = true;
      let accountToken = 1;
      const accountRun = vi.fn();
      host.accountScope = {
        capture: () => (active ? accountToken : null),
        isCurrent: (token) => active && token === accountToken,
        async run<T>(
          token: unknown,
          operation: () => Promise<T>,
        ): Promise<T> {
          accountRun(token);
          await gate.promise;
          if (!active || token !== accountToken) {
            throw new Error("[IM_NOT_READY] stale account generation");
          }
          return operation();
        },
      };
      const clientFactory = vi.fn(() => new FakeClient() as never);
      const im = new WecomIM(host, { clientFactory });
      im.registerIpc();

      const invoke = ipcHandlers.get(channel);
      expect(invoke).toBeDefined();
      const operation = Promise.resolve(invoke?.(payload));
      await vi.waitFor(() => expect(accountRun).toHaveBeenCalledWith(1));

      active = false;
      accountToken += 1;
      gate.resolve();

      await expect(operation).rejects.toThrow("[IM_NOT_READY]");
      expect(clientFactory).not.toHaveBeenCalled();
      expect(secrets.get("wecom-bot-id")).toBe("bot-1");
      expect(secrets.get("wecom-bot-secret")).toBe("secret-1");
    },
  );

  it("preserves arrival order when media download is slower than a following text message", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    let releaseDownload!: () => void;
    client.downloadFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDownload = () =>
            resolve({ buffer: Buffer.from("image"), filename: "photo.jpg" });
        }),
    );
    host.media = {
      getCachedImage: async () => null,
      cacheImage: async () => ({
        absPath: "C:\\managed\\photo.jpg",
        url: "cindy-media://image",
      }),
      resolveMediaUrl: () => null,
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: string[] = [];
    im.onMessage((event) =>
      received.push(event.text || event.attachments[0]?.kind || "empty"),
    );

    await im.init();
    client.emit("message.image", {
      body: {
        msgid: "image-first",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "image",
        image: { url: "https://example.invalid/image" },
      },
    });
    client.emit(
      "message.text",
      message({ id: "text-second", sender: "owner", text: "second" }),
    );
    await flush();
    expect(received).toEqual([]);

    releaseDownload();
    await flush();
    await flush();
    expect(received).toEqual(["image", "second"]);
  });

  it("routes inbound video bytes through the host media ledger", async () => {
    const { host, secrets } = createHost();
    secrets.set("wecom-owner-user-id", "owner");
    const client = new FakeClient();
    client.downloadFile.mockResolvedValueOnce({
      buffer: Buffer.from("video"),
      filename: "clip.mp4",
    });
    const cacheMedia = vi.fn(async () => ({
      absPath: "C:\\managed\\clip.mp4",
      url: `cindy-media://blobs/${"a".repeat(64)}.mp4`,
      mimeType: "video/mp4",
    }));
    host.media = {
      cacheImage: vi.fn(),
      cacheMedia,
      getCachedImage: vi.fn(async () => null),
      resolveMediaUrl: vi.fn(() => null),
    };
    const im = new WecomIM(host, { clientFactory: () => client as never });
    const received: IMMessageEvent[] = [];
    im.onMessage((event) => received.push(event));

    await im.init();
    client.emit("message.video", {
      body: {
        msgid: "video-1",
        aibotid: "bot-1",
        chattype: "single",
        from: { userid: "owner" },
        msgtype: "video",
        video: { url: "https://example.invalid/video" },
      },
    });
    await flush();
    await flush();

    expect(cacheMedia).toHaveBeenCalledWith({
      integration: "wecom",
      token: "video-1:video",
      buffer: Buffer.from("video"),
      mimeType: "video/mp4",
    });
    expect(received[0]?.attachments).toEqual([
      {
        kind: "file",
        absPath: "C:\\managed\\clip.mp4",
        originalName: "clip.mp4",
        mimeType: "video/mp4",
        url: `cindy-media://blobs/${"a".repeat(64)}.mp4`,
      },
    ]);
  });
});
