import { openPost, initPosts } from './blog.js';
import { changeTab } from './navigation.js';
import { CONFIG } from '../config.js';

const DEFAULT_HASH = CONFIG.defaultHash;

export function routing(hash) {
	const [route, query] = hash.slice(1).split('?');
	const params = new URLSearchParams(query || '');

	if (route === 'blog') {
		if (params.has('id')) {
			openPost(params.get('id'));
			document.getElementById('blog').classList.add('post-open');
		} else {
			initPosts();
		}
	} else {
		document.getElementById('blog').classList.remove('post-open');
	}

	if (route === 'home') {
		document.getElementById('home').style.display = 'block';
	} else {
		document.getElementById('home').style.display = 'none';
	}

	changeTab(route);
}

export function defaultHash() {
	history.replaceState(null, null, DEFAULT_HASH);

	return DEFAULT_HASH;
}

export function removeIDFromHash() {
	location.hash = location.hash.split('?')[0];
}

export function initRouting() {
	if (location.hash === '') {
		history.replaceState(null, null, DEFAULT_HASH);
	}

	window.addEventListener('hashchange', function () {
		routing(location.hash);
	});
	routing(location.hash || defaultHash());
}
