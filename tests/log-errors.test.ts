import { describe, expect, test } from 'bun:test';
import { MAX_LOG_ERROR_LENGTH, sanitizeLogError } from '../server/log-errors';

describe('copyable error text', () => {
  test('preserves the complete permission reason and multiline diagnostics', () => {
    const message = 'Bash: ls -la /workspace/private\nPermission was denied by the sandbox.\n\tRule: Bash(ls:*) requires approval.\nPRIVATE_OUTPUT';
    expect(sanitizeLogError(message)).toBe(message);
    expect(sanitizeLogError({ message, extra: 'not error text' })).toBe(message);
    expect(sanitizeLogError(new Error(message))).toBe(message);
  });

  test.each([undefined, null, 42, false, [], {}, { message: 42 }, { output: 'successful command output' }, '', ' \n\t '].map(value => ({ value })))('omits missing or unsupported error text %#', ({ value }) => {
    expect(sanitizeLogError(value)).toBeUndefined();
  });

  test('removes terminal colors, OSC hyperlinks, CR, and other control bytes', () => {
    const message = '\u001b[31mPermission denied\u001b[0m\r\n\t\u001b]8;;https://example.com\u0007details\u001b]8;;\u001b\\\u0000\u0008\u007f\u009f';
    expect(sanitizeLogError(message)).toBe('Permission denied\n\tdetails');
  });

  test('redacts Bearer and Basic authorization without losing the failure reason', () => {
    const message = 'HTTP 401\nAuthorization: Bearer bearer-secret-value\n"Authorization": "Basic dXNlcjpwYXNzd29yZA=="\nProxy-Authorization=Basic cHJveHk6c2VjcmV0\nInvalid Bearer another-token\nBasic permissions are required.';
    expect(sanitizeLogError(message)).toBe('HTTP 401\nAuthorization: Bearer [скрыто]\n"Authorization": "Basic [скрыто]"\nProxy-Authorization=Basic [скрыто]\nInvalid Bearer [скрыто]\nBasic permissions are required.');
  });

  test('redacts assignment credentials, quoted values, environment names, and CLI flags', () => {
    const message = 'permission denied\nTOKEN=raw-token PASSWORD="two words" api_key: \'api secret\'\n{"client_secret":"json-secret","refresh_token":"refresh-secret"}\nAWS_SECRET_ACCESS_KEY=aws-secret OPENAI_API_KEY=provider-secret\ncli --token cli-token --api-key="cli api secret" --password \'cli password\' --access-token=access-secret';
    const sanitized = sanitizeLogError(message)!;
    expect(sanitized).toBe('permission denied\nTOKEN=[скрыто] PASSWORD="[скрыто]" api_key: \'[скрыто]\'\n{"client_secret":"[скрыто]","refresh_token":"[скрыто]"}\nAWS_SECRET_ACCESS_KEY=[скрыто] OPENAI_API_KEY=[скрыто]\ncli --token [скрыто] --api-key="[скрыто]" --password \'[скрыто]\' --access-token=[скрыто]');
    expect(sanitizeLogError(sanitized)).toBe(sanitized);
  });

  test('redacts URL userinfo and sensitive query values while preserving routing details', () => {
    const message = 'Failed https://alice:password@example.com/private?token=secret&path=readme&api%5Fkey=encoded-secret#retry\nhttps://service.test/?X-Amz-Credential=user&X-Amz-Signature=signature&X-Amz-Security-Token=temporary&limit=5\npostgres://dbuser:dbpass@db.test:5432/app';
    expect(sanitizeLogError(message)).toBe('Failed https://[скрыто]@example.com/private?token=[скрыто]&path=readme&api%5Fkey=[скрыто]#retry\nhttps://service.test/?X-Amz-Credential=[скрыто]&X-Amz-Signature=[скрыто]&X-Amz-Security-Token=[скрыто]&limit=5\npostgres://[скрыто]@db.test:5432/app');
  });

  test.each(['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY'])('redacts a complete PEM %s block', label => {
    expect(sanitizeLogError(`Cannot load key:\n-----BEGIN ${label}-----\nPRIVATE_KEY_MATERIAL\n-----END ${label}-----\nPermission denied.`)).toBe('Cannot load key:\n[скрыто]\nPermission denied.');
  });

  test('redacts incomplete PEM blocks to the end of the diagnostic', () => {
    expect(sanitizeLogError('Key error:\n-----BEGIN PRIVATE KEY-----\nPRIVATE_KEY_MATERIAL')).toBe('Key error:\n[скрыто]');
  });

  // Build synthetic credentials at runtime so source files contain no complete
  // provider-shaped tokens that could trigger repository push protection.
  test.each([
    ['OpenAI', 'sk-proj-', 'a'.repeat(24)], ['Anthropic', 'sk-ant-api03-', 'b'.repeat(24)],
    ['GitHub personal', 'ghp_', 'c'.repeat(24)], ['GitHub installation', 'ghs_', 'd'.repeat(24)],
    ['GitHub fine-grained', 'github_pat_', 'e'.repeat(24)], ['GitLab', 'glpat-', 'f'.repeat(24)],
    ['Slack', 'xoxb-', ['1'.repeat(10), 'g'.repeat(16)].join('-')], ['Stripe', 'sk_live_', 'h'.repeat(24)],
    ['Hugging Face', 'hf_', 'i'.repeat(24)], ['npm', 'npm_', 'j'.repeat(24)],
    ['Google', 'AIza', 'k'.repeat(32)], ['AWS', 'AKIA', 'L'.repeat(16)],
    ['JWT', 'eyJ', ['m'.repeat(17), 'n'.repeat(24), 'o'.repeat(24)].join('.')],
  ].map(([provider, prefix, suffix]) => [provider!, prefix! + suffix!] as const))('redacts known standalone %s credentials', (_provider, token) => {
    expect(sanitizeLogError(`Authentication failed for ${token}. Retry after signing in.`)).toBe('Authentication failed for [скрыто]. Retry after signing in.');
  });

  test('limits the complete result to 8000 characters including the truncation marker', () => {
    expect(MAX_LOG_ERROR_LENGTH).toBe(8000);
    expect(sanitizeLogError('x'.repeat(8000))).toBe('x'.repeat(8000));
    const result = sanitizeLogError('x'.repeat(8001))!;
    expect(result.length).toBe(8000);
    expect(result).toEndWith('\n[текст ошибки сокращён]');
    expect(sanitizeLogError(result)).toBe(result);
    expect(sanitizeLogError('x'.repeat(1024 * 1024))).toBe(result);
  });

  test('redacts before truncating and does not cut a Unicode surrogate pair in half', () => {
    const result = sanitizeLogError(`token="${'s'.repeat(10000)}"\npermission denied`)!;
    expect(result).toBe('token="[скрыто]"\npermission denied');
    const prefixLength = 8000 - '\n[текст ошибки сокращён]'.length;
    const unicode = sanitizeLogError(`${'x'.repeat(prefixLength - 1)}😀${'y'.repeat(40)}`)!;
    expect(unicode).toBe(`${'x'.repeat(prefixLength - 1)}\n[текст ошибки сокращён]`);
  });

  test('handles long malformed credential names without treating arbitrary words as secrets', () => {
    const message = `${'token_'.repeat(50000)}: not a real credential field`;
    expect(sanitizeLogError(message)).toBe(sanitizeLogError('token_'.repeat(2000)));
  });
});
