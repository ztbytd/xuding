export const channels = {
  load: 'subscriptions:load',
  exchangeRates: 'exchange:rates',
  pickIcon: 'subscriptions:pick-icon',
  save: 'subscriptions:save',
  archive: 'subscriptions:archive',
  settings: 'settings:save',
  exportBackup: 'backup:export',
  previewImport: 'backup:preview-import',
  previewBackup: 'backup:preview',
  restoreBackup: 'backup:restore',
  backupStatus: 'backup:status',
  backupNow: 'backup:now',
  backupHistory: 'backup:history',
  chooseBackupDirectory: 'backup:choose-directory',
  navigate: 'navigation:open',
  navigationReady: 'navigation:ready',
  openWebsite: 'website:open'
} as const
