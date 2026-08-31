/**
 * Serialized read-modify-write store for chrome.storage.local keys with
 * multiple concurrent writers (homework_items is written by reconcile,
 * notification bookkeeping, popup actions…). Without serialization, one
 * writer's stale snapshot silently reverts another's update — e.g. reconcile
 * erasing lastNotificationLevel (notifications re-fire) or notification
 * write-back resurrecting a just-completed item.
 *
 * The factory takes injected get/set so it is unit-testable without chrome.*
 * APIs. The service worker wires it to getHomeworkItems/setHomeworkItems.
 */

export function createSerializedStore({ get, set }) {
  let chain = Promise.resolve();
  return function mutate(mutator) {
    const run = chain.then(async () => {
      const current = await get();
      const result = await mutator(current);
      await set(result === undefined ? current : result);
      return result === undefined ? current : result;
    });
    // A failed mutator must not poison the chain for later writers.
    chain = run.catch(() => {});
    return run;
  };
}
