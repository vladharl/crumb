// Runs `fn` over `list` four at a time. Shared by the changelog publish (its
// announcement and the public follower emails, lib/public-follows), which
// would otherwise import each other.
// ponytail: four at a time, inside the publish request. lib/email paces the
// sends to the provider's rate (2 a second by default), so N recipients take
// about N/2 seconds. Move the sends to the sweep cron before audiences reach
// the hundreds (a request through Cloudflare gets 100 seconds).
export async function fewAtATime<T>(list: T[], fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}
