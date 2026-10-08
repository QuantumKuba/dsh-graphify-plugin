/** Model-visible text limits, independent of upstream token-budget support. */
/**
 * Bounds text without silently presenting a partial result as complete.
 * @param text Original tool text, including any freshness warning.
 * @param maxChars Maximum UTF-16 code units, including the truncation notice.
 * @returns Original text or a bounded prefix with an explicit recovery instruction.
 */
export function boundResultText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const notice = '\n[Truncated; narrow the symbol, question or relation. Verify impact in source.]';
    const end = maxChars - notice.length;
    let prefix = text.slice(0, Math.max(0, end));
    const newline = prefix.lastIndexOf('\n');
    if (newline >= prefix.length / 2)
        prefix = prefix.slice(0, newline);
    // A sliced supplementary character must not leave an unpaired surrogate.
    if (/[\uD800-\uDBFF]$/.test(prefix))
        prefix = prefix.slice(0, -1);
    return prefix + notice.slice(0, maxChars);
}
