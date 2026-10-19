import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels'
import type { DesktopApi } from '../shared/model'

const api: DesktopApi = {
  openLicenses: () => ipcRenderer.invoke(channels.openLicenses),
  decisionSave: (input) => ipcRenderer.invoke(channels.decisionSave, input),
  usageRecord: (id, day, remove) => ipcRenderer.invoke(channels.usageRecord, id, day, remove),
  securityStatus: () => ipcRenderer.invoke(channels.securityStatus),
  securityAction: (input) => ipcRenderer.invoke(channels.securityAction, input),
  syncStatus: () => ipcRenderer.invoke(channels.syncStatus),
  syncAction: (input) => ipcRenderer.invoke(channels.syncAction, input),
  protectionStatus: () => ipcRenderer.invoke(channels.protectionStatus),
  configureProtection: (input) => ipcRenderer.invoke(channels.configureProtection, input),
  chooseImport: () => ipcRenderer.invoke(channels.chooseImport),
  selectBackup: (id) => ipcRenderer.invoke(channels.selectBackup, id),
  unlockBackup: (token, password) => ipcRenderer.invoke(channels.unlockBackup, token, password),
  removeBackup: (id) => ipcRenderer.invoke(channels.removeBackup, id),
  copyBackup: (id) => ipcRenderer.invoke(channels.copyBackup, id),
  openBackupDirectory: () => ipcRenderer.invoke(channels.openBackupDirectory),
  updateStatus: () => ipcRenderer.invoke(channels.updateStatus),
  updateAction: (action) => ipcRenderer.invoke(channels.updateAction, action),
  updatePreference: (automatic) => ipcRenderer.invoke(channels.updatePreference, automatic),
  diagnosticsExport: () => ipcRenderer.invoke(channels.diagnosticsExport),
  recoveryStatus: () => ipcRenderer.invoke(channels.recoveryStatus),
  recoveryAction: (action, id) => ipcRenderer.invoke(channels.recoveryAction, action, id),
  updateBill: (input) => ipcRenderer.invoke(channels.updateBill, input),
  addBill: (input) => ipcRenderer.invoke(channels.addBill, input),
  changePrice: (input) => ipcRenderer.invoke(channels.changePrice, input),
  saveBudget: (input) => ipcRenderer.invoke(channels.saveBudget, input),
  csvChoose: () => ipcRenderer.invoke(channels.csvChoose),
  csvDecode: (token, encoding) => ipcRenderer.invoke(channels.csvDecode, token, encoding),
  csvPreview: (input) => ipcRenderer.invoke(channels.csvPreview, input),
  csvCommit: (token) => ipcRenderer.invoke(channels.csvCommit, token),
  csvExport: (input) => ipcRenderer.invoke(channels.csvExport, input),
  load: () => ipcRenderer.invoke(channels.load),
  exchangeRates: (force) => ipcRenderer.invoke(channels.exchangeRates, force),
  pickIcon: () => ipcRenderer.invoke(channels.pickIcon),
  save: (input, id) => ipcRenderer.invoke(channels.save, input, id),
  archive: (id) => ipcRenderer.invoke(channels.archive, id),
  settings: (input) => ipcRenderer.invoke(channels.settings, input),
  exportBackup: (options) => ipcRenderer.invoke(channels.exportBackup, options),
  previewImport: () => ipcRenderer.invoke(channels.previewImport),
  previewBackup: (id) => ipcRenderer.invoke(channels.previewBackup, id),
  restoreBackup: (token, mode) => ipcRenderer.invoke(channels.restoreBackup, token, mode),
  backupStatus: () => ipcRenderer.invoke(channels.backupStatus),
  backupNow: () => ipcRenderer.invoke(channels.backupNow),
  backupHistory: () => ipcRenderer.invoke(channels.backupHistory),
  chooseBackupDirectory: () => ipcRenderer.invoke(channels.chooseBackupDirectory),
  onNavigate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, action: Parameters<typeof listener>[0]) =>
      listener(action)
    ipcRenderer.on(channels.navigate, handler)
    return () => {
      ipcRenderer.removeListener(channels.navigate, handler)
    }
  },
  navigationReady: () => ipcRenderer.invoke(channels.navigationReady),
  openWebsite: (url) => ipcRenderer.invoke(channels.openWebsite, url)
}
contextBridge.exposeInMainWorld('desktop', api)
