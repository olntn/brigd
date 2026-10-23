/** Russian source text → English. Keys keep `{name}` placeholders unchanged. */
export type Dictionary = Record<string, string>;

/**
 * Server text that embeds values, matched as a whole string.
 * A function receives the match and a translator for embedded server phrases.
 */
export type Pattern = readonly [RegExp, string | ((match: RegExpMatchArray, translate: (text: string) => string) => string)];
