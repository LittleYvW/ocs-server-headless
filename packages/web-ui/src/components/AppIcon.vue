<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number; strokeWidth?: number }>(), {
	size: 16,
	strokeWidth: 1.3
});

const paths: Record<string, string[]> = {
	grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
	browser: ['M3 5h18v14H3z', 'M3 9h18', 'M6 7h.01', 'M9 7h.01', 'M12 7h.01'],
	code: ['m9 7-5 5 5 5', 'm15 7 5 5-5 5'],
	settings: ['M4 8h9', 'M17 8h3', 'M4 16h3', 'M11 16h9', 'M15 5.5v5', 'M9 13.5v5'],
	events: ['M3 12h4l2-5 3 10 2-5h7'],
	plus: ['M12 5v14', 'M5 12h14'],
	play: ['M8 5.5v13l10-6.5z'],
	stop: ['M7 7h10v10H7z'],
	restart: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'],
	refresh: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'],
	download: ['M12 4v11', 'm8 11 4 4 4-4', 'M5 20h14'],
	close: ['M6 6l12 12', 'M18 6 6 18'],
	right: ['m9 6 6 6-6 6'],
	left: ['m15 6-6 6 6 6'],
	check: ['m5 13 4 4 10-11'],
	warning: ['M12 4 2.5 20h19z', 'M12 10v4', 'M12 17h.01'],
	lock: ['M7 10V7a5 5 0 0 1 10 0v3', 'M5 10h14v10H5z'],
	eye: [
		'M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z',
		'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'
	],
	'eye-off': [
		'M3 3l18 18',
		'M10.6 6.7A9.7 9.7 0 0 1 12 6.5c6 0 9.5 5.5 9.5 5.5a17 17 0 0 1-3.1 3.6',
		'M6.4 8.2A17.8 17.8 0 0 0 2.5 12S6 17.5 12 17.5a9.7 9.7 0 0 0 3.2-.5',
		'M9.9 9.9a3 3 0 0 0 4.2 4.2'
	],
	trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
	edit: ['M4 20h4L20 8l-4-4L4 16z', 'M14 6l4 4'],
	pause: ['M9 5v14', 'M15 5v14'],
	external: ['M14 4h6v6', 'M20 4 10 14', 'M19 13v6H5V5h6'],
	file: ['M6 3h8l4 4v14H6z', 'M14 3v5h5'],
	clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
	terminal: ['M4 5h16v14H4z', 'm8 10 2 2-2 2', 'M13 14h3'],
	power: ['M12 4v8', 'M7 7a7 7 0 1 0 10 0'],
	link: [
		'M10 13a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7L11 6',
		'M14 11a4 4 0 0 0-5.7 0L6 13.3a4 4 0 0 0 5.7 5.7L13 18'
	],
	dot: ['M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z']
};
</script>

<template>
	<svg
		:width="size"
		:height="size"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		:stroke-width="strokeWidth"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<path
			v-for="(d, index) in paths[name] || paths.dot"
			:key="index"
			:d="d"
		/>
	</svg>
</template>
