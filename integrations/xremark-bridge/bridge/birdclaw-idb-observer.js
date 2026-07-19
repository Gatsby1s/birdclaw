(() => {
	"use strict";

	const INSTALL_FLAG = "__birdclawXRemarkIdbObserverInstalled";
	const DATABASE_NAME = "xRemark";
	const OBSERVED_STORES = new Set(["remarks", "tags", "categories"]);
	const MESSAGE_TYPE = "birdclaw:xremark:database-mutated";

	if (globalThis[INSTALL_FLAG]) return;
	Object.defineProperty(globalThis, INSTALL_FLAG, {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});

	const observedTransactions = new WeakSet();

	function notifyWorker() {
		try {
			const result = chrome.runtime.sendMessage({
				type: MESSAGE_TYPE,
				database: DATABASE_NAME,
			});
			if (result && typeof result.catch === "function") result.catch(() => {});
		} catch {
			// The official operation has already completed; bridge availability must not affect it.
		}
	}

	function observeTransaction(transaction, storeName) {
		if (
			!transaction ||
			transaction.db?.name !== DATABASE_NAME ||
			!OBSERVED_STORES.has(storeName) ||
			observedTransactions.has(transaction)
		) {
			return;
		}
		observedTransactions.add(transaction);
		transaction.addEventListener("complete", notifyWorker, { once: true });
	}

	function wrapMethod(prototype, methodName, transactionDetails) {
		if (!prototype) return;
		const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
		if (!descriptor || typeof descriptor.value !== "function") return;
		const original = descriptor.value;
		const wrapped = function (...args) {
			const result = Reflect.apply(original, this, args);
			const details = transactionDetails(this);
			observeTransaction(details?.transaction, details?.storeName);
			return result;
		};
		Object.defineProperty(prototype, methodName, {
			...descriptor,
			value: wrapped,
		});
	}

	const objectStoreDetails = (store) => ({
		transaction: store?.transaction,
		storeName: store?.name,
	});
	const cursorDetails = (cursor) => {
		const source = cursor?.source;
		const objectStore = source?.objectStore ?? source;
		return {
			transaction: objectStore?.transaction,
			storeName: objectStore?.name,
		};
	};

	for (const methodName of ["add", "put", "delete", "clear"]) {
		wrapMethod(
			globalThis.IDBObjectStore?.prototype,
			methodName,
			objectStoreDetails,
		);
	}
	for (const methodName of ["update", "delete"]) {
		wrapMethod(globalThis.IDBCursor?.prototype, methodName, cursorDetails);
	}
})();
