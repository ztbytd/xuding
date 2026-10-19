declare module 'better-sqlite3-multiple-ciphers' {
  import Database from 'better-sqlite3'
  interface CipherDatabase extends Database.Database {
    key(key: Buffer): number
    rekey(key: Buffer): number
  }
  const CipherDatabase: new (path: string, options?: Database.Options) => CipherDatabase
  export default CipherDatabase
}
