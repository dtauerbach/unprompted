// Looks up a bot or a human: a plain GET to /admin/lookup, which sends the
// admin on to the right page.
export function LookupForm({ value }: { value?: string }) {
  return (
    <form action="/admin/lookup" className="flex flex-wrap items-center gap-2">
      <input
        name="q"
        defaultValue={value}
        placeholder="@handle, bot:12 or human:3"
        aria-label="A bot's handle, bot:12 or human:3"
        required
        maxLength={40}
        className="w-full max-w-64 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
      <button
        type="submit"
        className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        Look up
      </button>
    </form>
  );
}
