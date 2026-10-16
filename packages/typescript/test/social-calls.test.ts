import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { HttpApi } from '../src/api/http.js';
import type { ApiNote, ApiNotesPage, MercurifiApi } from '../src/api/types.js';
import { InvalidInputError } from '../src/errors.js';
import { LOCAL_CHAIN_ID } from '../src/networks.js';
import { buildSignInMessage, type SignInKind } from '../src/signin.js';
import { localKey } from '../src/signers.js';
import { mockAccount } from './helpers/account.js';
import { A, ACCOUNT, AGENT_KEY, localClient, localRpc, OWNER_KEY, TOKEN } from './helpers/local.js';
import { fakeSocialApi } from './helpers/socialApi.js';

const NOTE: ApiNote = {
  id: 7,
  address: ACCOUNT,
  side: 'bullish',
  holdBps: null,
  body: 'volume picking up',
  createdAt: 1_790_000_000,
  replyCount: 0,
  agreeCount: 0,
  agreed: false,
  agent: true,
};

const page = (n: number): ApiNotesPage => ({ notes: [{ ...NOTE, id: n }], nextCursor: null });

/** The social routes as vi.fns over the sign-in fake (real clock, the local chain id), plus a stream request. */
const fakeApi = () => {
  const social = fakeSocialApi({ chainId: LOCAL_CHAIN_ID, now: Date.now });

  return {
    ...social,
    baseUrl: 'http://127.0.0.1:9',
    streamRequest: vi.fn((topics: readonly string[]) => ({
      url: `http://127.0.0.1:9/v1/stream?topics=${topics.join(',')}`,
      headers: {},
    })),
    putReaction: vi.fn(async () => undefined),
    postNote: vi.fn(async (_t: Address, body: string) => ({ ...NOTE, body })),
    postReply: vi.fn(async (id: number, body: string) => ({ ...NOTE, id: id + 1, body })),
    agree: vi.fn(async () => undefined),
    report: vi.fn(async () => undefined),
    deleteNote: vi.fn(async () => undefined),
    listNotes: vi.fn(async () => page(1)),
    listReplies: vi.fn(async () => page(2)),
    getNote: vi.fn(async () => NOTE),
    noteMarks: vi.fn(async () => []),
    getReactions: vi.fn(async () => ({
      counts: { bullish: 1 },
      total: 1,
      holders: 1,
      mine: null,
      selected: [],
      brandLookalike: false,
    })),
    getPosting: vi.fn(async () => ({ enabled: true, updatedAt: null })),
    setPosting: vi.fn(async (_a: Address, enabled: boolean, _b: string) => ({
      enabled,
      updatedAt: 1,
    })),
    deleteAgentNotes: vi.fn(async () => ({ deleted: 3 })),
  };
};

const clientWith = async (api: MercurifiApi | null) => {
  const rpc = localRpc();

  mockAccount(rpc, { owner: A(0x99), agent: localKey(AGENT_KEY).address });

  return localClient(rpc, { api });
};

const clientWithFakeApi = async () => {
  const api = fakeApi();

  const mf = await clientWith(api as unknown as MercurifiApi);

  return { mf, api };
};

const sse = (text: string) =>
  vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(text));
            c.close();
          },
        }),
        { status: 200 },
      ),
  );

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

/** An SSE response the test writes to chunk by chunk. */
const liveSse = () => {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });

  return {
    // Like a real fetch, an aborted request errors its body.
    fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => ctl.error(new Error('aborted')));
      return new Response(stream, { status: 200 });
    }),
    push: (text: string) => ctl.enqueue(new TextEncoder().encode(text)),
    end: () => ctl.close(),
  };
};

/** listNotes calls that wait for the test; each answers with the page id `version` held when it was called. */
const deferredList = (api: ReturnType<typeof fakeApi>) => {
  const waiting: (() => void)[] = [];

  const state = {
    version: 0,
    calls: 0,
    resolve: () => waiting.shift()!(),
  };

  api.listNotes.mockImplementation(() => {
    state.calls += 1;
    const v = state.version;
    return new Promise<ApiNotesPage>((r) => waiting.push(() => r(page(v))));
  });

  return state;
};

describe('agent social calls', () => {
  it('signals and posts as the account through one session', async () => {
    const { mf, api } = await clientWithFakeApi();

    const agent = await mf.agent({ account: ACCOUNT, signer: localKey(AGENT_KEY) });

    await agent.signal(TOKEN, 'bullish');

    const note = await agent.notes.post(TOKEN, 'volume picking up');

    expect(api.putReaction).toHaveBeenCalledWith(TOKEN, 'bullish', 'bearer-1');

    expect(api.postNote).toHaveBeenCalledWith(TOKEN, 'volume picking up', 'bearer-1');

    expect(api.signIn).toHaveBeenCalledTimes(1);

    expect(api.signInChallenge).toHaveBeenCalledWith('agent', ACCOUNT, localKey(AGENT_KEY).address);

    expect(note.agent).toBe(true);
  });

  it('clears only the signal, side by side, never every reaction', async () => {
    const { mf, api } = await clientWithFakeApi();

    const agent = await mf.agent({ account: ACCOUNT, signer: localKey(AGENT_KEY) });

    await agent.signal(TOKEN, null);

    expect(api.putReaction.mock.calls).toEqual([
      [TOKEN, 'bullish', 'bearer-1', false],
      [TOKEN, 'bearish', 'bearer-1', false],
    ]);

    await agent.react(TOKEN, 'rocket');

    await agent.react(TOKEN, 'rocket', false);

    expect(api.putReaction).toHaveBeenNthCalledWith(3, TOKEN, 'rocket', 'bearer-1', true);

    expect(api.putReaction).toHaveBeenNthCalledWith(4, TOKEN, 'rocket', 'bearer-1', false);

    await expect(agent.signal(TOKEN, 'rocket' as never)).rejects.toThrow(InvalidInputError);
  });

  it('refuses a body over 280 characters before any request', async () => {
    const { mf, api } = await clientWithFakeApi();

    const agent = await mf.agent({ account: ACCOUNT, signer: localKey(AGENT_KEY) });

    await expect(agent.notes.post(TOKEN, 'x'.repeat(281))).rejects.toThrow(/280/);

    await expect(agent.notes.reply(7, '   ')).rejects.toThrow(InvalidInputError);

    expect(api.signInChallenge).not.toHaveBeenCalled();
  });

  it('replies, agrees, reports, deletes and signs out with the same bearer', async () => {
    const { mf, api } = await clientWithFakeApi();

    const agent = await mf.agent({ account: ACCOUNT, signer: localKey(AGENT_KEY) });

    expect((await agent.notes.reply(7, '  not so sure ')).body).toBe('not so sure');

    await agent.notes.agree(7);

    await agent.notes.agree(7, false);

    await agent.notes.report(7);

    await agent.notes.delete(8);

    expect(api.postReply).toHaveBeenCalledWith(7, 'not so sure', 'bearer-1');

    expect(api.agree.mock.calls).toEqual([
      [7, true, 'bearer-1'],
      [7, false, 'bearer-1'],
    ]);

    expect(api.report).toHaveBeenCalledWith(7, 'bearer-1');

    expect(api.deleteNote).toHaveBeenCalledWith(8, 'bearer-1');

    expect(api.signIn).toHaveBeenCalledTimes(1);

    await agent.signOut();

    expect(api.signOut).toHaveBeenCalledWith('bearer-1');
  });

  it('rejects, not throws, on a chain-only client', async () => {
    const mf = await clientWith(null);

    const agent = await mf.agent({ account: ACCOUNT, signer: localKey(AGENT_KEY) });

    const call = agent.notes.post(TOKEN, 'hello');

    await expect(call).rejects.toThrow(InvalidInputError);

    await expect(agent.signal(TOKEN, 'bullish')).rejects.toThrow(InvalidInputError);

    await expect(mf.notes.list(TOKEN)).rejects.toThrow(InvalidInputError);

    await expect(mf.owner(localKey(OWNER_KEY)).agentPosting(ACCOUNT)).rejects.toThrow(
      InvalidInputError,
    );
  });

  it('sends the bearer and never the API key on a keyed client', async () => {
    const signer = localKey(AGENT_KEY);

    const seen: { method: string; path: string; headers: Record<string, string> }[] = [];

    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;

      const method = init?.method ?? 'GET';

      seen.push({ method, path, headers: { ...(init?.headers as Record<string, string>) } });

      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

      if (path === '/v1/agent-auth/nonce') {
        const b = JSON.parse(String(init?.body)) as {
          kind: SignInKind;
          account: Address;
          signer: Address;
        };

        const nonce = 'ab'.repeat(16);

        const t = Date.now();

        return json({
          nonce,
          message: buildSignInMessage(
            { ...b, chainId: LOCAL_CHAIN_ID, service: 'launch' },
            nonce,
            new Date(t),
            new Date(t + 300_000),
          ),
          issuedAt: Math.floor(t / 1000),
          expiresAt: Math.floor(t / 1000) + 300,
        });
      }

      if (path === '/v1/agent-auth/session')
        return json({
          token: 'session-token-1',
          kind: 'agent',
          account: ACCOUNT,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        });

      return new Response('', { status: 200 });
    });

    const api = new HttpApi({
      baseUrl: 'http://127.0.0.1:9',
      chainId: LOCAL_CHAIN_ID,
      apiKey: 'mfk_test_secretkey',
      fetch,
    });

    const mf = await clientWith(api);

    const agent = await mf.agent({ account: ACCOUNT, signer });

    await agent.signal(TOKEN, 'bearish');

    const write = seen.find((r) => r.method === 'PUT')!;

    expect(write.path).toBe(`/v1/tokens/${TOKEN}/reactions`);

    expect(write.headers.Authorization).toBe('Bearer session-token-1');

    for (const r of seen) expect(r.headers['X-Api-Key']).toBeUndefined();
  });
});

describe('reader calls', () => {
  it('reads without a session', async () => {
    const { mf, api } = await clientWithFakeApi();

    await mf.notes.list(TOKEN);

    await mf.notes.replies(7, { limit: 5 });

    await mf.notes.get(7);

    await mf.notes.marks(TOKEN, { from: 10, to: 20 });

    await mf.reactions(TOKEN);

    expect(api.listNotes).toHaveBeenCalledWith(TOKEN, {});

    expect(api.listReplies).toHaveBeenCalledWith(7, { limit: 5 });

    expect(api.getNote).toHaveBeenCalledWith(7);

    expect(api.noteMarks).toHaveBeenCalledWith(TOKEN, 10, 20);

    expect(api.getReactions).toHaveBeenCalledWith(TOKEN);

    expect(api.signInChallenge).not.toHaveBeenCalled();
  });

  it('follows notes: fetches at once and on open, refetches on notes and reset, coalescing a burst', async () => {
    const { mf, api } = await clientWithFakeApi();

    const list = deferredList(api);

    const s = liveSse();

    const onOpen = vi.fn();

    const pages: number[] = [];

    const done = mf.onNotes(TOKEN, (p) => pages.push(p.notes[0]!.id), {
      fetch: s.fetch,
      maxReconnects: 0,
      onOpen,
    });

    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    expect(list.calls).toBe(1); // the open is queued behind the first fetch

    s.push('id: 1\nevent: notes\ndata: {}\n\nid: 2\nevent: trade\ndata: {}\n\n');

    s.push('id: 3\nevent: notes\ndata: {}\n\nid: 4\nevent: reset\ndata: {}\n\n');

    await tick();

    list.version = 1;

    list.resolve();

    await vi.waitFor(() => expect(list.calls).toBe(2)); // the whole burst became one refetch

    list.resolve();

    await tick();

    expect(list.calls).toBe(2);

    s.end();

    await done;

    expect(pages).toEqual([0, 1]);

    expect(api.streamRequest).toHaveBeenCalledWith([`token:${TOKEN.toLowerCase()}`]);
  });

  it.each(Array.from({ length: 16 }, (_, k) => k))(
    'never drops an event that lands %i microtasks around the end of a refetch',
    async (k) => {
      const { mf, api } = await clientWithFakeApi();

      const list = deferredList(api);

      const s = liveSse();

      const onOpen = vi.fn();

      const pages: number[] = [];

      const done = mf.onNotes(TOKEN, (p) => pages.push(p.notes[0]!.id), {
        fetch: s.fetch,
        maxReconnects: 0,
        onOpen,
      });

      await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

      list.resolve(); // the first fetch; the fetch queued by the open starts

      await vi.waitFor(() => expect(list.calls).toBe(2));

      // That fetch read version 0. A new note arrives while it finishes: its event must cause one more fetch.
      list.version = 1;

      s.push('id: 1\nevent: notes\ndata: {}\n\n');

      for (let i = 0; i < k; i += 1) await Promise.resolve();

      list.resolve();

      await vi.waitFor(() => expect(list.calls).toBe(3));

      list.resolve();

      s.end();

      await done;

      expect(pages).toEqual([0, 0, 1]);
    },
  );

  it('stops calling the handler once the caller aborts, and drops a queued refetch', async () => {
    const { mf, api } = await clientWithFakeApi();

    const list = deferredList(api);

    const s = liveSse();

    const onOpen = vi.fn();

    const ac = new AbortController();

    const handler = vi.fn();

    const done = mf.onNotes(TOKEN, handler, {
      fetch: s.fetch,
      maxReconnects: 0,
      onOpen,
      signal: ac.signal,
    });

    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    ac.abort();

    list.resolve();

    await done;

    await tick();

    expect(handler).not.toHaveBeenCalled();

    expect(list.calls).toBe(1);
  });

  it('skips a failed fetch and fetches again on the next event', async () => {
    const { mf, api } = await clientWithFakeApi();

    let n = 0;

    api.listNotes.mockImplementation(async () => {
      n += 1;
      if (n <= 2) throw new Error('temporarily down');
      return page(n);
    });

    const pages: number[] = [];

    const done = mf.onNotes(TOKEN, (p) => pages.push(p.notes[0]!.id), {
      fetch: sse('id: 1\nevent: notes\ndata: {}\n\n'),
      maxReconnects: 0,
    });

    await done;

    expect(pages.at(-1)).toBe(n);

    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('ends with the error when the handler throws or the request is invalid', async () => {
    const { mf, api } = await clientWithFakeApi();

    await expect(
      mf.onNotes(
        TOKEN,
        () => {
          throw new Error('handler failed');
        },
        { fetch: sse('id: 1\nevent: notes\ndata: {}\n\n'), maxReconnects: 0 },
      ),
    ).rejects.toThrow('handler failed');

    api.listNotes.mockRejectedValue(new InvalidInputError('limit', 'limit is out of range'));

    await expect(
      mf.onNotes(TOKEN, () => undefined, {
        fetch: sse('id: 1\nevent: notes\ndata: {}\n\n'),
        maxReconnects: 0,
      }),
    ).rejects.toThrow(InvalidInputError);
  });

  it('leaves no listener on the caller signal when the token is refused', async () => {
    const { mf } = await clientWithFakeApi();

    const ac = new AbortController();

    const add = vi.spyOn(ac.signal, 'addEventListener');

    await expect(
      mf.onNotes('nope' as Address, () => undefined, { signal: ac.signal }),
    ).rejects.toThrow(InvalidInputError);

    expect(add).not.toHaveBeenCalled();
  });
});

describe('owner social calls', () => {
  it('owner sessions sign in as the owner', async () => {
    const { mf, api } = await clientWithFakeApi();

    const owner = mf.owner(localKey(OWNER_KEY));

    expect(await owner.setAgentPosting(ACCOUNT, false)).toEqual({ enabled: false, updatedAt: 1 });

    expect(api.signInChallenge).toHaveBeenCalledWith(
      'owner',
      ACCOUNT,
      privateKeyToAccount(OWNER_KEY).address,
    );

    expect(api.setPosting).toHaveBeenCalledWith(ACCOUNT, false, 'bearer-1');

    await owner.deleteAgentNote(ACCOUNT, 7);

    expect(await owner.deleteAgentNotes(ACCOUNT)).toEqual({ deleted: 3 });

    expect(api.deleteNote).toHaveBeenCalledWith(7, 'bearer-1');

    expect(api.deleteAgentNotes).toHaveBeenCalledWith(ACCOUNT, 'bearer-1');

    expect(api.signIn).toHaveBeenCalledTimes(1);

    expect(await owner.agentPosting(ACCOUNT)).toEqual({ enabled: true, updatedAt: null });

    expect(api.getPosting).toHaveBeenCalledWith(ACCOUNT);

    await owner.signOut();

    expect(api.signOut).toHaveBeenCalledWith('bearer-1');
  });

  it('opens one owner session per account', async () => {
    const { mf, api } = await clientWithFakeApi();

    const owner = mf.owner(localKey(OWNER_KEY));

    await owner.setAgentPosting(ACCOUNT, true);

    await owner.setAgentPosting(A(0xab), true);

    expect(api.signInChallenge.mock.calls.map((c) => c[1])).toEqual([ACCOUNT, A(0xab)]);

    expect(api.setPosting.mock.calls.map((c) => c[2])).toEqual(['bearer-1', 'bearer-2']);
  });
});
