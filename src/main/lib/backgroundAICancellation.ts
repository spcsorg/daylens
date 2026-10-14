const activeJobs = new Set<AbortController>()

export function registerBackgroundAIJob(controller: AbortController): () => void {
  activeJobs.add(controller)
  return () => { activeJobs.delete(controller) }
}

export function cancelBackgroundAIJobs(): void {
  for (const controller of activeJobs) controller.abort()
  activeJobs.clear()
}
