import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, collectAttachments } from '../src/gmail.js';
import { isTransient, isQuotaExceeded } from '../src/retry.js';

test('parseAddress extracts bare address from a display-name header', () => {
  assert.equal(parseAddress('Jane Doe <jane@example.com>'), 'jane@example.com');
  assert.equal(parseAddress('bob@example.com'), 'bob@example.com');
  assert.equal(parseAddress('  ALICE@Example.COM  '), 'alice@example.com');
  assert.equal(parseAddress(''), '');
  assert.equal(parseAddress(undefined), '');
});

test('collectAttachments walks nested MIME parts', () => {
  const message = {
    payload: {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { size: 10 } },
        {
          mimeType: 'multipart/related',
          parts: [
            { filename: 'doc.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 2048 } },
          ],
        },
        { filename: 'img.png', mimeType: 'image/png', body: { attachmentId: 'a2', size: 4096 } },
        // inline part without attachmentId should be ignored
        { filename: 'inline.txt', mimeType: 'text/plain', body: { size: 5 } },
      ],
    },
  };
  const atts = collectAttachments(message);
  assert.equal(atts.length, 2);
  assert.deepEqual(atts.map((a) => a.filename).sort(), ['doc.pdf', 'img.png']);
});

test('isTransient identifies retryable errors', () => {
  assert.equal(isTransient({ code: 503 }), true);
  assert.equal(isTransient({ code: 429 }), true);
  assert.equal(isTransient({ code: 'ETIMEDOUT' }), true);
  assert.equal(isTransient({ code: 404 }), false);
  assert.equal(isTransient({ code: 400 }), false);
});

test('isQuotaExceeded detects Gmail quota errors', () => {
  assert.equal(isQuotaExceeded({ code: 429 }), true);
  assert.equal(isQuotaExceeded({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }] }), true);
  assert.equal(isQuotaExceeded({ code: 403, errors: [{ reason: 'notFound' }] }), false);
  assert.equal(isQuotaExceeded({ code: 500 }), false);
});
