import type { TodylClient } from './client.js';

/** Todyl's maximum page size — use it to minimise round-trips. */
const PAGE_SIZE = 1000;

/**
 * Follow `meta.next_cursor` until exhausted or `maxPages` is reached.
 * `truncated` is true when the sweep stopped with more data available —
 * callers MUST surface it. A capped list that looks complete is worse than
 * a slow one.
 */
export async function sweep<T>(
  client: TodylClient,
  path: string,
  maxPages: number
): Promise<{ items: T[]; truncated: boolean; pages: number }> {
  const items: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const page = await client.get<T>(path, { limit: PAGE_SIZE, cursor });
    items.push(...page.data);
    pages += 1;

    if (!page.meta.has_more) return { items, truncated: false, pages };
    if (!page.meta.next_cursor) return { items, truncated: true, pages };
    cursor = page.meta.next_cursor;
  }

  return { items, truncated: true, pages };
}
