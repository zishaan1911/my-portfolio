export const CONFIG = {
	defaultTheme: 'terminal',
	seasonalTheme: false, // will change the default theme based on the date (unless a theme is already set in local storage)

	// effects
	effectsDisabledByDefault: false,
	effectsDisabledByDefaultMobile: true,
	displayEffectsSwitch: true,

	// additional effects
	movingText: true, // example: title text
	crtEffect: true,
	noiseEffect: true,
	grungeOverlay: true,

	// tabs
	defaultHash: '#home',
	animationOnTabChange: true, // disabled when effects are disabled
	writeAnimationOnTabChange: false, // animationOnTabChange must be true | may cause performance issues

	// live data (written by scripts/sync.mjs, refreshed by GitHub Actions)
	liveData: true,

	// blog
	// Points at the local file, NOT the upstream author's data domain.
	// The blog tab is currently hidden from the nav in index.html; add its
	// <li> back once src/example/blog.xml has real posts in it.
	blogUrl: 'src/example/blog.xml',
	useExample: true,
	writeAnimationOnPostOpen: false,
	showEstimatedReadTime: true,
};
