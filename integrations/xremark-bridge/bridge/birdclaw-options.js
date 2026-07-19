(() => {
	"use strict";

	const CONTROL = {
		getState: "birdclaw:xremark:get-state",
		setToken: "birdclaw:xremark:set-token",
		syncNow: "birdclaw:xremark:sync-now",
	};

	const form = document.querySelector("#pairing-form");
	const tokenInput = document.querySelector("#token");
	const syncButton = document.querySelector("#sync-now");
	const pairingStatus = document.querySelector("#pairing-status");
	const syncState = document.querySelector("#sync-state");
	const sequence = document.querySelector("#sequence");
	const lastSuccess = document.querySelector("#last-success");
	const lastError = document.querySelector("#last-error");
	const notice = document.querySelector("#notice");

	function dateLabel(value) {
		if (!Number.isFinite(value)) return "Never";
		return new Date(value).toLocaleString();
	}

	function showNotice(message, isError = false) {
		notice.textContent = message;
		notice.classList.toggle("error", isError);
	}

	async function send(message) {
		try {
			const response = await chrome.runtime.sendMessage(message);
			if (!response || response.ok !== true) {
				throw new Error(response?.error || "The bridge did not respond.");
			}
			return response;
		} catch (error) {
			throw new Error(
				error instanceof Error ? error.message : "The bridge did not respond.",
			);
		}
	}

	async function refresh() {
		try {
			const state = await send({ type: CONTROL.getState });
			pairingStatus.textContent = state.tokenConfigured
				? "Paired"
				: "Token required";
			syncState.textContent = state.status.state;
			sequence.textContent = String(state.sequence);
			lastSuccess.textContent = dateLabel(state.status.lastSuccessAt);
			lastError.textContent = state.status.lastError || "None";
			syncButton.disabled = !state.tokenConfigured;
		} catch (error) {
			showNotice(error.message, true);
		}
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const token = tokenInput.value.trim();
		if (!token) return;
		const submitButton = form.querySelector("button[type='submit']");
		submitButton.disabled = true;
		showNotice("Saving and syncing…");
		try {
			await send({ type: CONTROL.setToken, token });
			tokenInput.value = "";
			showNotice("Pairing token saved. Full snapshot sent.");
		} catch (error) {
			showNotice(error.message, true);
		} finally {
			submitButton.disabled = false;
			await refresh();
		}
	});

	syncButton.addEventListener("click", async () => {
		syncButton.disabled = true;
		showNotice("Syncing…");
		try {
			await send({ type: CONTROL.syncNow });
			showNotice("Full snapshot sent.");
		} catch (error) {
			showNotice(error.message, true);
		} finally {
			syncButton.disabled = false;
			await refresh();
		}
	});

	void refresh();
})();
