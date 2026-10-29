import { reactive } from 'vue';

export type ToastKind = 'ok' | 'error' | 'info';

export interface Toast {
	id: number;
	kind: ToastKind;
	text: string;
}

const items = reactive<Toast[]>([]);
let sequence = 0;

export function toast(text: string, kind: ToastKind = 'info'): void {
	const id = ++sequence;
	items.push({ id, kind, text });
	setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4200);
}

export function dismiss(id: number): void {
	const index = items.findIndex((item) => item.id === id);
	if (index !== -1) items.splice(index, 1);
}

export function useToasts() {
	return { items, dismiss };
}
