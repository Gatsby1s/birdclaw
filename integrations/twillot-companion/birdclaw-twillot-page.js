(() => {
	"use strict";

	const CONTROL = {
		getActiveJob: "birdclaw:twillot:get-active-job",
		pageOpened: "birdclaw:twillot:page-opened",
		openOptions: "birdclaw:twillot:open-options",
	};

	function publicUidFromLocation() {
		return new URL(location.href).searchParams.get("publicUid")?.trim() || "";
	}

	function request(message) {
		return new Promise((resolve, reject) => {
			chrome.runtime.sendMessage(message, (response) => {
				if (chrome.runtime.lastError || !response?.ok) {
					reject(
						new Error(response?.error || "BirdClaw companion is unavailable."),
					);
					return;
				}
				resolve(response);
			});
		});
	}

	function createPrompt(job) {
		if (document.querySelector("#birdclaw-twillot-companion")) return;
		const root = document.createElement("aside");
		root.id = "birdclaw-twillot-companion";
		root.setAttribute("role", "status");
		root.style.cssText = [
			"position:fixed",
			"right:16px",
			"bottom:16px",
			"z-index:2147483647",
			"box-sizing:border-box",
			"width:min(360px,calc(100vw - 32px))",
			"padding:14px 15px",
			"border:1px solid rgba(148,163,184,.45)",
			"border-radius:10px",
			"background:#111827",
			"color:#f8fafc",
			"box-shadow:0 8px 24px rgba(0,0,0,.22)",
			"font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
		].join(";");
		const title = document.createElement("strong");
		title.textContent = "BirdClaw history queue";
		title.style.cssText = "display:block;margin-bottom:5px;font-size:14px";
		const text = document.createElement("div");
		text.textContent = `Please click Start in Twillot for @${job.handle}. BirdClaw will receive the local public-post archive automatically.`;
		const detail = document.createElement("div");
		detail.style.cssText = "margin-top:7px;color:#cbd5e1";
		detail.textContent =
			"The companion never clicks Twillot or calls an unpublished Twillot API. Completion is recorded only as caught_up_unverified.";
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = "Open companion settings";
		button.style.cssText = [
			"min-height:36px",
			"margin-top:10px",
			"padding:7px 11px",
			"border:1px solid #60a5fa",
			"border-radius:7px",
			"background:#2563eb",
			"color:white",
			"font:inherit",
			"font-weight:650",
			"cursor:pointer",
		].join(";");
		button.addEventListener("click", () => {
			void request({ type: CONTROL.openOptions });
		});
		root.append(title, text, detail, button);
		(document.body || document.documentElement).append(root);
	}

	async function boot() {
		const publicUid = publicUidFromLocation();
		if (!publicUid) return;
		const response = await request({
			type: CONTROL.getActiveJob,
			publicUid,
		});
		if (!response.job) return;
		createPrompt(response.job);
		await request({ type: CONTROL.pageOpened, publicUid });
	}

	if (globalThis.__BIRDCLAW_TWILLOT_TEST__) {
		globalThis.__birdclawTwillotPageTest = {
			CONTROL,
			publicUidFromLocation,
		};
	} else {
		void boot().catch(() => {});
	}
})();
