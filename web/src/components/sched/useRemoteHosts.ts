import { onMounted, onUnmounted, ref } from 'vue'
import { fetchRemoteHosts, type RemoteHost } from '@/api/remoteHosts'

export function useRemoteHosts() {
  const hosts = ref<RemoteHost[]>([]), configError = ref<string | null>(null), error = ref<string | null>(null), disabled = ref(false)
  let timer: number | undefined, request: AbortController | null = null, active = false
  async function refresh() {
    if (!active || document.visibilityState === 'hidden' || request) return
    const controller = new AbortController(); request = controller
    try {
      const result = await fetchRemoteHosts(controller.signal)
      if (!active || controller.signal.aborted) return
      hosts.value = result.hosts; configError.value = result.configError; disabled.value = !!result.disabled; error.value = null
    } catch (cause) {
      if (active && !controller.signal.aborted) { hosts.value = []; configError.value = null; disabled.value = false; error.value = cause instanceof Error ? cause.message : String(cause) }
    } finally { if (request === controller) request = null }
  }
  function visibility() {
    if (document.visibilityState === 'hidden') { window.clearInterval(timer); request?.abort(); request = null }
    else { void refresh(); timer = window.setInterval(refresh, 3000) }
  }
  onMounted(() => { active = true; document.addEventListener('visibilitychange', visibility); visibility() })
  onUnmounted(() => { active = false; document.removeEventListener('visibilitychange', visibility); window.clearInterval(timer); request?.abort() })
  return { hosts, configError, error, disabled }
}
