import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { checkBody, HttpApi } from '../src/api/http.js';
import { createClient } from '../src/client.js';
import { ApiError, InvalidInputError } from '../src/errors.js';
import { testnetRpc } from './helpers/testnet.js';

const ADDR = '0x00000000000000000000000000000000000000AA';
const LOWER = '0x00000000000000000000000000000000000000aa';
const fakeFetch = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(body === undefined ? '' : JSON.stringify(body), { status, headers }),
  );
const sentJson = (f: ReturnType<typeof fakeFetch>, i = 0) =>
  JSON.parse(String(f.mock.calls[i]![1]!.body));

describe('HttpApi', () => {
  it('sends the API key header and lowercases addresses', async () => {
    const f = fakeFetch(200, { account: ADDR, owner: ADDR, referrer: ADDR });
    const api = new HttpApi({
      baseUrl: 'https://testnet-launch-api.mercuri.finance/',
      chainId: 5042002,
      apiKey: 'mfk_test_k',
      fetch: f,
    });
    await api.getAccount(ADDR);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://testnet-launch-api.mercuri.finance/v1/agent-accounts/${LOWER}`,
    );
    expect((init!.headers as Record<string, string>)['X-Api-Key']).toBe('mfk_test_k');
    expect((init!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('asks for live chain reads only when told to', async () => {
    const f = fakeFetch(200, { account: ADDR, live: { asOfBlock: 100 } });
    const api = new HttpApi({
      baseUrl: 'https://x.example',
      chainId: 1,
      apiKey: 'mfk_test_k',
      fetch: f,
    });
    await api.getAccount(ADDR, { live: true });
    expect(String(f.mock.calls[0]![0])).toBe(`https://x.example/v1/agent-accounts/${LOWER}?live=1`);
  });

  it('reads list pages from a JSON array and the Next-Cursor header', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: '12-0', action: 'buy' }]), {
          status: 200,
          headers: { 'Next-Cursor': 'c1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: '10-0', action: 'sell' }]), { status: 200 }),
      );
    const api = new HttpApi({ baseUrl: 'https://x.example', chainId: 1, fetch: f });
    const first = await api.listActions(ADDR);
    expect(first).toEqual({ items: [{ id: '12-0', action: 'buy' }], nextCursor: 'c1' });
    const second = await api.listActions(ADDR, 'c1');
    expect(String(f.mock.calls[1]![0])).toBe(
      `https://x.example/v1/agent-accounts/${LOWER}/actions?cursor=c1`,
    );
    expect(second.nextCursor).toBeNull();
  });

  it("lists an owner's accounts as an array of summaries", async () => {
    const f = fakeFetch(200, [{ account: LOWER, owner: LOWER, activeAgents: 1 }]);
    const api = new HttpApi({ baseUrl: 'https://x.example', chainId: 1, fetch: f });
    expect(await api.listAccounts(ADDR)).toEqual([
      { account: LOWER, owner: LOWER, activeAgents: 1 },
    ]);
    expect(String(f.mock.calls[0]![0])).toBe(`https://x.example/v1/agent-accounts?owner=${LOWER}`);
  });

  it('posts quote and build bodies in the API wire shape', async () => {
    const f = fakeFetch(200, { advisory: true, asOfBlock: 7 });
    const api = new HttpApi({
      baseUrl: 'https://x.example',
      chainId: 1,
      apiKey: 'mfk_test_k',
      fetch: f,
    });
    await api.quote('curve-buy', { token: LOWER, usdcIn: '25000000' });
    expect(String(f.mock.calls[0]![0])).toBe('https://x.example/v1/quote/curve-buy');
    expect(f.mock.calls[0]![1]!.method).toBe('POST');
    expect(sentJson(f, 0)).toEqual({ token: LOWER, usdcIn: '25000000' });
    await api.quote('pool-swap', {
      token: LOWER,
      buyToken: true,
      amountIn: '1000000',
      account: LOWER,
    });
    expect(sentJson(f, 1)).toEqual({
      token: LOWER,
      buyToken: true,
      amountIn: '1000000',
      account: LOWER,
    });
    const g = fakeFetch(200, {
      chainId: 1,
      to: LOWER,
      data: '0x12345678',
      value: '0',
      function: 'buy',
      selector: '0x12345678',
    });
    const builder = new HttpApi({
      baseUrl: 'https://x.example',
      chainId: 1,
      apiKey: 'mfk_test_k',
      fetch: g,
    });
    await builder.buildTx({
      account: LOWER,
      function: 'buy',
      args: { token: LOWER, usdcIn: '25000000', minTokensOut: '1', deadline: '1800000060' },
    });
    expect(String(g.mock.calls[0]![0])).toBe('https://x.example/v1/tx/build');
    expect(sentJson(g, 0)).toEqual({
      account: LOWER,
      function: 'buy',
      args: { token: LOWER, usdcIn: '25000000', minTokensOut: '1', deadline: '1800000060' },
    });
  });

  it('maps API errors, including Retry-After', async () => {
    const api = new HttpApi({
      baseUrl: 'https://x.example',
      chainId: 1,
      fetch: fakeFetch(
        429,
        { error: { code: 'rate_limited', message: 'slow down' } },
        { 'Retry-After': '5' },
      ),
    });
    const err = (await api.getAccount(ADDR).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.apiCode, err.retryAfterSeconds, err.message]).toEqual([
      429,
      'rate_limited',
      5,
      'slow down',
    ]);
  });

  it('returns null for a token the API does not know', async () => {
    const api = new HttpApi({
      baseUrl: 'https://x.example',
      chainId: 1,
      fetch: fakeFetch(200, null),
    });
    expect(await api.getToken(ADDR)).toBeNull();
  });

  it('uploads launch metadata as multipart', async () => {
    const f = fakeFetch(200, {
      sha256: 'a'.repeat(64),
      metadataURI: 'https://x.example/m/a.json',
      status: 'clean',
    });
    const api = new HttpApi({ baseUrl: 'https://x.example', chainId: 1, fetch: f });
    const res = await api.uploadLaunchMetadata(
      { description: 'hi' },
      { bytes: new Uint8Array([1, 2]), contentType: 'image/png' },
    );
    expect(String(f.mock.calls[0]![0])).toBe('https://x.example/v1/uploads/launch-metadata');
    expect(res).toEqual({ metadataURI: 'https://x.example/m/a.json', imageStatus: null });
    const body = f.mock.calls[0]![1]!.body as FormData;
    expect(body.get('metadata')).toBe('{"description":"hi"}');
    expect(body.get('file')).toBeInstanceOf(Blob);
    const g = fakeFetch(200, {
      sha256: 'b'.repeat(64),
      metadataURI: 'https://x.example/m/b.json',
      status: 'clean',
      imageStatus: 'review',
    });
    expect(
      (
        await new HttpApi({
          baseUrl: 'https://x.example',
          chainId: 1,
          fetch: g,
        }).uploadLaunchMetadata({})
      ).imageStatus,
    ).toBe('review');
  });

  it('refuses a plain-http API host that is not loopback', () => {
    expect(() => new HttpApi({ baseUrl: 'http://api.example', chainId: 1 })).toThrow(/https/);
    expect(() => new HttpApi({ baseUrl: 'http://127.0.0.1:8080', chainId: 1 })).not.toThrow();
  });

  it('is the default API for a network with an API host, and can be turned off', async () => {
    const mf = await createClient({ network: 'testnet', transport: testnetRpc().transport() });
    expect(mf.api).toBeInstanceOf(HttpApi);
    expect(mf.api!.baseUrl).toBe('https://testnet-launch-api.mercuri.finance');
    expect(
      (await createClient({ network: 'testnet', api: null, transport: testnetRpc().transport() }))
        .api,
    ).toBeNull();
  });
});

describe('HttpApi hardening', () => {
  const KEY = 'mfk_test_supersecret';
  const keyed = (
    f: ReturnType<typeof fakeFetch>,
    over: Partial<ConstructorParameters<typeof HttpApi>[0]> = {},
  ) => new HttpApi({ baseUrl: 'https://x.example', chainId: 1, apiKey: KEY, fetch: f, ...over });

  it('holds the key privately: not enumerable, not in JSON or inspect, for the API and the client', async () => {
    const api = keyed(fakeFetch(200, {}));
    expect(Object.keys(api)).not.toContain('apiKey');
    expect(JSON.stringify(api)).not.toContain(KEY);
    expect(inspect(api, { depth: 6, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(api)).toContain('[redacted]');
    const mf = await createClient({
      network: 'testnet',
      apiKey: 'mfk_test_clientsecret',
      transport: testnetRpc().transport(),
    });
    expect(mf.settings.hasApiKey).toBe(true);
    for (const text of [
      JSON.stringify(mf.api),
      inspect(mf.api, { depth: 8, showHidden: true }),
      inspect(mf, { depth: 4 }),
      inspect(mf.settings),
    ])
      expect(text).not.toContain('clientsecret');
    expect(Object.values(mf.settings)).not.toContain('mfk_test_clientsecret');
  });

  it.each([
    'mfk_test_k\n',
    ' mfk_test_k',
    'mfk_test_\r\nX-Evil: 1',
    'mfk_test_\0k',
    'mfk_test_é',
    '',
    '  ',
    'k'.repeat(257),
  ])('refuses a malformed key without echoing it: %j', async (bad) => {
    expect(() => new HttpApi({ baseUrl: 'https://x.example', chainId: 1, apiKey: bad })).toThrow(
      InvalidInputError,
    );
    const err = (await createClient({
      network: 'testnet',
      apiKey: bad,
      transport: testnetRpc().transport(),
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.message).not.toMatch(/X-Evil|é/);
    expect(err.message).not.toContain('k'.repeat(200));
  });

  it('redacts the key from a server error body that echoes it, in the message and the code', async () => {
    for (const body of [
      { error: { code: 'unauthorized', message: `bad key ${KEY} (X-Api-Key: ${KEY})` } },
      { error: { code: KEY, message: 'nope' } },
    ]) {
      const err = (await keyed(fakeFetch(401, body) as never)
        .getAccount(ADDR)
        .catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(`${err.message} ${err.apiCode}`).not.toContain(KEY);
    }
    const said = (await keyed(
      fakeFetch(401, { error: { code: 'unauthorized', message: `bad key ${KEY}` } }) as never,
    )
      .getAccount(ADDR)
      .catch((e: unknown) => e)) as ApiError;
    expect(said.message).toContain('[redacted]');
    expect(said.apiCode).toBe('unauthorized');
  });

  it('accepts a 256-character key and refuses 257', () => {
    expect(
      () => new HttpApi({ baseUrl: 'https://x.example', chainId: 1, apiKey: 'k'.repeat(256) }),
    ).not.toThrow();
    expect(
      () => new HttpApi({ baseUrl: 'https://x.example', chainId: 1, apiKey: 'k'.repeat(257) }),
    ).toThrow(InvalidInputError);
  });

  it('redacts the key from transport failures and asks for identity encoding', async () => {
    const leaky = vi.fn(async () => {
      throw new Error(`Illegal header value ${KEY}`);
    });
    const err = (await keyed(leaky as never)
      .getAccount(ADDR)
      .catch((e: unknown) => e)) as ApiError;
    expect(err.message).not.toContain(KEY);
    const f = fakeFetch(200, { account: ADDR });
    await keyed(f).getAccount(ADDR);
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>)['Accept-Encoding']).toBe(
      'identity',
    );
  });

  it('refuses redirects, so the key cannot follow one', async () => {
    const f = fakeFetch(200, {});
    await keyed(f)
      .getAccount(ADDR)
      .catch(() => undefined);
    expect(f.mock.calls[0]![1]!.redirect).toBe('error');
  });

  it('rejects hostile base URLs and parameters before any request', async () => {
    for (const baseUrl of [
      'https://u:p@x.example',
      'https://x.example/?k=1',
      'https://x.example/#f',
      'not a url',
      'ftp://x.example',
    ]) {
      expect(() => new HttpApi({ baseUrl, chainId: 1 })).toThrow(InvalidInputError);
    }
    const f = fakeFetch(200, {});
    const api = keyed(f);
    await expect(api.getAccount('../../admin' as never)).rejects.toThrow(InvalidInputError);
    await expect(api.listActions(ADDR, 'a&b=c')).rejects.toThrow(InvalidInputError);
    await expect(api.listActions(ADDR, 'x'.repeat(300))).rejects.toThrow(InvalidInputError);
    expect(f).not.toHaveBeenCalled();
  });

  it('validates response shapes', async () => {
    const wrong = (body: unknown, headers: Record<string, string> = {}) =>
      keyed(fakeFetch(200, body, headers));
    await expect(
      wrong({ account: '0x00000000000000000000000000000000000000bb' }).getAccount(ADDR),
    ).rejects.toMatchObject({ code: 'API_BAD_RESPONSE' });
    await expect(wrong([]).getAccount(ADDR)).rejects.toMatchObject({ code: 'API_BAD_RESPONSE' });
    await expect(wrong({}).listAccounts(ADDR)).rejects.toMatchObject({ code: 'API_BAD_RESPONSE' });
    await expect(wrong([{ id: 1 }]).listActions(ADDR)).rejects.toMatchObject({
      code: 'API_BAD_RESPONSE',
    });
    await expect(wrong([{ id: 'a', token: 'nope' }]).listActions(ADDR)).rejects.toMatchObject({
      code: 'API_BAD_RESPONSE',
    });
    await expect(
      wrong({ advisory: false }).quote('curve-buy', { token: LOWER, usdcIn: '1' }),
    ).rejects.toMatchObject({ code: 'API_BAD_RESPONSE' });
    await expect(
      wrong({ chainId: 1, to: LOWER, data: 'nothex', value: '0' }).buildTx({
        account: LOWER,
        function: 'buy',
        args: {},
      }),
    ).rejects.toMatchObject({ code: 'API_BAD_RESPONSE' });
    await expect(
      wrong({ chainId: 1, to: LOWER, data: '0x00', value: '-1' }).buildTx({
        account: LOWER,
        function: 'buy',
        args: {},
      }),
    ).rejects.toMatchObject({ code: 'API_BAD_RESPONSE' });
    await expect(wrong({ metadataURI: 5 }).uploadLaunchMetadata({})).rejects.toMatchObject({
      code: 'API_BAD_RESPONSE',
    });
    await expect(
      wrong({ address: '0x00000000000000000000000000000000000000bb' }).getToken(ADDR),
    ).rejects.toMatchObject({ code: 'API_BAD_RESPONSE' });
  });

  it('bounds list size and cursors, and refuses a cursor that does not advance', async () => {
    const many = Array.from({ length: 1_001 }, (_, i) => ({ id: `${i}` }));
    await expect(keyed(fakeFetch(200, many)).listActions(ADDR)).rejects.toMatchObject({
      code: 'API_BAD_RESPONSE',
    });
    await expect(
      keyed(fakeFetch(200, [], { 'Next-Cursor': 'bad cursor!' })).listActions(ADDR),
    ).rejects.toMatchObject({ code: 'API_BAD_RESPONSE' });
    await expect(
      keyed(fakeFetch(200, [], { 'Next-Cursor': 'c1' })).listActions(ADDR, 'c1'),
    ).rejects.toMatchObject({ code: 'API_BAD_RESPONSE' });
  });

  it('refuses an oversized body', async () => {
    const f = vi.fn(async () => new Response('x'.repeat(5 * 1024 * 1024), { status: 200 }));
    await expect(keyed(f as never).getAccount(ADDR)).rejects.toMatchObject({
      code: 'API_BAD_RESPONSE',
    });
    const g = vi.fn(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'Content-Length': String(99 * 1024 * 1024) },
        }),
    );
    await expect(keyed(g as never).getAccount(ADDR)).rejects.toMatchObject({
      code: 'API_BAD_RESPONSE',
    });
  });

  it('times out, and redacts URLs and control text in errors', async () => {
    const hang = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const timed = (await keyed(hang as never, { timeoutMs: 20 })
      .getAccount(ADDR)
      .catch((e: unknown) => e)) as ApiError;
    expect(timed).toMatchObject({ status: 0, apiCode: 'timeout' });
    const leaky = vi.fn(async () => {
      throw new Error('connect failed https://x.example/v1/secret-path?key=abc\nsecond line');
    });
    const net = (await keyed(leaky as never)
      .getAccount(ADDR)
      .catch((e: unknown) => e)) as ApiError;
    expect(net.apiCode).toBe('network');
    for (const bit of ['secret-path', 'key=abc', 'second line', KEY])
      expect(net.message).not.toContain(bit);
    const hostile = fakeFetch(500, {
      error: { code: 'bad code!', message: 'see https://evil.example/p?token=1‮ now' },
    });
    const err = (await keyed(hostile)
      .getAccount(ADDR)
      .catch((e: unknown) => e)) as ApiError;
    expect(err.apiCode).toBe('http_error');
    expect(err.message).not.toMatch(/token=1|‮|\/p\b/);
  });

  it('builds the client with an explicit apiBaseUrl and refuses a plain-http one', async () => {
    const mf = await createClient({
      network: 'testnet',
      apiBaseUrl: 'https://api.example.org/',
      transport: testnetRpc().transport(),
    });
    expect(mf.api!.baseUrl).toBe('https://api.example.org');
    await expect(
      createClient({
        network: 'testnet',
        apiBaseUrl: 'http://api.example.org',
        transport: testnetRpc().transport(),
      }),
    ).rejects.toThrow(/https/);
  });

  it('follows Next-Cursor for listAccounts, and warns when it truncates', async () => {
    const item = { account: LOWER, owner: LOWER };
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([item]), { status: 200, headers: { 'Next-Cursor': 'c1' } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([item]), { status: 200 }));
    expect(
      await new HttpApi({ baseUrl: 'https://x.example', chainId: 1, fetch: f }).listAccounts(ADDR),
    ).toHaveLength(2);
    expect(String(f.mock.calls[1]![0])).toBe(
      `https://x.example/v1/agent-accounts?owner=${LOWER}&cursor=c1`,
    );
    let n = 0;
    const endless = vi.fn(
      async () =>
        new Response(JSON.stringify([item]), {
          status: 200,
          headers: { 'Next-Cursor': `c${n++}` },
        }),
    );
    const warnings: string[] = [];
    const out = await new HttpApi({
      baseUrl: 'https://x.example',
      chainId: 1,
      fetch: endless as never,
      onWarning: (m) => warnings.push(m),
    }).listAccounts(ADDR);
    expect(out).toHaveLength(10);
    expect(warnings[0]).toMatch(/cut off/);
  });
});

const VECTORS = JSON.parse(
  readFileSync(new URL('../../../fixtures/vectors/notes.json', import.meta.url), 'utf8'),
);
const TOKEN = VECTORS.token as `0x${string}`;
const NOTE = VECTORS.note;
const PAGE = VECTORS.page;
const BEARER = 'bearer-secret';
const headersOf = (f: ReturnType<typeof fakeFetch>, i = 0) =>
  f.mock.calls[i]![1]!.headers as Record<string, string>;
const social = (f: ReturnType<typeof fakeFetch>, apiKey: string | undefined = 'mfk_test_abc') =>
  new HttpApi({
    baseUrl: 'https://x.example',
    chainId: 1,
    fetch: f,
    ...(apiKey === undefined ? {} : { apiKey }),
  });

describe('social routes', () => {
  it('sends the bearer, never the API key, on a social write', async () => {
    const f = fakeFetch(201, NOTE);
    await social(f).postNote(TOKEN, 'volume picking up', BEARER);
    expect(String(f.mock.calls[0]![0])).toBe(`https://x.example/v1/tokens/${TOKEN}/notes`);
    expect(f.mock.calls[0]![1]!.method).toBe('POST');
    expect(sentJson(f)).toEqual({ body: 'volume picking up' });
    expect(headersOf(f).Authorization).toBe(`Bearer ${BEARER}`);
    expect(headersOf(f)['X-Api-Key']).toBeUndefined();
  });

  it('keeps the API key on public note reads, with no Authorization', async () => {
    const f = fakeFetch(200, PAGE);
    await social(f).listNotes(TOKEN);
    expect(headersOf(f)['X-Api-Key']).toBe('mfk_test_abc');
    expect(headersOf(f).Authorization).toBeUndefined();
  });

  it('cuts the bearer out of an echoed error', async () => {
    const f = fakeFetch(400, { error: { code: 'bad', message: `saw ${BEARER} here` } });
    const err = (await social(f)
      .postNote(TOKEN, 'x', BEARER)
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain(BEARER);
    expect(err.apiCode).toBe('bad');
    const echoed = fakeFetch(401, { error: { code: BEARER, message: 'no' } });
    const coded = (await social(echoed)
      .signOut(BEARER)
      .catch((e: unknown) => e)) as ApiError;
    expect(coded.apiCode).toBe('http_error');
    const leaky = vi.fn(async () => {
      throw new Error(`Illegal header value Bearer ${BEARER}`);
    });
    const net = (await social(leaky as never)
      .agree(7, true, BEARER)
      .catch((e: unknown) => e)) as ApiError;
    expect(net.message).not.toContain(BEARER);
  });

  it('cuts a bearer or key split by a zero-width character out of an echoed error', async () => {
    const split = (secret: string) => `${secret.slice(0, 4)}\u200b${secret.slice(4)}`;
    const f = fakeFetch(400, {
      error: { code: 'bad', message: `saw ${split(BEARER)} and ${split('mfk_test_abc')}` },
    });
    const err = (await social(f)
      .postNote(TOKEN, 'x', BEARER)
      .catch((e: unknown) => e)) as ApiError;
    expect(err.message).not.toContain(BEARER);
    expect(err.message).not.toContain('mfk_test_abc');
    expect(err.message).toBe('saw [redacted] and [redacted]');
  });

  it('reads the shared note vectors', async () => {
    const page = await social(fakeFetch(200, PAGE)).listNotes(TOKEN);
    expect(page.notes[0]!.agent).toBe(true);
    expect(page).toEqual(PAGE);
    const replies = await social(fakeFetch(200, VECTORS.replies)).listReplies(7);
    expect(replies.notes[0]!.holdBps).toBeNull();
    expect(await social(fakeFetch(200, VECTORS.marks)).noteMarks(TOKEN, 0, 100)).toEqual(
      VECTORS.marks,
    );
    expect(await social(fakeFetch(200, VECTORS.reactions)).getReactions(TOKEN)).toEqual(
      VECTORS.reactions,
    );
    expect(await social(fakeFetch(200, NOTE)).getNote(7)).toEqual(NOTE);
  });

  it('signs in with neither the API key nor Authorization', async () => {
    const challenge = {
      nonce: '0123456789abcdef0123456789abcdef',
      message: 'Agent sign-in for account ...',
      issuedAt: 1760616000,
      expiresAt: 1760616300,
    };
    const f = fakeFetch(200, challenge);
    expect(
      await social(f).signInChallenge('agent', NOTE.address, VECTORS.replies.notes[0].address),
    ).toEqual(challenge);
    expect(String(f.mock.calls[0]![0])).toBe('https://x.example/v1/agent-auth/nonce');
    expect(sentJson(f)).toEqual({
      kind: 'agent',
      account: NOTE.address,
      signer: VECTORS.replies.notes[0].address,
    });
    expect(headersOf(f)['X-Api-Key']).toBeUndefined();
    expect(headersOf(f).Authorization).toBeUndefined();
    const session = {
      token: 'A'.repeat(43),
      kind: 'agent',
      account: NOTE.address,
      expiresAt: 1760619600,
    };
    const g = fakeFetch(200, session);
    expect(await social(g).signIn(challenge.nonce, `0x${'11'.repeat(65)}`)).toEqual(session);
    expect(String(g.mock.calls[0]![0])).toBe('https://x.example/v1/agent-auth/session');
    expect(sentJson(g)).toEqual({ nonce: challenge.nonce, signature: `0x${'11'.repeat(65)}` });
    expect(headersOf(g)['X-Api-Key']).toBeUndefined();
    expect(headersOf(g).Authorization).toBeUndefined();
  });

  it('keeps a sign-in refusal code intact', async () => {
    const f = fakeFetch(403, { error: { code: 'posting_off', message: 'posting is off' } });
    const err = (await social(f)
      .signIn('0123456789abcdef0123456789abcdef', `0x${'11'.repeat(65)}`)
      .catch((e: unknown) => e)) as ApiError;
    expect([err.status, err.apiCode, err.message]).toEqual([403, 'posting_off', 'posting is off']);
  });

  it('sends each write to its route with its body', async () => {
    const A = NOTE.address;
    const cases: [string, (api: HttpApi) => Promise<unknown>, unknown, string, string, unknown][] =
      [
        [
          'signOut',
          (api) => api.signOut(BEARER),
          undefined,
          'DELETE',
          '/v1/agent-auth/session',
          undefined,
        ],
        [
          'putReaction',
          (api) => api.putReaction(TOKEN, 'bullish', BEARER),
          undefined,
          'PUT',
          `/v1/tokens/${TOKEN}/reactions`,
          { key: 'bullish' },
        ],
        [
          'putReaction off',
          (api) => api.putReaction(TOKEN, 'bearish', BEARER, false),
          undefined,
          'PUT',
          `/v1/tokens/${TOKEN}/reactions`,
          { key: 'bearish', active: false },
        ],
        [
          'putReaction null',
          (api) => api.putReaction(TOKEN, null, BEARER),
          undefined,
          'PUT',
          `/v1/tokens/${TOKEN}/reactions`,
          { key: null },
        ],
        [
          'postReply',
          (api) => api.postReply(7, 'not so sure', BEARER),
          VECTORS.replies.notes[0],
          'POST',
          '/v1/notes/7/replies',
          { body: 'not so sure' },
        ],
        [
          'agree',
          (api) => api.agree(7, true, BEARER),
          undefined,
          'PUT',
          '/v1/notes/7/agree',
          { active: true },
        ],
        [
          'report',
          (api) => api.report(7, BEARER),
          undefined,
          'POST',
          '/v1/notes/7/report',
          undefined,
        ],
        [
          'deleteNote',
          (api) => api.deleteNote(7, BEARER),
          undefined,
          'DELETE',
          '/v1/notes/7',
          undefined,
        ],
        [
          'setPosting',
          (api) => api.setPosting(A, true, BEARER),
          { enabled: true, updatedAt: 1760616000 },
          'PUT',
          `/v1/agent-accounts/${A}/posting`,
          { enabled: true },
        ],
        [
          'deleteAgentNotes',
          (api) => api.deleteAgentNotes(A, BEARER),
          { deleted: 3 },
          'DELETE',
          `/v1/agent-accounts/${A}/notes`,
          undefined,
        ],
      ];
    for (const [name, call, answer, method, path, body] of cases) {
      const f =
        answer === undefined
          ? (vi.fn(
              async (_url: string | URL | Request, _init?: RequestInit) =>
                new Response(null, { status: 204 }),
            ) as ReturnType<typeof fakeFetch>)
          : fakeFetch(200, answer);
      await call(social(f));
      const init = f.mock.calls[0]![1]!;
      expect([name, String(f.mock.calls[0]![0]), init.method]).toEqual([
        name,
        `https://x.example${path}`,
        method,
      ]);
      expect(init.body === undefined ? undefined : sentJson(f)).toEqual(body);
      expect(headersOf(f).Authorization).toBe(`Bearer ${BEARER}`);
      expect(headersOf(f)['X-Api-Key']).toBeUndefined();
    }
    expect(await social(fakeFetch(200, { deleted: 3 })).deleteAgentNotes(A, BEARER)).toEqual({
      deleted: 3,
    });
  });

  it('reads pages, marks and the posting switch from their routes', async () => {
    const f = fakeFetch(200, PAGE);
    await social(f).listNotes(TOKEN, { cursor: 'eyJzIjoibm90ZXMifQ', limit: 50 });
    expect(String(f.mock.calls[0]![0])).toBe(
      `https://x.example/v1/tokens/${TOKEN}/notes?cursor=eyJzIjoibm90ZXMifQ&limit=50`,
    );
    const g = fakeFetch(200, VECTORS.replies);
    await social(g).listReplies(7, { limit: 5 });
    expect(String(g.mock.calls[0]![0])).toBe('https://x.example/v1/notes/7/replies?limit=5');
    const m = fakeFetch(200, []);
    await social(m).noteMarks(TOKEN, 100, 100 + 90 * 86_400);
    expect(String(m.mock.calls[0]![0])).toBe(
      `https://x.example/v1/tokens/${TOKEN}/notes/marks?from=100&to=${100 + 90 * 86_400}`,
    );
    const p = fakeFetch(200, { enabled: false, updatedAt: null });
    expect(await social(p).getPosting(NOTE.address)).toEqual({ enabled: false, updatedAt: null });
    expect(String(p.mock.calls[0]![0])).toBe(
      `https://x.example/v1/agent-accounts/${NOTE.address}/posting`,
    );
    expect(headersOf(p).Authorization).toBeUndefined();
  });

  it('refuses bad arguments before any request', async () => {
    const f = fakeFetch(200, {});
    const api = social(f);
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
      await expect(api.getNote(id)).rejects.toThrow(InvalidInputError);
    await expect(api.listNotes(TOKEN, { limit: 0 })).rejects.toThrow(InvalidInputError);
    await expect(api.listNotes(TOKEN, { limit: 51 })).rejects.toThrow(InvalidInputError);
    await expect(api.listReplies(7, { cursor: 'a&b=c' })).rejects.toThrow(InvalidInputError);
    for (const [from, to, field] of [
      [-1, 5, 'from'],
      [10, 5, 'to'],
      [0, 90 * 86_400 + 1, 'to'],
      [0.5, 5, 'from'],
      [0, undefined, 'to'],
    ] as const) {
      const err = await api.noteMarks(TOKEN, from, to as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidInputError);
      expect((err as InvalidInputError).field).toBe(field);
    }
    await expect(api.putReaction(TOKEN, null, BEARER, false)).rejects.toThrow(InvalidInputError);
    await expect(api.putReaction(TOKEN, 'Bull ish', BEARER)).rejects.toThrow(InvalidInputError);
    await expect(api.signInChallenge('admin' as never, TOKEN, TOKEN)).rejects.toThrow(
      InvalidInputError,
    );
    await expect(api.signIn('nonce', 'nothex' as never)).rejects.toThrow(InvalidInputError);
    for (const bearer of ['', 'a b', 'x\r\nX-Evil: 1', 'é'])
      await expect(api.report(7, bearer)).rejects.toThrow(InvalidInputError);
    const bad = (await api.report(7, 'x\r\nX-Evil: 1').catch((e: unknown) => e)) as Error;
    expect(bad.message).not.toContain('X-Evil');
    expect(f).not.toHaveBeenCalled();
  });

  it('validates social response shapes', async () => {
    const wrong = (body: unknown) => social(fakeFetch(200, body));
    const reject = { code: 'API_BAD_RESPONSE' };
    await expect(wrong({ ...NOTE, side: 'neutral' }).getNote(7)).rejects.toMatchObject(reject);
    await expect(wrong({ ...NOTE, id: 8 }).getNote(7)).rejects.toMatchObject(reject);
    await expect(wrong({ ...NOTE, address: 'nope' }).getNote(7)).rejects.toMatchObject(reject);
    await expect(wrong({ ...NOTE, body: 'x'.repeat(281) }).getNote(7)).rejects.toMatchObject(
      reject,
    );
    expect((await wrong({ ...NOTE, body: '🚀'.repeat(280) }).getNote(7)).body).toHaveLength(560);
    await expect(
      wrong({ notes: Array.from({ length: 51 }, () => NOTE), nextCursor: null }).listNotes(TOKEN),
    ).rejects.toMatchObject(reject);
    await expect(
      wrong({ ...PAGE, nextCursor: 'bad cursor!' }).listNotes(TOKEN),
    ).rejects.toMatchObject(reject);
    await expect(
      wrong([{ id: 1, createdAt: 2, side: 'up', agent: false }]).noteMarks(TOKEN, 0, 1),
    ).rejects.toMatchObject(reject);
    await expect(
      wrong({ ...VECTORS.reactions, mine: 5 }).getReactions(TOKEN),
    ).rejects.toMatchObject(reject);
    await expect(
      wrong({ ...VECTORS.reactions, selected: [1] }).getReactions(TOKEN),
    ).rejects.toMatchObject(reject);
    await expect(
      wrong({ enabled: 'yes', updatedAt: null }).getPosting(TOKEN),
    ).rejects.toMatchObject(reject);
    await expect(wrong({ deleted: -1 }).deleteAgentNotes(TOKEN, BEARER)).rejects.toMatchObject(
      reject,
    );
    await expect(
      wrong({ nonce: 'n', message: 7, issuedAt: 1, expiresAt: 2 }).signInChallenge(
        'owner',
        TOKEN,
        TOKEN,
      ),
    ).rejects.toMatchObject(reject);
    await expect(
      wrong({ token: 'a b', kind: 'agent', account: TOKEN, expiresAt: 1 }).signIn(
        'n',
        `0x${'11'.repeat(65)}`,
      ),
    ).rejects.toMatchObject(reject);
    await expect(
      wrong({ token: 'abc', kind: 'agent', account: 'nope', expiresAt: 1 }).signIn(
        'n',
        `0x${'11'.repeat(65)}`,
      ),
    ).rejects.toMatchObject(reject);
  });
});

describe('checkBody', () => {
  it('strips control and format characters, trims and counts code points like the API', () => {
    expect(checkBody('  volume\u200b picking up\u0007 \n')).toBe('volume picking up');
    expect(checkBody('a\u2028b\u2029c')).toBe('abc');
    expect(checkBody('🚀'.repeat(280))).toBe('🚀'.repeat(280));
    for (const bad of ['🚀'.repeat(281), ' \u200b\t ', 5 as never]) {
      const err = (() => {
        try {
          checkBody(bad);
        } catch (e) {
          return e;
        }
        return undefined;
      })() as InvalidInputError;
      expect(err).toBeInstanceOf(InvalidInputError);
      expect(err.field).toBe('body');
    }
  });
});
