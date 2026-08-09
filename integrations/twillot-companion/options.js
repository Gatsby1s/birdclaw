(() => {
	"use strict";

	const CONTROL = {
		getState: "birdclaw:twillot:get-state",
		saveSettings: "birdclaw:twillot:save-settings",
		syncNow: "birdclaw:twillot:sync-now",
	};

	const form = document.querySelector("#settings-form");
	const endpoint = document.querySelector("#endpoint");
	const token = document.querySelector("#token");
	const pairingStatus = document.querySelector("#pairing-status");
	const queueStatus = document.querySelector("#queue-status");
	const lastSuccess = document.querySelector("#last-success");
	const lastError = document.querySelector("#last-error");
	const syncNow = document.querySelector("#sync-now");

	async function request(message) {
		const response = await chrome.runtime.sendMessage(message);
		if (!response?.ok) throw new Error(response?.error || "Request failed.");
		return response;
	}

	function formatTime(value) {
		if (!Number.isFinite(value)) return "Never";
		return new Date(value).toLocaleString();
	}

	function render(state) {
		endpoint.value = state.endpoint;
		token.value = "";
		token.placeholder = state.tokenConfigured
			? "Saved — enter a new token to replace it"
			: "Paste the pairing token from BirdClaw";
		token.required = !state.tokenConfigured;
		pairingStatus.textContent = state.tokenConfigured
			? "Configured"
			: "Missing";
		queueStatus.textContent = state.activeJob
			? `Waiting on @${state.activeJob.handle || state.activeJob.externalUserId}`
			: state.pendingBatch
				? "Retrying a saved batch"
				: state.status?.state || "Idle";
		lastSuccess.textContent = formatTime(state.status?.lastSuccessAt);
		lastError.textContent = state.status?.lastError || "None";
	}

	async function refresh() {
		try {
			render((await request({ type: CONTROL.getState })).state);
		} catch (error) {
			lastError.textContent =
				error instanceof Error ? error.message : String(error);
		}
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		lastError.textContent = "Saving…";
		try {
			await request({
				type: CONTROL.saveSettings,
				endpoint: endpoint.value,
				token: token.value,
			});
			await refresh();
		} catch (error) {
			lastError.textContent =
				error instanceof Error ? error.message : String(error);
		}
	});

	syncNow.addEventListener("click", async () => {
		lastError.textContent = "Checking…";
		try {
			await request({ type: CONTROL.syncNow });
			await refresh();
		} catch (error) {
			lastError.textContent =
				error instanceof Error ? error.message : String(error);
		}
	});

	void refresh();
})();
