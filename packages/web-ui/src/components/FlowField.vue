<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

const canvas = ref<HTMLCanvasElement>();

interface Line {
	base: number;
	amp1: number;
	amp2: number;
	freq1: number;
	freq2: number;
	speed1: number;
	speed2: number;
	phase: number;
	alpha: number;
	accent: boolean;
}

const TOTAL = 24;
let context: CanvasRenderingContext2D | null = null;
let width = 0;
let height = 0;
let ratio = 1;
let start = 0;
let frame = 0;
let lines: Line[] = [];
const reduceMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function hash(value: number): number {
	const x = Math.sin(value * 127.1 + 311.7) * 43758.5453;
	return x - Math.floor(x);
}

function build(): void {
	lines = Array.from({ length: TOTAL }, (_, index) => ({
		base: (height * (index + 0.8)) / (TOTAL + 0.6),
		amp1: height * (0.016 + hash(index) * 0.042),
		amp2: height * (0.005 + hash(index + 11) * 0.015),
		freq1: Math.PI * (1 + hash(index + 2) * 1.1),
		freq2: Math.PI * (2.4 + hash(index + 3) * 1.6),
		speed1: 0.06 + hash(index + 4) * 0.1,
		speed2: 0.05 + hash(index + 5) * 0.08,
		phase: hash(index + 6) * Math.PI * 2,
		alpha: index % 9 === 4 ? 0.09 + hash(index + 7) * 0.04 : 0.03 + hash(index + 8) * 0.032,
		accent: index % 9 === 4
	}));
}

function lineY(line: Line, nx: number, time: number): number {
	return (
		line.base +
		Math.sin(nx * line.freq1 + time * line.speed1 + line.phase) * line.amp1 +
		Math.sin(nx * line.freq2 - time * line.speed2 + line.phase * 1.7) * line.amp2
	);
}

function signal(context2d: CanvasRenderingContext2D, line: Line, time: number, offset: number): void {
	const span = Math.min(180, width * 0.16);
	const progress = ((time * 0.045 + offset) % 1.32) - 0.16;
	const center = progress * width;
	const from = center - span / 2;
	context2d.beginPath();
	for (let x = 0; x <= span; x += Math.max(6, span / 18)) {
		const y = lineY(line, (from + x) / width, time);
		if (x === 0) context2d.moveTo(from + x, y);
		else context2d.lineTo(from + x, y);
	}
	context2d.strokeStyle = 'rgba(123, 220, 190, 0.2)';
	context2d.lineWidth = 1;
	context2d.stroke();
	context2d.beginPath();
	context2d.arc(from + span, lineY(line, (from + span) / width, time), 1.3, 0, Math.PI * 2);
	context2d.fillStyle = 'rgba(123, 220, 190, 0.5)';
	context2d.fill();
}

function draw(now: number): void {
	const ctx = context;
	if (!ctx || !width || !height) return;
	const time = (now - start) / 1000;
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	ctx.clearRect(0, 0, width, height);
	ctx.lineWidth = 1;
	const step = Math.max(18, width / 64);
	for (const line of lines) {
		ctx.beginPath();
		let first = true;
		for (let x = -step; x <= width + step; x += step) {
			const y = lineY(line, x / width, time);
			if (first) {
				ctx.moveTo(x, y);
				first = false;
			} else {
				ctx.lineTo(x, y);
			}
		}
		ctx.strokeStyle = line.accent ? `rgba(123, 220, 190, ${line.alpha})` : `rgba(210, 226, 240, ${line.alpha})`;
		ctx.stroke();
	}
	if (lines.length > 16) {
		signal(ctx, lines[5], time, 0);
		signal(ctx, lines[15], time, 0.48);
	}
}

function loop(now: number): void {
	frame = requestAnimationFrame(loop);
	if (!document.hidden) draw(now);
}

function resize(): void {
	const element = canvas.value;
	if (!element) return;
	ratio = Math.min(window.devicePixelRatio || 1, 1.75);
	width = window.innerWidth;
	height = window.innerHeight;
	element.width = Math.floor(width * ratio);
	element.height = Math.floor(height * ratio);
	build();
	if (reduceMotion) draw(start);
}

onMounted(() => {
	const element = canvas.value;
	if (!element) return;
	context = element.getContext('2d');
	start = performance.now();
	resize();
	window.addEventListener('resize', resize);
	if (!reduceMotion) frame = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
	cancelAnimationFrame(frame);
	window.removeEventListener('resize', resize);
});
</script>

<template>
	<canvas
		ref="canvas"
		class="flow-canvas"
		aria-hidden="true"
	></canvas>
</template>

<style scoped>
.flow-canvas {
	opacity: 0.85;
}
</style>
