import type { ElementHandle, Frame, FrameLocator, Locator, Page } from 'playwright-core';
import { bad } from './validation';

export interface BrowserElement {
	selector: string;
	framePath: string[];
	tag: string;
	bounds: { x: number; y: number; width: number; height: number };
}

export function browserFramePath(value: unknown): string[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.length > 8 ||
		value.some((part) => typeof part !== 'string' || !part.trim() || part.length > 2000)
	)
		return bad('Expected at most 8 frame selectors, each at most 2000 characters');
	return value;
}

export function browserLocator(page: Page, selector: string, framePath: unknown = []): Locator {
	let scope: Page | FrameLocator = page;
	for (const frame of browserFramePath(framePath)) scope = scope.frameLocator(frame);
	return scope.locator(selector);
}

/** Fixed, read-only hit testing. Neither script source nor arbitrary properties come from the client. */
export async function inspectBrowserElement(page: Page, x: number, y: number): Promise<BrowserElement | null> {
	let frame = page.mainFrame();
	let position = { x, y };
	let geometry = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
	const framePath: string[] = [];
	for (let depth = 0; depth <= 8; depth++) {
		const handle = await frame.evaluateHandle(({ x, y }) => {
			let element = document.elementFromPoint(x, y);
			for (let depth = 0; element?.shadowRoot && depth < 20; depth++) {
				const inner = element.shadowRoot.elementFromPoint(x, y);
				if (!inner || inner === element) break;
				element = inner;
			}
			return element;
		}, position);
		try {
			const element = handle.asElement() as ElementHandle<Element> | null;
			if (!element) return null;
			const selector = await selectorFor(frame, element);
			if (!selector) return null;
			const tag = await element.evaluate((element) => element.localName);
			if ((tag === 'iframe' || tag === 'frame') && depth < 8) {
				const child = await element.contentFrame();
				const inner = await element.evaluate((element, point) => {
					const rect = element.getBoundingClientRect();
					const html = element as HTMLElement;
					// Translate through borders and axis-aligned CSS scaling of the iframe.
					for (let ancestor: Element | null = element, depth = 0; ancestor; depth++) {
						if (depth >= 64) return null;
						const style = getComputedStyle(ancestor);
						const transform = style.transform === 'none' ? null : new DOMMatrixReadOnly(style.transform);
						if (
							style.rotate !== 'none' ||
							style.perspective !== 'none' ||
							(style.scale !== 'none' && style.scale.split(/\s+/).some((scale) => Number(scale) <= 0)) ||
							(transform &&
								(!transform.is2D ||
									transform.a <= 0 ||
									transform.d <= 0 ||
									Math.abs(transform.b) > 0.001 ||
									Math.abs(transform.c) > 0.001))
						)
							return null;
						const root = ancestor.getRootNode();
						ancestor = ancestor.parentElement || (root instanceof ShadowRoot ? root.host : null);
					}
					if (!rect.width || !rect.height || !html.offsetWidth || !html.offsetHeight) return null;
					const scaleX = rect.width / html.offsetWidth;
					const scaleY = rect.height / html.offsetHeight;
					const x = (point.x - rect.left) / scaleX - html.clientLeft;
					const y = (point.y - rect.top) / scaleY - html.clientTop;
					if (x < 0 || y < 0 || x >= html.clientWidth || y >= html.clientHeight) return null;
					return {
						position: { x, y },
						scaleX,
						scaleY,
						x: rect.left + html.clientLeft * scaleX,
						y: rect.top + html.clientTop * scaleY
					};
				}, position);
				if (child && inner) {
					framePath.push(selector);
					frame = child;
					position = inner.position;
					geometry = {
						x: geometry.x + inner.x * geometry.scaleX,
						y: geometry.y + inner.y * geometry.scaleY,
						scaleX: geometry.scaleX * inner.scaleX,
						scaleY: geometry.scaleY * inner.scaleY
					};
					continue;
				}
			}
			// OOPIF boundingBox() does not consistently preserve ancestor iframe scaling.
			// Map the local DOM rectangle through the same frame transforms used for hit testing.
			const rect = await element.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
			});
			const bounds = {
				x: geometry.x + rect.x * geometry.scaleX,
				y: geometry.y + rect.y * geometry.scaleY,
				width: rect.width * geometry.scaleX,
				height: rect.height * geometry.scaleY
			};
			if (bounds.width <= 0 || bounds.height <= 0) return null;
			return { selector, framePath, tag, bounds };
		} finally {
			await handle.dispose();
		}
	}
	return null;
}

async function selectorFor(frame: Frame, element: ElementHandle<Element>): Promise<string | null> {
	const candidates = await element.evaluate((element) => {
		const local = (target: Element, structural: boolean): string | null => {
			const root = target.getRootNode() as Document | ShadowRoot;
			const unique = (selector: string) => root.querySelectorAll(selector).length === 1;
			if (!structural) {
				for (const attr of ['id', 'data-testid', 'data-test', 'data-qa', 'name', 'aria-label']) {
					const value = target.getAttribute(attr);
					if (!value || value.length > 180) continue;
					const selector =
						attr === 'id' ? `#${CSS.escape(value)}` : `${CSS.escape(target.localName)}[${attr}=${CSS.escape(value)}]`;
					if (unique(selector)) return selector;
				}
			}
			const parts: string[] = [];
			for (let node: Element | null = target; node && parts.length < 24; node = node.parentElement) {
				const name = CSS.escape(node.localName);
				const siblings = node.parentElement
					? Array.from(node.parentElement.children).filter((sibling) => sibling.localName === node!.localName)
					: [];
				parts.unshift(siblings.length > 1 ? `${name}:nth-of-type(${siblings.indexOf(node) + 1})` : name);
				const selector = parts.join(' > ');
				if ((!structural || !node.parentElement) && unique(selector)) return selector;
			}
			return null;
		};
		const build = (structural: boolean) => {
			const parts: string[] = [];
			for (let target: Element | null = element; target && parts.length < 20; ) {
				const selector = local(target, structural);
				if (!selector) return null;
				parts.unshift(`css=${selector}`);
				const root = target.getRootNode();
				target = root instanceof ShadowRoot ? root.host : null;
			}
			const selector = parts.join(' >> ');
			return selector.length <= 2000 ? selector : null;
		};
		return [build(false), build(true)];
	});
	for (const selector of candidates) {
		if (!selector) continue;
		const locator = frame.locator(selector);
		if ((await locator.count()) !== 1) continue;
		// Avoid returning a selector for a different node after a DOM update or a shadow-root collision.
		const match = await locator.elementHandle({ timeout: 1000 });
		try {
			if (match && (await element.evaluate((element, match) => element === match, match))) return selector;
		} finally {
			await match?.dispose();
		}
	}
	return null;
}
