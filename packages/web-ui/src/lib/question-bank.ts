import { ApiError } from '@/api/client';
import type { QueryResult } from '@/api/question-query';
import type { QuestionBankQuestion, QuestionInput } from '@/api/types';
import { describeError } from '@/api/errors';

/**
 * Question-bank helpers: UTF-8 byte limits, UTC time normalisation, stable
 * error copy and the import batching rules from the service contract.
 *
 * Length limits are specified in UTF-8 bytes, so character counts are never a
 * substitute: one Chinese character costs three bytes.
 */

export const BANK_LIMITS = {
	question: 16000,
	options: 24000,
	answer: 24000,
	questionType: 100,
	search: 200,
	pageSize: 100,
	importCount: 500,
	importBytes: 1024 * 1024,
	importRequestBytes: 1024 * 1024
} as const;

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
	return encoder.encode(value).length;
}

export type FieldErrors = Partial<Record<'question' | 'options' | 'answer' | 'questionType' | 'folderId', string>>;

function limitError(label: string, limit: number, value: string): string {
	return `${label}不能超过 ${limit} 字节（当前 ${utf8Bytes(value)} 字节）。`;
}

/** Mirrors the service validation so errors surface before a request is sent. */
export function validateQuestionInput(input: QuestionInput): FieldErrors {
	const errors: FieldErrors = {};
	if (!input.question.trim()) errors.question = '题干不能为空。';
	else if (utf8Bytes(input.question) > BANK_LIMITS.question)
		errors.question = limitError('题干', BANK_LIMITS.question, input.question);
	const options = input.options ?? '';
	if (utf8Bytes(options) > BANK_LIMITS.options) errors.options = limitError('选项', BANK_LIMITS.options, options);
	if (!input.answer.trim()) errors.answer = '答案不能为空。';
	else if (utf8Bytes(input.answer) > BANK_LIMITS.answer)
		errors.answer = limitError('答案', BANK_LIMITS.answer, input.answer);
	const type = input.questionType ?? '';
	if (utf8Bytes(type) > BANK_LIMITS.questionType)
		errors.questionType = limitError('题型', BANK_LIMITS.questionType, type);
	const folder = input.folderId ?? 0;
	if (!Number.isInteger(folder) || folder < 0) errors.folderId = '目标文件夹无效。';
	return errors;
}

export function hasFieldErrors(errors: FieldErrors): boolean {
	return Object.keys(errors).length > 0;
}

/** Assemble an explicit input: never submit ids or form-only fields. */
export function toQuestionInput(source: {
	question: string;
	options?: string | null;
	answer: string;
	questionType?: string | null;
	folderId?: number;
	isAi?: boolean;
	isPendingCorrection?: boolean;
}): QuestionInput {
	return {
		question: source.question,
		options: source.options?.trim() ? source.options : null,
		answer: source.answer,
		questionType: source.questionType?.trim() ? source.questionType.trim() : null,
		folderId: source.folderId ?? 0,
		isAi: source.isAi ?? false,
		isPendingCorrection: source.isPendingCorrection ?? false
	};
}

/** SQLite stores 'YYYY-MM-DD HH:mm:ss' in UTC; browsers must not read it as local. */
export function sqliteUtcToIso(value?: string | null): string {
	if (!value) return '';
	const trimmed = value.trim();
	if (!trimmed) return '';
	const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
		? `${trimmed.replace(' ', 'T')}Z`
		: trimmed;
	return Number.isNaN(new Date(iso).getTime()) ? '' : iso;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '—';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

const adminMessages: Record<string, string> = {
	QUESTION_BANK_DISABLED: '题库服务尚未接入：需要部署配置提供题库地址与内部令牌。',
	QUESTION_BANK_UNAVAILABLE: '无法连接题库服务：检查题库容器是否运行、地址与内部令牌是否正确。',
	INVALID_INPUT: '提交内容不符合服务端契约：检查字段类型与 UTF-8 字节上限。',
	INVALID_REQUEST: '请求参数不合法。',
	MODEL_NOT_CONFIGURED: '开启 AI 前需要填写模型 Base URL 与模型 ID。',
	INVALID_FOLDER: '目标文件夹不存在，刷新文件夹列表后重试。',
	FOLDER_NOT_EMPTY: '文件夹仍包含题目或子文件夹：先移动或删除内容，不做隐式级联删除。',
	TOKEN_LIMIT: '查询客户端数量已达上限，先撤销不再使用的客户端。',
	NOT_FOUND: '记录已不存在，已重新读取列表。',
	BODY_TOO_LARGE: '提交内容超过服务端大小限制。',
	STORAGE_BUSY: '题库存储繁忙，稍后重试。',
	STORAGE_ERROR: '题库存储操作失败，检查数据目录与磁盘空间。',
	SERVICE_PAUSED: '查询已暂停，管理接口仍可用。'
};

export function describeBankError(error: unknown): string {
	if (error instanceof ApiError) {
		const mapped = adminMessages[error.code];
		if (mapped) return mapped;
		if (error.status === 401) return '管理令牌已失效，无法访问题库服务。';
	}
	return describeError(error);
}

export type Tone = 'ok' | 'warn' | 'bad' | 'dim';

export interface OutcomeCopy {
	label: string;
	hint: string;
	tone: Tone;
}

/** Query failures stay business-level: never render provider internals. */
export function describeQueryFailure(result: QueryResult): OutcomeCopy {
	switch (result.code) {
		case 'UNAUTHORIZED':
			return {
				label: '查询令牌无效',
				hint: '令牌缺失、错误或已撤销。此结果只影响查询，不影响管理员登录。',
				tone: 'bad'
			};
		case 'NO_MATCH':
			return {
				label: '本地未命中',
				hint: '题库没有匹配记录，且未开启 AI 或 AI 未返回可用答案。',
				tone: 'warn'
			};
		case 'QUERY_LIMIT':
			return {
				label: '查询超限',
				hint: `每个令牌允许 2 个并发、每分钟 60 次；约 ${result.retryAfterSeconds ?? 60} 秒后再试。`,
				tone: 'warn'
			};
		case 'SERVICE_PAUSED':
			return { label: '查询已暂停', hint: '管理员暂停了查询入口，恢复后重试。', tone: 'warn' };
		case 'QUESTION_BANK_DISABLED':
			return { label: '未接入题库', hint: '主服务未配置题库地址与内部令牌。', tone: 'bad' };
		case 'QUESTION_BANK_UNAVAILABLE':
			return { label: '题库不可用', hint: '主服务无法连接题库服务，检查容器与网络。', tone: 'bad' };
		case 'STORAGE_BUSY':
			return { label: '存储繁忙', hint: '题库数据库繁忙，稍后重试。', tone: 'warn' };
		case 'PROVIDER_TIMEOUT':
			return { label: '预算耗尽', hint: '查询总时间预算用尽，可调高总超时或降低重试次数。', tone: 'warn' };
		case 'TEXT_ONLY':
			return { label: '仅支持文本题', hint: '当前路径不解码图片题或页面抓取。', tone: 'warn' };
		case 'BODY_TOO_LARGE':
			return { label: '查询过大', hint: '单次查询请求不超过 64 KiB。', tone: 'warn' };
		case 'INVALID_INPUT':
			return { label: '查询字段无效', hint: '检查题干与选项的必填和字节上限。', tone: 'warn' };
		case 'CLIENT_TIMEOUT':
			return { label: '等待超时', hint: '页面已停止等待；已接纳的任务仍受服务端预算约束。', tone: 'warn' };
		case 'NETWORK_ERROR':
			return { label: '无法连接', hint: '浏览器无法访问控制台入口，检查网络与代理。', tone: 'bad' };
		default:
			if (result.code === 'INVALID_MODEL_RESPONSE' || result.code.startsWith('PROVIDER_'))
				return {
					label: '模型调用失败',
					hint: '模型响应无效或供应商调用失败，检查模型设置；此处不展示供应商原始错误。',
					tone: 'bad'
				};
			return {
				label: result.code || '查询失败',
				hint: result.message || '题库返回了未分类的错误。',
				tone: 'bad'
			};
	}
}

export interface LogSource {
	label: string;
	className: string;
}

/** 'ai-or-cache' only marks an AI origin record; it does not prove a paid call. */
export function logSourceCopy(source: string): LogSource {
	switch (source) {
		case 'local':
			return { label: '本地命中', className: 'tag--ok' };
		case 'ai-or-cache':
			return { label: 'AI 记录', className: 'tag--warn' };
		case 'error':
			return { label: '失败', className: 'tag--bad' };
		default:
			return { label: source || '未知', className: 'tag--dim' };
	}
}

export function logStatusCopy(status: number): LogSource {
	if (status >= 200 && status < 300) return { label: String(status), className: 'tag--ok' };
	if (status === 429) return { label: '429', className: 'tag--warn' };
	if (status >= 500) return { label: String(status), className: 'tag--bad' };
	return { label: String(status), className: 'tag--dim' };
}

export interface ImportBatch {
	items: QuestionInput[];
	bytes: number;
}

export interface ImportPlan {
	batches: ImportBatch[];
	oversized: number[];
}

/**
 * Batch by both record count (500) and encoded size (1 MiB). The encoded size
 * counts the JSON wrapper and separators because the limit applies to the
 * request body, not to the sum of record strings.
 */
export function planImportBatches(
	items: QuestionInput[],
	maxCount = BANK_LIMITS.importCount,
	maxBytes = BANK_LIMITS.importBytes
): ImportPlan {
	const wrapper = utf8Bytes('{"questions":[]}');
	const batches: ImportBatch[] = [];
	const oversized: number[] = [];
	let current: ImportBatch = { items: [], bytes: wrapper };
	for (let index = 0; index < items.length; index += 1) {
		const bytes = utf8Bytes(JSON.stringify(items[index])) + (current.items.length > 0 ? 1 : 0);
		if (wrapper + bytes > maxBytes) {
			oversized.push(index);
			continue;
		}
		if (current.items.length >= maxCount || current.bytes + bytes > maxBytes) {
			batches.push(current);
			current = { items: [], bytes: wrapper };
		}
		const separator = current.items.length > 0 ? 1 : 0;
		current.items.push(items[index]);
		current.bytes += utf8Bytes(JSON.stringify(items[index])) + separator;
	}
	if (current.items.length > 0) batches.push(current);
	return { batches, oversized };
}

export function questionFolderName(folders: { id: number; name: string }[], id: number): string {
	return folders.find((folder) => folder.id === id)?.name || `文件夹 ${id}`;
}

export function sortedFolders<T extends { id: number; name: string; parentId: number }>(folders: T[]): T[] {
	const byParent = new Map<number, T[]>();
	for (const folder of folders) {
		const list = byParent.get(folder.parentId) || [];
		list.push(folder);
		byParent.set(folder.parentId, list);
	}
	for (const list of byParent.values()) list.sort((left, right) => left.id - right.id);
	const ordered: T[] = [];
	const seen = new Set<number>();
	const walk = (parentId: number, depth: number): void => {
		for (const folder of byParent.get(parentId) || []) {
			if (seen.has(folder.id)) continue;
			seen.add(folder.id);
			ordered.push(folder);
			walk(folder.id, depth + 1);
		}
	};
	walk(0, 0);
	// Folders whose parent is missing still need to be reachable.
	for (const folder of folders) if (!seen.has(folder.id)) ordered.push(folder);
	return ordered;
}

export function folderDepth(folders: { id: number; parentId: number }[], id: number): number {
	const byId = new Map(folders.map((folder) => [folder.id, folder.parentId]));
	let depth = 0;
	let cursor = byId.get(id) ?? 0;
	const seen = new Set<number>();
	while (cursor !== 0 && depth < 16 && !seen.has(cursor)) {
		seen.add(cursor);
		depth += 1;
		cursor = byId.get(cursor) ?? 0;
	}
	return depth;
}

/** Descendants are invalid parents: the service rejects cycles, the UI prevents them. */
export function folderDescendants(folders: { id: number; parentId: number }[], id: number): Set<number> {
	const result = new Set<number>([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const folder of folders) {
			if (!result.has(folder.id) && result.has(folder.parentId)) {
				result.add(folder.id);
				grew = true;
			}
		}
	}
	return result;
}

export function questionStemPreview(question: QuestionBankQuestion): string {
	return question.question.replace(/\s+/g, ' ').trim();
}
