import type { DesktopApi } from '../../shared/model'
declare global {
  interface Window {
    desktop: DesktopApi
  }
}
