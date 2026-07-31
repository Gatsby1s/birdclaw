function languageCharacterCounts(text: string) {
	const withoutMetadata = text
		.replace(/https?:\/\/\S+/giu, " ")
		.replace(/(?:^|\s)@[\p{L}\p{N}_]+/gu, " ")
		.replace(/(?:^|\s)[#$][\p{L}\p{N}_]+/gu, " ");
	return {
		han: (withoutMetadata.match(/\p{Script=Han}/gu) ?? []).length,
		hiragana: (withoutMetadata.match(/\p{Script=Hiragana}/gu) ?? []).length,
		katakana: (withoutMetadata.match(/\p{Script=Katakana}/gu) ?? []).length,
		hangul: (withoutMetadata.match(/\p{Script=Hangul}/gu) ?? []).length,
		latin: (withoutMetadata.match(/\p{Script=Latin}/gu) ?? []).length,
		latinWords: (
			withoutMetadata.match(
				/\p{Script=Latin}[\p{Script=Latin}\p{Number}'’-]*/gu,
			) ?? []
		).filter((word) => word.length >= 2).length,
	};
}

export function shouldAutoTranslateTweetText(text: string) {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const counts = languageCharacterCounts(trimmed);
	const kana = counts.hiragana + counts.katakana;
	const languageCharacters = counts.han + kana + counts.hangul + counts.latin;
	if (languageCharacters < 2) return false;
	if (kana > 0 || counts.hangul > 0) return true;
	if (counts.han === 0) return counts.latin >= 4;

	if (counts.latinWords <= 1) return false;
	return counts.han < counts.latinWords * 2;
}
