// Each run gets a new worker, so that stopping can end one at once. Once the script is held in
// memory, losing the connection after the page has loaded doesn't stop runs from starting.
let held: string | undefined;

export function spawnWorker(): Worker {
  return held ? new Worker(held, { type: "module" }) : new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

/** Website builds only. In development the script is split into modules that a copy can't reach. */
export async function holdWorkerScript(): Promise<void> {
  if (!import.meta.env.PROD) return;
  try {
    const { default: url } = await import("./worker?worker&url");
    const response = await fetch(url);
    if (response.ok) held = URL.createObjectURL(await response.blob());
  } catch {
    // Runs load the script from the site instead.
  }
}

export const NO_WORKER = "The simulator stopped, or couldn't load. Check your connection and run it again.";
