/** Ask's rule: the three billable clients with the most time in view get --work-1 to --work-3, the rest grey. */
export function clientColors(clients: { id: string; billable: boolean; seconds: number }[]): (clientId: string | undefined) => string {
  const ranked = clients.filter((c) => c.billable).sort((a, b) => b.seconds - a.seconds).slice(0, 3).map((c) => c.id);
  return (id) => {
    const i = id ? ranked.indexOf(id) : -1;
    return i >= 0 ? `var(--work-${i + 1})` : "var(--work-other)";
  };
}
