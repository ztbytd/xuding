import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ConfigProvider, Select, Tooltip, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { CircleHelp } from 'lucide-react'

function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

export function ControlsProvider({ children }: { children: ReactNode }) {
  const dark = useMedia('(prefers-color-scheme: dark)')
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)')
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: dark ? '#9cd3af' : '#286347',
          colorBgContainer: dark ? '#1e2721' : '#ffffff',
          colorBgElevated: dark ? '#253128' : '#ffffff',
          colorText: dark ? '#e7eee8' : '#243229',
          colorTextSecondary: dark ? '#a6b2a9' : '#738076',
          colorBorder: dark ? '#354039' : '#dce3dd',
          controlItemBgActiveHover: dark ? '#3d5947' : '#dfebe2',
          fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
          fontSize: 13,
          borderRadius: 8,
          controlHeight: 38,
          motion: !reducedMotion
        },
        components: {
          Select: {
            optionSelectedBg: dark ? '#344c3d' : '#eaf2ec',
            optionActiveBg: dark ? '#2f4135' : '#f3f7f4',
            optionHeight: 36
          },
          Switch: { trackHeight: 24, trackMinWidth: 44, handleSize: 20 }
        }
      }}
    >
      {children}
    </ConfigProvider>
  )
}

type Choice = { value: string; label: string }

// Keep native FormData submission while the visible control uses Ant Design.
export function SelectField({
  label,
  name,
  value,
  defaultValue,
  options,
  onChange,
  disabled
}: {
  label: string
  name?: string
  value?: string
  defaultValue?: string
  options: Choice[]
  onChange?: (value: string) => void
  disabled?: boolean
}) {
  const id = useId()
  const [localValue, setLocalValue] = useState(defaultValue ?? options[0]?.value)
  const selected = value ?? localValue
  return (
    <>
      <Select<string>
        id={id}
        className="app-select"
        aria-label={label}
        value={selected}
        options={options}
        disabled={disabled}
        virtual={false}
        onChange={(next) => {
          setLocalValue(next)
          onChange?.(next)
        }}
      />
      {name && <input type="hidden" name={name} value={selected} disabled={disabled} />}
    </>
  )
}

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip
      title={children}
      trigger={['hover', 'focus', 'click']}
      placement="top"
      styles={{ root: { maxWidth: 320 } }}
    >
      <button type="button" className="help-tip" aria-label={`${label}说明`}>
        <CircleHelp size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
