import { CONFIG } from './config.js';
import { initTheme, addThemeList } from './modules/theme.js';
import { initEffects, initEffectsToggle } from './modules/effects.js';
import { initPosts } from './modules/blog.js';
import { initPictureColl } from './modules/navigation.js';
import { initRouting } from './modules/routing.js';
import { initTooltips } from './modules/utils.js';
import { initLiveData } from './modules/live.js';

/**
 * Each subsystem is started independently.
 *
 * Previously a single throw anywhere in this list killed everything after it:
 * one missing element in addThemeList() took out the theme picker, the tab
 * routing and the effects toggle at once, and the page just sat there looking
 * fine with nothing working. Failures are now contained and reported.
 */
function safe(name, fn) {
	try {
		fn();
	} catch (err) {
		console.error(`[init] ${name} failed:`, err);
		return err;
	}
	return null;
}

document.addEventListener('DOMContentLoaded', () => {
	const failures = [
		['themes', addThemeList],
		['theme', initTheme],
		['effects', initEffects],
		['effects toggle', initEffectsToggle],
		['blog', initPosts],
		['pictures', initPictureColl],
		['routing', initRouting],
		['tooltips', initTooltips],
		['live data', initLiveData],
	]
		.map(([name, fn]) => (safe(name, fn) ? name : null))
		.filter(Boolean);

	if (!failures.length) return;

	/* A silent half-broken page is the worst outcome — it looks like a content
	   problem rather than a script problem. Say so, on the page. */
	const bar = document.createElement('p');
	bar.id = 'init-error';
	bar.textContent =
		`Some features failed to start (${failures.join(', ')}). ` +
		`Open the browser console for details.`;
	document.body.appendChild(bar);
});
