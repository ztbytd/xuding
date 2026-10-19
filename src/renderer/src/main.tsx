import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ControlsProvider } from './controls'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ControlsProvider>
      <App />
    </ControlsProvider>
  </React.StrictMode>
)
