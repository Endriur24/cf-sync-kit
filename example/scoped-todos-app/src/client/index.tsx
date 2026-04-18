import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { ConnectionProvider } from 'cf-sync-kit'
import App from './app'

const rootElement = document.getElementById('root')
if (rootElement) {
  const queryClient = new QueryClient()
  const root = createRoot(rootElement)
  root.render(
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <App />
      </ConnectionProvider>
    </QueryClientProvider>
  )
}
