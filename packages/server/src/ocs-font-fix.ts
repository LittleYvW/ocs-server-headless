import { parse, type Node } from 'acorn';
import type { UserScriptMetadata } from './types';
import { filterFontCharacters } from './font-cmap';

export const OCS_FONT_FIX_MARKER = 'OCS_HEADLESS_FONT_CMAP_V1';
export type OCSFontFix = 'applied' | 'not-needed' | 'unrecognized';

type AST = Node & Record<string, any>;
const isFunction = (node: AST) =>
	['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);

function visit(root: AST, callback: (node: AST, parent?: AST) => boolean | void) {
	const pending: [AST, AST?][] = [[root]];
	while (pending.length) {
		const [node, parent] = pending.pop()!;
		if (callback(node, parent) === false) continue;
		for (const value of Object.values(node)) {
			const children = Array.isArray(value) ? value : [value];
			for (const child of children) {
				if (child && typeof child === 'object' && typeof child.type === 'string') pending.push([child, node]);
			}
		}
	}
}

function facts(fn: AST, includeNested = false) {
	const strings = new Set<string>();
	const calls = new Set<string>();
	const members = new Set<string>();
	const constructors = new Set<string>();
	const config = new Map<string, Set<string>>();
	let threshold = false;
	visit(fn.body, (node) => {
		if (isFunction(node) && !includeNested) return false;
		if (node.type === 'Literal' && typeof node.value === 'string') strings.add(node.value);
		if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.add(node.callee.name);
		if (node.type === 'NewExpression' && node.callee.type === 'Identifier') constructors.add(node.callee.name);
		if (node.type === 'MemberExpression') {
			const property = node.computed ? node.property.value : node.property.name;
			if (typeof property === 'string') {
				members.add(property);
				if (node.object.type === 'Identifier') {
					if (!config.has(node.object.name)) config.set(node.object.name, new Set());
					config.get(node.object.name)!.add(property);
				}
			}
		}
		if (node.type === 'BinaryExpression' && node.operator === '<' && node.right.value === 1000) threshold = true;
	});
	return { strings, calls, members, constructors, config, threshold };
}

function isOCS(metadata: UserScriptMetadata): boolean {
	if (!(metadata.values.name || []).some((name) => /^OCS(?:\s|网课)/i.test(name))) return false;
	return ['source', 'homepage', 'namespace'].some((key) =>
		(metadata.values[key] || []).some((value) => {
			try {
				const url = new URL(value);
				return (
					['docs.ocsjs.com', 'ocsjs.com', 'enncy.cn'].includes(url.hostname) ||
					(url.hostname === 'github.com' && /^\/ocsjs\/ocsjs(?:\/|$)/.test(url.pathname))
				);
			} catch {
				return false;
			}
		})
	);
}

/** Patch only the known OCS decoder structure; never execute imported source in Node. */
export function adaptOCSFontSource(code: string, metadata: UserScriptMetadata): { code: string; fontFix: OCSFontFix } {
	if (!isOCS(metadata) || !code.includes('font-cxsecret') || !code.includes('font-decrypt-'))
		return { code, fontFix: 'not-needed' };
	if (code.includes(`/* ${OCS_FONT_FIX_MARKER} */`)) return { code, fontFix: 'applied' };
	try {
		const functions: { node: AST; name?: string; info: ReturnType<typeof facts> }[] = [];
		// Managers wrap userscripts in a function; their entrypoints may return early.
		visit(
			parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }) as AST,
			(node, parent) => {
				if (!isFunction(node) || node.body.type !== 'BlockStatement') return;
				const name =
					node.id?.name ||
					(parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? parent.id.name : undefined);
				functions.push({ node, name, info: facts(node) });
			}
		);
		const checks = new Set(
			functions
				.filter(
					({ node, info }) =>
						info.strings.has('serif') &&
						info.strings.has('sans-serif') &&
						info.threshold &&
						facts(node, true).members.has('getImageData')
				)
				.map(({ name }) => name)
				.filter((name): name is string => !!name)
		);
		if (!checks.size) return { code, fontFix: 'not-needed' };
		const candidates = functions.filter(({ node, info }) => {
			if (!node.async || node.generator || node.params.length !== 3) return false;
			if (!node.params.every((param: AST) => param.type === 'Identifier')) return false;
			const properties = info.config.get(node.params[2].name);
			return (
				info.strings.has('font-decrypt-') &&
				info.constructors.has('FontFace') &&
				properties?.has('refTableUrl') &&
				properties.has('useWorker') &&
				[...checks].some((name) => info.calls.has(name))
			);
		});
		if (candidates.length !== 1) return { code, fontFix: 'unrecognized' };
		const fn = candidates[0].node;
		let insertion = fn.body.start + 1;
		for (const statement of fn.body.body) {
			if (typeof statement.directive !== 'string') break;
			insertion = statement.end;
		}
		const guard = `\n/* ${OCS_FONT_FIX_MARKER} */\n${fn.params[1].name} = (${filterFontCharacters.toString()})(${
			fn.params[0].name
		}, ${fn.params[1].name});\n`;
		return { code: code.slice(0, insertion) + guard + code.slice(insertion), fontFix: 'applied' };
	} catch {
		return { code, fontFix: 'unrecognized' };
	}
}
