import { Hono } from 'hono';
import type { Context } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import {
  getLineAccounts,
  getFriendByLineUserId,
  upsertFriend,
  getChatByFriendId,
  createChat,
  updateChat,
  jstNow,
} from '@line-crm/db';
import type { Friend, LineAccount } from '@line-crm/db';
import { authenticateApiToken } from '../middleware/auth.js';
import { messageToLogPayload } from '../services/step-delivery.js';
import type { Env } from '../index.js';
import {
  getQuotaUsage,
  quotaEnabled,
  quotaConfig,
  estimateSendAudience,
  wouldExceedMonthlyQuota,
} from '../services/quota.js';

/**
 * LINE Messaging API 互換プロキシ。
 *
 * 外部エージェント (Codex / Claude Code / スクリプト等) が LINE API を直接叩くと
 * messages_log に残らず admin UI のチャット履歴から欠落する。このプロキシは
 * ベースURLを `https://api.line.me` → `https://<worker>/line-api` に差し替える
 * だけで送信を messages_log に記録する drop-in 経路を提供する。
 * 通常は source='external'、人間が個別返信する push は
 * X-Line-Harness-Source: manual を付けると source='manual' で記録する。
 *
 * 認証は2系統:
 * 1. チャネルアクセストークン (drop-in 移行用) — line_accounts /
 *    env.LINE_CHANNEL_ACCESS_TOKEN と照合。未登録トークンは 401 (オープンリレー防止)。
 * 2. harness API キー (staff key / env API_KEY) — worker が保持するチャネル
 *    トークンで上流を呼ぶ。エージェントにチャネルトークンを配らずに済むので、
 *    トークンローテーション後はこちらが正規経路。複数アカウント構成では
 *    X-Line-Account-Id ヘッダー (line_accounts.id または channel_id) で送信元を指定。
 *
 * - /line-api/v2/bot/** → api.line.me へ透過転送 (メッセージ以外も可)。
 * - /line-api-data/v2/bot/** → api-data.line.me へ透過転送 (コンテンツ取得等)。
 * - 記録対象: push / multicast / broadcast。reply は replyToken から友だちを
 *   特定できないため転送のみ (reply token は webhook 受信者=worker しか持たない
 *   ので実運用では到達しない)。narrowcast は宛先が確定しないため転送のみ。
 */
const lineProxy = new Hono<Env>();

// LINE message payloads are small (multicast: 500 recipients + 5 messages).
// 1 MiB matches the webhook body cap and bounds memory before upstream fetch.
const MAX_PROXY_BODY_SIZE = 1024 * 1024;

// Non-message bodies can be binary (rich menu image upload — LINE caps it at
// 1 MB). Buffered as ArrayBuffer to preserve bytes; 3 MiB leaves headroom.
const MAX_BINARY_BODY_SIZE = 3 * 1024 * 1024;

// POST endpoints inspected for logging. reply/narrowcast are included so the
// body is parsed as JSON (never binary) and the not-logged warning fires.
const MESSAGE_SEND_PATHS = new Set([
  '/v2/bot/message/push',
  '/v2/bot/message/multicast',
  '/v2/bot/message/broadcast',
  '/v2/bot/message/reply',
  '/v2/bot/message/narrowcast',
]);

// Unknown recipients cost a getProfile subrequest plus ~4 D1 queries each; cap
// them so a multicast full of strangers cannot exhaust the Workers subrequest
// budget. Overflow is skipped WITH a console.warn — never silently.
const MAX_FRIEND_CREATIONS = 20;

// D1 caps bound parameters at ~100 per statement. 8 params per row → 12 rows
// per INSERT keeps each statement legal while packing ~300 rows per db.batch
// subrequest (25 statements), so even large broadcasts stay in budget.
const ROWS_PER_INSERT = 12;
const STATEMENTS_PER_BATCH = 25;

// Chunk size for friend lookups via IN (...) — same 100-bind ceiling.
const LOOKUP_CHUNK = 90;

const AUTH_FAILED = {
  message:
    'Authentication failed. Confirm that the access token in the authorization header is valid.',
};

// push/multicast の宛先のうち friend として記録できるのは実ユーザーのみ。
// group (C…) / room (R…) 宛は friend 行を捏造しないためスキップする。
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

type ParsedSend = { to?: unknown; messages?: unknown };

type ProxyLogSource = 'external' | 'manual';

type LogRow = {
  friendId: string;
  messageType: string;
  content: string;
  deliveryType: string | null;
  lineAccountId: string | null;
};

type ResolvedCaller = {
  /** Channel access token used against api.line.me / api-data.line.me. */
  upstreamToken: string;
  /** line_accounts.id when the channel is DB-registered, else null (env default). */
  lineAccountId: string | null;
  /** Total number of registered accounts — used to scope broadcast logging. */
  accountCount: number;
};

function bearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function asMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is Message => !!m && typeof m === 'object' && 'type' in m);
}

/**
 * Resolve the caller to a channel. Channel tokens are matched against
 * line_accounts / env (drop-in mode); harness API keys (staff key / env
 * API_KEY) map to a channel via X-Line-Account-Id, the single active account,
 * or the env default token. Returns a Response on auth/validation failure.
 */
async function resolveCaller(c: Context<Env>, token: string): Promise<ResolvedCaller | Response> {
  const accounts = await getLineAccounts(c.env.DB);
  const active = accounts.filter((a) => a.is_active);

  const byChannelToken = active.find((a) => a.channel_access_token === token);
  if (byChannelToken) {
    return {
      upstreamToken: token,
      lineAccountId: byChannelToken.id,
      accountCount: active.length,
    };
  }
  if (token === c.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { upstreamToken: token, lineAccountId: null, accountCount: active.length };
  }

  // harness API キー経路 — worker 側でチャネルトークンを解決する。
  const staff = await authenticateApiToken(c, token);
  if (!staff) return c.json(AUTH_FAILED, 401);

  const requestedId = c.req.header('X-Line-Account-Id');
  let account: LineAccount | undefined;
  if (requestedId) {
    account = active.find((a) => a.id === requestedId || a.channel_id === requestedId);
    if (!account) {
      return c.json({ message: `Unknown X-Line-Account-Id: ${requestedId}` }, 400);
    }
  } else if (active.length === 1) {
    account = active[0];
  } else if (active.length > 1) {
    return c.json(
      { message: 'Multiple LINE accounts registered — set the X-Line-Account-Id header' },
      400,
    );
  }

  if (account) {
    return {
      upstreamToken: account.channel_access_token,
      lineAccountId: account.id,
      accountCount: active.length,
    };
  }
  if (c.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return {
      upstreamToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
      lineAccountId: null,
      accountCount: active.length,
    };
  }
  return c.json({ message: 'No LINE account configured' }, 400);
}

/**
 * Number of multicast recipients that have no friends row yet (unique ids,
 * counted in IN-clause chunks of ≤100 binds — the D1 parameter cap; a typical
 * multicast of up to 100 recipients is a single SELECT).
 */
async function countUnknownRecipients(db: D1Database, userIds: string[]): Promise<number> {
  const unique = [...new Set(userIds.filter((u): u is string => typeof u === 'string'))];
  let known = 0;
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const row = await db
      .prepare(
        `SELECT COUNT(DISTINCT line_user_id) as count FROM friends WHERE line_user_id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .bind(...chunk)
      .first<{ count: number }>();
    known += row?.count ?? 0;
  }
  return unique.length - known;
}

/** Look up friends for a set of userIds in IN-clause chunks (≤100 binds each). */
async function getFriendsByLineUserIds(
  db: D1Database,
  userIds: string[],
): Promise<Map<string, Friend>> {
  const found = new Map<string, Friend>();
  for (let i = 0; i < userIds.length; i += LOOKUP_CHUNK) {
    const chunk = userIds.slice(i, i + LOOKUP_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db
      .prepare(`SELECT * FROM friends WHERE line_user_id IN (${placeholders})`)
      .bind(...chunk)
      .all<Friend>();
    for (const row of result.results ?? []) {
      found.set(row.line_user_id, row);
    }
  }
  return found;
}

/**
 * Create a friend row for a recipient we have never seen. Mirrors
 * ensureFriendFromWebhookUser (webhook.ts) except that line_account_id is only
 * set on newly created rows — an outgoing push must not rebind an existing
 * friend's account attribution.
 */
async function createFriendForRecipient(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null,
): Promise<Friend | null> {
  try {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('[line-proxy] getProfile failed for', userId, err);
    }

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    if (lineAccountId) {
      await db
        .prepare(
          'UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id IS NULL',
        )
        .bind(lineAccountId, friend.id)
        .run();
    }
    return friend;
  } catch (err) {
    console.error('[line-proxy] friend creation failed for', userId, err);
    return null;
  }
}

/** Multi-row INSERT keeps large broadcasts within the D1 subrequest budget. */
async function insertLogRows(
  db: D1Database,
  rows: LogRow[],
  source: ProxyLogSource,
): Promise<void> {
  if (rows.length === 0) return;
  const now = jstNow();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const values = chunk
      .map(() => `(?, ?, 'outgoing', ?, ?, NULL, NULL, ?, ?, ?, ?)`)
      .join(', ');
    const params = chunk.flatMap((row) => [
      crypto.randomUUID(),
      row.friendId,
      row.messageType,
      row.content,
      row.deliveryType,
      source,
      row.lineAccountId,
      now,
    ]);
    statements.push(
      db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
           VALUES ${values}`,
        )
        .bind(...params),
    );
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
  }
}

/** 1:1 push は operator 手動送信と同じ扱いでチャットを更新する (chats.ts:608 と同型)。 */
async function touchChat(db: D1Database, friendId: string): Promise<void> {
  const chat = (await getChatByFriendId(db, friendId)) ?? (await createChat(db, { friendId }));
  await updateChat(db, chat.id, { status: 'in_progress', lastMessageAt: jstNow() });
}

/**
 * Record a successfully forwarded send into messages_log. Never throws: the
 * upstream send already happened, so a logging failure must not turn the
 * caller's 200 into an error (it would trigger client retries = double sends).
 */
async function logProxySend(
  db: D1Database,
  caller: ResolvedCaller,
  path: string,
  rawBody: string,
  source: ProxyLogSource,
): Promise<void> {
  try {
    const parsed = JSON.parse(rawBody) as ParsedSend;
    const messages = asMessages(parsed.messages);
    if (messages.length === 0) return;
    const payloads = messages.map(messageToLogPayload);
    const lineClient = new LineClient(caller.upstreamToken);
    const { lineAccountId } = caller;
    const rowsFor = (friendId: string, deliveryType: string | null): LogRow[] =>
      payloads.map((p) => ({
        friendId,
        messageType: p.messageType,
        content: p.content,
        deliveryType,
        lineAccountId,
      }));

    if (path === '/v2/bot/message/push' && typeof parsed.to === 'string') {
      if (!LINE_USER_ID_RE.test(parsed.to)) {
        console.warn(`[line-proxy] push to non-user target not logged: ${parsed.to.slice(0, 4)}…`);
        return;
      }
      const friend =
        (await getFriendByLineUserId(db, parsed.to)) ??
        (await createFriendForRecipient(db, lineClient, parsed.to, lineAccountId));
      if (!friend) return;
      await insertLogRows(db, rowsFor(friend.id, 'push'), source);
      await touchChat(db, friend.id);
      return;
    }

    if (path === '/v2/bot/message/multicast' && Array.isArray(parsed.to)) {
      const userIds = [
        ...new Set(
          parsed.to.filter((t): t is string => typeof t === 'string' && LINE_USER_ID_RE.test(t)),
        ),
      ];
      const known = await getFriendsByLineUserIds(db, userIds);
      const rows: LogRow[] = [];
      let created = 0;
      let skipped = 0;
      for (const userId of userIds) {
        let friend = known.get(userId) ?? null;
        if (!friend) {
          if (created >= MAX_FRIEND_CREATIONS) {
            skipped++;
            continue;
          }
          created++;
          friend = await createFriendForRecipient(db, lineClient, userId, lineAccountId);
        }
        if (friend) rows.push(...rowsFor(friend.id, 'push'));
      }
      if (skipped > 0) {
        console.warn(
          `[line-proxy] multicast: ${skipped} unknown recipients not logged (friend-creation cap ${MAX_FRIEND_CREATIONS})`,
        );
      }
      await insertLogRows(db, rows, source);
      return;
    }

    if (path === '/v2/bot/message/broadcast') {
      // A LINE broadcast reaches the followers of ONE channel. Scope the log
      // to that channel's friends; with a single registered account the whole
      // friends table belongs to it (legacy rows may carry NULL account_id).
      let friendIds: string[] = [];
      if (caller.accountCount <= 1 && lineAccountId) {
        // Single active account: legacy rows may carry NULL account_id, but
        // rows pinned to a deactivated account are not this channel's followers.
        const result = await db
          .prepare(
            'SELECT id FROM friends WHERE is_following = 1 AND (line_account_id = ? OR line_account_id IS NULL)',
          )
          .bind(lineAccountId)
          .all<{ id: string }>();
        friendIds = (result.results ?? []).map((r) => r.id);
      } else if (caller.accountCount <= 1) {
        const result = await db
          .prepare('SELECT id FROM friends WHERE is_following = 1')
          .all<{ id: string }>();
        friendIds = (result.results ?? []).map((r) => r.id);
      } else if (lineAccountId) {
        // Legacy NULL-account rows receive this channel's broadcast too, so
        // include them — matching the projection population
        // (estimateSendAudience). On multi-account installs a NULL row is
        // thus logged for every account's broadcast; over-recording is the
        // safe direction for a limiting feature, and an account-only filter
        // would make recorded usage drift below reality on every send.
        const result = await db
          .prepare(
            'SELECT id FROM friends WHERE is_following = 1 AND (line_account_id = ? OR line_account_id IS NULL)',
          )
          .bind(lineAccountId)
          .all<{ id: string }>();
        friendIds = (result.results ?? []).map((r) => r.id);
      } else {
        // Multi-account install + unregistered env token: the recipient set is
        // unknowable, and logging every friend would fabricate sends on other
        // accounts' timelines. Register the account to get broadcast logging.
        console.warn(
          '[line-proxy] broadcast not logged: env token is not registered in line_accounts and multiple accounts exist',
        );
        return;
      }
      // delivery_type stays NULL (not 'broadcast') on purpose: the monthly quota
      // count in line-accounts.ts matches LINE's "delivered messages" dashboard
      // via `delivery_type IS NULL OR = 'push'`, and a broadcast counts toward
      // that quota. Tagging these would silently undercount the month. Use
      // source='external' plus broadcast_id to tell broadcasts apart instead.
      const rows = friendIds.flatMap((friendId) => rowsFor(friendId, null));
      await insertLogRows(db, rows, source);
      console.log(`[line-proxy] broadcast logged for ${friendIds.length} friends`);
      return;
    }

    if (path === '/v2/bot/message/reply' || path === '/v2/bot/message/narrowcast') {
      console.warn(
        `[line-proxy] ${path} forwarded but not logged (recipient cannot be resolved)`,
      );
    }
  } catch (err) {
    console.error('[line-proxy] logProxySend failed:', err);
  }
}

function proxyHandler(prefix: string, upstreamBase: string, logSends: boolean) {
  return async (c: Context<Env>): Promise<Response> => {
    const url = new URL(c.req.url);
    const encodedPath = url.pathname.slice(prefix.length);
    // Percent-encoded paths (/%70ush) must not dodge the message-send check —
    // LINE decodes them upstream, so match against the decoded form.
    let path: string;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      return c.json({ message: 'Not found' }, 404);
    }
    if (!path.startsWith('/v2/bot/') || !encodedPath.startsWith('/v2/bot/')) {
      return c.json({ message: 'Not found' }, 404);
    }

    const token = bearerToken(c.req.header('Authorization'));
    if (!token) return c.json(AUTH_FAILED, 401);

    // Resolve the token to a known channel or harness key. Unknown tokens are
    // rejected so the worker cannot be used as an open relay.
    const caller = await resolveCaller(c, token);
    if (caller instanceof Response) return caller;

    const method = c.req.method.toUpperCase();
    const isMessageSend = logSends && method === 'POST' && MESSAGE_SEND_PATHS.has(path);

    // Proxy 経由の自動送信と、人間が行う個別返信を区別する。未指定は従来どおり
    // external。manual は 1:1 push だけに限定し、一斉配信で未対応をまとめて消す
    // 事故を防ぐ。独自ヘッダーは上流 LINE API には転送しない。
    const requestedSource = c.req.header('X-Line-Harness-Source');
    let logSource: ProxyLogSource = 'external';
    if (isMessageSend && requestedSource) {
      if (requestedSource !== 'manual') {
        return c.json({ message: 'X-Line-Harness-Source must be manual' }, 400);
      }
      if (path !== '/v2/bot/message/push') {
        return c.json(
          { message: 'X-Line-Harness-Source: manual is only supported for push messages' },
          400,
        );
      }
      logSource = 'manual';
    }

    // Message sends are buffered as text (needed for log parsing). Everything
    // else is buffered as raw bytes — e.g. rich menu image upload is binary
    // and text-decoding it would corrupt the payload.
    let rawBody: string | undefined;
    let binaryBody: ArrayBuffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const cap = isMessageSend ? MAX_PROXY_BODY_SIZE : MAX_BINARY_BODY_SIZE;
      const declared = Number.parseInt(c.req.header('Content-Length') ?? '', 10);
      if (Number.isFinite(declared) && declared > cap) {
        return c.json({ message: 'Payload too large' }, 413);
      }
      if (isMessageSend) {
        rawBody = await c.req.text();
        if (new TextEncoder().encode(rawBody).byteLength > cap) {
          return c.json({ message: 'Payload too large' }, 413);
        }
      } else {
        binaryBody = await c.req.arrayBuffer();
        if (binaryBody.byteLength > cap) {
          return c.json({ message: 'Payload too large' }, 413);
        }
      }
    }

    // Usage-limit gate for the two bulk-send endpoints only. Proxy sends are
    // recorded in messages_log (they count toward the tally), so they get the
    // same fences as the built-in send paths: refuse while over a limit, and
    // refuse a send whose projection (recipient count for multicast, follower
    // count for broadcast) would cross the monthly limit. 1:1 push and reply
    // pass through untouched — one-to-one conversations are never paused.
    // With no limits configured this adds zero queries. The error shape
    // mirrors the LINE API's own limit response so existing clients handle it.
    if (
      isMessageSend
      && (path === '/v2/bot/message/broadcast'
        || path === '/v2/bot/message/multicast'
        || path === '/v2/bot/message/narrowcast')
      && quotaEnabled(c.env)
    ) {
      const usage = await getQuotaUsage(c.env.DB, c.env);
      let estimate: number | null = null;
      if (usage.monthlyMessages.max > 0) {
        // Narrowcast: LINE resolves the audience server-side (demographic /
        // audience-group targeting), so the worker can neither project the
        // recipient count nor record the send — logProxySend only warns. A
        // bulk send whose usage cannot be recorded is not allowed while a
        // monthly limit is active; without one it passes through as before.
        if (path === '/v2/bot/message/narrowcast') {
          return c.json(
            { message: 'Sends without a determinable recipient list are not available while send limits are active.' },
            429,
          );
        }
        // A broadcast from an unregistered env token on a multi-account
        // install is exactly the case logProxySend refuses to log (the
        // recipient set is unknowable). A send whose usage cannot be recorded
        // cannot be allowed while a monthly limit is active — it would never
        // count toward the tally. Register the channel to send broadcasts.
        if (
          path === '/v2/bot/message/broadcast'
          && caller.lineAccountId === null
          && caller.accountCount > 1
        ) {
          return c.json({ message: 'Broadcast requires a registered channel account.' }, 429);
        }
        // logProxySend inserts one row per recipient per message, so the
        // projection multiplies the audience by the messages array length
        // (LINE allows 1–5 per request). A missing/empty/non-array messages
        // field falls back to 1 — the upstream rejects such payloads anyway.
        let toList: unknown[] | null = null;
        let messageCount = 1;
        try {
          const parsed = JSON.parse(rawBody ?? '{}') as { to?: unknown; messages?: unknown };
          if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
            messageCount = parsed.messages.length;
          }
          if (Array.isArray(parsed.to)) toList = parsed.to;
        } catch {
          // malformed body — no projection, let upstream reject it
        }
        if (path === '/v2/bot/message/multicast') {
          estimate = toList === null ? null : toList.length * messageCount;
          // logProxySend stops creating friend rows for unknown recipients at
          // MAX_FRIEND_CREATIONS — anyone beyond the cap would be sent to but
          // never recorded. A send whose usage cannot be fully recorded is not
          // allowed while a monthly limit is active, so refuse when more
          // recipients are unregistered than logging can register. Sends with
          // at most MAX_FRIEND_CREATIONS recipients can never exceed the cap,
          // so they skip the COUNT entirely.
          if (toList && toList.length > MAX_FRIEND_CREATIONS) {
            const unknown = await countUnknownRecipients(c.env.DB, toList as string[]);
            if (unknown > MAX_FRIEND_CREATIONS) {
              return c.json({ message: 'Too many unregistered recipients.' }, 429);
            }
          }
        } else {
          const followers = await estimateSendAudience(c.env.DB, {
            target_type: 'all',
            line_account_id: caller.lineAccountId,
          } as { target_type: string });
          estimate = followers === null ? null : followers * messageCount;
        }
      }
      if (usage.exceeded || wouldExceedMonthlyQuota(usage, estimate)) {
        return c.json({ message: 'You have reached your monthly limit.' }, 429);
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${caller.upstreamToken}`,
    };
    const contentType = c.req.header('Content-Type');
    if (contentType) headers['Content-Type'] = contentType;
    const retryKey = c.req.header('X-Line-Retry-Key');
    if (retryKey) headers['X-Line-Retry-Key'] = retryKey;

    let upstream: Response;
    try {
      upstream = await fetch(`${upstreamBase}${encodedPath}${url.search}`, {
        method,
        headers,
        body: rawBody ?? binaryBody,
      });
    } catch (err) {
      console.error('[line-proxy] upstream fetch failed:', err);
      return c.json({ message: 'Upstream request failed' }, 502);
    }

    if (isMessageSend && upstream.ok && rawBody) {
      // Log in the background where possible: a multicast to hundreds of
      // friends must not delay the client response (timeout → client retry →
      // double send). Falls back to inline await outside a Workers runtime.
      //
      // Exception: while a monthly send limit is active, bulk sends
      // (broadcast/multicast) are logged BEFORE the response returns. With
      // background logging, a client firing sequential bulk sends could pass
      // the next request's gate before the previous rows landed — awaiting
      // here makes each 200 mean "already counted", at the cost of added
      // response latency for these two endpoints only. 1:1 push and reply
      // keep background logging (they are never gated). Truly concurrent
      // parallel requests remain a bounded residue (rate limiting caps the
      // burst width).
      const logging = logProxySend(c.env.DB, caller, path, rawBody, logSource);
      const awaitBeforeResponse =
        (path === '/v2/bot/message/broadcast' || path === '/v2/bot/message/multicast')
        && quotaConfig(c.env).monthlyMessagesMax > 0;
      if (awaitBeforeResponse) {
        await logging;
      } else {
        try {
          c.executionCtx.waitUntil(logging);
        } catch {
          await logging;
        }
      }
    }

    const responseHeaders = new Headers();
    for (const name of [
      'content-type',
      'x-line-request-id',
      'x-line-accepted-request-id',
      'retry-after',
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    // Stream the body through — api-data downloads (images, video) can be
    // large binary; buffering them as text would corrupt and bloat memory.
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  };
}

lineProxy.all('/line-api/*', proxyHandler('/line-api', 'https://api.line.me', true));
lineProxy.all('/line-api-data/*', proxyHandler('/line-api-data', 'https://api-data.line.me', false));

export { lineProxy };
