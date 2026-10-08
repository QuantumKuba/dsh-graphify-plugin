/** Model-visible text limits, independent of upstream token-budget support. */
/**
 * Bounds text without silently presenting a partial result as complete.
 * @param text Original tool text, including any freshness warning.
 * @param maxChars Maximum UTF-16 code units, including the truncation notice.
 * @returns Original text or a bounded prefix with an explicit recovery instruction.
 */
export declare function boundResultText(text: string, maxChars: number): string;
