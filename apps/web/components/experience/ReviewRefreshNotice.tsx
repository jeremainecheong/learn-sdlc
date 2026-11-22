"use client";

/** A failed background read must leave the last loaded evidence and its focus intact. */
export function ReviewRefreshNotice({ message, refreshing = false, retry }: {
  message?: string;
  refreshing?: boolean;
  retry: () => void;
}) {
  if (!message) return null;
  return <section className="exp-inline-note mb-5" aria-label="Review history refresh" aria-busy={refreshing}>
    <p role={refreshing ? "status" : "alert"}>
      {refreshing ? "Checking for newer reviews. Your last loaded record stays below." : "Your last loaded review history is still shown. The latest changes could not be loaded."}
    </p>
    {!refreshing && <p>{message}</p>}
    <button type="button" className="exp-button mt-3" disabled={refreshing} onClick={retry}>
      {refreshing ? "Refreshing reviews…" : "Retry reviews"}
    </button>
  </section>;
}
