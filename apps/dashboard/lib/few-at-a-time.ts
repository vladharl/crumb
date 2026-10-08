// Runs `fn` over `list` four at a time. Shared by the changelog publish (its
// announcement and the public follower emails, lib/public-follows), which
// would otherwise import each other.
// ponytail: four at a time keeps a publish inside one request without bursting
// the email provider's rate limit (inbox bulk status does the same). Move the
// sends to the sweep cron if audiences grow into the thousands.
export async function fewAtATime<T>(list: T[], fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}
