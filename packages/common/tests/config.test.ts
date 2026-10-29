import { describe, expect, it } from 'vitest';
import { normalizeUrl, validateConfigValue } from '../index';

describe('automation configuration', () => {
	it('normalizes pasted domain links while leaving unsupported schemes for validation', () => {
		expect(normalizeUrl(' <example.com/path> ')).toBe('https://example.com/path');
		expect(normalizeUrl('//example.com')).toBe('https://example.com');
		expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
		expect(normalizeUrl('file:///tmp/private')).toBe('file:///tmp/private');
		expect(validateConfigValue({ label: '链接', type: 'url', value: 'file:///tmp/private' })).toContain('http/https');
	});
	it('validates required fields, numeric limits and declared patterns', () => {
		expect(validateConfigValue({ label: '密码', type: 'password', value: '', required: true })).toBe('请输入密码');
		expect(validateConfigValue({ label: '次数', type: 'number', value: 1, min: 2 })).toContain('不能小于 2');
		expect(validateConfigValue({ label: '次数', type: 'number', value: 3, min: 2, max: 4 })).toBeUndefined();
		expect(validateConfigValue({ label: '代码', value: 'abc', pattern: '^\\d+$' })).toBe('代码格式不正确');
	});
});
