import React from 'react'
import { createRoot } from 'react-dom/client'
import { Startup } from './Startup'
import { ControlsProvider } from './controls'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ControlsProvider>
      <Startup />
    </ControlsProvider>
  </React.StrictMode>
)
