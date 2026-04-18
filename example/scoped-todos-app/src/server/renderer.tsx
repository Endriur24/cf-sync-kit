import { reactRenderer } from '@hono/react-renderer'
import { Script, Link, ViteClient } from 'vite-ssr-components/react'

export const renderer = reactRenderer(({ children }) => {
  return (
    <html>
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Scoped Broadcast Demo</title>
        <ViteClient />
        <Script src="/src/client/index.tsx" />
        <Link href="/src/style.css" rel="stylesheet" />
      </head>
      <body className="bg-gray-50 min-h-screen">{children}</body>
    </html>
  )
})
