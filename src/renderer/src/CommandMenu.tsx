import { useEffect, useRef, useState } from 'react'
import { Input, Modal } from 'antd'
import type { InputRef } from 'antd'
import { Search } from 'lucide-react'
import type { Subscription } from '../../shared/model'
export function CommandMenu({
  subscriptions,
  onOpen,
  onPage,
  onNew
}: {
  subscriptions: Subscription[]
  onOpen: (id: string) => void
  onPage: (page: 'overview' | 'list' | 'calendar' | 'analysis' | 'settings') => void
  onNew: () => void
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [index, setIndex] = useState(0),
    input = useRef<InputRef>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        setQuery('')
        setIndex(0)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const items = [
    ...subscriptions.map((s) => ({
      id: s.id,
      title: s.name,
      subtitle: s.category,
      action: () => onOpen(s.id)
    })),
    { id: 'new', title: '新增订阅', subtitle: '操作', action: onNew },
    ...(['overview', 'list', 'calendar', 'analysis', 'settings'] as const).map((page, i) => ({
      id: page,
      title: ['总览', '我的订阅', '扣款日历', '支出分析', '设置与备份'][i],
      subtitle: '页面',
      action: () => onPage(page)
    }))
  ]
    .filter((v) => v.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 12)
  function select(i: number) {
    items[i]?.action()
    setOpen(false)
  }
  return (
    <>
      <button
        className="command-trigger"
        aria-label="全局搜索 Ctrl+K"
        onClick={() => {
          setOpen(true)
          setQuery('')
          setIndex(0)
        }}
      >
        <Search size={16} />
        <span>搜索</span>
        <kbd>Ctrl K</kbd>
      </button>
      <Modal
        title="搜索与快捷操作"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        afterOpenChange={(v) => v && input.current?.focus()}
        destroyOnHidden
      >
        <Input
          ref={input}
          aria-label="全局搜索"
          prefix={<Search size={16} />}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(items.length - 1, i + 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              select(index)
            }
          }}
        />
        <div className="command-results" role="listbox" aria-label="搜索结果">
          {items.map((v, i) => (
            <button role="option" aria-selected={i === index} key={v.id} onClick={() => select(i)}>
              <strong>{v.title}</strong>
              <small>{v.subtitle}</small>
            </button>
          ))}
          {!items.length && <p className="muted">没有匹配的结果。</p>}
        </div>
      </Modal>
    </>
  )
}
