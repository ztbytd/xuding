import { randomUUID } from 'node:crypto'
import type { SyncConnection } from '../shared/sync-model'
export class ConcurrentWrite extends Error {}
export class WebDavTransport {
  private base: URL
  private authorization: string
  constructor(
    connection: SyncConnection,
    private fetcher: typeof fetch = fetch,
    allowLoopback = false
  ) {
    const url = new URL(connection.url)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (allowLoopback &&
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      )
    )
      throw new Error('WebDAV 地址须为不含登录信息的 HTTPS 目录。')
    url.pathname = url.pathname.replace(/\/?$/, '/')
    this.base = url
    this.authorization =
      'Basic ' +
      Buffer.from(connection.username + ':' + connection.password, 'utf8').toString('base64')
  }
  private async request(
    name: string,
    method: string,
    body?: Buffer,
    condition?: Record<string, string>
  ): Promise<Response> {
    if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw new Error('同步文件名无效。')
    const result = await this.fetcher(new URL(name, this.base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: this.authorization,
        ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
        ...condition
      },
      body: body as unknown as BodyInit
    })
    if (result.status === 401 || result.status === 403)
      throw new Error('WebDAV 凭据无效或没有目录权限。')
    return result
  }
  async read(name = 'xuding-sync-v1.json'): Promise<{ bytes: Buffer; etag: string } | null> {
    const r = await this.request(name, 'GET')
    if (r.status === 404) return null
    if (!r.ok) throw new Error('无法读取同步数据。')
    const etag = r.headers.get('etag')
    if (!etag || !/^"[^"\r\n]+"$/.test(etag)) throw new Error('服务未提供强 ETag，无法安全同步。')
    if (Number(r.headers.get('content-length') || 0) > 72 * 1024 * 1024)
      throw new Error('远端账本超过大小限制。')
    const chunks: Buffer[] = []
    let size = 0
    if (!r.body) throw new Error('远端响应为空。')
    const reader = r.body.getReader()
    try {
      for (;;) {
        const v = await reader.read()
        if (v.done) break
        size += v.value.length
        if (size > 72 * 1024 * 1024) throw new Error('远端账本超过大小限制。')
        chunks.push(Buffer.from(v.value))
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return { bytes: Buffer.concat(chunks), etag }
  }
  async write(bytes: Buffer, etag: string | null, name = 'xuding-sync-v1.json'): Promise<void> {
    if (bytes.length > 72 * 1024 * 1024) throw new Error('同步账本超过大小限制。')
    const r = await this.request(
      name,
      'PUT',
      bytes,
      etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }
    )
    if (r.status === 412 || r.status === 409)
      throw new ConcurrentWrite('其他设备已提交修改，正在重新合并。')
    if (!r.ok) throw new Error('无法保存同步数据。')
  }
  async test(): Promise<void> {
    const name = 'xuding-probe-' + randomUUID() + '.tmp'
    try {
      await this.write(Buffer.from('a'), null, name)
      const first = await this.read(name)
      if (!first || first.bytes.toString() !== 'a') throw new Error('WebDAV 读取校验失败。')
      let rejected = false
      try {
        await this.write(Buffer.from('bad'), null, name)
      } catch (e) {
        if (e instanceof ConcurrentWrite) rejected = true
        else throw e
      }
      if (!rejected) throw new Error('服务不支持安全的条件创建。')
      rejected = false
      try {
        await this.write(Buffer.from('bad'), '"xuding-invalid-etag"', name)
      } catch (e) {
        if (e instanceof ConcurrentWrite) rejected = true
        else throw e
      }
      if (!rejected) throw new Error('服务忽略版本条件，不能启用同步。')
      await this.write(Buffer.from('b'), first.etag, name)
      const second = await this.read(name)
      if (!second || second.etag === first.etag || second.bytes.toString() !== 'b')
        throw new Error('WebDAV 版本检查失败。')
      const attempts = await Promise.allSettled([
        this.write(Buffer.from('c'), second.etag, name),
        this.write(Buffer.from('d'), second.etag, name)
      ])
      if (
        attempts.filter((v) => v.status === 'fulfilled').length !== 1 ||
        !attempts.some((v) => v.status === 'rejected' && v.reason instanceof ConcurrentWrite)
      )
        throw new Error('服务不支持原子的并发写入。')
    } finally {
      await this.request(name, 'DELETE').catch(() => {})
    }
  }
}
