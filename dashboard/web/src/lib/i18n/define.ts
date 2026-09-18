/**
 * Message module shape. `en` defines the key set; `ko` must provide exactly the same keys — a missing or extra key is a
 * TypeScript error, so the two locales cannot drift apart. Placeholders use `{name}` and are filled by `t(key, vars)`.
 */
export type MessageSet = Record<string, string>;
export type Messages<T extends MessageSet> = { en: T; ko: { [K in keyof T]: string } };

export function defineMessages<T extends MessageSet>(messages: { en: T; ko: { [K in keyof T]: string } }): Messages<T> {
  return messages;
}
