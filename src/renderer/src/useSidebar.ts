import { useCallback, useEffect, useState } from 'react'

const storageKey = 'xuding.sidebar.collapsed'

export function useSidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === 'true'
    } catch {
      return false
    }
  })
  const toggle = useCallback(() => setCollapsed((value) => !value), [])

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(collapsed))
    } catch {
      // The layout still works if this device cannot persist UI preferences.
    }
  }, [collapsed])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'b' &&
        !editing
      ) {
        event.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle])

  return { collapsed, toggle }
}
