async function flashBadge({ success = true }) {
	// credit: https://github.com/chitsaou/copy-as-markdown
	const text = success ? '✔' : '✘';
	const color = success ? 'hsl(135, 70%, 30%)' : 'hsl(0, 80%, 40%)';
	const transparent = 'rgba(0, 0, 0, 0)';
	const timeout = 1000;

	try {
		await chrome.action.setBadgeText({ text: text });
		await chrome.action.setBadgeBackgroundColor({ color: color });

		setTimeout(async () => {
			await chrome.action.setBadgeText({ text: '' });
			await chrome.action.setBadgeBackgroundColor({ color: transparent });
		}, timeout);
	}
	catch (error) {
		console.error('Failed to update badge:', error);
	}
}

async function setWorkingBadge() {
	try {
		await chrome.action.setBadgeText({ text: '...' });
		await chrome.action.setBadgeBackgroundColor({ color: 'hsl(225, 100%, 60%)' });
	}
	catch (error) {
		console.error('Failed to set working badge:', error);
	}
}

async function getSelectedTabs() {
	try {
		const tabs = await chrome.tabs.query({ currentWindow: true, highlighted: true });

		console.group('Tabs obtained.');
		tabs.forEach((tab) => console.log(tab.id, tab.url, tab.title));
		console.groupEnd();

		return tabs;
	}
	catch (error) {
		console.error('Failed to get selected tabs:', error);
		return [];
	}
}

async function groupSelectedTabs() {
	try {
		const tabs = await getSelectedTabs();
		if (!tabs || tabs.length === 0) {
			console.log('No tabs found.');
			await flashBadge({ success: false });
			return;
		}

		console.group('Grouping tabs...');
		tabs.forEach((tab) => console.log(tab.url));
		console.groupEnd();

		const groupId = await chrome.tabs.group({
			tabIds: tabs.map((tab) => tab.id),
		});

		console.log('Grouped!');
		await flashBadge({ success: true });
	}
	catch (error) {
		console.log(error);
		await flashBadge({ success: false });
	}
}

async function fetchTabDates(tabs) {
	const unloadedTabs = tabs.filter(tab => tab.discarded || tab.status !== 'complete');

	if (unloadedTabs.length > 0) {
		const RELOAD_TIMEOUT = 15000; // 15 seconds

		const reloadPromises = unloadedTabs.map(tab => {
			return Promise.race([
				new Promise(resolve => {
					const listener = (tabId, changeInfo) => {
						if (tabId === tab.id && changeInfo.status === 'complete') {
							chrome.tabs.onUpdated.removeListener(listener);
							resolve({ status: 'reloaded', tabId: tab.id });
						}
					};
					chrome.tabs.onUpdated.addListener(listener);
					chrome.tabs.reload(tab.id);
				}),
				new Promise(resolve => {
					setTimeout(() => {
						resolve({ status: 'timeout', tabId: tab.id });
					}, RELOAD_TIMEOUT);
				})
			]);
		});

		const results = await Promise.all(reloadPromises);
		console.log('Tab reload results:', results);
	}

	const tabIds = tabs.map((tab) => tab.id);

	const manifest = chrome.runtime.getManifest();
	const { FIREFOX_EXTENSION_ID, CHROME_EXTENSION_ID } = manifest.externals.heliotropium;
	const extensionId = navigator.userAgent.includes('Firefox')
		? FIREFOX_EXTENSION_ID
		: CHROME_EXTENSION_ID;

	const fallbackData = tabIds.map(tabId => {
		const tab = tabs.find(t => t.id === tabId);
		return {
			tabId,
			url: tab.url,
			title: null,
			dateString: null,
			date: { year: null, month: null, day: null },
		};
	});

	try {
		console.log('Sending message to extension:', { action: 'get-dates', tabIds });

		const response = await chrome.runtime.sendMessage(extensionId, { action: 'get-dates', tabIds });

		console.log('Raw response from extension:', response);
		console.log('Response type:', typeof response);

		// Handle different response formats
		let processedData;

		if (!response) {
			console.log('No response from extension');
			await flashBadge({ success: false });
			return fallbackData;
		}
		else if (response.error) {
			console.log('Extension returned error:', response.error);
			await flashBadge({ success: false });
			return fallbackData;
		}
		else if (response.data && Array.isArray(response.data)) {
			// Expected format: { data: [...] }
			console.log('Using response.data array');
			processedData = response.data;
		}
		else {
			console.log('Unexpected response format:', response);
			await flashBadge({ success: false });
			return fallbackData;
		}

		console.log('Processed data:', processedData);

		const dataByTabId = {};
		processedData.forEach(item => {
			dataByTabId[item.tabId] = item;
		});

		const completeData = tabIds.map(tabId => {
			if (dataByTabId[tabId]) {
				return dataByTabId[tabId];
			}
			else {
				const tab = tabs.find(t => t.id === tabId);
				return {
					tabId,
					url: tab.url,
					title: null,
					dateString: null,
					date: { year: null, month: null, day: null },
				};
			}
		});

		return completeData;
	}
	catch (error) {
		console.log('Failed to fetch tab dates:', error);
		await flashBadge({ success: false });
		return fallbackData;
	}
}

function sortTabsByDate(tabs, tabDataArray) {
	console.log('Sorting tabs by date...');
	console.log('Tab data:', tabDataArray);
	console.log('Current tab ids:', tabs.map(tab => tab.id));

	const dateMap = {};
	tabDataArray.forEach(({ tabId, date }) => {
		const { year = '', month = '', day = '' } = date || {};
		dateMap[tabId] = `${year}-${month}-${day}`;
	});
	console.log('Date map:', dateMap);

	const sortedTabs = tabs.toSorted((a, b) => {
		const dateA = dateMap[a.id] || '';
		const dateB = dateMap[b.id] || '';
		return dateA.localeCompare(dateB);
	});

	// move tabs without dates to the start of the array
	const undatedTabs = sortedTabs.filter(tab => !dateMap[tab.id]);
	const datedTabs = sortedTabs.filter(tab => dateMap[tab.id]);
	sortedTabs.length = 0;
	sortedTabs.push(...undatedTabs, ...datedTabs);

	console.log('Sorted tab ids:', sortedTabs.map(tab => tab.id));

	return sortedTabs;
}

// make a new array from tabs and the result from fetchTabdates, with each item being an object whose key is the date and the value is an array of tab ids. undated tabs should be grouped together, perhaps with a key of 'undated'
function makeDateTabGroups(tabs, tabDataArray) {
	const tabGroups = {};
	tabs.forEach((tab) => {
		const tabData = tabDataArray.find((data) => data.tabId === tab.id);
		const { date } = tabData || {};
		const dateKey = date ? `${date.year}-${date.month}-${date.day}` : 'undated';
		if (!tabGroups[dateKey]) {
			tabGroups[dateKey] = [];
		}
		tabGroups[dateKey].push(tab.id);
	});
	return tabGroups;
}

async function groupSelectedTabsByDate() {
	try {
		await setWorkingBadge();

		const tabs = await getSelectedTabs();
		if (!tabs || tabs.length === 0) {
			console.log('No tabs found.');
			await flashBadge({ success: false });
			return;
		}
		console.group('Grouping tabs by date...');
		tabs.forEach((tab) => console.log(tab.id, tab.url));
		console.groupEnd();

		// 1. fetch dates for selected tabs, gets an array of objects with tabId and date
		const tabDataArray = await fetchTabDates(tabs);
		if (!tabDataArray || tabDataArray.length === 0) {
			console.log('No tab data found.');
			await flashBadge({ success: false });
			return;
		}
		console.group('Tab data:');
		tabDataArray.forEach((tabData) => console.log(tabData.tabId, tabData.date));
		console.groupEnd();

		// 2. sort the array of tabs by date. move tabs with undated dates to the start of the array
		const sortedTabs = sortTabsByDate(tabs, tabDataArray);
		if (!sortedTabs || sortedTabs.length === 0) {
			console.log('No sorted tabs found.');
			await flashBadge({ success: false });
			return;
		}
		console.group('Sorted tabs:');
		sortedTabs.forEach((tab) => console.log(tab.id, tab.url));
		console.groupEnd();

		// 3. make tabGroups object
		const tabGroups = makeDateTabGroups(sortedTabs, tabDataArray);
		console.group('Tab groups:');
		console.log(tabGroups);
		Object.entries(tabGroups).forEach(([date, tabIds]) => {
			console.log(date, tabIds);
		});
		console.groupEnd();

		// 4. group the tabs by date, using the array from step 3. if tabGroups.update() is supported, use the date (or 'undated') as the name of the group
		const groupPromises = Object.entries(tabGroups).map(async ([date, tabIds]) => {
			try {
				console.log('Grouping tabs on date:', date);
				const groupId = await chrome.tabs.group({ tabIds });
				const tabGroup = await chrome.tabGroups.get(groupId);
				console.log('Created group:', tabGroup);

				if (date !== 'undated') {
					await chrome.tabGroups.update(groupId, { title: date });
				}
				console.log('Grouped tabs by date:', date, tabIds);
			}
			catch (error) {
				console.log('Error grouping tabs:', error);
			}
		});
		await Promise.all(groupPromises);

		console.log('Grouped all tabs by date!');
		await flashBadge({ success: true });
	}
	catch (error) {
		console.log('Error grouping tabs by date:', error);
		await flashBadge({ success: false });
	}
}

chrome.action.onClicked.addListener(async () => {
	// fixme: use `groupSelectedTabsByUrl()` by default. change to `groupSelectedTabsByDate()` if heliotropium is installed
	await groupSelectedTabsByDate();
});

chrome.commands.onCommand.addListener(async (command) => {
	if (command === 'group-tabs') {
		await groupSelectedTabs();
	}
	if (command === 'group-tabs-by-date') {
		await groupSelectedTabsByDate();
	}
});

function isDarkMode() {
	if (typeof window === 'undefined' || !('matchMedia' in window)) {
		return false;
	}
	return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

async function updateIcon() {
	const icon = isDarkMode() ? 'icons/icon_white.png' : 'icons/icon_black.png';
	try {
		await chrome.action.setIcon({ path: icon });

		const tabs = await getSelectedTabs();
		if (tabs.length < 2) {
			await chrome.action.disable();
			return;
		}

		await chrome.action.enable();
	}
	catch (error) {
		console.log(error);
	}
}

chrome.windows.onFocusChanged.addListener(async () => {
	await updateIcon();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
	console.log('Tab activated:', tabId);
	await updateIcon();
});

chrome.tabs.onHighlighted.addListener(async ({ tabIds }) => {
	console.log('Tab highlighted:', tabIds);
	await updateIcon();
});

// top-level await is not supported in service workers
function initialize() {
	updateIcon().catch((error) => {
		console.log('Error on initialization:', error);
	});
}

initialize();
