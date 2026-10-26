import { describe, expect, it } from 'vitest';
import { createRedactor, createTokenizer, redactJson, tokenizeJson } from './redact.ts';

describe('createRedactor', () => {
  it('replaces the secret wherever it appears', () => {
    expect(createRedactor(['hook-secret-7f3a'])('token=hook-secret-7f3a&x')).toBe(
      'token=[redacted]&x',
    );
  });

  it('also replaces the url-encoded, base64 and base64url forms', () => {
    const secret = 'a b/c+d?e=f~';
    const redact = createRedactor([secret]);
    expect(redact(`q=${encodeURIComponent(secret)}`)).toBe('q=[redacted]');
    expect(redact(`Basic ${Buffer.from(secret).toString('base64')}`)).toBe('Basic [redacted]');
    expect(redact(Buffer.from(secret).toString('base64url'))).toBe('[redacted]');
  });

  it('ignores secrets shorter than 4 characters', () => {
    expect(createRedactor(['abc', ''])('abc abc')).toBe('abc abc');
  });

  it('replaces the longest secret first', () => {
    expect(createRedactor(['secret', 'secret-long'])('x secret-long y secret')).toBe(
      'x [redacted] y [redacted]',
    );
  });
});

describe('redactJson', () => {
  it('walks arrays and objects and leaves non-strings alone', () => {
    const redact = createRedactor(['K-SECRET-9']);
    expect(
      redactJson(redact, {
        reason: 'key K-SECRET-9',
        list: ['K-SECRET-9', 1, null, true],
        nested: { deep: [{ v: 'x K-SECRET-9 y' }] },
        'K-SECRET-9': 'keys are not values',
      }),
    ).toEqual({
      reason: 'key [redacted]',
      list: ['[redacted]', 1, null, true],
      nested: { deep: [{ v: 'x [redacted] y' }] },
      'K-SECRET-9': 'keys are not values',
    });
  });
});

describe('createRedactor, alignments and escapes', () => {
  it('finds the secret inside base64 of a prefixed value at every byte alignment', () => {
    const secret = 'hook-secret-7f3a';
    const redact = createRedactor([secret]);
    for (const prefix of ['', 'u:', 'us:', 'user:', 'admin:']) {
      for (const suffix of ['', 'x', 'xy']) {
        const out = redact(Buffer.from(`${prefix}${secret}${suffix}`).toString('base64'));
        expect(out, `${prefix}|${suffix}`).toContain('[redacted]');
        expect(out, `${prefix}|${suffix}`).not.toContain(secret);
      }
    }
  });

  it('finds the JSON-escaped form', () => {
    const secret = 'pa"ss\\word1';
    const text = JSON.stringify({ k: secret });
    expect(createRedactor([secret])(text)).toBe('{"k":"[redacted]"}');
  });
});

describe('form-urlencoded secrets', () => {
  const secret = "pa ss!(w)'o~r*d1";
  const tokenize = createTokenizer([{ path: 'apiKey', value: secret }], createRedactor([secret]));
  const formEncoded = new URLSearchParams([['', secret]]).toString().slice(1);

  it('is a form the plain redactor and the tokenizer both know', () => {
    expect(formEncoded).toContain('+');
    expect(formEncoded).toMatch(/%21|%28/);
    expect(createRedactor([secret])(`a=${formEncoded}`)).toBe('a=[redacted]');
  });

  it('is tokenized in a url written by URLSearchParams and in a form body', () => {
    const url = new URL('https://api.example.test/v1');
    url.searchParams.set('key', secret);
    const out = tokenize(url.toString());
    expect(out).toBe('https://api.example.test/v1?key=__TRANSCODA_SECRET__apiKey__form__');
    const body = tokenize(new URLSearchParams({ key: secret, x: '1' }).toString());
    expect(body).toBe('key=__TRANSCODA_SECRET__apiKey__form__&x=1');
    for (const text of [out, body]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(formEncoded);
    }
  });
});

describe('createTokenizer', () => {
  const secret = 'K-SEC>>??9 x';
  const tokenize = createTokenizer([{ path: 'apiKey', value: secret }], createRedactor([secret]));

  it('writes one token per form found, naming the field and the encoding', () => {
    expect(tokenize(`a ${secret} b`)).toBe('a __TRANSCODA_SECRET__apiKey__raw__ b');
    expect(tokenize(`?k=${encodeURIComponent(secret)}`)).toBe(
      '?k=__TRANSCODA_SECRET__apiKey__url__',
    );
    expect(tokenize(Buffer.from(secret).toString('base64'))).toBe(
      '__TRANSCODA_SECRET__apiKey__b64__',
    );
    expect(tokenize(Buffer.from(secret).toString('base64url'))).toBe(
      '__TRANSCODA_SECRET__apiKey__b64url__',
    );
  });

  it('uses only [A-Za-z0-9_.] in a token', () => {
    const t = createTokenizer([{ path: 'a-b c', value: 'longsecret' }], (s) => s);
    expect(t('longsecret')).toMatch(/^__TRANSCODA_SECRET__[A-Za-z0-9_.]+__raw__$/);
  });

  it('still redacts a form the tokens do not cover, outside the tokens', () => {
    const basic = Buffer.from(`user:${secret}`).toString('base64');
    const out = tokenize(`Basic ${basic} and ${secret}`);
    // Only the unalignable edge characters of the base64 remain.
    expect(out).toMatch(/^Basic \w*\[redacted\]\w*=* and __TRANSCODA_SECRET__apiKey__raw__$/);
    expect(out).not.toContain(basic.slice(8, 20));
  });

  it('rewrites strings inside JSON values', () => {
    expect(tokenizeJson(tokenize, { h: { a: [`Bearer ${secret}`] } })).toEqual({
      h: { a: ['Bearer __TRANSCODA_SECRET__apiKey__raw__'] },
    });
  });

  it('is the plain redactor when there are no secrets', () => {
    expect(createTokenizer([], (s) => s.toUpperCase())('abc')).toBe('ABC');
  });
});
