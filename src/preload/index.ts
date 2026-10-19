import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels'
import type { DesktopApi } from '../shared/model'

const api: DesktopApi = {
  load: () => ipcRenderer.invoke(channels.load),
  save: (input, id) => ipcRenderer.invoke(channels.save, input, id),
  archive: (id) => ipcRenderer.invoke(channels.archive, id),
  settings: (input) => ipcRenderer.invoke(channels.settings, input),
  exportBackup: () => ipcRenderer.invoke(channels.exportBackup),
  importBackup: () => ipcRenderer.invoke(channels.importBackup),
  openWebsite: (url) => ipcRenderer.invoke(channels.openWebsite, url)
}
contextBridge.exposeInMainWorld('desktop', api)
